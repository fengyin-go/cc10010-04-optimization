import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  CHANNEL_FIELDS,
  computeImpactedTables,
  dedupeKey,
  emptyValidationState,
  ensureBaseline,
  fingerprint,
  IngestValidationError,
  latestRun,
  latestVersion,
  pendingImpactedTableIds,
  referencedFieldsOfTable,
  registerChange,
  retryRun,
  snapshotFromRow,
  traceFailures,
  VALIDATION_STEPS,
} from '../src/data/validation/engine.ts'
import type { EntryRow } from '../src/data/types.ts'
import type { ChannelField, ValidationState } from '../src/data/validation/types.ts'

const STAMP = '2026-11-15T08:00:00.000Z'

function channelRow(id: number, code: string, overrides: Record<string, string> = {}): EntryRow {
  return {
    id,
    status: '运行中',
    pending: false,
    abnormal: false,
    通道编号: code,
    源端类型: 'MySQL',
    连接参数: `conn-${code}`,
    接入模式: '批量拉取',
    批次大小: '1000',
    校验规则: `rule-${code}`,
    异常处理: `strategy-${code}`,
    通道负责人: 'tester',
    ...overrides,
  }
}

function bronzeRow(id: number, code: string, channel: string, refs: string, overrides: Record<string, string> = {}): EntryRow {
  return {
    id,
    status: '已启用',
    pending: false,
    abnormal: false,
    表编号: code,
    来源通道: channel,
    引用来源字段: refs,
    目标路径: `oss://lake/${code}`,
    保留策略: '保留365天',
    分区规则: '按天分区',
    文件格式: 'Parquet',
    压缩类型: 'Snappy',
    数据校验: '主键非空',
    ...overrides,
  }
}

function fixture() {
  const ingest = [
    channelRow(1, 'INGE-0001'),
    channelRow(2, 'INGE-0002', { 批次大小: '2000' }),
  ]
  // BRON-0001 只依赖连接参数+校验规则；BRON-0002 依赖批次大小+异常处理；BRON-0003 属于另一通道。
  const bronze = [
    bronzeRow(1, 'BRON-0001', 'INGE-0001', '连接参数、校验规则'),
    bronzeRow(2, 'BRON-0002', 'INGE-0001', '批次大小、异常处理', { status: '待校验', pending: true }),
    bronzeRow(3, 'BRON-0003', 'INGE-0002', '连接参数、校验规则、批次大小、异常处理'),
  ]
  const state = emptyValidationState()
  ensureBaseline(state, ingest, bronze, STAMP)
  return { state, ingest, bronze }
}

test('指纹稳定且只由校验链字段决定', () => {
  const row = channelRow(1, 'INGE-0001')
  const snap = snapshotFromRow(row)
  const fp1 = fingerprint(snap)
  const fp2 = fingerprint({ ...snap, 接入模式: '流式订阅' })
  assert.equal(fp1, fp2, '接入模式不在影响范围内，指纹不应变化')
  assert.notEqual(fp1, fingerprint({ ...snap, 批次大小: '9999' }))
})

test('原始表引用字段解析：空声明保守回退为全部影响字段', () => {
  const row = bronzeRow(9, 'BRON-0009', 'INGE-0001', '')
  assert.deepEqual(referencedFieldsOfTable(row), ['连接参数', '校验规则', '批次大小', '异常处理'])
  const explicit = bronzeRow(10, 'BRON-0010', 'INGE-0001', '连接参数,批次大小')
  assert.deepEqual(referencedFieldsOfTable(explicit), ['连接参数', '批次大小'])
})

test('影响范围只包含依赖字段命中的原始表', () => {
  const { ingest, bronze } = fixture()
  const impacted = computeImpactedTables(ingest[0], bronze, ['批次大小'])
  assert.deepEqual(impacted.map((item) => item.tableCode), ['BRON-0002'])
  assert.deepEqual(impacted[0].hitFields, ['批次大小'])
})

