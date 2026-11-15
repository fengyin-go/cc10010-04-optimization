/**
 * 多源接入校验链门面：页面只跟这里打交道。
 * 负责基线迁移、深拷贝与持久化编排；业务判断全部下沉到 data/validation/engine.ts。
 */
import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'
import { getValidationState, resetValidationState, saveValidationState } from '@/data/validation-store'
import {
  computeImpactedTables,
  dedupeKey,
  ensureBaseline,
  fingerprint,
  IngestValidationError,
  latestRun,
  latestVersion,
  nowStamp,
  openLockInfo,
  pendingImpactedTableIds,
  referencedFieldsOfTable,
  registerChange,
  retryRun,
  snapshotFromRow,
  traceFailures as traceFailuresEngine,
  VALIDATION_STEPS,
} from '@/data/validation/engine'
import { CHANNEL_FIELDS } from '@/data/validation/engine'
import type {
  ChannelField,
  ImpactedTable,
  ParamVersion,
  TableCheckState,
  ValidationRun,
  ValidationState,
} from '@/data/validation/types'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 清单签名：通道 / 原始表的编号、来源通道与引用字段变化时，触发校验链增量对齐。 */
function manifestSignature(): string {
  const ingest = listRows('ingest')
    .map((row) => `${row.id}:${String(row['通道编号'] ?? '')}`)
    .join('|')
  const bronze = listRows('bronze')
    .map((row) => `${row.id}:${String(row['来源通道'] ?? '')}:${String(row['引用来源字段'] ?? '')}`)
    .join('|')
  return `${ingest}#${bronze}`
}

/** 读取校验链状态并保证存量数据已迁移；迁移是幂等的，重复调用不产生新版本。 */
export function loadState(): ValidationState {
  const state = getValidationState()
  if (!state.migrated) {
    ensureBaseline(state, listRows('ingest'), listRows('bronze'), nowStamp())
    state.manifestSignature = manifestSignature()
    saveValidationState(state)
    return state
  }
  // 清单发生漂移（新增表、改来源通道或引用字段）时增量对齐，避免结论档案挂在失效编号上。
  const signature = manifestSignature()
  if (state.manifestSignature !== signature) {
    reconcileManifest(state)
    state.manifestSignature = signature
    saveValidationState(state)
  }
  return state
}

/** 增量对齐：新通道 / 新表补基线，改了引用字段只更新声明，已落账的历史结论不动。 */
function reconcileManifest(state: ValidationState): void {
  const stamp = nowStamp()
  const ingestRows = listRows('ingest')
  const bronzeRows = listRows('bronze')
  ensureBaseline(state, ingestRows, bronzeRows, stamp)
  const ruleMap = new Map(ingestRows.map((row) => [String(row['通道编号'] ?? ''), String(row['校验规则'] ?? '')]))
  for (const bronze of bronzeRows) {
    const tableState = state.tableStates[Number(bronze.id)]
    if (!tableState) {
      continue
    }
    const referenced = referencedFieldsOfTable(bronze)
    tableState.referencedFields = referenced
    tableState.channelCode = String(bronze['来源通道'] ?? '')
    tableState.tableCode = String(bronze['表编号'] ?? '')
    // 挂着待处理版本时，待处理字段也要按新的引用声明重新求交集。
    if (tableState.pendingVersion !== null) {
      const channelCode = String(bronze['来源通道'] ?? '')
      const channelId = ingestRows.find((row) => String(row['通道编号'] ?? '') === channelCode)?.id
      const paramVersion = channelId === undefined ? null : [...(state.channelVersions[Number(channelId)] ?? [])].pop() ?? null
      const changed = new Set(paramVersion?.changedFields ?? [])
      tableState.pendingFields = referenced.filter((field) => changed.has(field))
      if (tableState.pendingFields.length === 0) {
        tableState.pendingVersion = null
        tableState.pendingBatchNo = null
        tableState.pendingReason = '引用来源字段调整后不再命中任何变更字段，撤销待校验标记'
      }
    }
    tableState.history = tableState.history.map((record) => ({
      ...record,
      conclusion: { ...record.conclusion, rule: record.conclusion.rule || ruleMap.get(tableState.channelCode) || '' },
    }))
  }
}

export interface ChannelChain {
  channelId: number
  channelCode: string
  locked: boolean
  lockBatchNo: string | null
  activeVersion: ParamVersion | null
  versions: ParamVersion[]
  latestRun: ValidationRun | null
  runs: ValidationRun[]
  tables: TableCheckState[]
}

