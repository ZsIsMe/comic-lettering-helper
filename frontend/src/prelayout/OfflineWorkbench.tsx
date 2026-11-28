import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react'
import { Alert, Button, Checkbox, ConfigProvider, Input, InputNumber, Modal, Select, Space, Tag, theme as antdTheme } from 'antd'
import { EditorState } from './editor-state'
import { loadOfflineProject, type OfflineProject } from './offline-data'
import { ContinuousPages } from './ContinuousPages'
import { PageNavigation, type PageRange } from './PageNavigation'
import { LocalFontPicker } from './LocalFontPicker'
import { loadLocalFont } from './local-fonts'
import { groupFontChanges } from './group-fonts'
import { AlignmentControls } from './AlignmentControls'
import { LineBreakControls } from './LineBreakControls'
import { ShortcutHelp } from './ShortcutHelp'
import { OfflineQuestions } from './OfflineQuestions'
import { GroupName } from './GroupName'
import { color, moved, selectTextItem, selectionIds, selectionPages, type PagePointer, type Selection } from './geometry'
import { adjustedItems, textShortcut, type TextAdjustment } from './shortcuts'
import { pasteFrame, copyFrame, readFrame, storeFrame, type FramePaste } from './frame-clipboard'
import { useFrameClipboard } from './use-frame-clipboard'
import { loadPrelayoutTheme, savePrelayoutTheme, loadViewPreferences, saveViewPreferences } from './view-preferences'
import { uid, type Group, type Item, type Page, type Project } from './types'
import type { TextReference } from './question-references'
import type { LineBreakPreview } from './line-breaks'
import './styles.css'
import './offline.css'