test('基线迁移保留存量校验结论并按 v1 版本归档', () => {
  const { state } = fixture()
  assert.equal(state.migrated, true)
  const v1 = state.channelVersions[1][0]
  assert.equal(v1.version, 1)
  assert.equal(v1.active, true)
  const t1 = state.tableStates[1]
  assert.equal(t1.history.length, 1)
  assert.equal(t1.history[0].channelVersion, 1)
  assert.equal(t1.effective?.conclusion.pass, true)
  // 存量待校验表迁移后没有通过结论，但历史记录仍保留。
  assert.equal(state.tableStates[2].effective, null)
  assert.equal(state.tableStates[2].history[0].conclusion.pass, false)
})

test('调整批次大小只让依赖该字段的表回到待校验，范围外表不动', () => {
  const { state, ingest, bronze } = fixture()
  const result = registerChange({
    draft: state,
    channel: ingest[0],
    bronzeRows: bronze,
    patch: { 批次大小: '8000' },
    trigger: '测试调整',
    stamp: STAMP,
  })
  assert.equal(result.unchanged, false)
  assert.deepEqual(result.impacted.map((item) => item.tableCode), ['BRON-0002'])
  const row1 = bronze.find((row) => row.id === 1)
  const row2 = bronze.find((row) => row.id === 2)
  const row3 = bronze.find((row) => row.id === 3)
  assert.equal(row1?.status, '已启用', '未命中字段的表保持已启用')
  assert.equal(row3?.status, '已启用', '其它通道的表完全不受影响')
  assert.equal(result.run?.status, 'success')
  // 成功落账后受影响表恢复启用，结论按表追加；待校验中间态只在中断批次里停留。
  assert.equal(row2?.status, '已启用')
  assert.equal(state.tableStates[2].history.length, 2)
  assert.equal(state.tableStates[1].history.length, 1, '范围外表不新增结论')
  assert.equal(latestVersion(state, 1)?.version, 2)
})

test('重复触达同一参数变更只产生一次重算', () => {
  const { state, ingest, bronze } = fixture()
  const patch = { 校验规则: '主键非空 + 行数对账 + 空值率<1%' }
  const first = registerChange({ draft: state, channel: ingest[0], bronzeRows: bronze, patch, trigger: '第一次', stamp: STAMP })
  assert.equal(first.deduped, false)
  const runsBefore = state.runs[1].length
  // 重复触达一：通道行已是该参数，再提交一遍相同参数，识别为无变化，不新建版本。
  const second = registerChange({ draft: state, channel: ingest[0], bronzeRows: bronze, patch, trigger: '重复提交', stamp: STAMP })
  assert.equal(second.unchanged, true, '参数与当前版本一致时不产生新版本')
  // 重复触达二：参数先改走再改回，目标指纹与已成功批次一致，命中指纹去重，只保留一次重算。
  registerChange({ draft: state, channel: ingest[0], bronzeRows: bronze, patch: { 校验规则: '临时规则' }, trigger: '改走', stamp: STAMP })
  const back = registerChange({ draft: state, channel: ingest[0], bronzeRows: bronze, patch, trigger: '改回', stamp: STAMP })
  assert.equal(back.deduped, true)
  assert.equal(state.runs[1].length, runsBefore + 1, '改回命中指纹去重，只有「改走」新增了一个批次')
  assert.equal(state.channelVersions[1].length, 3, '版本时间线保留 V1/V2/V3，改回没有再插入版本')
  const active = state.channelVersions[1].find((item) => item.active)
  assert.equal(active?.version, 2, '改回不新建版本，有效版本指针切回指纹对应的 V2')
  assert.equal(active?.fingerprint, first.version?.fingerprint)
})

test('无实际字段变化时不产生新版本', () => {
  const { state, ingest, bronze } = fixture()
  const result = registerChange({
    draft: state,
    channel: ingest[0],
    bronzeRows: bronze,
    patch: { 批次大小: '1000' },
    trigger: '空调整',
    stamp: STAMP,
  })
  assert.equal(result.unchanged, true)
  assert.equal(state.channelVersions[1].length, 1)
  assert.equal(state.runs[1], undefined)
})