export function getChannelChain(channelId: number): ChannelChain {
  const state = loadState()
  const bronze = listRows('bronze')
  const channel = listRows('ingest').find((row) => Number(row.id) === channelId)
  const channelCode = channel ? String(channel['通道编号'] ?? '') : ''
  const tableCodes = new Set(
    bronze.filter((row) => String(row['来源通道'] ?? '') === channelCode).map((row) => Number(row.id)),
  )
  const versions = state.channelVersions[channelId] ?? []
  const runs = [...(state.runs[channelId] ?? [])].reverse()
  return {
    channelId,
    channelCode,
    locked: openLockInfo(state, channelId) !== null,
    lockBatchNo: openLockInfo(state, channelId),
    activeVersion: versions.find((item) => item.active) ?? null,
    versions: [...versions].reverse(),
    latestRun: latestRun(state, channelId),
    runs,
    tables: Object.values(state.tableStates).filter((item) => tableCodes.has(item.tableId)),
  }
}

export interface ImpactPreview {
  changedFields: ChannelField[]
  impacted: ImpactedTable[]
  unchanged: boolean
  deduped: boolean
  fingerprint: string
}

/** 保存前预演：算出本次调整会命中哪些原始表，以及是否会被去重。 */
export function previewImpact(channelId: number, patch: Partial<Record<ChannelField, string>>): ImpactPreview {
  const state = loadState()
  const channel = listRows('ingest').find((row) => Number(row.id) === channelId)
  if (!channel) {
    throw new IngestValidationError('not-found', `没有找到编号为 ${channelId} 的接入通道`)
  }
  const base = latestVersion(state, channelId)
  const current = base ? base.snapshot : snapshotFromRow(channel)
  const nextSnapshot = { ...current }
  for (const field of CHANNEL_FIELDS) {
    if (patch[field] !== undefined) {
      nextSnapshot[field] = String(patch[field])
    }
  }
  const changedFields = CHANNEL_FIELDS.filter((field) => nextSnapshot[field] !== current[field])
  const fp = fingerprint(nextSnapshot)
  const key = dedupeKey(String(channel['通道编号'] ?? ''), fp)
  const deduped = (state.runs[channelId] ?? []).some((run) => run.dedupeKey === key && run.status === 'success')
  const impacted =
    changedFields.length === 0
      ? []
      : computeImpactedTables(channel, listRows('bronze'), changedFields)
  return { changedFields, impacted, unchanged: changedFields.length === 0, deduped, fingerprint: fp }
}

export interface AdjustResult {
  ok: boolean
  message: string
  deduped: boolean
  unchanged: boolean
  impacted: ImpactedTable[]
  run: ValidationRun | null
  version: ParamVersion | null
}

/**
 * 调整通道参数并驱动影响范围内的重算。
 * 同一参数指纹只产生一次重算；通道存在未完成批次时拒绝并发，旧批次结论不会被改写。
 */
export function adjustChannelParams(
  channelId: number,
  patch: Partial<Record<ChannelField, string>>,
  options: { failAtStep?: string | null } = {},
): AdjustResult {
  const ingestRows = listRows('ingest')
  const channelIndex = ingestRows.findIndex((row) => Number(row.id) === channelId)
  if (channelIndex < 0) {
    throw new IngestValidationError('not-found', `没有找到编号为 ${channelId} 的接入通道`)
  }
  const stamp = nowStamp()
  const state = clone(loadState())
  const bronzeRows = clone(listRows('bronze'))
  const channelDraft = clone(ingestRows[channelIndex])

  const result = registerChange({
    draft: state,
    channel: channelDraft,
    bronzeRows,
    patch,
    trigger: '页面参数调整',
    stamp,
    failAtStep: options.failAtStep ?? null,
  })

  if (result.unchanged) {
    return {
      ok: true,
      message: '本次调整与当前生效版本参数一致，未产生新版本，也无需重算',
      deduped: false,
      unchanged: true,
      impacted: [],
      run: null,
      version: result.version,
    }
  }
  if (result.deduped) {
    // 「改回」场景：没有新批次，但通道行参数要对齐到指纹对应的有效版本，
    // 之后页面再提交相同参数会走 unchanged 分支，不会反复触发。
    if (result.version) {
      for (const field of CHANNEL_FIELDS) {
        channelDraft[field] = result.version.snapshot[field]
      }
      const nextIngest = [...ingestRows]
      nextIngest[channelIndex] = channelDraft
      saveRows('ingest', nextIngest)
    }
    saveValidationState(state)
    return {
      ok: true,
      message: `参数指纹 ${result.version ? fingerprint(result.version.snapshot) : ''} 已完成过重算，重复触达不再产生新批次，沿用既有校验结论；有效版本已切回 V${result.version?.version ?? ''}`,
      deduped: true,
      unchanged: false,
      impacted: [],
      run: null,
      version: result.version,
    }
  }

  // 真正落库：通道行写入新参数，原始层只落影响范围内的状态变化。
  for (const field of CHANNEL_FIELDS) {
    if (patch[field] !== undefined) {
      channelDraft[field] = String(patch[field])
    }
  }
  const nextIngest = [...ingestRows]
  nextIngest[channelIndex] = channelDraft
  saveRows('ingest', nextIngest)
  saveRows('bronze', bronzeRows)
  saveValidationState(state)

  const run = result.run
  const tableNames = result.impacted.map((item) => item.tableCode).join('、') || '无'
  const message =
    run?.status === 'success'
      ? `通道 V${result.version?.version} 重算完成，影响 ${result.impacted.length} 张原始表（${tableNames}），范围外表未退回待校验`
      : `通道 V${result.version?.version} 在「${run?.steps.find((step) => step.status === 'failed')?.name ?? ''}」中断：${run?.errorMessage ?? ''}。历史结论已保留，可从该断点重试`
  return {
    ok: true,
    message,
    deduped: false,
    unchanged: false,
    impacted: result.impacted,
    run,
    version: result.version,
  }
}

