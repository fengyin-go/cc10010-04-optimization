/**
 * 接入校验链纯逻辑引擎。
 *
 * 约定：本文件不触碰 localStorage，也不引入 React；所有函数对传入的 draft 做就地修改，
 * 由 api 层在调用前做深拷贝、调用后统一持久化，保证引擎可在 Node 测试里直接驱动。
 */
import type { EntryRow } from '../types'
import type {
  ChannelField,
  CheckStep,
  ImpactedTable,
  ParamVersion,
  RunStatus,
  TableCheckRecord,
  TableCheckState,
  ValidationRun,
  ValidationState,
} from './types'

/** 通道侧全部可参与版本指纹的字段。 */
export const CHANNEL_FIELDS: ChannelField[] = ['连接参数', '校验规则', '批次大小', '异常处理', '接入模式']

/** 触发原始表待校验的字段（接入模式调整不进校验链影响范围）。 */
export const IMPACT_FIELDS: ChannelField[] = ['连接参数', '校验规则', '批次大小', '异常处理']

/**
 * 字段级影响矩阵：通道字段变更时，由对应的检查点守护。
 * 原始表只有在「引用来源字段」里声明依赖该字段时才进入影响范围。
 */
export const FIELD_GUARD_STEP: Record<ChannelField, string> = {
  连接参数: '连接参数探活',
  校验规则: '校验规则比对',
  批次大小: '批次大小压测',
  异常处理: '异常处理演练',
  接入模式: '接入模式评审',
}

export const VALIDATION_STEPS = [
  '连接参数探活',
  '校验规则比对',
  '批次大小压测',
  '异常处理演练',
  '来源表逐表复核',
] as const

export class IngestValidationError extends Error {
  code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'IngestValidationError'
    this.code = code
  }
}

export function emptyValidationState(): ValidationState {
  return { schemaVersion: 1, channelVersions: {}, runs: {}, tableStates: {}, locks: {}, migrated: false }
}

export function nowStamp(): string {
  return new Date().toISOString()
}

function asText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

/** 从通道行抽取参数字段快照，缺字段给空串，兼容存量数据。 */
export function snapshotFromRow(row: EntryRow): Record<ChannelField, string> {
  return {
    连接参数: asText(row['连接参数']),
    校验规则: asText(row['校验规则']),
    批次大小: asText(row['批次大小']),
    异常处理: asText(row['异常处理']),
    接入模式: asText(row['接入模式']),
  }
}

