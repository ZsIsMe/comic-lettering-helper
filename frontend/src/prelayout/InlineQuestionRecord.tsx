import { useEffect, useRef, useState } from 'react'
import { Button, Input } from 'antd'
import type { EditorState } from './editor-state'
import { selectionOrder, selectionPages, type Selection } from './geometry'
import { questionReferences, type TextReference } from './question-references'
import { appendQuestionRecord, deleteQuestionRecord, readQuestionRecords, updateQuestionRecord, type QuestionRecord } from './question-record-store'
import type { Project } from './types'
import './question-records.css'

type PendingWrite = { kind: 'add'; record: QuestionRecord; selection: Selection }
  | { kind: 'update'; original: QuestionRecord; note: string; updatedAt: string }
  | { kind: 'delete'; original: QuestionRecord }

export function InlineQuestionRecord({ project, controller, selection, onSaved, onExportPendingChange, onNavigate, refreshKey }: {
  project: Project; controller: EditorState; selection: Selection; onSaved: (selection: Selection) => void;
  onExportPendingChange?: (pending: boolean) => void; onNavigate?: (reference: TextReference) => void | Promise<void>; refreshKey?: unknown;
}) {
  const [records, setRecords] = useState<QuestionRecord[]>([])
  const [loading, setLoading] = useState(false), [loadError, setLoadError] = useState(''), [loadAttempt, setLoadAttempt] = useState(0)
  const [note, setNote] = useState(''), [editing, setEditing] = useState<QuestionRecord | null>(null)
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(false)
  const active = useRef(false), pending = useRef<PendingWrite | null>(null), readGeneration = useRef(0)
  const live = useRef(true), navigation = useRef(0), reportPending = useRef(onExportPendingChange)
  useEffect(() => { reportPending.current = onExportPendingChange }, [onExportPendingChange])
  useEffect(() => {
    live.current = true
    return () => { live.current = false; reportPending.current?.(false) }
  }, [])
  useEffect(() => {
    let current = true
    const generation = ++readGeneration.current
    setLoading(true); setLoadError('')
    void readQuestionRecords(project.id).then(value => {
      if (current && generation === readGeneration.current) setRecords(value.records)
    }).catch(error => { if (current && generation === readGeneration.current) setLoadError((error as Error).message) })
      .finally(() => { if (current && generation === readGeneration.current) setLoading(false) })
    return () => { current = false }
  }, [project.id, refreshKey, loadAttempt])

  async function submit(write?: PendingWrite) {
    if (active.current) return
    if (write && !pending.current) pending.current = write
    const operation = pending.current
    if (!operation) return
    active.current = true; reportPending.current?.(true); setSaving(true); setError('')
    // An older list read must not replace the result of this write.
    readGeneration.current += 1; setLoading(false)
    try {
      const value = operation.kind === 'add' ? await appendQuestionRecord(project.id, operation.record)
        : operation.kind === 'update' ? await updateQuestionRecord(project.id, operation.original, operation.note, operation.updatedAt)
          : await deleteQuestionRecord(project.id, operation.original)
      if (!live.current) return
      readGeneration.current += 1; setLoading(false)
      setRecords(value.records); setLoadError(''); pending.current = null; setRetry(false)
      if (operation.kind === 'add') { setNote(''); onSaved(operation.selection) }
      else if (operation.kind === 'update' || editing?.id === operation.original.id) { setNote(''); setEditing(null) }
    } catch (error) {
      if (!live.current) return
      const status = (error as Error & { status?: number }).status
      const uncertain = !status || status >= 500
      if (!uncertain) pending.current = null
      setRetry(uncertain)
      setError(`${operation.kind === 'delete' ? '刪除' : '保存'}失敗：${(error as Error).message}；內容已保留。`)
    } finally {
      active.current = false
      if (live.current) { setSaving(false); reportPending.current?.(pending.current !== null) }
    }
  }
  function save() {
    if (pending.current) { void submit(); return }
    if (!note.trim()) return
    const now = new Date().toISOString()
    if (editing) { void submit({ kind: 'update', original: editing, note: note.trim(), updatedAt: now }); return }
    const pages = new Map([...controller.pages].map(([id, state]) => [id, state.data]))
    const texts = questionReferences(project, pages, selectionPages(selection), selectionOrder(selection))
    if (!texts.length) return
    void submit({ kind: 'add', record: { id: crypto.randomUUID(), note: note.trim(), texts, createdAt: now, updatedAt: now }, selection })
  }
  const locked = saving || retry
  return <section className="pl-question-sidebar">
    <div className="pl-inspector-title"><h2>疑問記錄</h2></div>
    <div className="pl-inline-question">
      {editing && <div className="pl-question-sidebar-edit"><strong>修改疑問</strong><Button size="small" disabled={locked} onClick={() => { setEditing(null); setNote(''); setError('') }}>取消修改</Button></div>}
      <Input.TextArea aria-label="記錄疑問" placeholder={editing ? '修改此條疑問的內容' : '填寫疑問，為所選文本添加記錄'} autoSize={{ minRows: 2, maxRows: 4 }} value={note}
        disabled={locked} onChange={event => { setNote(event.target.value); setError('') }} />
      <Button size="small" loading={saving} disabled={!retry && (!note.trim() || (!editing && !selection.ids.length))} onClick={save}>{retry ? '重試保存' : editing ? '更新記錄' : '添加記錄'}</Button>
      {error && <small role="alert">{error}</small>}
    </div>
    <div className="pl-question-sidebar-load" role="status">{loading ? '讀取記錄中…' : `${records.length} 條記錄`}
      <Button size="small" disabled={loading || saving} onClick={() => setLoadAttempt(value => value + 1)}>重新載入記錄</Button>
    </div>
    {loadError && <div className="pl-question-sidebar-error" role="alert">讀取失敗：{loadError}<Button size="small" disabled={loading} onClick={() => setLoadAttempt(value => value + 1)}>重試讀取記錄</Button></div>}
    <div className="pl-question-sidebar-list">
      {records.map((record, index) => <article className={`pl-question-sidebar-record${editing?.id === record.id ? ' is-editing' : ''}`} key={record.id}>
        <div className="pl-question-sidebar-line">
          <button type="button" disabled={locked} className="pl-question-sidebar-summary" title={record.note} aria-label={`修改疑問 ${index + 1}`} onClick={() => { setEditing(structuredClone(record)); setNote(record.note); setError('') }}>
            <span>{index + 1}.</span><span>{record.note.replace(/\s*\n\s*/g, ' ')}</span>
          </button>
          <Button size="small" type="text" danger disabled={locked} aria-label={`刪除疑問 ${index + 1}`}
            onClick={() => void submit({ kind: 'delete', original: structuredClone(record) })}>刪</Button>
        </div>
        <div className="pl-question-sidebar-references">{record.texts.map((reference, ordinal) => <Button size="small" key={reference.key} disabled={!onNavigate} title={`第 ${reference.pageNumber} 頁 · 第 ${reference.itemNumber} 框`}
          aria-label={`疑問 ${index + 1} 引用 ${ordinal + 1}：第 ${reference.pageNumber} 頁第 ${reference.itemNumber} 框`} onClick={() => {
            const request = ++navigation.current; setError('')
            void Promise.resolve().then(() => onNavigate?.(reference)).catch(error => {
              if (live.current && request === navigation.current) setError(`定位失敗：${(error as Error).message}`)
            })
          }}>{ordinal + 1}</Button>)}</div>
      </article>)}
      {!loading && !loadError && !records.length && <p className="pl-muted">暫無記錄</p>}
    </div>
  </section>
}