test('中断演练：失败停在指定检查点，历史结论保留，整批不退回', () => {
  const { state, ingest, bronze } = fixture()
  const result = registerChange({
    draft: state,
    channel: ingest[0],
    bronzeRows: bronze,
    patch: { 连接参数: 'conn-new', 批次大小: '8000' },
    trigger: '中断演练',
    stamp: STAMP,
    failAtStep: VALIDATION_STEPS[2],
  })
  const run = result.run
  assert.ok(run)
  assert.equal(run?.status, 'interrupted')
  // 校验规则 / 异常处理未变更，对应检查点跳过；中断前最后成功的是连接参数探活。
  assert.equal(run?.lastSuccessStep, VALIDATION_STEPS[0])
  const failedStep = run?.steps.find((step) => step.status === 'failed')
  assert.equal(failedStep?.name, VALIDATION_STEPS[2])
  assert.ok(run?.errorMessage.includes('中断'))
  // 命中的两张表挂起待处理版本，但历史结论未被改写。
  assert.deepEqual(run?.impactTableIds.sort(), [1, 2])
  assert.deepEqual(run?.processedTableIds, [])
  assert.equal(state.tableStates[1].history.length, 1)
  assert.equal(state.tableStates[1].effective?.batchNo, 'BASE-V1')
  assert.equal(state.tableStates[1].pendingVersion, 2)
  // 锁仍被中断批次占用。
  assert.equal(state.locks[1], run?.batchNo)
})

test('并发重算同一通道只接受一个批次：未完成批次期间拒绝新变更', () => {
  const { state, ingest, bronze } = fixture()
  registerChange({
    draft: state,
    channel: ingest[0],
    bronzeRows: bronze,
    patch: { 批次大小: '7000' },
    trigger: '第一次中断',
    stamp: STAMP,
    failAtStep: VALIDATION_STEPS[2],
  })
  assert.throws(
    () =>
      registerChange({
        draft: state,
        channel: ingest[0],
        bronzeRows: bronze,
        patch: { 批次大小: '7500' },
        trigger: '并发写入',
        stamp: STAMP,
      }),
    (error: unknown) => error instanceof IngestValidationError && error.code === 'channel-busy',
  )
})

test('重试从最后成功检查点继续，已通过检查点与已落账表不重跑', () => {
  const { state, ingest, bronze } = fixture()
  registerChange({
    draft: state,
    channel: ingest[0],
    bronzeRows: bronze,
    patch: { 连接参数: 'conn-new', 批次大小: '8000' },
    trigger: '中断演练',
    stamp: STAMP,
    failAtStep: VALIDATION_STEPS[2],
  })
  const runBefore = latestRun(state, 1)
  const retry = retryRun(state, 1, bronze, 'rule-INGE-0001', STAMP)
  assert.equal(retry.recovered, true)
  assert.equal(retry.run.status, 'success')
  assert.equal(retry.run.batchNo, runBefore?.batchNo, '重试复用同一批次号')
  const passed = retry.run.steps.filter((step) => step.status === 'success')
  assert.ok(passed.length >= 3)
  // 影响范围两张表均落账，历史结论追加而不是覆盖。
  assert.deepEqual(retry.run.processedTableIds.sort(), [1, 2])
  assert.equal(state.tableStates[1].history.length, 2)
  assert.equal(state.tableStates[2].history.length, 2)
  assert.equal(state.tableStates[1].effective?.channelVersion, 2)
  assert.equal(state.locks[1], undefined)
})

test('重试再次中断后仍可继续重试，且不把整批原始表退回', () => {
  const { state, ingest, bronze } = fixture()
  registerChange({
    draft: state,
    channel: ingest[0],
    bronzeRows: bronze,
    patch: { 异常处理: 'new-strategy' },
    trigger: '首次中断',
    stamp: STAMP,
    failAtStep: VALIDATION_STEPS[3],
  })
  const first = retryRun(state, 1, bronze, 'rule', STAMP, VALIDATION_STEPS[4])
  assert.equal(first.run.status, 'interrupted')
  assert.equal(first.run.lastSuccessStep, VALIDATION_STEPS[3])
  const second = retryRun(state, 1, bronze, 'rule', STAMP)
  assert.equal(second.run.status, 'success')
  assert.deepEqual(second.run.processedTableIds, [2])
  // BRON-0001 不依赖异常处理，全程不在影响范围内，状态从未被改。
  assert.equal(bronze.find((row) => row.id === 1)?.status, '已启用')
})

