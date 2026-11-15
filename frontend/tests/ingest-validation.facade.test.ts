import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// 在加载任何带 @ 别名或浏览器依赖的模块之前，先搭好 localStorage 桩。
const memory = new Map<string, string>()
globalThis.localStorage = {
  getItem: (key: string) => memory.get(key) ?? null,
  setItem: (key: string, value: string) => {
    memory.set(key, value)
  },
  removeItem: (key: string) => {
    memory.delete(key)
  },
  clear: () => memory.clear(),
} as Storage

const { SEED_ROWS } = await import('../src/data/seed.ts')
const { saveRows, __resetStoreCacheForTest } = await import('../src/data/local-store.ts')
const validation = await import('../src/api/ingest-validation.ts')

beforeEach(() => {
  memory.clear()
  __resetStoreCacheForTest()
  for (const [key, rows] of Object.entries(SEED_ROWS)) {
    saveRows(key, structuredClone(rows))
  }
  validation.hardResetValidation()
})

test('端到端：调整批次大小只影响引用该字段的原始表，清单与空态原因正确', () => {
  // 种子数据中 INGE-0001 下 BRON-0001 不引用批次大小，BRON-0002 引用。
  const preview = validation.previewImpact(1, { 批次大小: '9000' })
  assert.deepEqual(preview.changedFields, ['批次大小'])
  assert.deepEqual(preview.impacted.map((item) => item.tableCode), ['BRON-0002'])

  const result = validation.adjustChannelParams(1, { 批次大小: '9000' })
  assert.equal(result.ok, true)
  assert.equal(result.run?.status, 'success')

  const pending = validation.listPendingBronze()
  assert.equal(pending.length, 0, '成功批次落账后没有待校验表')
  assert.ok(validation.emptyPendingReason().includes('已全部完成重算'))

  const chain = validation.getChannelChain(1)
  assert.equal(chain.versions[0].version, 2)
  const table2 = validation.getTableCheckState(2)
  assert.equal(table2?.effective?.channelVersion, 2)
  assert.equal(table2?.history.length, 2, '基线结论 + 重算结论都保留')
  const table1 = validation.getTableCheckState(1)
  assert.equal(table1?.history.length, 1, '未命中字段的表没有新增结论')
})

test('端到端：中断后待校验清单只列受影响表，重试从断点恢复且历史结论保留', () => {
  const result = validation.adjustChannelParams(2, { 连接参数: 'bootstrap.servers=kafka-new:9092' }, { failAtStep: validation.VALIDATION_STEPS[0] })
  assert.equal(result.run?.status, 'interrupted')

  const pending = validation.listPendingBronze()
  const codes = pending.map((item) => item.row['表编号']).sort()
  assert.deepEqual(codes, ['BRON-0003', 'BRON-0004'])
  for (const item of pending) {
    assert.ok(item.reason.includes('连接参数'))
    assert.equal(item.version, 2)
  }

  // 中断期间历史结论仍按旧版本保留。
  const table3 = validation.getTableCheckState(3)
  assert.equal(table3?.effective?.batchNo, 'BASE-V1')
  assert.equal(table3?.pendingVersion, 2)

  // 并发写入被拒绝。
  assert.throws(
    () => validation.adjustChannelParams(2, { 批次大小: '500' }),
    (error: unknown) => error instanceof validation.IngestValidationError && error.code === 'channel-busy',
  )

  const retry = validation.retryChannel(2)
  assert.equal(retry.ok, true)
  assert.equal(retry.run.status, 'success')
  assert.equal(validation.listPendingBronze().length, 0)
  assert.equal(validation.getTableCheckState(3)?.effective?.channelVersion, 2)
})

test('端到端：同一指纹重复触达只产生一次重算', () => {
  validation.adjustChannelParams(1, { 校验规则: '主键非空 + 行数对账 + 空值率<0.5%' })
  const runsBefore = validation.getChannelChain(1).runs.length
  const again = validation.adjustChannelParams(1, { 校验规则: '主键非空 + 行数对账 + 空值率<0.5%' })
  assert.equal(again.unchanged, true)
  assert.equal(validation.getChannelChain(1).runs.length, runsBefore)
})

test('端到端：没有原始表时空态说明原因', () => {
  saveRows('bronze', [])
  validation.hardResetValidation()
  assert.deepEqual(validation.listPendingBronze(), [])
  assert.ok(validation.emptyPendingReason().includes('没有任何原始表'))
})

test('端到端：失败分支可从版本追到批次与失败检查点', () => {
  // BRON-0002 引用批次大小，中断在批次检查点，保证批次真正建立并停留失败态。
  validation.adjustChannelParams(1, { 批次大小: '7777' }, { failAtStep: validation.VALIDATION_STEPS[2] })
  const traces = validation.traceFailures(1)
  assert.equal(traces.length, 1)
  assert.equal(traces[0].failedStep, '批次大小压测')
  assert.equal(traces[0].channelVersion, 2)
  assert.ok(traces[0].errorMessage.includes('中断'))
})
