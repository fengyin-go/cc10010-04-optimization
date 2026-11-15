/**
 * 多源接入校验链领域类型。
 *
 * 这条链关注三件事：
 * 1. 接入通道的连接参数 / 校验规则 / 批次大小 / 异常处理每次调整都形成一个参数版本；
 * 2. 原始表通过「引用来源字段」声明自己实际依赖通道的哪些字段，变更只在交集内产生影响；
 * 3. 每个通道的重算按批次执行，批次内分检查点推进，结论按表追加保存、历史永不改写。
 */

/** 通道侧参与版本指纹计算、且可能影响原始表的字段。 */
export type ChannelField = '连接参数' | '校验规则' | '批次大小' | '异常处理' | '接入模式'

export type RunStatus = 'running' | 'success' | 'failed' | 'interrupted'

export type StepStatus = 'pending' | 'success' | 'failed' | 'skipped'

/** 一次参数调整形成的通道版本，版本号在通道内递增。 */
export interface ParamVersion {
  version: number
  /** 该版本下通道参数字段的完整快照。 */
  snapshot: Record<ChannelField, string>
  /** 相对上一版本实际发生变化的字段。 */
  changedFields: ChannelField[]
  fingerprint: string
  active: boolean
  trigger: string
  createdAt: string
}

export interface CheckConclusion {
  pass: boolean
  /** 结论所依据的通道校验规则原文。 */
  rule: string
  detail: string
}

export interface CheckStep {
  /** 检查点名称，同时也是失败注入 / 断点续跑的定位键。 */
  name: string
  /** 该检查点守护的通道字段；为空表示是通道级收尾步骤。 */
  field: ChannelField | null
  status: StepStatus
  message: string
  finishedAt: string | null
}

/** 单张原始表的校验结论档案，history 只追加、不修改、不删除。 */
export interface TableCheckRecord {
  batchNo: string
  channelVersion: number
  /** 产出该结论时通道自身的状态，用于区分新旧批次交替期的结论来源。 */
  channelStatus: string
  fields: ChannelField[]
  conclusion: CheckConclusion
  checkedAt: string
}

export interface TableCheckState {
  tableId: number
  tableCode: string
  channelCode: string
  /** 该表实际引用的通道字段；老数据缺省时按全部通道字段处理。 */
  referencedFields: ChannelField[]
  history: TableCheckRecord[]
  /** 当前生效结论；中断 / 失败期间保留上一成功版本的结论。 */
  effective: TableCheckRecord | null
  /** 已登记但尚未重算完成的待处理版本。 */
  pendingVersion: number | null
  pendingFields: ChannelField[]
  pendingBatchNo: string | null
  pendingReason: string
}

export interface ValidationRun {
  batchNo: string
  channelId: number
  channelCode: string
  /** 关联的通道参数版本。 */
  channelVersion: number
  status: RunStatus
  /** 去重键 = 通道编号 + 参数指纹，同一指纹重复触达只会落到同一个重算。 */
  dedupeKey: string
  trigger: string
  startedAt: string
  finishedAt: string | null
  steps: CheckStep[]
  /** 本次批次影响范围内的全部原始表。 */
  impactTableIds: number[]
  /** 已经完成结论落账的原始表。 */
  processedTableIds: number[]
  /** 最后一个成功检查点，重试从它的下一个检查点继续。 */
  lastSuccessStep: string | null
  errorMessage: string
  /** 演练 / 测试用：执行到该检查点时注入中断。 */
  failAtStep: string | null
}

export interface ImpactedTable {
  tableId: number
  tableCode: string
  channelCode: string
  referencedFields: ChannelField[]
  /** 变更字段与引用字段的交集，即真正命中的依赖字段。 */
  hitFields: ChannelField[]
}

export interface ValidationState {
  schemaVersion: number
  /** 通道编号 -> 参数版本时间线（v1 为存量基线）。 */
  channelVersions: Record<number, ParamVersion[]>
  /** 通道编号 -> 重算批次列表。 */
  runs: Record<number, ValidationRun[]>
  /** 原始表编号 -> 校验结论档案。 */
  tableStates: Record<number, TableCheckState>
  /** 通道编号 -> 占用该通道的批次号，存在未完成批次时拒绝新批次并发写入。 */
  locks: Record<number, string>
  migrated: boolean
  /** 业务清单签名：通道 / 原始表编号、来源通道与引用字段变化后触发增量对齐。 */
  manifestSignature?: string
}
