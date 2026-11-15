import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import {
  emptyPendingReason,
  getTableCheckState,
  listPendingBronze,
  type PendingBronzeRow,
} from '@/api/ingest-validation'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('bronze')
const columns = [
  "表编号",
  "来源通道",
  "引用来源字段",
  "目标路径",
  "保留策略",
  "分区规则",
  "文件格式",
  "压缩类型",
  "数据校验"
]
const actions = [
  "提交校验",
  "启用同步",
  "停用同步"
]
const COLSPAN = columns.length + 3
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]

export default function BronzeView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [okMessage, setOkMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [pendingOnly, setPendingOnly] = useState(true)
  const [pendingRows, setPendingRows] = useState<PendingBronzeRow[]>([])
  const [emptyReason, setEmptyReason] = useState('')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      const pending = listPendingBronze()
      setPendingRows(pending)
      setEmptyReason(emptyPendingReason())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '原始层管理列表读取失败')
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

  const pendingIds = useMemo(() => new Set(pendingRows.map((item) => Number(item.row.id))), [pendingRows])
  const visibleRows = pendingOnly ? rows.filter((row) => pendingIds.has(Number(row.id))) : rows
  const pendingMap = useMemo(() => new Map(pendingRows.map((item) => [Number(item.row.id), item])), [pendingRows])

  const stats = [
    { label: "原始表总数", value: rows.length },
    { label: "已启用表", value: rows.filter((row) => String(row.status) === "已启用").length },
    { label: "待校验表（实际受影响）", value: pendingRows.length },
  ]

  return (
    <section className="page" data-module="bronze">
      <header className="page-head">
        <div>
          <h2>原始层管理</h2>
          <p className="page-desc">待校验清单只列出「引用来源字段」真正命中通道变更字段的原始表；未受影响的表不会随通道调整一起退回待校验。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('原始表登记入口尚未接入审批流')}>
            登记原始表
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出原始层管理清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.slice(0, 3).map((item) => (
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
        <label className="inline-check">
          <input type="checkbox" checked={pendingOnly} onChange={(event) => setPendingOnly(event.target.checked)} />
          只看跨模块待校验清单（实际受影响表）
        </label>
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
            <th>待校验原因 / 通道版本</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map((row) => {
            const rowId = Number(row.id)
            const pending = pendingMap.get(rowId)
            const checkState = getTableCheckState(rowId)
            return (
              <Fragment key={String(row.id)}>
                <tr className={pending ? 'row-pending' : ''}>
                  {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
                  <td>{row.status}</td>
                  <td>
                    {pending ? (
                      <div>
                        <p className="pending-reason">{pending.reason}</p>
                        <span className="run-tag interrupted">
                          {pending.batchNo ?? '待分配批次'} · V{pending.version ?? '?'} · 命中字段：{pending.fields.join('、')}
                        </span>
                      </div>
                    ) : (
                      <span className="muted-text">无待处理通道变更</span>
                    )}
                  </td>
                  <td className="row-actions">
                    {actions.map((action) => (
                      <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                        {action}
                      </button>
                    ))}
                    <button className="link" type="button" onClick={() => setExpandedId(expandedId === rowId ? null : rowId)}>
                      {expandedId === rowId ? '收起结论' : '查看校验结论'}
                    </button>
                  </td>
                </tr>
                {expandedId === rowId && (
                  <tr className="chain-row">
                    <td colSpan={COLSPAN}>
                      {checkState ? (
                        <div className="chain-panel">
                          <h5>{checkState.tableCode} 校验结论档案（历史结论保留，只追加不改写）</h5>
                          <table className="sub-table">
                            <thead>
                              <tr><th>批次</th><th>通道版本</th><th>复核字段</th><th>结论</th><th>规则</th><th>说明</th><th>时间</th></tr>
                            </thead>
                            <tbody>
                              {[...checkState.history].reverse().map((record, index) => (
                                <tr key={`${record.batchNo}-${index}`}>
                                  <td>{record.batchNo}</td>
                                  <td>V{record.channelVersion}（{record.channelStatus}）</td>
                                  <td>{record.fields.join('、') || '全字段'}</td>
                                  <td>{record.conclusion.pass ? '通过' : '未通过'}</td>
                                  <td>{record.conclusion.rule}</td>
                                  <td>{record.conclusion.detail}</td>
                                  <td>{record.checkedAt}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <p className="resume-hint">
                            生效结论：
                            {checkState.effective
                              ? `${checkState.effective.batchNo} / V${checkState.effective.channelVersion}，冲突时以运行中通道的有效版本为准。`
                              : '暂无通过结论；中断或失败后可在多源接入页从失败检查点重试。'}
                          </p>
                        </div>
                      ) : (
                        <p className="empty-state">暂无校验结论：该表尚未纳入任何通道重算批次。</p>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
          {visibleRows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={COLSPAN}>
                {pendingOnly
                  ? `暂无待校验原始表：${emptyReason}`
                  : '暂无原始层数据：没有登记任何原始表，可先登记原始表并声明来源通道与引用来源字段。'}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条原始层记录，其中跨模块待校验清单 {pendingRows.length} 条；通道编号只在影响范围内重算，整批不会一起退回。</span>
      </footer>
    </section>
  )
}
