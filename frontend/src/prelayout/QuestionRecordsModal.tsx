import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Empty, Input, Modal, Select, Spin } from 'antd'
import { body, projectPath, request } from './api'
import type { EditorState } from './editor-state'
import type { PageData, Project } from './types'
import { questionReferences, type TextReference } from './question-references'
import { loadQuestionPages } from './question-page-loader'
import './question-records.css'

type QuestionRecord = { id: string; note: string; texts: TextReference[]; createdAt: string; updatedAt: string }
type RecordsDocument = { version: number; records: QuestionRecord[] }
type Props = { currentPageId: string; open: boolean; project: Project; controller: EditorState; onClose: () => void; onExportPendingChange?: (pending: boolean) => void }

export function QuestionRecordsModal(props: Props) {
  return <QuestionRecordsPanel key={props.project.id} {...props} />
}

function QuestionRecordsPanel({ open, project, controller, onClose, currentPageId, onExportPendingChange }: Props) {
  const [pages, setPages] = useState<Map<string, PageData>>(new Map())
  const [failures, setFailures] = useState<Map<string, string>>(new Map())
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [search, setSearch] = useState('')
  const [pageTarget, setPageTarget] = useState<{ id: string } | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const [priorityReady, setPriorityReady] = useState(false)
  const [positioned, setPositioned] = useState(false)
  const opened = useRef(false)
  const pagesSnapshot = useRef(pages)
  const pendingLocation = useRef<string | null>(null)
  const pendingAnchor = useRef<{ page: string; key?: string; offset: number } | null>(null)
  const pageRefs = useRef(new Map<string, HTMLElement>())
  const [selected, setSelected] = useState<Map<string, TextReference>>(new Map())
  const [note, setNote] = useState('')
  const [records, setRecords] = useState<QuestionRecord[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [viewingId, setViewingId] = useState<string | null>(null)
  const [feedback, setFeedback] = useState('')
  const [recordVersion, setRecordVersion] = useState(0)
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [recordsReady, setRecordsReady] = useState(false)
  const [saving, setSaving] = useState(false)
  const [recordError, setRecordError] = useState('')
  const [recordsAttempt, setRecordsAttempt] = useState(0)
  const writeActive = useRef(false)
  const [retryPending, setRetryPending] = useState(false)
  const pendingWrite = useRef<{ version: number; records: QuestionRecord[]; complete: () => void } | null>(null)
  useEffect(() => () => { onExportPendingChange?.(false) }, [onExportPendingChange])
  const recordsPath = `${projectPath(project.id)}/question-records`
  function captureAnchor() {
    const list = listRef.current
    if (!list) return null
    const rect = list.getBoundingClientRect(), scale = rect.height / list.offsetHeight || 1
    const top = rect.top + list.clientTop * scale
    for (const [page, section] of pageRefs.current) {
      const rect = section.getBoundingClientRect()
      if (rect.bottom <= top + 1 || rect.top >= top + list.clientHeight * scale) continue
      const row = [...section.querySelectorAll<HTMLElement>('[data-question-key]')].find(node => node.getBoundingClientRect().bottom > top + 1)
      return { page, key: row?.dataset.questionKey, offset: ((row || section).getBoundingClientRect().top - top) / scale }
    }
    return null
  }
  useLayoutEffect(() => { pagesSnapshot.current = pages }, [pages])
  useLayoutEffect(() => {
    if (!open || !priorityReady) return
    const list = listRef.current
    if (!list) return
    const rect = list.getBoundingClientRect(), scale = rect.height / list.offsetHeight || 1
    const top = rect.top + list.clientTop * scale
    if (pendingLocation.current && !search) {
      const section = pageRefs.current.get(pendingLocation.current)
      if (!section) return
      const firstRow = section.querySelector<HTMLElement>('[data-question-key]') || section
      list.scrollTop += (firstRow.getBoundingClientRect().top - top) / scale
      pendingLocation.current = null; pendingAnchor.current = null
      setPositioned(true)
    } else if (pendingAnchor.current) {
      const anchor = pendingAnchor.current, section = pageRefs.current.get(anchor.page)
      const row = anchor.key && section ? [...section.querySelectorAll<HTMLElement>('[data-question-key]')].find(node => node.dataset.questionKey === anchor.key) : null
      if (section) list.scrollTop += ((row || section).getBoundingClientRect().top - top) / scale - anchor.offset
      pendingAnchor.current = null
    }
  }, [open, priorityReady, pages, failures, pageTarget, search, records, selected, saving])
  function locatePage(id: string) { pendingLocation.current = id; setSearch(''); setPageTarget({ id }) }

  useEffect(() => {
    if (!open) return
    let live = true
    setRecordsLoading(true); setRecordsReady(false); setRecordError(''); setViewingId(null)
    void request<RecordsDocument>(recordsPath).then(value => {
      if (live) { setRecords(value.records); setRecordVersion(value.version); setRecordsReady(true); if (pendingWrite.current) setRecordError('上次保存結果未確認，請重試保存。') }
    }).catch(error => { if (live) setRecordError((error as Error).message) })
      .finally(() => { if (live) setRecordsLoading(false) })
    return () => { live = false }
  }, [open, recordsPath, recordsAttempt])

  async function persist(next: QuestionRecord[], complete: () => void) {
    if (writeActive.current || !recordsReady || pendingWrite.current) return false
    pendingWrite.current = { version: recordVersion, records: next, complete }
    return submitWrite()
  }
  async function submitWrite() {
    const pending = pendingWrite.current
    if (writeActive.current || !pending) return false
    pendingAnchor.current = captureAnchor()
    writeActive.current = true; onExportPendingChange?.(true); setSaving(true); setRecordError(''); setFeedback('')
    try {
      const value = await request<RecordsDocument>(recordsPath, body({ expected_version: pending.version, records: pending.records }, 'PUT'))
      setRecords(value.records); setRecordVersion(value.version)
      pendingWrite.current = null; setRetryPending(false); pending.complete()
      return true
    } catch (error) {
      const status = (error as Error & { status?: number }).status
      const conflict = status === 409
      const uncertain = !status || status >= 500
      if (uncertain) setRetryPending(true)
      else { pendingWrite.current = null; setRetryPending(false) }
      setRecordError(conflict ? '記錄已有更新，請重新載入後再修改。未送出的疑問已保留。' : `保存失敗：${(error as Error).message}。可重試，疑問內容已保留。`)
      if (conflict) setRecordsReady(false)
      return false
    } finally { writeActive.current = false; setSaving(false); onExportPendingChange?.(pendingWrite.current !== null) }
  }

  useLayoutEffect(() => {
    if (!open) { opened.current = false; return }
    let live = true
    const opening = !opened.current
    opened.current = true
    const cached = new Map<string, PageData>()
    for (const page of project.pages) {
      const data = controller.pages.get(page.id)?.data || pagesSnapshot.current.get(page.id)
      if (data && data.revision >= page.revision) cached.set(page.id, data)
    }
    if (opening) {
      setSearch(''); setPriorityReady(false); setPositioned(false)
      const id = project.pages.some(page => page.id === currentPageId) ? currentPageId : project.pages[0]?.id
      pendingLocation.current = id || null
      setPageTarget(id ? { id } : null)
    } else pendingAnchor.current = captureAnchor()
    setPages(cached); setFailures(new Map()); setLoading(true)
    // Direct reads never restore or auto-save unrelated editor drafts.
    void loadQuestionPages<PageData>({
      pageIds: project.pages.map(page => page.id), currentPageId, cached,
      load: id => request<PageData>(`${projectPath(project.id)}/pages/${id}`),
      isActive: () => live,
      onBatch: (loaded, errors, priorityDone) => {
        if (!live) return
        if (!pendingLocation.current) pendingAnchor.current = captureAnchor()
        setPages(previous => {
          const next = new Map(previous)
          for (const [id, data] of loaded) next.set(id, controller.pages.get(id)?.data || data)
          return next
        })
        setFailures(previous => new Map([...previous, ...errors]))
        if (priorityDone) setPriorityReady(true)
      },
    }).finally(() => { if (live) { setLoading(false); setPriorityReady(true); if (!project.pages.length) setPositioned(true) } })
    return () => { live = false }
  }, [open, project.id, project.pages, controller, currentPageId, attempt])

  const texts = useMemo(() => questionReferences(project, pages), [project, pages])
  const query = search.trim().toLocaleLowerCase()
  const visible = texts.filter(text => !query || text.text.toLocaleLowerCase().includes(query))
  const selectedTexts = [...selected.values()]
  const selectedPages = new Set(selectedTexts.map(text => text.pageId)).size
  const viewed = records.find(record => record.id === viewingId)
  const visibleKeys = new Set(visible.map(text => text.key))
  const selectedVisibleCount = visible.filter(text => selected.has(text.key)).length


  function toggle(text: TextReference, checked: boolean) {
    setSelected(previous => {
      const next = new Map(previous)
      if (checked) next.set(text.key, text); else next.delete(text.key)
      return next
    })
    setFeedback('')
  }
  function clearDraft() { setEditingId(null); setSelected(new Map()); setNote('') }
  async function saveRecord() {
    if (!selectedTexts.length || !note.trim() || !recordsReady) return
    if (editingId && !records.some(record => record.id === editingId)) {
      setRecordError('這條記錄已被刪除，請取消修改後新增。'); return
    }
    const now = new Date().toISOString()
    const texts = selectedTexts.map(text => ({ ...text }))
    const next = editingId
      ? records.map(record => record.id === editingId ? { ...record, note: note.trim(), texts, updatedAt: now } : record)
      : [...records, { id: crypto.randomUUID(), note: note.trim(), texts, createdAt: now, updatedAt: now }]
    await persist(next, () => { setFeedback(editingId ? '已更新' : '已保存'); clearDraft() })
  }
  function editRecord(record: QuestionRecord) {
    setEditingId(record.id); setNote(record.note); setSelected(new Map(record.texts.map(text => [text.key, { ...text }])))
    setViewingId(null); setSearch(''); setPageTarget(null); setFeedback('')
  }
  async function deleteRecord(id: string) {
    await persist(records.filter(record => record.id !== id), () => {
      if (editingId === id) clearDraft()
      if (viewingId === id) setViewingId(null)
      setFeedback('已刪除')
    })
  }
  function references(items: TextReference[]) {
    return items.map(text => <div className="pl-question-reference" key={text.key}>
      <span className="pl-question-text-label">第 {text.pageNumber} 頁 · 第 {text.itemNumber} 框</span>
      <div className="pl-question-text">{text.text || <span className="pl-question-muted">（空文字）</span>}</div>
    </div>)
  }

  return <Modal title={<div className="pl-question-header-line"><strong>疑問記錄 · {project.name}</strong><span>只讀 · 跨頁多選</span><small>{saving ? '保存中…' : '隨項目保存'}</small></div>} open={open} transitionName="" maskTransitionName="" width="calc(100vw - 16px)" className="pl-question-modal" onCancel={onClose} closable={!saving} keyboard={!saving} maskClosable={!saving}
    footer={null}>
    <div className="pl-question-layout">
      <section className="pl-question-source" aria-label="項目全部文本">
        <div className="pl-question-filters">
          <Input.Search size="small" aria-label="搜尋文本" placeholder="搜尋" allowClear value={search} onChange={event => setSearch(event.target.value)} />
          <Select size="small" aria-label="定位頁碼" placeholder="定位頁碼" showSearch optionFilterProp="label" value={pageTarget?.id} onSelect={locatePage}
            options={project.pages.map((page, index) => ({ value: page.id, label: `第 ${index + 1} 頁 · ${page.name}` }))} />
        <div className="pl-question-selection-bar">
          <Checkbox checked={visible.length > 0 && selectedVisibleCount === visible.length} indeterminate={selectedVisibleCount > 0 && selectedVisibleCount < visible.length}
            disabled={saving || retryPending || !visible.length} onChange={event => setSelected(previous => {
              const next = new Map(previous)
              if (event.target.checked) visible.forEach(text => next.set(text.key, text))
              else visibleKeys.forEach(key => next.delete(key))
              return next
            })}>全選</Checkbox>
          <span className="pl-question-muted">{visible.length === texts.length ? `${texts.length} 條` : `${visible.length}／${texts.length}`}</span>
        </div>
        </div>
        <div className="pl-question-text-list" ref={listRef} aria-busy={loading} style={{ visibility: positioned ? 'visible' : 'hidden' }}>
          {project.pages.map((page, pageIndex) => {
            const items = visible.filter(text => text.pageId === page.id)
            if (!items.length && query) return null
            return <section className="pl-question-page" data-question-page={page.id} key={page.id} ref={node => { if (node) pageRefs.current.set(page.id, node); else pageRefs.current.delete(page.id) }} aria-label={`第 ${pageIndex + 1} 頁文本`}>
              <h4 className="pl-question-sr-only">第 {pageIndex + 1} 頁 · {page.name}</h4>
              {!items.length && <div className="pl-question-empty-page pl-question-muted">第 {pageIndex + 1} 頁 · {pages.has(page.id) ? '無文本' : failures.has(page.id) ? '讀取失敗' : '讀取中…'}</div>}
              {items.map(text => <div key={text.key} data-question-key={text.key} className={`pl-question-text-row${selected.has(text.key) ? ' is-selected' : ''}`}>
                <Checkbox disabled={saving || retryPending} checked={selected.has(text.key)} onChange={event => toggle(text, event.target.checked)} aria-label={`選取第 ${text.pageNumber} 頁第 ${text.itemNumber} 框`}>
                  <span className="pl-question-text-label" title={`第 ${text.pageNumber} 頁第 ${text.itemNumber} 框`}>{text.pageNumber}·{text.itemNumber}</span>
                  <span className="pl-question-text">{text.text.replace(/\s*\n\s*/g, ' ') || <span className="pl-question-muted">（空文字）</span>}</span>
                </Checkbox>
              </div>)}
            </section>
          })}
          {!loading && !visible.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={texts.length ? '沒有符合條件的文本' : failures.size ? '尚未讀取到文本，請重試' : '此項目尚無文本'} />}
        </div>
      </section>
      <aside className="pl-question-compose" aria-label="疑問與記錄">
        <div className="pl-question-load-status" role="status" aria-live="polite">
          <span>{loading && <Spin size="small" />}{loading ? '讀取文本' : '文本'} {pages.size}／{project.pages.length} 頁</span>
          {failures.size > 0 && <Button size="small" disabled={loading} onClick={() => setAttempt(value => value + 1)}>重試讀取</Button>}
        </div>
        {failures.size > 0 && <Alert type="warning" showIcon message={`${failures.size} 頁讀取失敗，其餘文本仍可選取。`}
          description={<><div>{project.pages.filter(page => failures.has(page.id)).map(page => `第 ${project.pages.findIndex(candidate => candidate.id === page.id) + 1} 頁：${failures.get(page.id)}`).join('；')}</div>
</>} />}
        {recordError && <Alert type="error" showIcon message={recordError} action={retryPending ? <Button size="small" loading={saving} onClick={() => void submitWrite()}>重試保存</Button> : <Button size="small" disabled={saving} onClick={() => setRecordsAttempt(value => value + 1)}>重新載入</Button>} />}
        {recordsLoading && <Spin size="small" />}
        {editingId && <div className="pl-question-edit-heading"><strong>修改疑問</strong><Button size="small" disabled={saving || retryPending} onClick={() => { clearDraft(); setFeedback('') }}>取消修改</Button></div>}
        <div className="pl-question-selected-heading">
          <details className="pl-question-selected-details"><summary>已選 {selectedTexts.length} 條／{selectedPages} 頁</summary>
            {selectedTexts.length > 0 && <div className="pl-question-selected-preview">{references(selectedTexts)}</div>}
          </details>
          <Button type="link" size="small" disabled={saving || retryPending || !selected.size} onClick={() => setSelected(new Map())}>清空</Button>
        </div>
        <label className="pl-question-note-label" htmlFor="pl-question-note">疑問</label>
        <Input.TextArea id="pl-question-note" disabled={saving || retryPending} value={note} onChange={event => { setNote(event.target.value); setFeedback('') }}
          placeholder="選取文本後填寫疑問" autoSize={{ minRows: 2, maxRows: 5 }} />
        <Button type="primary" size="small" block loading={saving} disabled={retryPending || !recordsReady || !selected.size || !note.trim()} onClick={() => void saveRecord()}>{editingId ? '更新記錄' : '新增記錄'}</Button>
        {feedback && <div role="status" className="pl-question-feedback">{feedback}</div>}
        <div className="pl-question-records-heading"><h3>記錄 {records.length}</h3></div>
        <div className="pl-question-record-list">
          {!records.length && <p className="pl-question-muted">暫無記錄</p>}
          {records.map((record, index) => <article className={`pl-question-record${viewingId === record.id ? ' is-open' : ''}`} key={record.id}>
            <div className="pl-question-record-line">
              <button type="button" className="pl-question-record-summary" aria-expanded={viewingId === record.id}
                onClick={() => setViewingId(viewingId === record.id ? null : record.id)} title={record.note}>
                <span>{viewingId === record.id ? '▾' : '▸'}{index + 1}</span><span className="pl-question-record-title">{record.note}</span>
              </button>
              <span className="pl-question-record-count" title={`${record.texts.length} 條文本 · ${new Set(record.texts.map(text => text.pageId)).size} 頁`}>{record.texts.length}條</span>
              <Button type="text" size="small" disabled={saving || retryPending || !recordsReady} aria-label={`修改疑問 ${index + 1}`} onClick={() => editRecord(record)}>改</Button>
              <Button type="text" size="small" danger disabled={saving || retryPending || !recordsReady} aria-label={`刪除疑問 ${index + 1}`}
                onClick={() => void deleteRecord(record.id)}>刪</Button>
            </div>
            {viewed?.id === record.id && <div className="pl-question-record-detail"><p className="pl-question-record-note">{record.note}</p><p className="pl-question-muted">{record.texts.length} 條 · {new Set(record.texts.map(text => text.pageId)).size} 頁 · {new Date(record.updatedAt).toLocaleString()}</p>{references(record.texts)}</div>}
          </article>)}
        </div>
      </aside>
    </div>
  </Modal>
}