test('跨模块待校验清单只标记实际受影响的表', () => {
  const { state, ingest, bronze } = fixture()
  registerChange({
    draft: state,
    channel: ingest[0],
    bronzeRows: bronze,
    patch: { 校验规则: 'rule-v2' },
    trigger: '中断',
    stamp: STAMP,
    failAtStep: VALIDATION_STEPS[1],
  })
  const pendingIds = pendingImpactedTableIds(state)
  assert.deepEqual(pendingIds, [1])
})

test('失败分支可从参数版本追到批次、检查点与影响表', () => {
  const { state, ingest, bronze } = fixture()
  const patch = { 连接参数: 'conn-broken' }
  registerChange({
    draft: state,
    channel: ingest[0],
    bronzeRows: bronze,
    patch,
    trigger: '失败追踪',
    stamp: STAMP,
    failAtStep: VALIDATION_STEPS[0],
  })
  const traces = traceFailures(state, 1)
  assert.equal(traces.length, 1)
  const trace = traces[0]
  assert.equal(trace.failedStep, VALIDATION_STEPS[0])
  assert.equal(trace.lastSuccessStep, null)
  assert.equal(trace.channelVersion, 2)
  assert.equal(trace.dedupeKey, dedupeKey('INGE-0001', fingerprint({ ...snapshotFromRow(ingest[0]), ...patch })))
  assert.equal(trace.impactedCount, 1)
  assert.equal(trace.processedCount, 0)
  assert.ok(trace.errorMessage.length > 0)
})

test('新旧版本冲突以当前有效版本为准，历史版本与结论保留', () => {
  const { state, ingest, bronze } = fixture()
  registerChange({ draft: state, channel: ingest[0], bronzeRows: bronze, patch: { 校验规则: 'rule-v2' }, trigger: 'v2', stamp: STAMP })
  registerChange({ draft: state, channel: ingest[0], bronzeRows: bronze, patch: { 校验规则: 'rule-v3' }, trigger: 'v3', stamp: STAMP })
  const versions = state.channelVersions[1]
  assert.equal(versions.length, 3)
  assert.equal(versions.filter((version) => version.active).length, 1)
  assert.equal(versions[versions.length - 1].active, true)
  assert.equal(versions[0].active, false)
  const t1 = state.tableStates[1]
  assert.equal(t1.history.length, 3, '基线 + 两次重算全部保留')
  assert.equal(t1.effective?.channelVersion, 3)
  assert.equal(t1.effective?.conclusion.rule, 'rule-v3')
})

test('草稿表受影响时不强制改状态，通道成功后仍保留草稿，仅登记待处理原因', () => {
  const ingest = [channelRow(1, 'INGE-0001')]
  const bronze = [bronzeRow(1, 'BRON-0001', 'INGE-0001', '批次大小', { status: '草稿', pending: true })]
  const state: ValidationState = emptyValidationState()
  ensureBaseline(state, ingest, bronze, STAMP)
  registerChange({ draft: state, channel: ingest[0], bronzeRows: bronze, patch: { 批次大小: '3000' }, trigger: '草稿通道变更', stamp: STAMP })
  assert.equal(bronze[0].status, '草稿')
  assert.equal(state.tableStates[1].history.length, 2, '结论档案照样追加')
  assert.equal(state.tableStates[1].effective?.channelVersion, 2)
})

test('全部通道字段均纳入指纹快照，字段集合变化会反映在版本上', () => {
  const snap = snapshotFromRow(channelRow(1, 'INGE-0001'))
  for (const field of CHANNEL_FIELDS) {
    assert.ok(field in snap)
  }
  const changed: Partial<Record<ChannelField, string>> = { 异常处理: '隔离并告警' }
  const impacted = computeImpactedTables(channelRow(1, 'INGE-0001'), [bronzeRow(1, 'BRON-0001', 'INGE-0001', '异常处理')], ['异常处理'])
  assert.deepEqual(impacted[0].hitFields, ['异常处理'])
  assert.notEqual(fingerprint(snap), fingerprint({ ...snap, ...changed }))
})