export interface RetrySummary {
  ok: boolean
  message: string
  run: ValidationRun
}

/** 失败 / 中断后从最后成功检查点续跑，不把整批原始表退回。 */
export function retryChannel(channelId: number, options: { failAtStep?: string | null } = {}): RetrySummary {
  const stamp = nowStamp()
  const state = clone(loadState())
  const bronzeRows = clone(listRows('bronze'))
  const version = latestVersion(state, channelId)
  const rule = version?.snapshot['校验规则'] ?? ''
  const { run } = retryRun(state, channelId, bronzeRows, rule, stamp, options.failAtStep ?? null)
  saveRows('bronze', bronzeRows)
  saveValidationState(state)
  const message =
    run.status === 'success'
      ? `批次 ${run.batchNo} 已从断点续跑完成（最后成功检查点：${run.lastSuccessStep ?? '无'}），${run.processedTableIds.length} 张受影响原始表结论已落账`
      : `批次 ${run.batchNo} 重试后仍在「${run.steps.find((step) => step.status === 'failed')?.name ?? ''}」中断：${run.errorMessage}`
  return { ok: run.status === 'success', message, run }
}

export interface PendingBronzeRow {
  row: EntryRow
  reason: string
  fields: ChannelField[]
  batchNo: string | null
  version: number | null
}

export function emptyPendingReason(): string {
  const state = loadState()
  if (listRows('bronze').length === 0) {
    return '暂无原始表登记：没有任何原始表引用接入通道，无待校验对象'
  }
  const openCount = Object.values(state.locks).length
  return openCount > 0
    ? '当前没有待校验原始表：进行中的批次尚未落账，中断后可从失败通道重试'
    : '当前没有待校验原始表：通道变更字段未命中任何表的「引用来源字段」，或受影响表已全部完成重算'
}

/** 跨模块原始层待校验清单：只标记实际受影响、挂着待处理参数版本的表。 */
export function listPendingBronze(): PendingBronzeRow[] {
  const state = loadState()
  const pendingIds = new Set(pendingImpactedTableIds(state))
  return listRows('bronze')
    .filter((row) => pendingIds.has(Number(row.id)))
    .map((row) => {
      const tableState = state.tableStates[Number(row.id)]
      return {
        row,
        reason: tableState?.pendingReason ?? String(row['_pendingReason'] ?? '通道参数变更待重算'),
        fields: tableState?.pendingFields ?? [],
        batchNo: tableState?.pendingBatchNo ?? null,
        version: tableState?.pendingVersion ?? null,
      }
    })
}

export function getTableCheckState(tableId: number): TableCheckState | null {
  const state = loadState()
  return state.tableStates[tableId] ?? null
}

/** 失败 / 中断分支追踪：从参数版本追到批次、断点与影响表。 */
export function traceFailures(channelId?: number) {
  return traceFailuresEngine(loadState(), channelId)
}

export { referencedFieldsOfTable, IngestValidationError, VALIDATION_STEPS }

export function hardResetValidation(): void {
  resetValidationState()
}
