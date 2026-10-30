import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, Button, Checkbox, Empty, Input, InputNumber, Modal, Popover, Select, Space, Spin, Tag, Tooltip, message } from 'antd'
import { base, body, files, projectPath, request } from './api'
import { type Availability, type Detection, type Item, type Project, activeDetection, uid } from './types'
import { EditorState } from './editor-state'
import { ContinuousPages } from './ContinuousPages'
import { type Selection, type PagePointer, selectionPages, selectTextItem, color, moved, measureStyle } from './geometry'
import { adjustedItems, textShortcut, type TextAdjustment } from './shortcuts'
import { pasteFrame } from './frame-clipboard'
import { useFrameClipboard } from './use-frame-clipboard'
import { ShortcutHelp } from './ShortcutHelp'
import { GroupName } from './GroupName'
import { PageNavigation, type PageRange } from './PageNavigation'
import { usePrelayoutAgent } from './usePrelayoutAgent'
import { TextReplacementModal } from './TextReplacementModal'
import { QuestionRecordsModal } from './QuestionRecordsModal'
import { InlineQuestionRecord } from './InlineQuestionRecord'
import type { TextReference } from './question-references'
import { questionReferencePage, questionReferenceItem } from './question-navigation'
import bundledFontUrl from '../assets/fonts/toolbox-demibold-v2.7.ttf?url'
import { displayFontUrl } from './display-font'
import { LocalFontPicker } from './LocalFontPicker'
import { loadLocalFont } from './local-fonts'
import { getFontCatalogue, refreshFontCatalogue, subscribeFontCatalogue } from './font-catalogue'
import { groupFontChanges } from './group-fonts'
import { GroupImportModal } from './GroupImportModal'
import { downloadDiscussion, downloadMeo as downloadMeoFile } from './download-discussion'
import { ProjectExportGuard } from './export-guard'
import type { GroupImportResult } from './group-import'
import { AlignmentControls } from './AlignmentControls'
import { loadViewPreferences, saveViewPreferences } from './view-preferences'
import { ProjectLibrary } from './ProjectLibrary'
import { loadProjectView, saveProjectView } from './project-view'
import './styles.css'

const showCleanUpload = false
const detectionMethodOptions = [
  { value: 'ocr_aligned', label: 'OCR 對齊逐字計算' },
  { value: 'single_char', label: '單字框計算' },
  { value: 'fixed', label: '固定字體大小' },
]

