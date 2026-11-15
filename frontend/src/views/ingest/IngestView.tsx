import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  adjustChannelParams,
  getChannelChain,
  IngestValidationError,
  previewImpact,
  retryChannel,
  VALIDATION_STEPS,
  type ChannelChain,
} from '@/api/ingest-validation'
import type { ChannelField } from '@/data/validation/types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('ingest')
const columns = [
  "通道编号",
  "源端类型",
  "连接参数",
  "接入模式",
  "批次大小",
  "校验规则",
  "异常处理",
  "通道负责人"
]
const editableFields: ChannelField[] = ["连接参数", "接入模式", "批次大小", "校验规则", "异常处理"]
const COLSPAN = columns.length + 3
const actions = [
  "提交校验",
  "启动接入",
  "停止接入"
]
const statuses = [
  "草稿",
  "待校验",
  "运行中",
  "已停止"
]

type FormState = Partial<Record<ChannelField, string>>

export default function IngestView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [okMessage, setOkMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [chains, setChains] = useState<Map<number, ChannelChain>>(new Map())
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [form, setForm] = useState<FormState>({})
  const [previewText, setPreviewText] = useState('')
  const [simulateInterrupt, setSimulateInterrupt] = useState(false)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      const next = new Map<number, ChannelChain>()
      for (const row of payload.items) {
        next.set(Number(row.id), getChannelChain(Number(row.id)))
      }
      setChains(next)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '多源接入列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setOkMessage('')
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setOkMessage(result.message)
    reload()
  }

  function openEditor(row: EntryRow) {
    setErrorMessage('')
    setOkMessage('')
    setEditingId(Number(row.id))
    setExpandedId(Number(row.id))
    setSimulateInterrupt(false)
    const initial: FormState = {}
    for (const field of editableFields) {
      initial[field] = String(row[field] ?? '')
    }
    setForm(initial)
    setPreviewText('')
  }

  function updatePreview(row: EntryRow, next: FormState) {
    try {
      const preview = previewImpact(Number(row.id), next)
      if (preview.unchanged) {
        setPreviewText('表单与当前生效版本一致：不会产生新版本，也不会触发重算。')
        return
      }
      if (preview.deduped) {
        setPreviewText(
          `参数指纹 ${preview.fingerprint} 已完成过重算：重复触达只产生一次重算，将沿用既有结论，不新建批次。`,
        )
        return
      }
      const names = preview.impacted.map((item) => `${item.tableCode}（命中：${item.hitFields.join('、')}）`).join('；')
      setPreviewText(
        `变更字段：${preview.changedFields.join('、')}。真正受影响的原始表 ${preview.impacted.length} 张：${names || '无'}。其余原始表不退回待校验。`,
      )
    } catch (error) {
      setPreviewText(error instanceof Error ? error.message : '影响范围预演失败')
    }
  }

  function saveAdjustment(row: EntryRow) {
    setErrorMessage('')
    setOkMessage('')
    const blank = editableFields.filter((field) => (form[field] ?? '').trim() === '')
    if (blank.length > 0) {
      setErrorMessage(`字段不能留空：${blank.join('、')}`)
      return
    }
    try {
      const result = adjustChannelParams(Number(row.id), form, {
        failAtStep: simulateInterrupt ? VALIDATION_STEPS[2] : null,
      })
      setOkMessage(result.message)
      setEditingId(null)
      setForm({})
      setPreviewText('')
      setSimulateInterrupt(false)
      reload()
    } catch (error) {
      if (error instanceof IngestValidationError) {
        setErrorMessage(error.message)
      } else {
        setErrorMessage(error instanceof Error ? error.message : '通道参数调整失败')
      }
    }
  }

  function retry(channelId: number) {
    setErrorMessage('')
    setOkMessage('')
    try {
      const summary = retryChannel(channelId, { failAtStep: null })
      setOkMessage(summary.message)
      reload()
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '批次重试失败')
    }
  }

  const stats = [
    { label: "接入通道总数", value: rows.length },
    { label: "运行中通道", value: rows.filter((row) => String(row.status) === "运行中").length },
    { label: "待校验通道", value: rows.filter((row) => String(row.status) === "待校验").length },
    { label: "中断批次", value: [...chains.values()].filter((chain) => chain.latestRun?.status === 'interrupted' || chain.latestRun?.status === 'failed').length },
  ]

  return (
    <section className="page" data-module="ingest">
      <header className="page-head">
        <div>
          <h2>多源接入管理</h2>
          <p className="page-desc">调整通道参数后按「连接参数 / 校验规则 / 批次大小 / 异常处理」与原始表引用字段计算影响范围，只重算受影响的接入校验。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('接入通道登记入口尚未接入审批流')}>
            登记接入通道
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出多源接入清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      {okMessage && <p className="info-banner success">{okMessage}</p>}
      {errorMessage && <p className="info-banner error">{errorMessage}</p>}

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>生效版本 / 批次</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const rowId = Number(row.id)
            const chain = chains.get(rowId)
            const open = chain?.latestRun && chain.latestRun.status !== 'success'
            return (
              <Fragment key={String(row.id)}>
                <tr className={open ? 'row-blocked' : ''}>
                  {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                  <td>{row.status}</td>
                  <td>
                    {chain?.activeVersion ? `V${chain.activeVersion.version}` : '—'}
                    {chain?.latestRun && (
                      <span className={`run-tag ${chain.latestRun.status}`}>
                        {chain.latestRun.batchNo}·{chain.latestRun.status === 'interrupted' ? '中断' : chain.latestRun.status === 'failed' ? '失败' : chain.latestRun.status === 'running' ? '进行中' : '成功'}
                      </span>
                    )}
                  </td>
                  <td className="row-actions">
                    {actions.map((action) => (
                      <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                        {action}
                      </button>
                    ))}
                    <button className="link" type="button" onClick={() => openEditor(row)}>调整参数</button>
                    <button className="link" type="button" onClick={() => setExpandedId(expandedId === rowId ? null : rowId)}>
                      {expandedId === rowId ? '收起校验链' : '查看校验链'}
                    </button>
                  </td>
                </tr>
                {editingId === rowId && (
                  <tr key={`edit-${rowId}`} className="edit-row">
                    <td colSpan={COLSPAN}>
                      <div className="edit-panel">
                        <h4>调整通道「{String(row['通道编号'])}」参数（保存即按影响范围重算）</h4>
                        <div className="edit-grid">
                          {editableFields.map((field) => (
                            <label key={field} className="edit-field">
                              <span>{field}</span>
                              <input
                                value={form[field] ?? ''}
                                onChange={(event) => {
                                  const next = { ...form, [field]: event.target.value }
                                  setForm(next)
                                  updatePreview(row, next)
                                }}
                              />
                            </label>
                          ))}
                        </div>
                        <label className="inline-check">
                          <input type="checkbox" checked={simulateInterrupt} onChange={(event) => setSimulateInterrupt(event.target.checked)} />
                          演练模式：本批次在「{VALIDATION_STEPS[2]}」检查点注入中断，用于验证断点保留与重试
                        </label>
                        {previewText && <p className="preview-text">{previewText}</p>}
                        <div className="edit-actions">
                          <button
                            className="btn primary"
                            type="button"
                            disabled={!!chain?.locked}
                            title={chain?.locked ? `通道被批次 ${chain.lockBatchNo ?? ''} 占用，并发重算只接受一个完成结果` : ''}
                            onClick={() => saveAdjustment(row)}
                          >
                            保存并按范围重算
                          </button>
                          <button className="btn ghost" type="button" onClick={() => { setEditingId(null); setPreviewText(''); setSimulateInterrupt(false) }}>
                            取消
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                {expandedId === rowId && editingId !== rowId && (
                  <tr key={`chain-${rowId}`} className="chain-row">
                    <td colSpan={COLSPAN}>
                      <ChannelChainPanel chain={chain} onRetry={() => retry(rowId)} />
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={COLSPAN}>
                暂无多源接入数据：没有登记接入通道，因此不存在参数版本、重算批次与校验结论，可先登记接入通道。
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条多源接入记录；旧校验结论按运行中通道的有效版本保留，冲突时以当前有效版本为准。</span>
      </footer>
    </section>
  )
}

function ChannelChainPanel({ chain, onRetry }: { chain: ChannelChain | undefined; onRetry: () => void }) {
  if (!chain) {
    return <p className="empty-state">暂无校验链数据。</p>
  }
  const run = chain.latestRun
  const canRetry = run && (run.status === 'interrupted' || run.status === 'failed')
  return (
    <div className="chain-panel">
      <div className="chain-head">
        <h4>通道 {chain.channelCode} 校验链</h4>
        {canRetry && (
          <button className="btn primary" type="button" onClick={onRetry}>
            从失败检查点重试（批次 {run.batchNo}）
          </button>
        )}
      </div>
      {run && (
        <div className="run-block">
          <p className="run-meta">
            批次 {run.batchNo} · 关联版本 V{run.channelVersion} · 状态
            <span className={`run-tag ${run.status}`}>
              {run.status === 'interrupted' ? '中断' : run.status === 'failed' ? '失败' : run.status === 'running' ? '进行中' : '成功'}
            </span>
            · 影响原始表 {run.impactTableIds.length} 张 · 已落账 {run.processedTableIds.length} 张
          </p>
          {run.errorMessage && <p className="error-text">异常原因：{run.errorMessage}</p>}
          <ol className="step-list">
            {run.steps.map((step) => (
              <li key={step.name} className={`step ${step.status}`}>
                <strong>{step.name}</strong>
                <span>
                  {step.status === 'success' ? '通过' : step.status === 'skipped' ? '跳过' : step.status === 'failed' ? '失败/中断' : '待执行'}
                  {step.message ? `：${step.message}` : ''}
                </span>
              </li>
            ))}
          </ol>
          <p className="resume-hint">
            {canRetry
              ? `重试将从最后成功检查点「${run.lastSuccessStep ?? '无'}」继续，已通过检查点与已落账原始表不重跑，整批原始表不会一起退回。`
              : '批次完成后结论按表落账；中断期间历史结论保留，旧批次未结束时不接受新批次并发写入。'}
          </p>
        </div>
      )}
      <h5>参数版本时间线（历史结论保留，冲突以有效版本为准）</h5>
      <table className="sub-table">
        <thead>
          <tr><th>版本</th><th>指纹</th><th>变更字段</th><th>触发方式</th><th>状态</th><th>时间</th></tr>
        </thead>
        <tbody>
          {chain.versions.map((version) => (
            <tr key={version.version}>
              <td>V{version.version}</td>
              <td>{version.fingerprint}</td>
              <td>{version.changedFields.length ? version.changedFields.join('、') : '基线版本'}</td>
              <td>{version.trigger}</td>
              <td>{version.active ? '有效版本' : '历史版本'}</td>
              <td>{version.createdAt}</td>
            </tr>
          ))}
          {chain.versions.length === 0 && (
            <tr><td className="empty-state" colSpan={6}>暂无参数版本：通道尚未产生任何调整。</td></tr>
          )}
        </tbody>
      </table>
      <h5>原始表校验结论档案</h5>
      <table className="sub-table">
        <thead>
          <tr><th>原始表</th><th>引用来源字段</th><th>当前生效结论</th><th>待处理版本</th><th>历史结论数</th></tr>
        </thead>
        <tbody>
          {chain.tables.map((state) => (
            <tr key={state.tableId}>
              <td>{state.tableCode}</td>
              <td>{state.referencedFields.join('、') || '未声明（按全部字段保守处理）'}</td>
              <td>
                {state.effective
                  ? `${state.effective.conclusion.pass ? '通过' : '未通过'} · ${state.effective.batchNo} · V${state.effective.channelVersion}`
                  : '暂无通过结论'}
              </td>
              <td>{state.pendingVersion ? `V${state.pendingVersion}（${state.pendingFields.join('、')}）` : '无'}</td>
              <td>{state.history.length}</td>
            </tr>
          ))}
          {chain.tables.length === 0 && (
            <tr><td className="empty-state" colSpan={5}>暂无原始表引用该通道，通道变更不会产生原始层待校验项。</td></tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
