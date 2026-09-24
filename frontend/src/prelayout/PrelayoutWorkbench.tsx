import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, Button, Checkbox, Empty, Input, InputNumber, Modal, Select, Space, Spin, Tag, Tooltip, message } from 'antd'
import { base, body, files, previewUrl, projectPath, request } from './api'
import { type Availability, type Detection, type Item, type Project, activeDetection, uid } from './types'
import { EditorState } from './editor-state'
import { ContinuousPages } from './ContinuousPages'
import { type Selection, type PagePointer, color, moved, measureStyle } from './geometry'
import { adjustedItems, textShortcut, type TextAdjustment } from './shortcuts'
import { pasteFrame } from './frame-clipboard'
import { useFrameClipboard } from './use-frame-clipboard'
import { ShortcutHelp } from './ShortcutHelp'
import { GroupName } from './GroupName'
import { PageNavigation, type PageRange } from './PageNavigation'
import { usePrelayoutAgent } from './usePrelayoutAgent'
import './styles.css'

const showCleanUpload = false
const defaultDifferenceColor = '#ff288c'
const defaultDifferenceOpacity = .4
const detectionMethodOptions = [
  { value: 'ocr_aligned', label: 'OCR 對齊逐字計算' },
  { value: 'single_char', label: '單字框計算' },
  { value: 'fixed', label: '固定字體大小' },
]

function differenceStylePreference() {
  try {
    const value = JSON.parse(localStorage.getItem('pl-difference-style') || '{}')
    const opacity = Number(value.opacity)
    return {
      color: typeof value.color === 'string' && /^#[0-9a-f]{6}$/i.test(value.color) ? value.color : defaultDifferenceColor,
      opacity: Number.isFinite(opacity) && opacity >= 0 && opacity <= 1 ? opacity : defaultDifferenceOpacity,
    }
  } catch {
    return { color: defaultDifferenceColor, opacity: defaultDifferenceOpacity }
  }
}