// Structural types keep the picker optional on browsers without the File System Access API.
type FileHandle = { kind: 'file'; name: string; getFile(): Promise<File>; createWritable(): Promise<{ write(data: Blob): Promise<void>; close(): Promise<void>; abort?(): Promise<void> }> }
type DirectoryHandle = { kind: 'directory'; name: string; getFileHandle(name: string): Promise<FileHandle>; getDirectoryHandle(name: string): Promise<DirectoryHandle> }
type PickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode: 'readwrite' }) => Promise<DirectoryHandle>
  showOpenFilePicker?: (options: { multiple: boolean; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandle[]>
  showSaveFilePicker?: (options: { suggestedName: string; types: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileHandle>
}
const jsonTypes = [{ description: 'Meo JSON', accept: { 'application/json': ['.json'] } }]
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
const cancelled = (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
const inputTarget = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable="true"],.ant-select,.ant-modal')

const fileStamps = new WeakMap<FileHandle, { lastModified: number; size: number }>()
async function snapshotFile(handle: FileHandle) {
  const file = await handle.getFile()
  fileStamps.set(handle, { lastModified: file.lastModified, size: file.size })
  return file
}
async function directoryFiles(directory: DirectoryHandle) {
  const files: File[] = []
  const manifestHandle = await directory.getFileHandle('project.json')
  const manifestFile = await manifestHandle.getFile()
  let manifest: { pages?: { original?: unknown; overlay?: unknown; clean?: unknown }[] }
  try { manifest = JSON.parse(await manifestFile.text()) }
  catch { throw new Error('project.json 不是有效的 JSON。') }
  if (!manifest || !Array.isArray(manifest.pages)) throw new Error('請選擇解壓後、包含 project.json 的項目資料夾。')
  const paths = new Set(['project.json', 'Meo.json', ...manifest.pages.flatMap(page => [page?.original, page?.overlay, page?.clean].filter((value): value is string => typeof value === 'string'))])
  let meoHandle: FileHandle | undefined
  for (const path of paths) {
    const segments = path.split('/')
    if (segments.some(value => !value || value === '.' || value === '..' || value.includes('\\') || Array.from(value).some(char => char.charCodeAt(0) < 32))) throw new Error('project.json 包含無效的檔案路徑。')
    let parent = directory
    for (const segment of segments.slice(0, -1)) parent = await parent.getDirectoryHandle(segment)
    const handle = await parent.getFileHandle(segments.at(-1)!)
    const file = path === 'Meo.json' ? await snapshotFile(handle) : await handle.getFile()
    if (path === 'Meo.json') meoHandle = handle
    Object.defineProperty(file, 'webkitRelativePath', { value: `${directory.name}/${path}` })
    files.push(file)
  }
  return { files, handle: meoHandle }
}
function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob), anchor = document.createElement('a')
  anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

export default function OfflineWorkbench() {
  const [session, setSession] = useState<OfflineProject | null>(null)
  const [fileHandle, setFileHandle] = useState<FileHandle | undefined>()
  const [generation, setGeneration] = useState(0)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [theme, setTheme] = useState(loadPrelayoutTheme)
  const dirty = useRef<() => boolean>(() => false), directoryInput = useRef<HTMLInputElement>(null), meoInput = useRef<HTMLInputElement>(null)
  const updateDirty = useCallback((read: () => boolean) => { dirty.current = read }, [])
  const currentSession = useRef(session); currentSession.current = session
  useEffect(() => () => currentSession.current?.dispose(), [])
  const canReplace = () => !dirty.current() || window.confirm('尚有未保存的修改。確定放棄並重新開啟？')
  const execute = async (operation: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await operation() } catch (e) { if (!cancelled(e)) setError(errorMessage(e)) }
    finally { setBusy(false) }
  }
  const openFiles = async (files: File[], handle?: FileHandle) => {
    const next = await loadOfflineProject(files)
    session?.dispose(); setSession(next); setFileHandle(handle); setGeneration(value => value + 1)
  }
  const openDirectory = () => {
    if (!canReplace()) return
    const picker = (window as PickerWindow).showDirectoryPicker
    if (!picker) { directoryInput.current?.click(); return }
    void execute(async () => {
      let directory: DirectoryHandle
      try { directory = await picker.call(window, { mode: 'readwrite' }) }
      catch (error) {
        if (cancelled(error)) return
        directoryInput.current?.click(); return
      }
      const selected = await directoryFiles(directory)
      await openFiles(selected.files, selected.handle)
    })
  }
  const replaceMeo = () => {
    if (!session || !canReplace()) return
    const picker = (window as PickerWindow).showOpenFilePicker
    if (!picker) { meoInput.current?.click(); return }
    void execute(async () => {
      const [handle] = await picker.call(window, { multiple: false, types: jsonTypes })
      await session.replaceMeo(await snapshotFile(handle)); setFileHandle(handle); setGeneration(value => value + 1)
    })
  }
  return <ConfigProvider theme={{ algorithm: theme === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm }}>
    <div className="pl-shell pl-theme pl-offline" data-theme={theme}>
      <input ref={directoryInput} hidden type="file" multiple {...{ webkitdirectory: '', directory: '' }} onChange={event => {
        const files = Array.from(event.target.files || []); event.target.value = ''
        if (files.length) void execute(() => openFiles(files))
      }} />
      <input ref={meoInput} hidden type="file" accept=".json,application/json" onChange={event => {
        const file = event.target.files?.[0]; event.target.value = ''
        if (file && session) void execute(async () => { await session.replaceMeo(file); setFileHandle(undefined); setGeneration(value => value + 1) })
      }} />
      {session ? <OfflineEditor key={generation} session={session} fileHandle={fileHandle} setFileHandle={setFileHandle} onDirty={updateDirty} busy={busy} error={error} onError={setError}
        onOpen={openDirectory} onReopen={replaceMeo} theme={theme} onTheme={() => setTheme(value => { const next = value === 'dark' ? 'light' : 'dark'; savePrelayoutTheme(next); return next })} />
        : <main className="pl-home pl-offline-home"><h1>離線預排版</h1><p>選擇解壓後的項目資料夾，即可編輯文字與排版。</p><Button type="primary" size="large" loading={busy} onClick={openDirectory}>開啟項目資料夾</Button><p className="pl-muted">資料夾需包含 project.json、Meo.json 和圖片。保存時更新 Meo.json；不支援直接保存的瀏覽器會下載新檔。</p>{error && <Alert type="error" message={error} />}</main>}
    </div>
  </ConfigProvider>
}

function OfflineEditor({ session, fileHandle, setFileHandle, onDirty, busy, error, onError, onOpen, onReopen, theme, onTheme }: {
  session: OfflineProject; fileHandle?: FileHandle; setFileHandle: (handle?: FileHandle) => void;
  onDirty: (read: () => boolean) => void; busy: boolean; error: string; onError: (error: string) => void;
  onOpen: () => void; onReopen: () => void; theme: 'light' | 'dark'; onTheme: () => void;
}) {
  const [controller] = useState(() => new EditorState(`offline-${uid()}`, session.pages))
  useSyncExternalStore(callback => controller.subscribe('*', callback), () => controller.tick('*'))
  const [extraVersion, setExtraVersion] = useState(0), savedExtra = useRef(0)
  const [saving, setSaving] = useState(false), [notice, setNotice] = useState('')
  const [questionDraft, setQuestionDraft] = useState(false)
  const questionDraftRef = useRef(questionDraft); questionDraftRef.current = questionDraft
  const [current, setCurrent] = useState(session.pages[0].id)
  const [selection, setSelection] = useState<Selection>({ page: current, ids: [] })
  const [range, setRange] = useState<PageRange>([1, session.pages.length])
  const [jump, setJump] = useState<{ id: string; version: number; x?: number; y?: number } | null>(null)
  const [view, setView] = useState(() => loadViewPreferences('offline'))
  const [helpOpen, setHelpOpen] = useState(false), [interacting, setInteracting] = useState(false)
  const [textPreview, setTextPreview] = useState<LineBreakPreview | null>(null)
  const pointer = useRef<PagePointer | null>(null)
  const extraRef = useRef(extraVersion); extraRef.current = extraVersion
  const savingRef = useRef(false)
  const dirty = controller.dirty || extraVersion !== savedExtra.current || questionDraft
  const project = useMemo<Project>(() => ({ id: controller.project, name: session.manifest.name, pages: session.pages,
    updated_at: '', revision: 0, detection_id: null, template: session.meo as Project['template'] }), [controller, session])
  const state = controller.pages.get(selection.page), selected = state?.data.items.filter(item => selection.ids.includes(item._id)) || [], first = selected[0]
  const allSelected = Object.entries(selectionPages(selection)).flatMap(([id, ids]) => controller.pages.get(id)?.data.items.filter(item => ids.includes(item._id)) || [])
  const groups = (Array.isArray(session.meo.groupList) ? session.meo.groupList : []) as Group[]
  const itemFontNames = JSON.stringify([...new Set([...controller.pages.values()].flatMap(page => page.data.items.map(item => item.font).filter(Boolean)))])
  useEffect(() => {
    for (const name of JSON.parse(itemFontNames) as string[]) void loadLocalFont(name).catch(() => {})
  }, [itemFontNames])
  const markDirty = useCallback(() => setExtraVersion(value => value + 1), [])
  useEffect(() => { onDirty(() => controller.dirty || extraRef.current !== savedExtra.current || questionDraftRef.current || savingRef.current); return () => { onDirty(() => false); controller.dispose() } }, [controller, onDirty])
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => { if (controller.dirty || extraRef.current !== savedExtra.current || questionDraftRef.current || savingRef.current) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave)
  }, [controller])
  useEffect(() => { saveViewPreferences(view) }, [view])
  const select = (next: Selection) => { controller.finishTextDraft(); setSelection(next); setTextPreview(null) }
  const go = (id: string) => { controller.finishTextDraft(); setCurrent(id); setSelection({ page: id, ids: [] }); setTextPreview(null); setJump({ id, version: performance.now() }) }
  const imageSources = useCallback((page: Page) => ({ original: session.imageUrl(page.id, 'original')!, overlay: session.imageUrl(page.id, 'overlay') || session.imageUrl(page.id, 'clean') }), [session])
  const mixed = (key: keyof Item) => allSelected.some(item => item[key] !== allSelected[0]?.[key])
  const patch = (value: Partial<Item>, allPages = true) => {
    value = groupFontChanges(value, groups)
    controller.finishTextDraft()
    const pages = allPages ? selectionPages(selection) : { [selection.page]: selection.ids }
    const changes = new Map(Object.entries(pages).map(([id, ids]) => [id, controller.pages.get(id)!.data.items.map(item => ids.includes(item._id) ? { ...item, ...value, match_status: 'manual' } : item)]))
    controller.editBatch(changes)
  }
  const adjust = (adjustment: TextAdjustment, group?: string, continuing = false) => {
    if (interacting || !view.showText || !allSelected.length) return false
    const pages = adjustment.kind === 'move' ? { [selection.page]: selection.ids } : selectionPages(selection)
    const changes = new Map(Object.entries(pages).map(([id, ids]) => {
      const data = controller.pages.get(id)!.data
      return [id, adjustedItems(data.items, ids, adjustment, data.width, data.height)]
    }))
    if (changes.size === 1 && group) {
      const [id, items] = [...changes][0]
      if (items !== controller.pages.get(id)!.data.items) controller.edit(id, items, true, group, continuing)
    } else controller.editBatch(changes)
    return true
  }
  const add = () => {
    const point = pointer.current || { page: current, x: .5, y: .5 }, data = controller.pages.get(point.page)?.data
    if (!data || !view.showText) return
    const item: Item = { _id: uid(), text: '新文字', x: point.x, y: point.y, 'font-size': 40, rotation: 0, orientation: 'vertical', color: '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 0, match_status: 'manual' }
    controller.edit(data.id, [...data.items, item]); setSelection({ page: data.id, ids: [item._id] })
  }
  const duplicate = () => {
    if (!state || !selected.length) return
    const copies = selected.map(item => ({ ...moved(item, 16, 16, state.data.width, state.data.height), _id: uid() }))
    controller.edit(selection.page, [...state.data.items, ...copies]); setSelection({ page: selection.page, ids: copies.map(item => item._id) })
  }
  const remove = () => { if (state) controller.edit(selection.page, state.data.items.filter(item => !selection.ids.includes(item._id))); setSelection({ page: selection.page, ids: [] }) }
  async function save(asNew = false) {
    if (savingRef.current) return false
    controller.finishTextDraft()
    if (questionDraftRef.current) { onError('疑問內容尚未加入或更新記錄，請先在右側添加／更新，或清空草稿後再保存 Meo.json。'); return false }
    savingRef.current = true; setSaving(true); onError('')
    try {
      // Snapshot before any asynchronous picker/write so later edits remain unsaved.
      for (const [id, entry] of controller.pages) session.setPageItems(id, entry.data.items)
      const versions = new Map([...controller.pages].map(([id, entry]) => [id, entry.version])), extras = extraRef.current
      const blob = session.meoBlob()
      let handle = asNew ? undefined : fileHandle
      const picker = (window as PickerWindow).showSaveFilePicker
      if (!handle && picker) {
        try { handle = await picker.call(window, { suggestedName: 'Meo.json', types: jsonTypes }); await snapshotFile(handle) }
        catch (error) { if (cancelled(error)) return false }
      }
      if (handle) {
        try {
          const currentFile = await handle.getFile(), expected = fileStamps.get(handle)
          if (!expected || currentFile.lastModified !== expected.lastModified || currentFile.size !== expected.size) {
            throw new Error('Meo.json 已被其他視窗或程式修改')
          }
          const writable = await handle.createWritable()
          try { await writable.write(blob); await writable.close() }
          catch (error) { await writable.abort?.().catch(() => undefined); throw error }
          await snapshotFile(handle)
          setFileHandle(handle); setNotice(`已保存 ${handle.name}`)
        } catch (error) {
          if (cancelled(error)) return false
          download(blob, 'Meo.edited.json'); setFileHandle(undefined)
          setNotice(`${errorMessage(error)}；已下載 Meo.edited.json，原檔保留。`)
        }
      } else { download(blob, 'Meo.json'); setNotice('已下載 Meo.json，請保留新檔以供下次開啟。') }
      savedExtra.current = extras; controller.acknowledgeLocalSave(versions)
      return true
    } catch (e) { if (!cancelled(e)) onError(errorMessage(e)); return false }
    finally { savingRef.current = false; setSaving(false) }
  }
  controller.localSave = () => save()
  const blocked = (event: KeyboardEvent) => !!event.defaultPrevented || inputTarget(event.target) || helpOpen || interacting || busy || saving || controller.editing || !view.showText
  const paste = async (capture: FramePaste, stillCurrent: () => boolean) => {
    const data = controller.pages.get(capture.pointer.page)?.data
    if (!data || !stillCurrent()) return
    const item = pasteFrame(capture.frame, capture.pointer, data, uid, capture.text)
    controller.edit(data.id, [...data.items, item]); setSelection({ page: data.id, ids: [item._id] })
  }
  useFrameClipboard({ blocked, selectionCount: allSelected.length, selected, selectedPage: state?.data, pointer, paste, notify: setNotice })
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.isComposing || event.defaultPrevented || helpOpen || busy || saving || interacting) return
      const command = event.metaKey || event.ctrlKey, letter = event.key.toLowerCase()
      if (command && letter === 's') { event.preventDefault(); void save(); return }
      if (inputTarget(event.target) || controller.editing) return
      if (command && letter === 'z') { event.preventDefault(); controller.undo(selection.page, event.shiftKey); return }
      if (event.key === 'Escape') { select({ page: current, ids: [] }); return }
      if (event.key === 'PageUp' || event.key === 'PageDown') {
        const index = session.pages.findIndex(page => page.id === current) + (event.key === 'PageUp' ? -1 : 1)
        if (session.pages[index]) { event.preventDefault(); go(session.pages[index].id) }; return
      }
      if (!command && !event.altKey && letter === 'q') { setView(value => ({ ...value, clean: !value.clean })); return }
      if (!command && !event.altKey && letter === 'h') { setView(value => ({ ...value, difference: !value.difference })); return }
      if (!view.showText) return
      if (command && letter === 'a' && state) { event.preventDefault(); select({ page: state.data.id, ids: state.data.items.map(item => item._id) }); return }
      if (command && letter === 'n') { event.preventDefault(); add(); return }
      if (command && letter === 'd') { event.preventDefault(); duplicate(); return }
      if (['Delete', 'Backspace'].includes(event.key) && selected.length) { event.preventDefault(); remove(); return }
      if (event.key === 'F1' && selected.length === 1 && state) { event.preventDefault(); storeFrame(copyFrame(selected[0], state.data)); setNotice('已暫存文字框'); return }
      if (event.key === 'F2') { event.preventDefault(); const frame = readFrame(); if (frame && pointer.current) void paste({ frame, pointer: pointer.current }, () => true); else setNotice('請先暫存文字框，並將指標移到編輯頁面'); return }
      const adjustment = textShortcut(event)
      if (adjustment && adjust(adjustment, `key-${event.code}`, event.repeat)) event.preventDefault()
    }
    const release = () => controller.endGroup(selection.page)
    window.addEventListener('keydown', key); window.addEventListener('keyup', release)
    return () => { window.removeEventListener('keydown', key); window.removeEventListener('keyup', release) }
  })
  const moveSelected = (axis: 'x' | 'y', value: number | null) => {
    if (value === null || !first || !state) return
    const delta = value - first[axis] * (axis === 'x' ? state.data.width : state.data.height)
    adjust({ kind: 'move', dx: axis === 'x' ? delta : 0, dy: axis === 'y' ? delta : 0 })
  }
  const navigate = (reference: TextReference) => {
    const item = controller.pages.get(reference.pageId)?.data.items.find(item => item._id === reference.itemId)
    setCurrent(reference.pageId); select({ page: reference.pageId, ids: item ? [item._id] : [] }); setJump({ id: reference.pageId, x: item?.x, y: item?.y, version: performance.now() })
  }
  const hasClean = session.pages.some(page => page.clean)
  const hasMeasurements = session.pages.some(page => page.measure.length || page.character_boxes?.length)
  return <div className={`pl-workspace pl-compact-workspace pl-offline-workspace ${view.focus ? 'pl-focus-mode' : ''} ${!view.showTopControls ? 'pl-top-controls-hidden' : ''}`}>
    <div id="pl-offline-top-controls" className="pl-top-controls" hidden={!view.showTopControls}>
      <header className="pl-toolbar"><div className="pl-title"><Button size="small" disabled={busy || saving} onClick={onOpen}>開啟資料夾</Button><strong title={project.name}>{project.name}</strong><Tag>離線</Tag><Tag color={dirty ? 'orange' : 'green'}>{saving ? '保存中' : dirty ? '尚未保存' : '已保存'}</Tag></div><Space size={4} wrap>
        <Button size="small" disabled={busy || saving} onClick={onReopen}>開啟 Meo.json</Button><Button size="small" type="primary" loading={saving} disabled={busy} onClick={() => void save()}>保存 Meo.json</Button><Button size="small" disabled={busy || saving} onClick={() => void save(true)}>另存新檔</Button><Button size="small" onClick={() => setHelpOpen(true)}>快捷鍵</Button>
      </Space></header>
      <div className="pl-tool-row"><span className="pl-tool-label">編輯</span><Space size={[6, 4]} wrap><Button size="small" disabled={!view.showText} onClick={add}>新增文字</Button><Button size="small" onClick={() => controller.undo(selection.page)}>撤銷</Button><Button size="small" onClick={() => controller.undo(selection.page, true)}>重做</Button><span className="pl-muted" role="status">{notice}</span></Space></div>
      <div className="pl-tool-row pl-display-tools"><span className="pl-tool-label">顯示</span><Space size={[8, 4]} wrap>
        <Button size="small" aria-label="切換深淺主題" onClick={onTheme}>{theme === 'dark' ? '淺色' : '深色'}</Button>
        <Select size="small" aria-label="縮放" value={view.zoom} onChange={zoom => setView(value => ({ ...value, zoom }))} options={[...new Set([.5, .75, 1, 1.5, 2, 3, view.zoom])].sort((a, b) => a - b).map(value => ({ value, label: value === 1 ? '適合寬度' : `${Math.round(value * 100)}%` }))} />
        <Checkbox checked={view.compare} onChange={e => setView(value => ({ ...value, compare: e.target.checked }))}>原圖對照</Checkbox><Checkbox checked={view.clean} disabled={!hasClean} onChange={e => setView(value => ({ ...value, clean: e.target.checked }))}>去字底圖</Checkbox><Checkbox checked={view.showText} onChange={e => setView(value => ({ ...value, showText: e.target.checked }))}>顯示譯文</Checkbox>
        <label className="pl-opacity-slider">底圖透明度<input aria-label="底圖透明度" type="range" min="0" max="100" value={Math.round(view.backgroundOpacity * 100)} onChange={e => setView(value => ({ ...value, backgroundOpacity: Number(e.target.value) / 100 }))} /><output>{Math.round(view.backgroundOpacity * 100)}%</output></label>
        {hasMeasurements && <Checkbox checked={view.showMeasure} onChange={e => setView(value => ({ ...value, showMeasure: e.target.checked }))}>偵測框</Checkbox>}<Checkbox checked={view.difference} disabled={!hasClean} onChange={e => setView(value => ({ ...value, difference: e.target.checked }))}>差異高亮（H）</Checkbox>
        <label className="pl-difference-setting">顏色<input aria-label="差異高亮顏色" type="color" value={view.differenceColor} disabled={!hasClean} onChange={e => setView(value => ({ ...value, differenceColor: e.target.value }))} /></label><label className="pl-opacity-slider">高亮透明度<input aria-label="差異高亮透明度" type="range" min="0" max="100" disabled={!hasClean} value={Math.round(view.differenceOpacity * 100)} onChange={e => setView(value => ({ ...value, differenceOpacity: Number(e.target.value) / 100 }))} /><output>{Math.round(view.differenceOpacity * 100)}%</output></label>
      </Space></div>
      <PageNavigation pages={session.pages} current={current} range={range} onRange={setRange} onGo={go} reviewed={() => false} onReview={() => {}} onFinishAndNext={() => {}} reviewControls={false} busy={busy || saving} focus={view.focus} onFocus={focus => setView(value => ({ ...value, focus }))} />
    </div>
    {error && <Alert type="error" message={error} closable onClose={() => onError('')} />}
    <div className="pl-layout" style={{ '--pl-background-opacity': view.backgroundOpacity } as CSSProperties}>
      <ContinuousPages project={project} controller={controller} selection={selection} textPreview={textPreview} onSelect={select} onAdjust={adjust} zoom={view.zoom} onZoom={zoom => setView(value => ({ ...value, zoom }))} compare={view.compare} clean={view.clean} difference={view.difference} differenceColor={view.differenceColor} differenceOpacity={view.differenceOpacity} showText={view.showText} showMeasure={view.showMeasure && hasMeasurements} jump={jump}
        imageSources={imageSources} onCurrent={id => { setCurrent(id); setSelection(value => value.ids.length ? value : { page: id, ids: [] }) }} onMeasure={() => {}} onPointer={value => { pointer.current = value }} onFontWheel={event => !!pointer.current && adjust({ kind: 'font', delta: event.deltaY < 0 ? 2 : -2 })} onInteractionChange={setInteracting} />
      <aside className="pl-inspector" aria-label="文字編輯"><div className="pl-inspector-title"><h2>文字編輯</h2></div>
        <LineBreakControls controller={controller} selection={selection} preview={textPreview} onPreview={setTextPreview} disabled={!view.showText || interacting} onApplied={() => setTextPreview(null)} />
        {!!allSelected.length && <p className="pl-muted">已選 {Object.keys(selectionPages(selection)).length} 頁 · {allSelected.length} 框</p>}
        <details open className="pl-groups-top"><summary>分組</summary><Space wrap>{groups.map((group, index) => <Button key={index} size="small" disabled={!allSelected.length || !view.showText} onClick={() => patch({ groupId: index })}><GroupName name={group.name} index={index} /></Button>)}{!groups.length && <span className="pl-muted">尚無分組</span>}</Space></details>
        {first ? <fieldset className="pl-offline-fields" disabled={!view.showText || busy || saving}>
          <label>文字 {selected.length > 1 && `· 本頁已選 ${selected.length} 條`}<Input.TextArea aria-label="文字內容" autoSize={{ minRows: 3, maxRows: 7 }} value={first.text} onChange={e => patch({ text: e.target.value }, false)} /></label>
          <div className="pl-two-fields"><label>X 位置（像素）<InputNumber aria-label="X 位置（像素）" value={state ? Math.round(first.x * state.data.width * 10) / 10 : 0} onChange={value => moveSelected('x', value)} /></label><label>Y 位置（像素）<InputNumber aria-label="Y 位置（像素）" value={state ? Math.round(first.y * state.data.height * 10) / 10 : 0} onChange={value => moveSelected('y', value)} /></label></div>
          <AlignmentControls controller={controller} selection={selection} pageLabel={`第 ${session.pages.findIndex(page => page.id === selection.page) + 1} 頁`} disabled={!view.showText} />
          <div className="pl-two-fields"><label>角度<InputNumber aria-label="角度" value={mixed('rotation') ? null : first.rotation} placeholder="混合" min={-180} max={180} onChange={value => value !== null && patch({ rotation: value })} /></label><label>方向<Select aria-label="方向" value={mixed('orientation') ? undefined : first.orientation} placeholder="混合" onChange={orientation => patch({ orientation })} options={[{ value: 'vertical', label: '直排' }, { value: 'horizontal', label: '橫排' }]} /></label></div>
          <LocalFontPicker browserOnly value={first.font} values={allSelected.map(item => item.font)} mixed={mixed('font')} selectionKey={allSelected.map(item => item._id).join(',')} onChange={font => patch({ font })} disabled={!view.showText} />
          <div className="pl-four-fields"><label>字級<InputNumber aria-label="字級" value={mixed('font-size') ? null : first['font-size']} min={1} max={999} onChange={value => value !== null && patch({ 'font-size': value })} /></label><label>文字色<input aria-label="文字色" type="color" value={color(first.color)} onChange={e => patch({ color: e.target.value })} /></label><label>描邊粗細<InputNumber aria-label="描邊粗細" value={mixed('stroke-weight') ? null : first['stroke-weight']} min={0} max={99} onChange={value => value !== null && patch({ 'stroke-weight': value })} /></label><label>描邊色<input aria-label="描邊色" type="color" value={color(first['stroke-color'])} onChange={e => patch({ 'stroke-color': e.target.value })} /></label></div>
          <Space wrap><Button onClick={duplicate}>複製</Button><Button danger onClick={remove}>刪除</Button></Space>
        </fieldset> : <p className="pl-muted">雙擊文字可原位編輯；雙擊底圖新增文字。Shift 點選可跨頁多選。</p>}
        <details open><summary>本頁文字</summary><div className="pl-items-list">{state?.data.items.map((item, index) => <button key={item._id} className={selectionIds(selection, state.data.id).includes(item._id) ? 'active' : ''} onClick={event => { select(selectTextItem(selection, state.data.id, item._id, event.shiftKey)); setJump({ id: state.data.id, x: item.x, y: item.y, version: performance.now() }) }}><span>{index + 1}. {item.text || '空文字'}</span><small>{typeof item.groupId === 'number' && groups[item.groupId] ? groups[item.groupId].name : '未分組'} · 字級 {item['font-size']}</small></button>)}</div></details>
      </aside>
      <aside className="pl-inspector pl-question-inspector" aria-label="疑問記錄"><OfflineQuestions session={session} controller={controller} selection={selection} onChange={markDirty} onDraftChange={setQuestionDraft} onNavigate={navigate} /></aside>
    </div>
    <Button className="pl-top-controls-toggle" aria-controls="pl-offline-top-controls" aria-expanded={view.showTopControls} onClick={() => setView(value => ({ ...value, focus: false, showTopControls: !value.showTopControls }))}>{view.showTopControls ? '收起工具列' : '顯示工具列'}</Button>
    <Modal title="快捷鍵與滑鼠操作" open={helpOpen} onCancel={() => setHelpOpen(false)} footer={null} width={800}><ShortcutHelp collapsible={false} /></Modal>
  </div>
}