/** 参数指纹：只对参与校验链的字段做稳定序列化，未纳入影响范围的字段不触发重算。 */
export function fingerprint(snapshot: Record<ChannelField, string>): string {
  const ordered = IMPACT_FIELDS.map((field) => `${field}=${snapshot[field]}`)
  let hash = 0
  const text = ordered.join('|')
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0
  }
  return `fp-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

export function dedupeKey(channelCode: string, fp: string): string {
  return `${channelCode}@${fp}`
}

/** 解析原始表「引用来源字段」，声明为空时保守地视为依赖全部通道字段。 */
export function referencedFieldsOfTable(row: EntryRow): ChannelField[] {
  const raw = asText(row['引用来源字段'])
  if (raw.trim() === '') {
    return [...IMPACT_FIELDS]
  }
  const allowed = new Set<ChannelField>(CHANNEL_FIELDS)
  const parsed = raw
    .split(/[,，、]/)
    .map((item) => item.trim())
    .filter((item): item is ChannelField => allowed.has(item as ChannelField))
  return parsed.length > 0 ? parsed : [...IMPACT_FIELDS]
}

/** 计算一次通道字段变更真正影响到的原始表（依赖字段交集非空才入选）。 */
export function computeImpactedTables(
  channel: EntryRow,
  bronzeRows: EntryRow[],
  changedFields: ChannelField[],
): ImpactedTable[] {
  const channelCode = asText(channel['通道编号'])
  const changed = new Set(changedFields)
  return bronzeRows
    .filter((row) => asText(row['来源通道']) === channelCode)
    .map((row) => {
      const referenced = referencedFieldsOfTable(row)
      const hitFields = referenced.filter((field) => changed.has(field))
      return {
        tableId: Number(row.id),
        tableCode: asText(row['表编号']),
        channelCode,
        referencedFields: referenced,
        hitFields,
      }
    })
    .filter((item) => item.hitFields.length > 0)
}

function ensureChannelBaseline(draft: ValidationState, channel: EntryRow, stamp: string): void {
  const id = Number(channel.id)
  if (draft.channelVersions[id] && draft.channelVersions[id].length > 0) {
    return
  }
  const snapshot = snapshotFromRow(channel)
  const version: ParamVersion = {
    version: 1,
    snapshot,
    changedFields: [],
    fingerprint: fingerprint(snapshot),
    active: true,
    trigger: '存量基线迁移',
    createdAt: stamp,
  }
  draft.channelVersions[id] = [version]
}

function ensureTableBaseline(
  draft: ValidationState,
  bronze: EntryRow,
  channelRuleOf: (code: string) => string,
  stamp: string,
): void {
  const id = Number(bronze.id)
  if (draft.tableStates[id]) {
    return
  }
  const referenced = referencedFieldsOfTable(bronze)
  const pass = asText(bronze.status) === '已启用'
  const record: TableCheckRecord = {
    batchNo: 'BASE-V1',
    channelVersion: 1,
    channelStatus: asText(bronze.status),
    fields: referenced,
    conclusion: {
      pass,
      rule: channelRuleOf(asText(bronze['来源通道'])) || '存量校验规则（迁移时保留）',
      detail: pass ? '存量校验结论迁移：历史校验通过' : '存量校验结论迁移：历史未通过或未完成',
    },
    checkedAt: stamp,
  }
  draft.tableStates[id] = {
    tableId: id,
    tableCode: asText(bronze['表编号']),
    channelCode: asText(bronze['来源通道']),
    referencedFields: referenced,
    history: [record],
    effective: pass ? record : null,
    pendingVersion: null,
    pendingFields: [],
    pendingBatchNo: null,
    pendingReason: '',
  }
}

/** 幂等迁移：把存量通道与原始表纳入版本化校验链，旧结论按运行中通道的版本原样保留。 */
export function ensureBaseline(
  draft: ValidationState,
  ingestRows: EntryRow[],
  bronzeRows: EntryRow[],
  stamp: string,
): void {
  const ruleMap = new Map(ingestRows.map((row) => [asText(row['通道编号']), asText(row['校验规则'])]))
  for (const channel of ingestRows) {
    ensureChannelBaseline(draft, channel, stamp)
  }
  for (const bronze of bronzeRows) {
    ensureTableBaseline(draft, bronze, (code) => ruleMap.get(code) ?? '', stamp)
  }
  draft.migrated = true
}

export function latestVersion(draft: ValidationState, channelId: number): ParamVersion | null {
  const list = draft.channelVersions[channelId]
  return list && list.length > 0 ? list[list.length - 1] : null
}

export function latestRun(draft: ValidationState, channelId: number): ValidationRun | null {
  const list = draft.runs[channelId]
  return list && list.length > 0 ? list[list.length - 1] : null
}

export function hasOpenRun(draft: ValidationState, channelId: number): boolean {
  const run = latestRun(draft, channelId)
  return !!run && (run.status === 'running' || run.status === 'interrupted' || run.status === 'failed')
}

function buildSteps(changedFields: ChannelField[]): CheckStep[] {
  const changed = new Set(changedFields)
  return VALIDATION_STEPS.map((name) => {
    const guard = (Object.entries(FIELD_GUARD_STEP).find(([, step]) => step === name)?.[0] ?? null) as
      | ChannelField
      | null
    const skipped = guard !== null && !changed.has(guard)
    return {
      name,
      field: guard,
      status: skipped ? 'skipped' : 'pending',
      message: skipped ? '本批次未调整该字段，跳过对应检查点' : '',
      finishedAt: skipped ? null : null,
    }
  })
}

function baselineRecord(
  state: TableCheckState,
  run: ValidationRun,
  hitFields: ChannelField[],
  rule: string,
  stamp: string,
): TableCheckRecord {
  return {
    batchNo: run.batchNo,
    channelVersion: run.channelVersion,
    channelStatus: '运行中',
    fields: hitFields,
    conclusion: {
      pass: true,
      rule,
      detail: `按通道 V${run.channelVersion} 版本完成 ${hitFields.join('、')} 复核`,
    },
    checkedAt: stamp,
  }
}

export interface RegisterChangeInput {
  draft: ValidationState
  channel: EntryRow
  bronzeRows: EntryRow[]
  patch: Partial<Record<ChannelField, string>>
  trigger: string
  stamp: string
  /** 演练 / 测试注入：批次执行到该检查点时中断。 */
  failAtStep?: string | null
}

export interface RegisterChangeResult {
  deduped: boolean
  unchanged: boolean
  run: ValidationRun | null
  impacted: ImpactedTable[]
  version: ParamVersion | null
}

/**
 * 登记一次通道参数变更并立即驱动重算。
 * - 同一参数指纹重复触达：命中已成功批次直接去重，只产生一次重算；
 * - 通道上存在未完成批次：拒绝并发写入，旧批次结论不会被改写；
 * - 影响范围按「变更字段 ∩ 原始表引用字段」计算，范围外原始表状态不动。
 */
export function registerChange(input: RegisterChangeInput): RegisterChangeResult {
  const { draft, channel, bronzeRows, patch, trigger, stamp } = input
  const channelId = Number(channel.id)
  const channelCode = asText(channel['通道编号'])
  const base = latestVersion(draft, channelId)
  if (!base) {
    throw new IngestValidationError('not-found', `通道 ${channelCode} 尚未建立版本基线`)
  }
  if (draft.locks[channelId]) {
    const run = latestRun(draft, channelId)
    throw new IngestValidationError(
      'channel-busy',
      `通道 ${channelCode} 已有进行中的批次 ${draft.locks[channelId]}（状态：${run?.status ?? 'unknown'}），请先处理该批次，并发重算只接受一个完成结果`,
    )
  }

  // 以通道行的当前参数为起点，再叠加本次补丁：这样重复提交已落库的参数会被识别为无变化，
  // 从旧页面提交的目标指纹若与已成功批次一致则走指纹去重，不会误建新版本。
  const nextSnapshot: Record<ChannelField, string> = snapshotFromRow(channel)
  for (const field of CHANNEL_FIELDS) {
    if (patch[field] !== undefined) {
      nextSnapshot[field] = asText(patch[field])
    }
  }
  const fp = fingerprint(nextSnapshot)
  const changedFields = CHANNEL_FIELDS.filter((field) => nextSnapshot[field] !== base.snapshot[field])
  if (changedFields.length === 0) {
    return { deduped: false, unchanged: true, run: null, impacted: [], version: base }
  }

  const key = dedupeKey(channelCode, fp)
  const succeeded = (draft.runs[channelId] ?? []).some((run) => run.dedupeKey === key && run.status === 'success')
  if (succeeded) {
    // 「改回」场景：目标指纹已有成功批次，不新建批次、不重跑结论，
    // 只把有效版本指针切回指纹对应的历史版本（历史版本本身保留不删）。
    const matched = draft.channelVersions[channelId].find((item) => item.fingerprint === fp) ?? null
    if (matched) {
      draft.channelVersions[channelId].forEach((item) => {
        item.active = item.version === matched.version
      })
    }
    return { deduped: true, unchanged: false, run: null, impacted: [], version: matched ?? base }
  }

  const impacted = computeImpactedTables(channel, bronzeRows, changedFields)
  const version: ParamVersion = {
    version: base.version + 1,
    snapshot: nextSnapshot,
    changedFields,
    fingerprint: fp,
    active: true,
    trigger,
    createdAt: stamp,
  }
  draft.channelVersions[channelId].forEach((item) => {
    item.active = false
  })
  draft.channelVersions[channelId].push(version)

  const seq = (draft.runs[channelId]?.length ?? 0) + 1
  const run: ValidationRun = {
    batchNo: `V${channelId}-R${seq}`,
    channelId,
    channelCode,
    channelVersion: version.version,
    status: 'running',
    dedupeKey: key,
    trigger,
    startedAt: stamp,
    finishedAt: null,
    steps: buildSteps(changedFields),
    impactTableIds: impacted.map((item) => item.tableId),
    processedTableIds: [],
    lastSuccessStep: null,
    errorMessage: '',
    failAtStep: input.failAtStep ?? null,
  }
  draft.runs[channelId] = [...(draft.runs[channelId] ?? []), run]
  draft.locks[channelId] = run.batchNo

  // 只登记受影响表的待校验，范围外表保持原状态与原结论。
  for (const item of impacted) {
    const state = draft.tableStates[item.tableId]
    if (state) {
      state.pendingVersion = version.version
      state.pendingFields = item.hitFields
      state.pendingBatchNo = run.batchNo
      state.pendingReason = `通道 ${channelCode} 变更字段（${item.hitFields.join('、')}）命中该表引用来源字段`
    }
    const row = bronzeRows.find((candidate) => Number(candidate.id) === item.tableId)
    if (row && asText(row.status) !== '草稿') {
      row.status = '待校验'
      row.pending = true
      row.abnormal = false
      row['_pendingReason'] = `${item.hitFields.join('、')} 随通道 V${version.version} 待重算`
    } else if (row) {
      row['_pendingReason'] = `通道已变更（${item.hitFields.join('、')}），草稿表提交校验后生效`
    }
  }

  executeRun(draft, run, bronzeRows, nextSnapshot['校验规则'], stamp, input.failAtStep ?? null)
  return { deduped: false, unchanged: false, run, impacted, version }
}

function executeRun(
  draft: ValidationState,
  run: ValidationRun,
  bronzeRows: EntryRow[],
  rule: string,
  stamp: string,
  failAtStep: string | null,
): void {
  for (const step of run.steps) {
    if (step.status === 'success' || step.status === 'skipped') {
      continue
    }
    if (failAtStep && step.name === failAtStep) {
      step.status = 'failed'
      step.message = `检查点「${step.name}」执行中断：${step.field ?? '通道级'}校验未通过，已保留在失败断点`
      step.finishedAt = stamp
      run.status = 'interrupted'
      run.finishedAt = stamp
      run.errorMessage = `通道 ${run.channelCode} 在检查点「${step.name}」中断：参数 V${run.channelVersion} 未完成校验，已保留历史结论，可从该断点重试`
      return
    }
    step.status = 'success'
    step.message = '检查点通过'
    step.finishedAt = stamp
    run.lastSuccessStep = step.name
  }

  // 末位检查点：逐表落账，只处理影响范围内尚未处理的表，已处理表不重复退回。
  const impacted = run.impactTableIds
    .map((tableId) => draft.tableStates[tableId])
    .filter((state): state is TableCheckState => !!state)
  for (const state of impacted) {
    if (run.processedTableIds.includes(state.tableId)) {
      continue
    }
    const record = baselineRecord(state, run, state.pendingFields, rule, stamp)
    state.history.push(record)
    state.effective = record
    state.pendingVersion = null
    state.pendingFields = []
    state.pendingBatchNo = null
    state.pendingReason = ''
    run.processedTableIds.push(state.tableId)

    const row = bronzeRows.find((candidate) => Number(candidate.id) === state.tableId)
    if (row && asText(row.status) === '待校验') {
      row.status = '已启用'
      row.pending = false
      row.abnormal = false
      row['_pendingReason'] = ''
    }
  }

  run.status = 'success'
  run.finishedAt = stamp
  run.errorMessage = ''
  delete draft.locks[run.channelId]
}

export interface RetryResult {
  run: ValidationRun
  recovered: boolean
}

/** 从失败 / 中断批次的最后成功检查点继续，已通过的检查点与已落账的表不重跑。 */
export function retryRun(
  draft: ValidationState,
  channelId: number,
  bronzeRows: EntryRow[],
  rule: string,
  stamp: string,
  failAtStep: string | null = null,
): RetryResult {
  const run = latestRun(draft, channelId)
  if (!run) {
    throw new IngestValidationError('not-found', '该通道没有可重试的校验批次')
  }
  if (run.status !== 'interrupted' && run.status !== 'failed') {
    throw new IngestValidationError('no-retry', `批次 ${run.batchNo} 当前状态为 ${run.status}，无需重试`)
  }
  const failedStep = run.steps.find((step) => step.status === 'failed')
  if (failedStep) {
    failedStep.status = 'pending'
    failedStep.message = ''
    failedStep.finishedAt = null
  }
  run.status = 'running'
  run.errorMessage = ''
  run.finishedAt = null
  draft.locks[channelId] = run.batchNo
  const version = latestVersion(draft, channelId)
  executeRun(draft, run, bronzeRows, rule || version?.snapshot['校验规则'] || '', stamp, failAtStep)
  const finalStatus = run.status as RunStatus
  return { run, recovered: finalStatus === 'success' }
}

export interface FailureTrace {
  channelId: number
  channelCode: string
  batchNo: string
  channelVersion: number
  dedupeKey: string
  status: ValidationRun['status']
  failedStep: string | null
  lastSuccessStep: string | null
  errorMessage: string
  impactedCount: number
  processedCount: number
  startedAt: string
  finishedAt: string | null
}

/** 从参数版本追到校验结果的失败分支：列出所有未完成批次及其断点。 */
export function traceFailures(draft: ValidationState, channelId?: number): FailureTrace[] {
  const ids = channelId === undefined ? Object.keys(draft.runs ?? {}).map(Number) : [channelId]
  const traces: FailureTrace[] = []
  for (const id of ids) {
    for (const run of draft.runs[id] ?? []) {
      if (run.status === 'success') {
        continue
      }
      traces.push({
        channelId: id,
        channelCode: run.channelCode,
        batchNo: run.batchNo,
        channelVersion: run.channelVersion,
        dedupeKey: run.dedupeKey,
        status: run.status,
        failedStep: run.steps.find((step) => step.status === 'failed')?.name ?? null,
        lastSuccessStep: run.lastSuccessStep,
        errorMessage: run.errorMessage,
        impactedCount: run.impactTableIds.length,
        processedCount: run.processedTableIds.length,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      })
    }
  }
  return traces
}

/** 跨模块的原始层待校验清单：只返回真正挂着通道待处理版本的表。 */
export function pendingImpactedTableIds(draft: ValidationState): number[] {
  return Object.values(draft.tableStates)
    .filter((state) => state.pendingVersion !== null)
    .map((state) => state.tableId)
}

export function openLockInfo(draft: ValidationState, channelId: number): string | null {
  return draft.locks[channelId] ?? null
}