export default function PrelayoutWorkbench({ onExit, onReadyToLeave }: { onExit: () => void; onReadyToLeave?: (handler: () => Promise<boolean>) => void }) {
  const [modal, modalContext] = Modal.useModal()
  const [projects, setProjects] = useState<Project[]>([]), [current, setCurrent] = useState<Project | null>(null)
  const [projectView, setProjectView] = useState(loadProjectView)
  const [projectQuery, setProjectQuery] = useState('')
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
  return <main className={`pl-shell pl-home${projectView === 'list' ? ' pl-home--list' : ''}`}>{modalContext}
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
    {busy ? <Spin /> : projects.length ? <ProjectLibrary projects={projects} view={projectView} query={projectQuery} onQueryChange={setProjectQuery} onViewChange={view => { setProjectView(view); saveProjectView(view) }} onOpen={setCurrent} onRename={project => {
        let next = project.name
        modal.confirm({ title: '重新命名', content: <Input defaultValue={next} onChange={e => { next = e.target.value }} />, onOk: () => action(async () => { await request(projectPath(project.id), body({ name: next }, 'PATCH')); await reload() }) })
      }} onDelete={project => modal.confirm({ title: `刪除「${project.name}」？`, content: '將刪除此預排版項目的圖片、文字及進度。', okButtonProps: { danger: true }, onOk: () => action(async () => { await request(projectPath(project.id), { method: 'DELETE' }); await reload() }) })} /> : <Empty description="建立預排版項目，先上傳漫畫原圖" />}
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
  const [view] = useState(() => loadViewPreferences(initial.id))
  const [focus, setFocus] = useState(view.focus)
  const [current, setCurrent] = useState(initial.pages[0].id), [zoom, setZoom] = useState(view.zoom), [compare, setCompare] = useState(view.compare), [clean, setClean] = useState(view.clean), [difference, setDifference] = useState(view.difference), [showText, setShowText] = useState(view.showText), [showMeasure, setShowMeasure] = useState(view.showMeasure)
  const [differenceColor, setDifferenceColor] = useState(view.differenceColor), [differenceOpacity, setDifferenceOpacity] = useState(view.differenceOpacity)
  const [jump, setJump] = useState<{ id: string; version: number; x?: number; y?: number } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [pendingOnly, setPendingOnly] = useState(false)
  const [availability, setAvailability] = useState<Availability | null>(null), [task, setTask] = useState<Detection | null>(null)
  const [detectOpen, setDetectOpen] = useState(promptDetection)
  const [shortcutOpen, setShortcutOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false), [groupDraft, setGroupDraft] = useState<string[]>([]), [newGroupName, setNewGroupName] = useState('')
  const [replacementOpen, setReplacementOpen] = useState(false)
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [questionExportPending, setQuestionExportPending] = useState(false)
  const [inlineQuestionPending, setInlineQuestionPending] = useState(false)
  const exportGuard = useMemo(() => new ProjectExportGuard(), [])
  const operationCount = useRef(0)
  const questionPendingChanged = useCallback((pending: boolean) => { exportGuard.setPending('questions', pending); setQuestionExportPending(pending) }, [exportGuard])
  const inlinePendingChanged = useCallback((pending: boolean) => { exportGuard.setPending('inline', pending); setInlineQuestionPending(pending) }, [exportGuard])
  const [questionsPage, setQuestionsPage] = useState(initial.pages[0].id)
  const [showService, setShowService] = useState(view.showService)
  const [moreToolsOpen, setMoreToolsOpen] = useState(false)
  const [detectionToolsOpen, setDetectionToolsOpen] = useState(false)
  const groupCatalogue = useSyncExternalStore(subscribeFontCatalogue, getFontCatalogue)
  const [groupCatalogueRefreshing, setGroupCatalogueRefreshing] = useState(false)
  const [groupImportOpen, setGroupImportOpen] = useState(false)
  const [groupFontApply, setGroupFontApply] = useState<Record<string, boolean>>({})
  const [groupFontLoading, setGroupFontLoading] = useState<Record<string, boolean>>({})
  const [groupFonts, setGroupFonts] = useState<Record<string, string | null>>({})
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
  const selected = showText ? state?.data.items.filter(item => selection.ids.includes(item._id)) || [] : []
  const selectedPages = selectionPages(selection)
  const allSelected = showText ? Object.entries(selectedPages).flatMap(([page, ids]) => controller.pages.get(page)?.data.items.filter(item => ids.includes(item._id)) || []) : []
  const selectedPageCount = Object.keys(selectedPages).length
  const crossPage = selectedPageCount > 1
  const mixed = (key: keyof Item) => allSelected.some(item => item[key] !== allSelected[0]?.[key])
  const first = selected[0]
  const groupNames = (project.template?.groupList || []).map(group => group.name).filter(name => typeof name === 'string')
  const selectedGroupIds = new Set(allSelected.map(item => typeof item.groupId === 'number' ? item.groupId : -1))
  const selectedGroupId = selectedGroupIds.size === 1 ? [...selectedGroupIds][0] : undefined
  const hasClean = project.pages.some(page => page.clean)
  const errors = [...controller.pages.values()].filter(state => state.error).map(state => `${project.pages.find(page => page.id === state.data.id)?.name || state.data.id}：${state.error}`)
  const saving = [...controller.pages.values()].some(state => state.saving)
  useEffect(() => { try { localStorage.setItem(`pl-review-range-${initial.id}`, JSON.stringify(range)) } catch { /* Optional range preference. */ } }, [initial.id, range])
  useEffect(() => { saveViewPreferences({ zoom, compare, clean, difference, showText, showMeasure, differenceColor, differenceOpacity, focus, showService }) }, [zoom, compare, clean, difference, showText, showMeasure, differenceColor, differenceOpacity, focus, showService])
  useEffect(() => { if (!showText) { pointer.current = null; setSelection(value => value.ids.length ? { page: value.page, ids: [] } : value) } }, [showText])
  useEffect(() => {
    void request<Item[]>(`${base}/preferences`).then(setClipboard).catch(e => setError(e.message))
    const refresh = () => { void request<Availability>(`${base}/availability`).then(setAvailability).catch(() => {}); void request<Detection | null>(`${projectPath(initial.id)}/detections`).then(setTask).catch(() => {}) }
    refresh(); const timer = setInterval(refresh, 1000)
    const unload = (event: BeforeUnloadEvent) => { if (controller.dirty) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', unload)
    return () => { clearInterval(timer); window.removeEventListener('beforeunload', unload); controller.dispose() }
  }, [controller, initial.id])
  const itemFontNames = JSON.stringify([...new Set([...controller.pages.values()].flatMap(page => page.data.items.map(item => item.font).filter(Boolean)))])
  useEffect(() => {
    for (const name of JSON.parse(itemFontNames) as string[]) void loadLocalFont(name).catch(() => {})
  }, [itemFontNames])
  const fontSource = availability ? displayFontUrl(bundledFontUrl, availability) : null
  useEffect(() => {
    setFontReady(false)
    if (!fontSource) return
    let live = true
    const font = new FontFace('Prelayout CJK', `url(${fontSource})`, { weight: '500' })
    void font.load().then(loaded => { if (live) { document.fonts.add(loaded); setFontReady(true) } }).catch(() => { if (live) setError('預覽字型載入失敗，請檢查服務的預覽字型設定。') })
    return () => { live = false; document.fonts.delete(font) }
  }, [fontSource])
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
    operationCount.current += 1; exportGuard.invalidate()
    setBusy(true); setError('')
    try { await fn() } catch (e) { setError((e as Error).message) } finally { operationCount.current -= 1; setBusy(operationCount.current > 0) }
  }
  async function openGroupOrganizer() {
    if (!await controller.flush()) throw new Error('文字尚未保存，請先處理保存衝突')
    const fresh = await request<Project>(projectPath(project.id))
    setProject(fresh)
    setGroupDraft((fresh.template?.groupList || []).map(group => group.name))
    setGroupRevision(fresh.revision)
    setGroupFonts({})
    setGroupFontApply({})
    setGroupImportOpen(false)
    setGroupFontLoading({})
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
  function setGroupFontPreset(index: number, font: string | null) {
    setGroupFonts(values => ({ ...values, [index]: font }))
    setGroupFontApply(values => ({ ...values, [index]: true }))
    setGroupError('')
  }
  function importGroups(result: GroupImportResult) {
    setGroupDraft(result.names)
    setGroupFonts(values => ({ ...values, ...result.fonts }))
    setGroupFontApply(values => ({ ...values, ...Object.fromEntries(Object.keys(result.fonts).map(key => [key, result.applyFontGroups.includes(key)])) }))
    setGroupImportOpen(false)
    setGroupError('')
  }
  async function saveGroups() {
    if (busy || groupCatalogueRefreshing || Object.values(groupFontLoading).some(Boolean)) return
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
      if (!await controller.flush()) throw new Error('文字尚未保存，請先處理保存衝突')
      const result = await request<Project>(`${projectPath(project.id)}/groups`, body({ expected_revision: groupRevision, names, fonts: groupFonts, apply_font_groups: Object.keys(groupFonts).filter(key => groupFonts[key] !== null && groupFontApply[key] !== false) }, 'PUT'))
      setProject(result)
      setGroupRevision(result.revision)
      setGroupFonts({})
      setGroupFontApply({})
      await controller.acceptTextReplacement(result)
      setGroupOpen(false)
      notices.success('分組已整理')
    } catch (e) {
      setGroupError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const patch = useCallback((changes: Partial<Item>) => {
    if (!showText) return
    changes = groupFontChanges(changes, project.template?.groupList || [])
    const local = Object.keys(changes).some(key => ['text', 'x', 'y', 'xyxy_pixel'].includes(key))
    const pages = local ? { [selection.page]: selection.ids } : selectionPages(selection)
    const updates = new Map<string, Item[]>()
    for (const [page, ids] of Object.entries(pages)) {
      const state = controller.pages.get(page)
      if (!state) continue
      const items = state.data.items.map(item => ids.includes(item._id) && Object.entries(changes).some(([key, value]) => item[key] !== value) ? { ...item, ...changes, match_status: 'manual' as const } : item)
      if (items.some((item, index) => item !== state.data.items[index])) updates.set(page, items)
    }
    controller.editBatch(updates)
  }, [controller, selection, showText, project.template?.groupList])
  const moveSelected = (axis: 'x' | 'y', value: number | null) => {
    if (value === null || !Number.isFinite(value) || !state || !first) return
    const delta = value - first[axis] * (axis === 'x' ? state.data.width : state.data.height)
    if (!delta) return
    controller.edit(selection.page, state.data.items.map(item => selection.ids.includes(item._id)
      ? moved(item, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0, state.data.width, state.data.height) : item))
  }
  const questionNavigation = useRef(0)
  useEffect(() => () => { questionNavigation.current += 1 }, [])
  async function navigateQuestion(reference: TextReference) {
    const generation = ++questionNavigation.current
    controller.finishTextDraft()
    const page = questionReferencePage(project.pages, reference)
    const loaded = await controller.load(page.id)
    if (generation !== questionNavigation.current) return
    const item = questionReferenceItem(loaded.data.items, reference)
    setShowText(true)
    setCurrent(page.id)
    setSelection({ page: page.id, ids: [item._id] })
    setJump({ id: page.id, x: item.x, y: item.y, version: performance.now() })
  }
  const select = useCallback((value: Selection) => setSelection(value), [])
  const currentPage = useCallback((id: string) => { setCurrent(id); setSelection(value => value.ids.length ? value : { page: id, ids: [] }) }, [])
  function go(id: string) { setJump({ id, version: Date.now() }); setCurrent(id); setSelection(value => value.ids.length ? value : { page: id, ids: [] }) }
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
    controller.edit(selection.page, [...state.data.items, ...added]); setSelection({ page: selection.page, ids: added.map(item => item._id) })
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
    blocked: event => !showText || shortcutBlocked(event),
    selectionCount: allSelected.length,
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
    if (!showText) return false
    if (!selection.ids.length) return false
    const pages = adjustment.kind === 'move' ? { [selection.page]: selection.ids } : selectionPages(selection)
    const updates = new Map<string, Item[]>()
    for (const [page, ids] of Object.entries(pages)) {
      const state = controller.pages.get(page)
      if (!state) continue
      const items = adjustedItems(state.data.items, ids, adjustment, state.data.width, state.data.height)
      if (items !== state.data.items) updates.set(page, items)
    }
    if (Object.keys(pages).length > 1) controller.editBatch(updates)
    else for (const [page, items] of updates) {
      const group = `${JSON.stringify(adjustment)}:${selection.ids.join(',')}`
      controller.edit(page, items, true, group, continuing)
    }
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
      if (event.key === 'Escape') { setSelection(value => ({ page: value.page, ids: [] })); return }
      if (!meta && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'q') { event.preventDefault(); if (!event.repeat) setClean(value => !value); return }
      if (!meta && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'h' && hasClean) { event.preventDefault(); if (!event.repeat) setDifference(value => !value); return }
      if (!meta && !event.altKey && !event.shiftKey && ['PageUp', 'PageDown'].includes(event.key)) {
        event.preventDefault()
        const index = project.pages.findIndex(page => page.id === current) + (event.key === 'PageUp' ? -1 : 1)
        const page = project.pages[index]
        if (page) go(page.id)
        return
      }
      if (!showText) return
      const state = controller.pages.get(selection.page)
      if (!state) return
      if (event.key === 'F1' && first) { event.preventDefault(); setMemory(structuredClone(first)); return }
      if (event.key === 'F2' && memory) { event.preventDefault(); add(memory, true); return }
      if (meta && !event.altKey && event.key.toLowerCase() === 'n') { event.preventDefault(); add(undefined, true); return }
      if (meta && !event.altKey && event.key.toLowerCase() === 'd') { event.preventDefault(); duplicate(); return }
      if (!selection.ids.length) return
      if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); controller.edit(selection.page, state.data.items.filter(item => !selection.ids.includes(item._id))); setSelection(value => ({ page: value.page, ids: [] })); return }
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
    modal.confirm({ title: '確認匯入譯稿', okText: '匯入', cancelText: '取消', content: <><p>{summary.pages} 頁，共 {summary.items} 條文字。對應頁面會替換為本次譯稿。</p><p>來源已有的原文、概括與註釋會保留；同頁同編號文本缺少的附加資訊沿用既有內容。來源明確填寫的內容優先。</p><p>分組：{summary.groups.length ? summary.groups.map((group, index) => <span key={`${index}-${group.name}`}><GroupName name={group.name} index={index} />{index < summary.groups.length - 1 ? '、' : ''}</span>) : '無分組'}；所有分組均保留。</p></>, onOk: () => execute(async () => {
      form.set('apply', 'true'); const result = await request<Project>(`${projectPath(project.id)}/imports`, { method: 'POST', body: form })
      await controller.reload(); setProject(result); setSelection({ page: current, ids: [] }); setJump({ id: current, version: Date.now() })
      await Promise.all(result.pages.filter(page => page.id === current).map(page => controller.load(page.id)))
    }) })
  }
  function exportProject(markdown: boolean) {
    if (operationCount.current || busy || activeDetection(task)) return
    void execute(() => markdown ? downloadDiscussion(project, () => controller.flush(), exportGuard) : downloadMeoFile(project, () => controller.flush(), exportGuard))
  }
  const onMeasure = useCallback((index: number, pageId: string) => {
    const state = controller.pages.get(pageId)
    const measure = state?.data.measure[index], box = measure?.xyxy_pixel
    if (!state || !measure || !box || selection.page !== pageId || !selection.ids.length) { notices.info('先選取同頁文字，再點擊偵測框'); return }
    const center = measure.center_normalized || [(box[0] + box[2]) / 2 / state.data.width, (box[1] + box[3]) / 2 / state.data.height]
    const size = measure.font_size || first?.['font-size'] || 40
    patch({ x: center[0], y: center[1], xyxy_pixel: box, 'font-size': size, orientation: measure.orientation === 'horizontal' ? 'horizontal' : 'vertical', ...measureStyle(measure, size) })
  }, [controller, first, patch, selection, notices])
  const agent = usePrelayoutAgent({ controller, project, current, busy, fontReady, interacting, range, compare, difference, showText, differenceColor, differenceOpacity, zoom, focus, clean,
    go, setCompare, setClean, setDifference, setShowText, setDifferenceColor, setDifferenceOpacity, setZoom, setFocus, refreshProject: async () => setProject(await request<Project>(projectPath(project.id))) })
  return <main className={`pl-shell pl-workspace pl-compact-workspace ${showService ? 'pl-show-service' : ''} ${focus ? 'pl-focus-mode' : ''}`}>{modalContext}{noticesContext}{agent.review}
    <TextReplacementModal open={replacementOpen} project={project} controller={controller} onClose={() => setReplacementOpen(false)}
      onBusyChange={setBusy} onProject={setProject} onReviewPage={go} />
    <QuestionRecordsModal onExportPendingChange={questionPendingChanged} currentPageId={questionsPage} open={questionsOpen} project={project} controller={controller} onClose={() => setQuestionsOpen(false)} />
    <Modal title="預排版快捷鍵與滑鼠操作" open={shortcutOpen} onCancel={() => setShortcutOpen(false)} width="calc(100vw - 32px)" centered className="pl-shortcut-modal" footer={<Button onClick={() => setShortcutOpen(false)}>關閉</Button>}>
      <ShortcutHelp collapsible={false} />
    </Modal>
    <GroupImportModal open={groupImportOpen} currentProjectId={project.id} currentGroups={groupDraft.map((name, index) => ({ name, ...(Object.hasOwn(groupFonts, String(index)) ? groupFonts[index] ? { font: groupFonts[index]! } : {} : project.template?.groupList?.[index]?.font ? { font: project.template.groupList[index].font } : {}) }))} onClose={() => setGroupImportOpen(false)} onImport={importGroups} />
    <Modal title="整理分組" width="min(1120px, calc(100vw - 32px))" className="pl-group-organizer" open={groupOpen} okButtonProps={{ disabled: groupCatalogueRefreshing || Object.values(groupFontLoading).some(Boolean) }} okText="保存" cancelText="取消" confirmLoading={busy} onCancel={() => { if (!busy) setGroupOpen(false) }} onOk={() => void saveGroups()}>
      <div className="pl-group-toolbar"><Button size="small" disabled={busy || groupCatalogueRefreshing || Object.values(groupFontLoading).some(Boolean)} onClick={() => setGroupImportOpen(true)}>匯入其他項目分組</Button><Button size="small" loading={groupCatalogueRefreshing} disabled={busy || Object.values(groupFontLoading).some(Boolean)} onClick={() => {
        setGroupCatalogueRefreshing(true); setGroupError('')
        void refreshFontCatalogue().catch(error => setGroupError(error instanceof Error ? error.message : '字體列表更新失敗')).finally(() => setGroupCatalogueRefreshing(false))
      }}>{groupCatalogue.updatedAt ? '更新字體列表' : '讀取字體列表'}</Button><span>{groupCatalogue.updatedAt ? `${groupCatalogue.fonts.length} 款字體 · 已快取` : '尚未讀取字體'}</span></div>
      <p className="pl-group-hint">設定字體後保存，套用到該組全部頁面；之後仍可單獨改字體。全組套用無法整批撤銷。</p>
      <div className="pl-group-table"><div className="pl-group-grid-row pl-group-table-head"><span>分組名稱</span><div className="pl-local-font-fields"><span>字體</span><span>字重</span></div><span>操作</span></div>
      <div className="pl-group-editor-list">
        {groupDraft.map((name, index) => {
          const font = Object.hasOwn(groupFonts, String(index)) ? groupFonts[index] : project.template?.groupList?.[index]?.font
          return <div key={index} className="pl-group-grid-row pl-group-editor-entry"><div className="pl-group-name-cell"><label><GroupName name="" index={index} /><Input size="small" aria-label={`分組 ${index + 1} 名稱`} maxLength={80} disabled={busy} value={name} onChange={event => { const value = event.target.value; setGroupDraft(names => names.map((current, currentIndex) => currentIndex === index ? value : current)); setGroupError('') }} /></label>{Object.hasOwn(groupFonts, String(index)) && <small>{font && groupFontApply[index] !== false ? '待統一全組字體' : '待保存預設'}</small>}</div>
            <LocalFontPicker compact disabled={busy || groupCatalogueRefreshing} onLoadingChange={loading => setGroupFontLoading(values => values[index] === loading ? values : { ...values, [index]: loading })} value={font} values={[font]} mixed={false} selectionKey={`group-${index}-${groupRevision}-${groupOpen}`} onChange={font => setGroupFontPreset(index, font)} />
            <Button size="small" title="保存後統一此分組全部頁面的字體，包含個別修改的文字。" disabled={busy || !font} onClick={() => setGroupFontPreset(index, font || null)}>統一全組字體</Button>
          </div>
        })}
        {!groupDraft.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚無分組，請在下方新增" />}
      </div></div>
      <div className="pl-group-editor-add"><Input disabled={busy} aria-label="新分組名稱" maxLength={80} value={newGroupName} placeholder="新分組名稱" onChange={event => { setNewGroupName(event.target.value); setGroupError('') }} onPressEnter={appendGroup} /><Button disabled={busy} onClick={appendGroup}>新增分組</Button></div>
      {groupError && <Alert type="error" showIcon message={groupError} />}
    </Modal>
    <Modal title="偵測與字級" open={detectionToolsOpen} width={520} onCancel={() => { if (!busy) setDetectionToolsOpen(false) }} closable={!busy}
      footer={<Button disabled={busy} onClick={() => setDetectionToolsOpen(false)}>關閉</Button>}>
      <div className="pl-detection-tools"><p className="pl-muted">{availability?.methods[method] ? `本地模型已就緒；提交時檢查 ${availability.device === 'mps' ? 'Apple GPU（MPS）' : 'CUDA GPU'}` : '尚未準備模型；可繼續人工編輯。'}</p>
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
        {error && <Alert type="error" showIcon message={error} />}
      </div>
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
    <header className="pl-toolbar"><div className="pl-title"><Button size="small" onClick={() => void execute(async () => { if (await controller.flush()) await onExit() })}>項目列表</Button><strong title={project.name}>{project.name}</strong><Tag color={errors.length ? 'red' : controller.dirty ? 'orange' : 'green'}>{saving ? '保存中' : controller.dirty ? '尚未保存' : '已保存'}</Tag></div>
      <Space size={4} wrap>
        <Popover open={moreToolsOpen} onOpenChange={setMoreToolsOpen} trigger="click" placement="bottomRight" title="匯入與準備" content={<div className="pl-more-tools"><Space size={4} wrap>
            {(['bt', 'labelplus', 'clean'] as const).filter((kind): boolean => kind !== 'clean' || showCleanUpload).map(kind => <Button size="small" key={kind} disabled={busy} onClick={() => { importKind.current = kind; if (fileInput.current) { fileInput.current.accept = kind === 'bt' ? '.json' : kind === 'labelplus' ? '.txt' : '.png,.jpg,.jpeg'; fileInput.current.multiple = kind === 'clean'; fileInput.current.click() } }}>{kind === 'bt' ? '開啟 Meo.json' : kind === 'labelplus' ? '匯入LP.txt' : '上傳去字圖'}</Button>)}
            <Button size="small" disabled={busy || questionExportPending || inlineQuestionPending || activeDetection(task)} onClick={() => { setMoreToolsOpen(false); exportProject(false) }}>匯出 Meo.json</Button>
            <Button size="small" onClick={() => { setMoreToolsOpen(false); setDetectionToolsOpen(true) }}>偵測與字級</Button>
            <Button size="small" href="/downloads/LabelPlus_Ps_Script_ZS-1.8.0.zip" download="LabelPlus_Ps_Script_ZS-1.8.0.zip">配套PS腳本</Button>
        </Space></div>}><Button size="small">匯入與準備 ▾{activeDetection(task) ? ' · 偵測中' : ''}</Button></Popover>
        <Button size="small" onClick={() => void execute(async () => { await controller.flush() })}>保存</Button>
        <Button size="small" onClick={() => setShortcutOpen(true)}>快捷鍵</Button>
        <Checkbox checked={showService} onChange={e => setShowService(e.target.checked)}>服務狀態</Checkbox>
      </Space>
    </header>
    <div className="pl-tool-row pl-edit-tools"><span className="pl-tool-label">編輯</span><Space size={[6, 4]} wrap>
      <input hidden ref={fileInput} type="file" onChange={e => { const list = files(e.target.files); e.target.value = ''; void execute(() => importFile(list)) }} />
      <Button size="small" disabled={!showText} onClick={() => add()}>新增文字</Button>
      <Button size="small" onClick={() => controller.undo(selection.page)}>撤銷</Button><Button size="small" onClick={() => controller.undo(selection.page, true)}>重做</Button>
            <Button size="small" onClick={() => void execute(openGroupOrganizer)}>整理分組</Button>
            <Button size="small" disabled={busy || saving || activeDetection(task)} onClick={() => void execute(async () => {
              if (!await controller.flush()) throw new Error('文字尚未保存，請先處理保存錯誤或版本衝突。')
              setReplacementOpen(true)
            })}>批量替換</Button>
      <Button size="small" disabled={busy || activeDetection(task)} title="查看、新增與修改疑問記錄" onClick={() => { setQuestionsPage(current); setQuestionsOpen(true) }}>疑問記錄</Button>
      <Button size="small" disabled={busy || questionExportPending || inlineQuestionPending || activeDetection(task)} title={inlineQuestionPending ? '疑問保存結果尚未確認，請先在右側重試保存' : questionExportPending ? '疑問保存結果尚未確認，請先在疑問記錄中重試保存' : '下載 Markdown：疑問置前，附逐頁全文、原文、註解與概括'} onClick={() => exportProject(true)}>導出疑問記錄</Button>
    </Space></div>
    <div className="pl-tool-row pl-display-tools"><span className="pl-tool-label">顯示</span><Space size={[8, 4]} wrap>
      <Select size="small" aria-label="縮放" title="相對適合寬度的縮放比例" value={zoom} onChange={setZoom} options={[...new Set([.5, .75, 1, 1.5, 2, 3, zoom])].sort((a, b) => a - b).map(value => ({ value, label: value === 1 ? '適合寬度' : `${Math.round(value * 100)}%` }))} />
      <Checkbox checked={compare} onChange={e => setCompare(e.target.checked)}>原圖對照</Checkbox><Checkbox checked={clean} onChange={e => setClean(e.target.checked)}>去字底圖</Checkbox><Checkbox checked={showText} onChange={e => setShowText(e.target.checked)}>顯示譯文</Checkbox>
            <Button size="small" disabled={!agent.hasReview} onClick={() => void agent.openReview().catch(e => setError(e.message))}>局部前後對比</Button>
            <Checkbox checked={showMeasure} onChange={e => setShowMeasure(e.target.checked)}>偵測框</Checkbox>
            <Checkbox checked={difference} disabled={!hasClean} title="以自訂顏色顯示原圖與去字圖的像素差異；只在記憶體計算。快捷鍵：H" onChange={e => setDifference(e.target.checked)}>差異高亮（H）</Checkbox>
            <label className="pl-difference-setting" title="差異高亮顏色">顏色<input aria-label="差異高亮顏色" type="color" value={differenceColor} disabled={!hasClean} onChange={event => setDifferenceColor(event.target.value)} /></label>
            <label className="pl-difference-setting pl-difference-opacity" title="差異高亮透明度">透明度<input aria-label="差異高亮透明度" type="range" min="0" max="100" step="1" value={Math.round(differenceOpacity * 100)} disabled={!hasClean} onChange={event => setDifferenceOpacity(Number(event.target.value) / 100)} /><output>{Math.round(differenceOpacity * 100)}%</output></label>
    </Space></div>
    {(error || errors.length > 0) && <Alert type="error" message={error || errors[0]} closable onClose={() => setError('')} />}
    <PageNavigation pages={project.pages} current={current} range={range} onRange={setRange} onGo={go} reviewed={isReviewed}
      onReview={reviewed => void execute(() => setReviewed(reviewed))} onFinishAndNext={() => void execute(finishAndNext)} busy={busy || saving} focus={focus} onFocus={setFocus} />
    <div className="pl-layout">
      <ContinuousPages project={project} controller={controller} selection={selection} onSelect={select} onAdjust={adjust} zoom={zoom} onZoom={setZoom} compare={compare} clean={clean} difference={difference} differenceColor={differenceColor} differenceOpacity={differenceOpacity} showText={showText} showMeasure={showMeasure} jump={jump} onCurrent={currentPage} onMeasure={onMeasure} onPointer={pointerChanged} onFontWheel={fontWheel} onInteractionChange={interactionChanged} />
      <aside className="pl-inspector" aria-label="文字編輯">
        <div className="pl-inspector-title"><h2>文字編輯</h2><Tooltip title="雙擊頁面文字可原位編輯；Mac 也可用 ⌘＋單擊，並支援直排。Enter 換行；⌘／Ctrl＋Enter 完成；Esc 保存並結束編輯。"><button type="button" className="pl-help" aria-label="文字編輯說明">?</button></Tooltip></div>{state?.conflict && <Space wrap><Button onClick={() => void execute(() => controller.resolve(selection.page, true))}>保留我的草稿</Button><Button onClick={() => void execute(() => controller.resolve(selection.page, false))}>載入伺服器版</Button></Space>}
        {allSelected.length > 0 && <div className="pl-selection-summary"><span>已選 {selectedPageCount} 頁 · {allSelected.length} 框</span><Button size="small" onClick={() => setSelection({ page: current, ids: [] })}>清除</Button>{crossPage && <small>樣式與分組套用全部；文字、位置、拖曳、複製及刪除僅作用於第 {project.pages.findIndex(page => page.id === selection.page) + 1} 頁所選框。</small>}</div>}
        <details open className="pl-groups-top"><summary>分組</summary><Space wrap>{groupNames.map((name, index) => <Tooltip key={`${index}-${name}`} title={selected.length ? `切換選取文字至「${name}」` : '請先選取文字'}><Button size="small" type={selectedGroupIds.size === 1 && selectedGroupId === index ? 'primary' : 'default'} disabled={!selected.length} onClick={() => patch({ groupId: index })}><GroupName name={name} index={index} /></Button></Tooltip>)}{!groupNames.length && <span className="pl-muted">尚無分組</span>}<Button size="small" onClick={() => void execute(openGroupOrganizer)}>整理分組</Button></Space></details>
        {first ? <><label>文字 {selected.length > 1 && `· 本頁已選 ${selected.length} 條`}<Input.TextArea autoSize={{ minRows: 3, maxRows: 7 }} value={first.text} onChange={e => patch({ text: e.target.value })} /></label>
          <div className="pl-two-fields"><label>X 位置（像素）<InputNumber aria-label="X 位置（像素）" min={0} max={state?.data.width} step={1} precision={1} value={state ? Math.round(first.x * state.data.width * 10) / 10 : 0} onChange={value => moveSelected('x', value)} /></label><label>Y 位置（像素）<InputNumber aria-label="Y 位置（像素）" min={0} max={state?.data.height} step={1} precision={1} value={state ? Math.round(first.y * state.data.height * 10) / 10 : 0} onChange={value => moveSelected('y', value)} /></label></div>
          <AlignmentControls controller={controller} selection={selection} pageLabel={`第 ${project.pages.findIndex(page => page.id === selection.page) + 1} 頁`} disabled={busy || !showText} onApplied={() => exportGuard.invalidate()} />
          <div className="pl-two-fields"><label>角度<InputNumber aria-label="角度" value={mixed('rotation') ? null : first.rotation} placeholder="混合" min={-180} max={180} step={1} onChange={v => v !== null && patch({ rotation: v })} /></label><label>方向<Select value={mixed('orientation') ? undefined : first.orientation} placeholder="混合" onChange={v => patch({ orientation: v })} options={[{ value: 'vertical', label: '直排' }, { value: 'horizontal', label: '橫排' }]} /></label></div>
          <LocalFontPicker value={first.font} values={allSelected.map(item => item.font)} mixed={mixed('font')} selectionKey={allSelected.map(item => item._id).join(',')} onChange={font => patch({ font })} />
          <div className="pl-four-fields"><label>字級<InputNumber aria-label="字級" value={mixed('font-size') ? null : first['font-size']} placeholder="混合" min={1} max={999} onChange={v => v !== null && patch({ 'font-size': v })} /></label><label>文字色{mixed('color') && '（混合）'}<input aria-label="文字色" type="color" value={color(first.color)} onChange={e => patch({ color: e.target.value })} /></label><label>描邊粗細<InputNumber aria-label="描邊粗細" min={0} max={99} value={mixed('stroke-weight') ? null : first['stroke-weight']} placeholder="混合" onChange={v => v !== null && patch({ 'stroke-weight': v })} /></label><label>描邊色{mixed('stroke-color') && '（混合）'}<input aria-label="描邊色" type="color" value={color(first['stroke-color'])} onChange={e => patch({ 'stroke-color': e.target.value })} /></label></div>
          <Space wrap><Button onClick={duplicate}>複製</Button><Button danger onClick={() => { if (state) controller.edit(selection.page, state.data.items.filter(item => !selection.ids.includes(item._id))); setSelection(value => ({ page: value.page, ids: [] })) }}>刪除</Button><Button onClick={() => void execute(async () => { const values = [...clipboard, { ...first, _id: uid() }]; await request(`${base}/preferences`, body(values, 'PUT')); setClipboard(values) })}>加入常用框</Button></Space>
        </> : <p className="pl-muted">雙擊文字可原位編輯（橫排／直排）；Mac 也可用 ⌘＋單擊。雙擊底圖新增文字；Shift 點選可跨頁多選，再點一次取消該框。</p>}
        <details open><summary>本頁文字</summary><Space wrap><Checkbox checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)}>只看待處理</Checkbox><Button size="small" onClick={() => void execute(nextPending)}>下一個待處理</Button></Space><div className="pl-items-list">{state?.data.items.filter(item => !pendingOnly || ['unmatched', 'duplicate'].includes(item.match_status || '')).map((item, index) => <button key={item._id} className={selection.ids.includes(item._id) ? 'active' : ''} onClick={event => { setSelection(value => selectTextItem(value, state.data.id, item._id, event.shiftKey)); setJump({ id: state.data.id, y: item.y, version: Date.now() }) }}><span>{index + 1}. {item.text || '空文字'}</span><small>{typeof item.groupId === 'number' && groupNames[item.groupId] ? <GroupName name={groupNames[item.groupId]} index={item.groupId} /> : typeof item.groupId === 'number' ? `未知分組 ${item.groupId + 1}` : '未分組'} · {({ auto: '自動', manual: '手動', duplicate: '待確認', unmatched: '未匹配' } as Record<string, string>)[item.match_status || ''] || '—'}</small></button>)}</div></details>
        <details><summary>常用文字框</summary>{clipboard.map(item => <div className="pl-clipboard" key={item._id}><button title="暫存此框，再用 F2 貼到指標位置" onClick={() => { setMemory(structuredClone(item)); notices.info('已暫存，將指標移到頁面後按 F2 貼上') }}>{item.text || '空文字'}</button><Button size="small" onClick={() => void execute(async () => { const next = clipboard.filter(i => i._id !== item._id); await request(`${base}/preferences`, body(next, 'PUT')); setClipboard(next) })}>移除</Button></div>)}</details>

        {!fontReady && <p className="pl-muted">預覽字型尚未載入，目前暫用系統字型。</p>}
      </aside>
      <aside className="pl-inspector pl-question-inspector" aria-label="疑問記錄">
        <InlineQuestionRecord refreshKey={questionsOpen} onNavigate={navigateQuestion} onExportPendingChange={inlinePendingChanged} project={project} controller={controller} selection={selection} onSaved={saved => {
          setSelection(current => JSON.stringify(selectionPages(current)) === JSON.stringify(selectionPages(saved)) ? { page: current.page, ids: [] } : current)
          notices.success('已添加疑問記錄')
        }} />
      </aside>
    </div>
  </main>
}