export default function PrelayoutWorkbench({ onExit, onReadyToLeave }: { onExit: () => void; onReadyToLeave?: (handler: () => Promise<boolean>) => void }) {
  const [modal, modalContext] = Modal.useModal()
  const [projects, setProjects] = useState<Project[]>([]), [current, setCurrent] = useState<Project | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [createOpen, setCreateOpen] = useState(false)
  const [newProjectId, setNewProjectId] = useState<string | null>(null)
  const [name, setName] = useState(''), [images, setImages] = useState<File[]>([])
  const reload = useCallback(async () => setProjects(await request<Project[]>(`${base}/projects`)), [])
  useEffect(() => {
    void reload().catch(e => setError(e.message))
    const id = localStorage.getItem('pl-last-project')
    if (id) void request<Project>(projectPath(id)).then(setCurrent).catch(() => localStorage.removeItem('pl-last-project'))
  }, [reload])
  useEffect(() => { if (current) localStorage.setItem('pl-last-project', current.id) }, [current])
  async function action(fn: () => Promise<void>) {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (current) return <Workspace key={current.id} project={current} promptDetection={newProjectId === current.id} onReadyToLeave={onReadyToLeave} onExit={async () => { localStorage.removeItem('pl-last-project'); setNewProjectId(null); setCurrent(null); await reload() }} />
  return <main className="pl-shell pl-home">{modalContext}
    <header className="pl-home-header"><div><span className="pl-kicker">LETTERING STUDIO</span><h1>漫畫預排版</h1><p>匯入譯文，在連續漫畫頁上調整文字與樣式。</p></div><Space wrap>
      <Button onClick={onExit}>返回圖片修復</Button>
      <Button href="/downloads/LabelPlus_Ps_Script_ZS-1.8.0.zip" download="LabelPlus_Ps_Script_ZS-1.8.0.zip">配套PS腳本</Button>
      <label className="pl-file">匯入預排版項目<input type="file" accept=".zip" disabled={busy} onChange={e => {
        const file = e.target.files?.[0]; e.target.value = ''; if (!file) return
        void action(async () => { const data = new FormData(); data.append('archive', file); setCurrent(await request<Project>(`${base}/projects/import`, { method: 'POST', body: data })) })
      }} /></label>
      <Button type="primary" onClick={() => setCreateOpen(true)}>新建預排版</Button>
    </Space></header>
    {error && <Alert type="error" showIcon message={error} />}
    {busy ? <Spin /> : projects.length ? <div className="pl-project-grid">{projects.map(project => <article key={project.id} className="pl-project-card">
      <button className="pl-cover" onClick={() => setCurrent(project)}><img src={previewUrl(project.id, project.pages[0], 384)} loading="lazy" alt={project.name} /></button>
      <h2>{project.name}</h2><p>{project.pages.length} 頁 · {new Date(project.updated_at).toLocaleString()}</p>
      <Space><Button type="primary" onClick={() => setCurrent(project)}>繼續預排版</Button><Button onClick={() => {
        let next = project.name
        modal.confirm({ title: '重新命名', content: <Input defaultValue={next} onChange={e => { next = e.target.value }} />, onOk: () => action(async () => { await request(projectPath(project.id), body({ name: next }, 'PATCH')); await reload() }) })
      }}>改名</Button><Button danger onClick={() => modal.confirm({ title: `刪除「${project.name}」？`, content: '將刪除此預排版項目的圖片、文字及進度。', okButtonProps: { danger: true }, onOk: () => action(async () => { await request(projectPath(project.id), { method: 'DELETE' }); await reload() }) })}>刪除</Button></Space>
    </article>)}</div> : <Empty description="建立預排版項目，先上傳漫畫原圖" />}
    <Modal title="新建預排版項目" open={createOpen} onCancel={() => setCreateOpen(false)} okText="建立項目" confirmLoading={busy} okButtonProps={{ disabled: !images.length }} onOk={() => void action(async () => {
      const data = new FormData(); data.append('name', name); images.forEach(file => data.append('source_files', file, file.name))
      const created = await request<Project>(`${base}/projects`, { method: 'POST', body: data }); setNewProjectId(created.id); setCurrent(created); setCreateOpen(false); setImages([]); setName('')
    })}>
      <Input placeholder="項目名稱" value={name} onChange={e => setName(e.target.value)} />
      <p>原圖 · 已選 {images.length} 張</p><Space>
        <label className="pl-file">選擇圖片<input type="file" accept=".png,.jpg,.jpeg" multiple onChange={e => setImages(files(e.target.files))} /></label>
        <label className="pl-file">選擇資料夾<input type="file" multiple {...{ webkitdirectory: '' }} onChange={e => { const selected = files(e.target.files); setImages(selected); if (!name) setName(selected[0]?.webkitRelativePath.split('/')[0] || '') }} /></label>
      </Space><p className="pl-muted">資料夾只讀第一層；圖片與進度保存於預排版專用項目。</p>
    </Modal>
  </main>
}

function Workspace({ project: initial, promptDetection, onExit, onReadyToLeave }: { project: Project; promptDetection: boolean; onExit: () => Promise<void>; onReadyToLeave?: (handler: () => Promise<boolean>) => void }) {
  const [modal, modalContext] = Modal.useModal()
  const [notices, noticesContext] = message.useMessage()
  const [project, setProject] = useState(initial)
  const controller = useMemo(() => new EditorState(initial.id), [initial.id])
  useSyncExternalStore(callback => controller.subscribe('*', callback), () => controller.tick('*'))
  const [selection, setSelection] = useState<Selection>({ page: initial.pages[0].id, ids: [] })
  const [range, setRange] = useState<PageRange>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(`pl-review-range-${initial.id}`) || 'null')
      if (Array.isArray(saved) && saved.length === 2 && saved.every(value => Number.isInteger(value)) && saved[0] >= 1 && saved[0] <= saved[1] && saved[1] <= initial.pages.length) return [saved[0], saved[1]]
    } catch { /* Use the full range when a preference is unavailable. */ }
    return [1, initial.pages.length]
  })
  const [focus, setFocus] = useState(false)
  const [view] = useState(() => { try { return JSON.parse(localStorage.getItem(`pl-view-${initial.id}`) || '{}') } catch { return {} } })
  const [differenceStyle] = useState(differenceStylePreference)
  const [current, setCurrent] = useState(initial.pages[0].id), [zoom, setZoom] = useState<number>(Math.max(.5, Math.min(3, Number(view.zoom) || 1))), [compare, setCompare] = useState(view.compare !== false), [clean, setClean] = useState(view.clean !== false), [difference, setDifference] = useState(view.difference === true), [showMeasure, setShowMeasure] = useState(view.showMeasure !== false)
  const [differenceColor, setDifferenceColor] = useState(differenceStyle.color), [differenceOpacity, setDifferenceOpacity] = useState(differenceStyle.opacity)
  const [jump, setJump] = useState<{ id: string; version: number; y?: number } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [pendingOnly, setPendingOnly] = useState(false)
  const [availability, setAvailability] = useState<Availability | null>(null), [task, setTask] = useState<Detection | null>(null)
  const [detectOpen, setDetectOpen] = useState(promptDetection)
  const [shortcutOpen, setShortcutOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false), [groupDraft, setGroupDraft] = useState<string[]>([]), [newGroupName, setNewGroupName] = useState('')
  const [groupRevision, setGroupRevision] = useState<number | null>(null), [groupError, setGroupError] = useState('')
  const [method, setMethod] = useState('ocr_aligned'), [fontBase, setFontBase] = useState(24), [fontStep, setFontStep] = useState(2)
  const [clipboard, setClipboard] = useState<Item[]>([]), [memory, setMemory] = useState<Item | null>(null)
  const [fontReady, setFontReady] = useState(false)
  const completedDetection = useRef<string | null>(initial.detection_id)
  const refreshingDetection = useRef(false)
  const pointer = useRef<PagePointer | null>(null)
  const pointerChanged = useCallback((value: PagePointer | null) => { pointer.current = value }, [])
  useEffect(() => {
    pointer.current = null
    const invalidate = () => { pointer.current = null }
    window.addEventListener('scroll', invalidate, true)
    window.addEventListener('resize', invalidate)
    return () => { window.removeEventListener('scroll', invalidate, true); window.removeEventListener('resize', invalidate) }
  }, [zoom, compare])
  const interacting = useRef(false)
  const interactionChanged = useCallback((value: boolean) => { interacting.current = value }, [])
  useEffect(() => {
    onReadyToLeave?.(async () => !busy && !interacting.current && await controller.flush())
    return () => onReadyToLeave?.(async () => true)
  }, [busy, controller, onReadyToLeave])
  const fileInput = useRef<HTMLInputElement>(null), importKind = useRef('bt')
  const state = controller.pages.get(selection.page)
  const selected = state?.data.items.filter(item => selection.ids.includes(item._id)) || []
  const first = selected[0]
  const groupNames = (project.template?.groupList || []).map(group => group.name).filter(name => typeof name === 'string')
  const selectedGroupIds = new Set(selected.map(item => typeof item.groupId === 'number' ? item.groupId : -1))
  const selectedGroupId = selectedGroupIds.size === 1 ? [...selectedGroupIds][0] : undefined
  const hasClean = project.pages.some(page => page.clean)
  const errors = [...controller.pages.values()].map(state => state.error).filter(Boolean)
  const saving = [...controller.pages.values()].some(state => state.saving)
  useEffect(() => { try { localStorage.setItem(`pl-review-range-${initial.id}`, JSON.stringify(range)) } catch { /* Optional range preference. */ } }, [initial.id, range])
  useEffect(() => { try { localStorage.setItem(`pl-view-${initial.id}`, JSON.stringify({ zoom, compare, clean, difference, showMeasure })) } catch { /* Optional view preferences. */ } }, [initial.id, zoom, compare, clean, difference, showMeasure])
  useEffect(() => { try { localStorage.setItem('pl-difference-style', JSON.stringify({ color: differenceColor, opacity: differenceOpacity })) } catch { /* Optional browser preference. */ } }, [differenceColor, differenceOpacity])
  useEffect(() => {
    void request<Item[]>(`${base}/preferences`).then(setClipboard).catch(e => setError(e.message))
    const refresh = () => { void request<Availability>(`${base}/availability`).then(setAvailability).catch(() => {}); void request<Detection | null>(`${projectPath(initial.id)}/detections`).then(setTask).catch(() => {}) }
    refresh(); const timer = setInterval(refresh, 1000)
    const unload = (event: BeforeUnloadEvent) => { if (controller.dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', unload)
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', unload); controller.dispose() }
  }, [controller, initial.id])
  useEffect(() => {
    if (!availability?.assets.font) return
    let live = true
    setFontReady(false)
    const font = new FontFace('Prelayout CJK', `url(${base}/font?v=${encodeURIComponent(availability.font_version || '')})`)
    void font.load().then(loaded => { if (live) { document.fonts.add(loaded); setFontReady(true) } }).catch(() => setError('預覽字型載入失敗，請準備 README 指定字型。'))
    return () => { live = false; document.fonts.delete(font) }
  }, [availability?.assets.font, availability?.font_version])
  useEffect(() => {
    if (task?.state !== 'completed' || task.id === completedDetection.current || refreshingDetection.current) return
    refreshingDetection.current = true
    void (async () => {
      if (!await controller.flush()) return
      setProject(await request<Project>(projectPath(initial.id)))
      await controller.reload()
      completedDetection.current = task.id
    })().catch(e => setError(e.message)).finally(() => { refreshingDetection.current = false })
  }, [task, controller, initial.id])
  async function execute(fn: () => Promise<void>) {
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function openGroupOrganizer() {
    if (!await controller.flush()) throw new Error('文字尚未保存，請先處理保存衝突')
    const fresh = await request<Project>(projectPath(project.id))
    setProject(fresh)
    setGroupDraft((fresh.template?.groupList || []).map(group => group.name))
    setGroupRevision(fresh.revision)
    setNewGroupName('')
    setGroupError('')
    setGroupOpen(true)
  }
  function appendGroup() {
    const name = newGroupName.trim()
    if (!name) { setGroupError('請輸入分組名稱'); return }
    if (groupDraft.some(value => value.trim().toLocaleLowerCase() === name.toLocaleLowerCase())) { setGroupError(`分組名稱重複：${name}`); return }
    setGroupDraft(names => [...names, name])
    setNewGroupName('')
    setGroupError('')
  }
  async function saveGroups() {
    const names = groupDraft.map(name => name.trim())
    const empty = names.findIndex(name => !name)
    if (empty >= 0) { setGroupError(`第 ${empty + 1} 個分組名稱不能為空`); return }
    const seen = new Set<string>()
    for (const name of names) {
      const key = name.toLocaleLowerCase()
      if (seen.has(key)) { setGroupError(`分組名稱重複：${name}`); return }
      seen.add(key)
    }
    if (groupRevision === null) { setGroupError('分組資料尚未載入，請關閉後重試'); return }
    setBusy(true); setGroupError('')
    try {
      const result = await request<Project>(`${projectPath(project.id)}/groups`, body({ expected_revision: groupRevision, names }, 'PUT'))
      setProject(result)
      setGroupOpen(false)
      notices.success('分組已整理')
    } catch (e) {
      setGroupError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const patch = useCallback((changes: Partial<Item>) => {
    const state = controller.pages.get(selection.page)
    if (!state) return
    controller.edit(selection.page, state.data.items.map(item => selection.ids.includes(item._id) ? { ...item, ...changes, match_status: 'manual' } : item))
  }, [controller, selection])
  const moveSelected = (axis: 'x' | 'y', value: number | null) => {
    if (value === null || !Number.isFinite(value) || !state || !first) return
    const delta = value - first[axis] * (axis === 'x' ? state.data.width : state.data.height)
    if (!delta) return
    controller.edit(selection.page, state.data.items.map(item => selection.ids.includes(item._id)
      ? moved(item, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0, state.data.width, state.data.height) : item))
  }
  const select = useCallback((value: Selection) => setSelection(value), [])
  const currentPage = useCallback((id: string) => { setCurrent(id); setSelection(value => value.ids.length ? value : { page: id, ids: [] }) }, [])
  function go(id: string) { setJump({ id, version: Date.now() }); setCurrent(id); setSelection({ page: id, ids: [] }) }
  const isReviewed = (page: Project['pages'][number]) => {
    const loaded = controller.pages.get(page.id)
    if (loaded?.dirty) return false
    if (!loaded || loaded.data.revision < page.revision) return page.reviewed_revision === page.revision
    if (loaded.data.revision > page.revision) return loaded.data.reviewed_revision === loaded.data.revision
    return page.reviewed_revision === page.revision && loaded.data.reviewed_revision === loaded.data.revision
  }
  async function setReviewed(reviewed: boolean) {
    await controller.markReviewed(current, reviewed)
    setProject(await request<Project>(projectPath(project.id)))
  }
  async function finishAndNext() {
    const number = project.pages.findIndex(page => page.id === current) + 1
    if (number >= range[0] && number <= range[1]) await controller.markReviewed(current, true)
    const fresh = await request<Project>(projectPath(project.id))
    setProject(fresh)
    const subset = fresh.pages.slice(range[0] - 1, range[1])
    const start = subset.findIndex(page => page.id === current)
    const ordered = start < 0 ? subset : [...subset.slice(start + 1), ...subset.slice(0, start + 1)]
    const pending = ordered.find(page => !isReviewed(page))
    if (pending) go(pending.id)
    else notices.success('範圍內所有頁面已完成')
  }
  function add(template?: Item, atPointer = false) {
    const position = atPointer ? pointer.current : null
    const page = project.pages.find(page => page.id === (position?.page || current)) || project.pages[0]
    void controller.load(page.id).then(state => {
      const item: Item = template ? moved({ ...structuredClone(template), _id: uid(), index: undefined }, ((position?.x ?? .5) - template.x) * page.width, ((position?.y ?? .5) - template.y) * page.height, page.width, page.height) : { _id: uid(), text: '新文字', x: position?.x ?? .5, y: position?.y ?? .5, 'font-size': 40, rotation: 0, orientation: 'vertical', color: '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 0, match_status: 'manual' }
      if (template?.xyxy_pixel) {
        const w = template.xyxy_pixel[2] - template.xyxy_pixel[0], h = template.xyxy_pixel[3] - template.xyxy_pixel[1]
        const x = item.x * page.width, y = item.y * page.height
        item.xyxy_pixel = [x - w / 2, y - h / 2, x + w / 2, y + h / 2]
      }
      controller.edit(page.id, [...state.data.items, item]); setSelection({ page: page.id, ids: [item._id] })
    }).catch(e => setError(e.message))
  }
  function duplicate() {
    if (!state || !selected.length) return
    const added = selected.map(item => ({ ...moved(item, 16, 16, state.data.width, state.data.height), _id: uid(), index: undefined }))
    controller.edit(selection.page, [...state.data.items, ...added]); setSelection(value => ({ ...value, ids: added.map(item => item._id) }))
  }
  async function nextPending() {
    const pages = project.pages.slice(range[0] - 1, range[1])
    const start = Math.max(0, pages.findIndex(page => page.id === selection.page))
    for (let offset = 0; offset < pages.length; offset++) {
      const page = pages[(start + offset) % pages.length], state = await controller.load(page.id)
      const after = offset === 0 ? state.data.items.findIndex(item => selection.ids.includes(item._id)) : -1
      const item = state.data.items.find((item, i) => i > after && ['unmatched', 'duplicate'].includes(item.match_status || ''))
      if (item) { setCurrent(page.id); setSelection({ page: page.id, ids: [item._id] }); setJump({ id: page.id, y: item.y, version: Date.now() }); return }
    }
    notices.info('沒有待處理的未匹配或重複匹配文字')
  }
  function shortcutBlocked(event: Event) {
    const editing = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="combobox"],[role="textbox"],[role="spinbutton"]')
    return busy || interacting.current || event.defaultPrevented || !!document.querySelector('.ant-modal-wrap:not([style*="display: none"])') || editing(event.target) || editing(document.activeElement)
  }
  useFrameClipboard({
    blocked: shortcutBlocked,
    selectionCount: selection.ids.length,
    selected,
    selectedPage: project.pages.find(page => page.id === selection.page),
    pointer,
    notify: value => notices.info(value),
    paste: async (capture, valid) => {
      const page = project.pages.find(page => page.id === capture.pointer.page)
      if (!page) throw new Error('找不到滑鼠所在頁面')
      const target = await controller.load(page.id)
      if (!valid()) return
      const item = pasteFrame(capture.frame, capture.pointer, page, uid, capture.text)
      controller.edit(page.id, [...target.data.items, item])
      setSelection({ page: page.id, ids: [item._id] })
    },
  })
  function adjust(adjustment: TextAdjustment, continuing = false) {
    const state = controller.pages.get(selection.page)
    if (!state || !selection.ids.length) return false
    const items = adjustedItems(state.data.items, selection.ids, adjustment, state.data.width, state.data.height)
    const group = `${JSON.stringify(adjustment)}:${selection.ids.join(',')}`
    if (items !== state.data.items) controller.edit(selection.page, items, true, group, continuing)
    return true
  }
  function fontWheel(event: WheelEvent) {
    if (shortcutBlocked(event) || !event.deltaY) return false
    return adjust({ kind: 'font', delta: event.deltaY < 0 ? 2 : -2 })
  }
  useEffect(() => {
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape' && focus && !shortcutBlocked(event)) { event.preventDefault(); setFocus(false); return }
      if (shortcutBlocked(event) || event.isComposing || event.keyCode === 229) return
      const meta = event.metaKey || event.ctrlKey
      if (meta && !event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void controller.flush(); return }
      if (meta && !event.altKey && event.key.toLowerCase() === 'z') { event.preventDefault(); controller.undo(selection.page, event.shiftKey); return }
      if (event.key === 'Escape') { setSelection(value => ({ ...value, ids: [] })); return }
      if (!meta && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'q') { event.preventDefault(); if (!event.repeat) setClean(value => !value); return }
      if (!meta && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'h' && hasClean) { event.preventDefault(); if (!event.repeat) setDifference(value => !value); return }
      if (!meta && !event.altKey && !event.shiftKey && ['PageUp', 'PageDown'].includes(event.key)) {
        event.preventDefault()
        const index = project.pages.findIndex(page => page.id === current) + (event.key === 'PageUp' ? -1 : 1)
        const page = project.pages[index]
        if (page) go(page.id)
        return
      }
      const state = controller.pages.get(selection.page)
      if (!state) return
      if (event.key === 'F1' && first) { event.preventDefault(); setMemory(structuredClone(first)); return }
      if (event.key === 'F2' && memory) { event.preventDefault(); add(memory, true); return }
      if (meta && !event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); add(undefined, true); return }
      if (meta && !event.altKey && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); return }
      if (!selection.ids.length) return
      if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); controller.edit(selection.page, state.data.items.filter(item => !selection.ids.includes(item._id))); setSelection(value => ({ ...value, ids: [] })); return }
      const adjustment = textShortcut(event)
      if (adjustment) { event.preventDefault(); adjust(adjustment, event.repeat) }
    }
    const end = () => controller.endGroup(selection.page)
    window.addEventListener('keydown', key)
    window.addEventListener('keyup', end)
    window.addEventListener('blur', end)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', end); window.removeEventListener('blur', end) }
  })
  async function importFile(list: File[]) {
    if (!list.length || !await controller.flush()) return
    const fresh = await request<Project>(projectPath(project.id))
    const form = new FormData(); form.append('kind', importKind.current); form.append('expected_revision', String(fresh.revision)); list.forEach(file => form.append('files', file, file.name))
    if (importKind.current === 'clean') {
      const result = await request<Project>(`${projectPath(project.id)}/imports`, { method: 'POST', body: form })
      await controller.reload(); setProject(result); return
    }
    const summary = await request<{ pages: number; items: number; groups: { name: string }[] }>(`${projectPath(project.id)}/imports`, { method: 'POST', body: form })
    modal.confirm({ title: '確認匯入譯稿', okText: '匯入', cancelText: '取消', content: <><p>{summary.pages} 頁，共 {summary.items} 條文字。對應頁面會替換為本次譯稿。</p><p>分組：{summary.groups.length ? summary.groups.map((group, index) => <span key={`${index}-${group.name}`}><GroupName name={group.name} index={index} />{index < summary.groups.length - 1 ? '、' : ''}</span>) : '無分組'}；所有分組均保留。</p></>, onOk: () => execute(async () => {
      form.set('apply', 'true'); const result = await request<Project>(`${projectPath(project.id)}/imports`, { method: 'POST', body: form })
      await controller.reload(); setProject(result); setSelection({ page: current, ids: [] }); setJump({ id: current, version: Date.now() })
      await Promise.all(result.pages.filter(page => page.id === current).map(page => controller.load(page.id)))
    }) })
  }
  function downloadMeo() { void execute(async () => { if (await controller.flush()) window.location.assign(`${projectPath(project.id)}/export/bt`) }) }
  const onMeasure = useCallback((index: number, pageId: string) => {
    const state = controller.pages.get(pageId)
    const measure = state?.data.measure[index], box = measure?.xyxy_pixel
    if (!state || !measure || !box || selection.page !== pageId || !selection.ids.length) { notices.info('先選取同頁文字，再點擊偵測框'); return }
    const center = measure.center_normalized || [(box[0] + box[2]) / 2 / state.data.width, (box[1] + box[3]) / 2 / state.data.height]
    const size = measure.font_size || first?.['font-size'] || 40
    patch({ x: center[0], y: center[1], xyxy_pixel: box, 'font-size': size, orientation: measure.orientation === 'horizontal' ? 'horizontal' : 'vertical', ...measureStyle(measure, size) })
  }, [controller, first, patch, selection, notices])
  const agent = usePrelayoutAgent({ controller, project, current, busy, fontReady, interacting, range, compare, difference, zoom, focus, clean,
    go, setCompare, setDifference, setZoom, setFocus, refreshProject: async () => setProject(await request<Project>(projectPath(project.id))) })
  return <main className={`pl-shell pl-workspace ${focus ? 'pl-focus-mode' : ''}`}>{modalContext}{noticesContext}{agent.review}
    <Modal title="預排版快捷鍵與滑鼠操作" open={shortcutOpen} onCancel={() => setShortcutOpen(false)} width="calc(100vw - 32px)" centered className="pl-shortcut-modal" footer={<Button onClick={() => setShortcutOpen(false)}>關閉</Button>}>
      <ShortcutHelp collapsible={false} />
    </Modal>
    <Modal title="整理分組" open={groupOpen} okText="保存" cancelText="取消" confirmLoading={busy} onCancel={() => { if (!busy) setGroupOpen(false) }} onOk={() => void saveGroups()}>
      <p className="pl-muted">可以新增或修改分組名稱。分組順序與文字的分組關聯保持不變；不能移動或刪除分組。</p>
      <div className="pl-group-editor-list">
        {groupDraft.map((name, index) => <label key={index} className="pl-group-editor-row"><span><GroupName name={name || `分組 ${index + 1}`} index={index} /></span><Input aria-label={`分組 ${index + 1} 名稱`} maxLength={80} value={name} onChange={event => { const value = event.target.value; setGroupDraft(names => names.map((current, currentIndex) => currentIndex === index ? value : current)); setGroupError('') }} /></label>)}
        {!groupDraft.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚無分組，請在下方新增" />}
      </div>
      <div className="pl-group-editor-add"><Input aria-label="新分組名稱" maxLength={80} value={newGroupName} placeholder="新分組名稱" onChange={event => { setNewGroupName(event.target.value); setGroupError('') }} onPressEnter={appendGroup} /><Button onClick={appendGroup}>新增分組</Button></div>
      {groupError && <Alert type="error" showIcon message={groupError} />}
    </Modal>
    <Modal title="圖片已匯入，是否進行 CTD 識別？" open={detectOpen} okText="開始識別" cancelText="稍後再說" confirmLoading={busy}
      okButtonProps={{ disabled: !availability?.methods[method] || !!availability?.gpu_owner || activeDetection(task) }}
      onCancel={() => { if (!busy) setDetectOpen(false) }} onOk={() => void execute(async () => {
        if (!await controller.flush()) return
        setTask(await request<Detection>(`${projectPath(project.id)}/detections`, body({ method, font_size: fontBase, step: fontStep })))
        setDetectOpen(false)
      })}>
      <p>{method === 'fixed' ? '識別整個項目的文字框，直接套用固定字級；不執行 OCR、逐字框分析或字級校準。' : '識別整個項目的文字框與字級。完成後匯入 LP.txt，會自動匹配譯文。'}</p>
      <Select aria-label="CTD 識別方式" value={method} onChange={setMethod} options={detectionMethodOptions} />
      {method === 'fixed' && <label className="pl-detection-fixed-size">固定字級<InputNumber aria-label="固定字級" value={fontBase} min={1} max={999} onChange={value => value !== null && setFontBase(value)} /></label>}
      <p>{!availability ? '正在檢查識別環境…' : !availability.methods[method] ? '尚未準備模型，可稍後再識別。' : availability.gpu_owner ? 'GPU 正忙，請稍後開始。' : '識別環境已就緒。'}</p>
      {error && <Alert type="error" message={error} />}
    </Modal>
    <header className="pl-toolbar"><div className="pl-title"><Button onClick={() => void execute(async () => { if (await controller.flush()) await onExit() })}>項目列表</Button><strong>{project.name}</strong><Tag color={errors.length ? 'red' : controller.dirty ? 'orange' : 'green'}>{saving ? '保存中' : controller.dirty ? '尚未保存' : '已保存'}</Tag></div>
      <Space wrap><Button onClick={() => setShortcutOpen(true)}>快捷鍵</Button><Button onClick={() => void execute(async () => { await controller.flush() })}>保存</Button><Button onClick={downloadMeo}>匯出 Meo.json</Button><Button href="/downloads/LabelPlus_Ps_Script_ZS-1.8.0.zip" download="LabelPlus_Ps_Script_ZS-1.8.0.zip">配套PS腳本</Button></Space>
    </header>
    <ShortcutHelp onOpen={() => setShortcutOpen(true)} />
    <div className="pl-tool-row"><Space wrap>
      {(['bt', 'labelplus', 'clean'] as const).filter((kind): boolean => kind !== 'clean' || showCleanUpload).map(kind => <Button key={kind} disabled={busy} onClick={() => { importKind.current = kind; if (fileInput.current) { fileInput.current.accept = kind === 'bt' ? '.json' : kind === 'labelplus' ? '.txt' : '.png,.jpg,.jpeg'; fileInput.current.multiple = kind === 'clean'; fileInput.current.click() } }}>{kind === 'bt' ? '開啟 Meo.json' : kind === 'labelplus' ? '匯入LP.txt' : '上傳去字圖'}</Button>)}
      <input hidden ref={fileInput} type="file" onChange={e => { const list = files(e.target.files); e.target.value = ''; void execute(() => importFile(list)) }} />
      <Button onClick={() => add()}>新增文字</Button><Button onClick={() => void execute(openGroupOrganizer)}>整理分組</Button><Button onClick={() => controller.undo(selection.page)}>撤銷</Button><Button onClick={() => controller.undo(selection.page, true)}>重做</Button>
      <Button disabled={!agent.hasReview} onClick={() => void agent.openReview().catch(e => setError(e.message))}>局部前後對比</Button>
      <Select aria-label="縮放" title="相對適合寬度的縮放比例" value={zoom} onChange={setZoom} options={[...new Set([.5, .75, 1, 1.5, 2, 3, zoom])].sort((a, b) => a - b).map(value => ({ value, label: value === 1 ? '適合寬度' : `${Math.round(value * 100)}%` }))} />
      <Checkbox checked={compare} onChange={e => setCompare(e.target.checked)}>原圖對照</Checkbox><Checkbox checked={clean} onChange={e => setClean(e.target.checked)}>去字底圖</Checkbox><Checkbox checked={difference} disabled={!hasClean} title="以自訂顏色顯示原圖與去字圖的像素差異；只在記憶體計算。快捷鍵：H" onChange={e => setDifference(e.target.checked)}>差異高亮（H）</Checkbox>
      <label className="pl-difference-setting" title="差異高亮顏色">顏色<input aria-label="差異高亮顏色" type="color" value={differenceColor} disabled={!hasClean} onChange={event => setDifferenceColor(event.target.value)} /></label>
      <label className="pl-difference-setting pl-difference-opacity" title="差異高亮透明度">透明度<input aria-label="差異高亮透明度" type="range" min="0" max="100" step="1" value={Math.round(differenceOpacity * 100)} disabled={!hasClean} onChange={event => setDifferenceOpacity(Number(event.target.value) / 100)} /><output>{Math.round(differenceOpacity * 100)}%</output></label>
      <Checkbox checked={showMeasure} onChange={e => setShowMeasure(e.target.checked)}>偵測框</Checkbox>
    </Space></div>
    {(error || errors.length > 0) && <Alert type="error" message={error || errors[0]} closable onClose={() => setError('')} />}
    <PageNavigation pages={project.pages} current={current} range={range} onRange={setRange} onGo={go} reviewed={isReviewed}
      onReview={reviewed => void execute(() => setReviewed(reviewed))} onFinishAndNext={() => void execute(finishAndNext)} busy={busy || saving} focus={focus} onFocus={setFocus} />
    <div className="pl-layout">
      <ContinuousPages project={project} controller={controller} selection={selection} onSelect={select} zoom={zoom} onZoom={setZoom} compare={compare} clean={clean} difference={difference} differenceColor={differenceColor} differenceOpacity={differenceOpacity} showMeasure={showMeasure} jump={jump} onCurrent={currentPage} onMeasure={onMeasure} onPointer={pointerChanged} onFontWheel={fontWheel} onInteractionChange={interactionChanged} />
      <aside className="pl-inspector">
        <div className="pl-inspector-title"><h2>文字編輯</h2><Tooltip title="雙擊頁面文字可原位編輯；Mac 也可用 ⌘＋單擊，並支援直排。Enter 換行；⌘／Ctrl＋Enter 完成；Esc 保存並結束編輯。"><button type="button" className="pl-help" aria-label="文字編輯說明">?</button></Tooltip></div>{state?.conflict && <Space wrap><Button onClick={() => void execute(() => controller.resolve(selection.page, true))}>保留我的草稿</Button><Button onClick={() => void execute(() => controller.resolve(selection.page, false))}>載入伺服器版</Button></Space>}
        <details open className="pl-groups-top"><summary>分組</summary><Space wrap>{groupNames.map((name, index) => <Tooltip key={`${index}-${name}`} title={selected.length ? `切換選取文字至「${name}」` : '請先選取文字'}><Button size="small" type={selectedGroupIds.size === 1 && selectedGroupId === index ? 'primary' : 'default'} disabled={!selected.length} onClick={() => patch({ groupId: index })}><GroupName name={name} index={index} /></Button></Tooltip>)}{!groupNames.length && <span className="pl-muted">尚無分組</span>}<Button size="small" onClick={() => void execute(openGroupOrganizer)}>整理分組</Button></Space></details>
        {first ? <><label>文字 {selected.length > 1 && `· 已選 ${selected.length} 條`}<Input.TextArea rows={5} value={first.text} onChange={e => patch({ text: e.target.value })} /></label>
          <div className="pl-two-fields"><label>X 位置（像素）<InputNumber aria-label="X 位置（像素）" min={0} max={state?.data.width} step={1} precision={1} value={state ? Math.round(first.x * state.data.width * 10) / 10 : 0} onChange={value => moveSelected('x', value)} /></label><label>Y 位置（像素）<InputNumber aria-label="Y 位置（像素）" min={0} max={state?.data.height} step={1} precision={1} value={state ? Math.round(first.y * state.data.height * 10) / 10 : 0} onChange={value => moveSelected('y', value)} /></label></div>
          <div className="pl-two-fields"><label>角度<InputNumber aria-label="角度" value={first.rotation} min={-180} max={180} step={1} onChange={v => v !== null && patch({ rotation: v })} /></label><label>方向<Select value={first.orientation} onChange={v => patch({ orientation: v })} options={[{ value: 'vertical', label: '直排' }, { value: 'horizontal', label: '橫排' }]} /></label></div>
          <div className="pl-four-fields"><label>字級<InputNumber aria-label="字級" value={first['font-size']} min={1} max={999} onChange={v => v !== null && patch({ 'font-size': v })} /></label><label>文字色<input aria-label="文字色" type="color" value={color(first.color)} onChange={e => patch({ color: e.target.value })} /></label><label>描邊粗細<InputNumber aria-label="描邊粗細" min={0} max={99} value={first['stroke-weight']} onChange={v => v !== null && patch({ 'stroke-weight': v })} /></label><label>描邊色<input aria-label="描邊色" type="color" value={color(first['stroke-color'])} onChange={e => patch({ 'stroke-color': e.target.value })} /></label></div>
          <Space wrap><Button onClick={duplicate}>複製</Button><Button danger onClick={() => { if (state) controller.edit(selection.page, state.data.items.filter(item => !selection.ids.includes(item._id))); setSelection(value => ({ ...value, ids: [] })) }}>刪除</Button><Button onClick={() => void execute(async () => { const values = [...clipboard, { ...first, _id: uid() }]; await request(`${base}/preferences`, body(values, 'PUT')); setClipboard(values) })}>加入常用框</Button></Space>
        </> : <p className="pl-muted">雙擊文字可原位編輯（橫排／直排）；Mac 也可用 ⌘＋單擊。雙擊底圖新增文字；Shift 點選可多選。</p>}
        <details open><summary>本頁文字</summary><Space wrap><Checkbox checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)}>只看待處理</Checkbox><Button size="small" onClick={() => void execute(nextPending)}>下一個待處理</Button></Space><div className="pl-items-list">{state?.data.items.filter(item => !pendingOnly || ['unmatched', 'duplicate'].includes(item.match_status || '')).map((item, index) => <button key={item._id} className={selection.ids.includes(item._id) ? 'active' : ''} onClick={() => { setSelection({ page: state.data.id, ids: [item._id] }); setJump({ id: state.data.id, y: item.y, version: Date.now() }) }}><span>{index + 1}. {item.text || '空文字'}</span><small>{typeof item.groupId === 'number' && groupNames[item.groupId] ? <GroupName name={groupNames[item.groupId]} index={item.groupId} /> : typeof item.groupId === 'number' ? `未知分組 ${item.groupId + 1}` : '未分組'} · {({ auto: '自動', manual: '手動', duplicate: '待確認', unmatched: '未匹配' } as Record<string, string>)[item.match_status || ''] || '—'}</small></button>)}</div></details>
        <details><summary>常用文字框</summary>{clipboard.map(item => <div className="pl-clipboard" key={item._id}><button title="暫存此框，再用 F2 貼到指標位置" onClick={() => { setMemory(structuredClone(item)); notices.info('已暫存，將指標移到頁面後按 F2 貼上') }}>{item.text || '空文字'}</button><Button size="small" onClick={() => void execute(async () => { const next = clipboard.filter(i => i._id !== item._id); await request(`${base}/preferences`, body(next, 'PUT')); setClipboard(next) })}>移除</Button></div>)}</details>
        <details open><summary>偵測與字級</summary><p className="pl-muted">{availability?.methods[method] ? `本地模型已就緒；提交時檢查 ${availability.device === 'mps' ? 'Apple GPU（MPS）' : 'CUDA GPU'}` : '尚未準備模型；可繼續人工編輯。'}</p>
          <Select aria-label="字級計算方式" value={method} onChange={setMethod} options={detectionMethodOptions} />
          <div className="pl-two-fields"><label>{method === 'fixed' ? '固定字級' : '預設字級'}<InputNumber aria-label={method === 'fixed' ? '固定字級' : '預設字級'} value={fontBase} min={1} max={999} onChange={v => v !== null && setFontBase(v)} /></label><label>字級步長<InputNumber aria-label="字級步長" disabled={method === 'fixed'} value={fontStep} min={.1} max={100} onChange={v => v !== null && setFontStep(v)} /></label></div>
          {method === 'fixed' && <p className="pl-muted">保留文字框對齊與去字預覽；跳過 OCR、逐字框分析及字級校準。</p>}
          <Button disabled={!availability?.methods[method] || !!availability?.gpu_owner || activeDetection(task)} onClick={() => void execute(async () => { setTask(await request<Detection>(`${projectPath(project.id)}/detections`, body({ method, font_size: fontBase, step: fontStep }))) })}>{method === 'fixed' ? '生成 CTD／固定字級' : '生成 CTD／字級'}</Button>
          {task && <p>{task.state === 'measuring' && task.options?.method === 'fixed' ? '整理文字框' : ({ queued: '等候開始', validating: '檢查環境', detecting: '偵測文字', aligning: '對齊文字框', measuring: '量測字框', previewing: '生成去字預覽', calibrating: '計算字級', publishing: '保存偵測結果', completed: '偵測完成', failed: '偵測失敗', cancelling: '正在停止', cancelled: '已取消', recovery_required: '恢復任務中' } as Record<string, string>)[task.state] || task.state}{task.progress ? ` · ${task.progress.completed}／${task.progress.total} 頁` : ''} · {task.message}</p>}{activeDetection(task) && <Button danger onClick={() => void execute(async () => { setTask(await request<Detection>(`${projectPath(project.id)}/detections/cancel`, body({}))) })}>取消偵測</Button>}
          {task && <Button onClick={() => void execute(async () => {
            const response = await fetch(`${projectPath(project.id)}/detections/${task.id}/log`)
            if (!response.ok) { const error = await response.json(); throw new Error(error.detail || '無法下載日誌') }
            const url = URL.createObjectURL(await response.blob()), link = document.createElement('a')
            link.href = url; link.download = `${task.id}.log`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
          })}>下載偵測日誌</Button>}
          <Button disabled={!project.detection_id && task?.state !== 'completed'} onClick={() => void execute(async () => {
            if (!await controller.flush()) return
            const candidate = await request<{ project_revision: number; summary: { automatic: number; manual: number } }>(`${projectPath(project.id)}/matches`, body({}))
            const manual = selected.filter(item => item.match_status === 'manual').map(item => item._id)
            let includeSelected = false
            modal.confirm({ title: '套用自動匹配', okText: '套用', cancelText: '取消', content: <><p>將匹配 {candidate.summary.automatic} 條文字；保留 {candidate.summary.manual} 條人工修改。</p>{manual.length > 0 && <Checkbox onChange={e => { includeSelected = e.target.checked }}>同時重新匹配目前選取的 {manual.length} 條手動文字</Checkbox>}</>, onOk: async () => {
              if (controller.dirty) throw new Error('預覽後文字已有修改，請保存並重新預覽匹配。')
              // Load undo snapshots before publishing; the server checks the project revision atomically.
              await Promise.all(project.pages.map(page => controller.load(page.id)))
              const result = await request<Project>(`${projectPath(project.id)}/matches/apply`, body({ expected_revision: candidate.project_revision, manual: includeSelected ? { [selection.page]: manual } : {} }))
              await controller.acceptRemote(); setProject(result)
            } })
          })}>匹配譯文</Button>
        </details>
        <p className="pl-muted pl-shortcuts">方向鍵移動 · Shift 加速<br />⌘／Ctrl＋＋／－ 調字級<br />⌘／Ctrl＋[／] 旋轉<br />加 Option／Alt 可大步調整字級與角度<br />完整說明見頂部「快捷鍵」</p>
        {!fontReady && <p className="pl-muted">目前使用系統替代字型。鏡像準備固定預覽字型後，可取得一致的文字外觀。</p>}
      </aside>
    </div>
  </main>
}
