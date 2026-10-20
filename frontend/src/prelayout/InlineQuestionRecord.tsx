import { useRef, useState } from 'react'
import { Button, Input } from 'antd'
import type { EditorState } from './editor-state'
import { selectionOrder, selectionPages, type Selection } from './geometry'
import { questionReferences } from './question-references'
import { appendQuestionRecord, type QuestionRecord } from './question-record-store'
import type { Project } from './types'

export function InlineQuestionRecord({ project, controller, selection, onSaved }: {
  project: Project; controller: EditorState; selection: Selection; onSaved: (selection: Selection) => void;
}) {
  const [note, setNote] = useState(''), [saving, setSaving] = useState(false), [error, setError] = useState('')
  const [retry, setRetry] = useState(false)
  const active = useRef(false)
  const pending = useRef<{ record: QuestionRecord; selection: Selection } | null>(null)
  async function save() {
    if (active.current) return
    if (!pending.current) {
      const pages = new Map([...controller.pages].map(([id, state]) => [id, state.data]))
      const texts = questionReferences(project, pages, selectionPages(selection), selectionOrder(selection))
      if (!note.trim() || !texts.length) return
      const now = new Date().toISOString()
      pending.current = { record: { id: crypto.randomUUID(), note: note.trim(), texts, createdAt: now, updatedAt: now }, selection }
    }
    active.current = true; setSaving(true); setError('')
    try {
      await appendQuestionRecord(project.id, pending.current.record)
      const saved = pending.current.selection
      pending.current = null; setRetry(false); setNote(''); onSaved(saved)
    } catch (error) {
      const status = (error as Error & { status?: number }).status
      const uncertain = !status || status >= 500
      if (!uncertain) pending.current = null
      setRetry(uncertain)
      setError(`保存失敗：${(error as Error).message}；內容已保留，可重試。`)
    } finally { active.current = false; setSaving(false) }
  }
  if (!selection.ids.length && !note && !retry) return null
  return <div className="pl-inline-question">
    <Input.TextArea aria-label="記錄疑問" placeholder="填寫疑問，為所選文本添加記錄" autoSize={{ minRows: 2, maxRows: 4 }} value={note}
      disabled={saving || retry} onChange={event => { setNote(event.target.value); setError('') }} />
    <Button size="small" loading={saving} disabled={!retry && (!note.trim() || !selection.ids.length)} onClick={() => void save()}>{retry ? '重試保存' : '添加記錄'}</Button>
    {error && <small role="alert">{error}</small>}
  </div>
}
