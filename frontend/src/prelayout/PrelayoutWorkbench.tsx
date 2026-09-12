import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Alert, Button, Checkbox, Empty, Input, InputNumber, Modal, Select, Space, Spin, Tag, message } from 'antd'
import { base, body, files, previewUrl, projectPath, request } from './api'
import { type Availability, type Detection, type Item, type Project, activeDetection, uid } from './types'
import { EditorState } from './editor-state'
import { ContinuousPages } from './ContinuousPages'
import { type Selection, type PagePointer, color, moved, measureStyle } from './geometry'
import { adjustedItems, textShortcut, shortcutHelp, type TextAdjustment } from './shortcuts'
import './styles.css'

const showCleanUpload = false

export default function PrelayoutWorkbench({ onExit, onReadyToLeave }: { onExit: () => void; onReadyToLeave?: (handler: () => Promise<boolean>) => void }) {
  const [modal, modalContext] = Modal.useModal()
  const [projects, setProjects] = useState<Project[]>([]), [current, setCurrent] = useState<Project | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [createOpen, setCreateOpen] = useState(false)
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
  if (current) return <Workspace key={current.id} project={current} onReadyToLeave={onReadyToLeave} onExit={async () => { localStorage.removeItem('pl-last-project'); setCurrent(null); await reload() }} />
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
      setCurrent(await request<Project>(`${base}/projects`, { method: 'POST', body: data })); setCreateOpen(false); setImages([]); setName('')
    })}>
      <Input placeholder="項目名稱" value={name} onChange={e => setName(e.target.value)} />
      <p>原圖 · 已選 {images.length} 張</p><Space>
        <label className="pl-file">選擇圖片<input type="file" accept=".png,.jpg,.jpeg" multiple onChange={e => setImages(files(e.target.files))} /></label>
        <label className="pl-file">選擇資料夾<input type="file" multiple {...{ webkitdirectory: '' }} onChange={e => { const selected = files(e.target.files); setImages(selected); if (!name) setName(selected[0]?.webkitRelativePath.split('/')[0] || '') }} /></label>
      </Space><p className="pl-muted">資料夾只讀第一層；圖片與進度保存於預排版專用項目。</p>
    </Modal>
  </main>
}

function Workspace({ project: initial, onExit, onReadyToLeave }: { project: Project; onExit: () => Promise<void>; onReadyToLeave?: (handler: () => Promise<boolean>) => void }) {
  const [modal, modalContext] = Modal.useModal()
  const [notices, noticesContext] = message.useMessage()
  const [project, setProject] = useState(initial)
  const controller = useMemo(() => new EditorState(initial.id), [initial.id])
  useSyncExternalStore(callback => controller.subscribe('*', callback), () => controller.tick('*'))
  const [selection, setSelection] = useState<Selection>({ page: initial.pages[0].id, ids: [] })
  const [view] = useState(() => { try { return JSON.parse(localStorage.getItem(`pl-view-${initial.id}`) || '{}') } catch { return {} } })
  const [current, setCurrent] = useState(initial.pages[0].id), [zoom, setZoom] = useState<number>(Math.max(.5, Math.min(3, Number(view.zoom) || 1))), [compare, setCompare] = useState(!!view.compare), [clean, setClean] = useState(view.clean !== false), [showMeasure, setShowMeasure] = useState(!!view.showMeasure)
  const [jump, setJump] = useState<{ id: string; version: number; y?: number } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [pendingOnly, setPendingOnly] = useState(false)
  const [availability, setAvailability] = useState<Availability | null>(null), [task, setTask] = useState<Detection | null>(null)
  const [method, setMethod] = useState('ocr_aligned'), [fontBase, setFontBase] = useState(24), [fontStep, setFontStep] = useState(2)
  const [clipboard, setClipboard] = useState<Item[]>([]), [memory, setMemory] = useState<Item | null>(null)
  const [fontReady, setFontReady] = useState(false)
  const completedDetection = useRef<string | null>(initial.detection_id)
  const refreshingDetection = useRef(false)
  const pointer = useRef<PagePointer | null>(null)
  const pointerChanged = useCallback((value: PagePointer | null) => { pointer.current = value }, [])
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
  const errors = [...controller.pages.values()].map(state => state.error).filter(Boolean)
  const saving = [...controller.pages.values()].some(state => state.saving)
  useEffect(() => { try { localStorage.setItem(`pl-view-${initial.id}`, JSON.stringify({ zoom, compare, clean, showMeasure })) } catch { /* Optional view preferences. */ } }, [initial.id, zoom, compare, clean, showMeasure])
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
  const patch = useCallback((changes: Partial<Item>) => {
    const state = controller.pages.get(selection.page)
    if (!state) return
    controller.edit(selection.page, state.data.items.map(item => selection.ids.includes(item._id) ? { ...item, ...changes, match_status: 'manual' } : item))
  }, [controller, selection])
  const select = useCallback((value: Selection) => setSelection(value), [])
  const currentPage = useCallback((id: string) => { setCurrent(id); setSelection(value => value.ids.length ? value : { page: id, ids: [] }) }, [])
  function go(id: string) { setJump({ id, version: Date.now() }); setCurrent(id); setSelection({ page: id, ids: [] }) }
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
    const start = Math.max(0, project.pages.findIndex(page => page.id === selection.page))
    for (let offset = 0; offset <= project.pages.length; offset++) {
      const page = project.pages[(start + offset) % project.pages.length], state = await controller.load(page.id)
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
      if (shortcutBlocked(event) || event.isComposing || event.keyCode === 229) return
      const meta = event.metaKey || event.ctrlKey
      if (meta && !event.altKey && event.key.toLowerCase() === 's') { event.preventDefault(); void controller.flush(); return }
      if (meta && !event.altKey && event.key.toLowerCase() === 'z') { event.preventDefault(); controller.undo(selection.page, event.shiftKey); return }
      if (event.key === 'Escape') { setSelection(value => ({ ...value, ids: [] })); return }
      if (!meta && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'q') { event.preventDefault(); if (!event.repeat) setClean(value => !value); return }
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
    if (importKind.current === 'clean') { setProject(await request<Project>(`${projectPath(project.id)}/imports`, { method: 'POST', body: form })); return }
    const summary = await request<{ pages: number; items: number; groups: { name: string }[] }>(`${projectPath(project.id)}/imports`, { method: 'POST', body: form })
    modal.confirm({ title: '確認匯入譯稿', okText: '匯入', cancelText: '取消', content: <><p>{summary.pages} 頁，共 {summary.items} 條文字。對應頁面會替換為本次譯稿。</p><p>分組：{summary.groups.map(g => g.name).join('、') || '無分組'}；所有分組均保留。</p></>, onOk: () => execute(async () => {
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
  return <main className="pl-shell pl-workspace">{modalContext}{noticesContext}
    <header className="pl-toolbar"><div className="pl-title"><Button onClick={() => void execute(async () => { if (await controller.flush()) await onExit() })}>項目列表</Button><strong>{project.name}</strong><Tag color={errors.length ? 'red' : controller.dirty ? 'orange' : 'green'}>{saving ? '保存中' : controller.dirty ? '尚未保存' : '已保存'}</Tag></div>
      <Space wrap><Button onClick={() => modal.info({ title: '預排版快捷鍵', width: 650, content: <div className="pl-shortcut-help"><p>先點選文字，再使用移動、字級與旋轉快捷鍵。多選時每條文字分別調整；長按可連續操作，放開後記為一次撤銷。編輯輸入框或中文組字期間不攔截按鍵。</p><p>Mac 使用 ⌘／Option，Windows 使用 Ctrl／Alt。移動以原圖像素計算，與畫面縮放無關。</p><dl>{shortcutHelp.map(([action, keys]) => <div key={action}><dt>{action}</dt><dd>{keys}</dd></div>)}</dl></div> })}>快捷鍵</Button><Button onClick={() => void execute(async () => { await controller.flush() })}>保存</Button><Button onClick={downloadMeo}>匯出 Meo.json</Button><Button href="/downloads/LabelPlus_Ps_Script_ZS-1.8.0.zip" download="LabelPlus_Ps_Script_ZS-1.8.0.zip">配套PS腳本</Button></Space>
    </header>
    <div className="pl-tool-row"><Space wrap>
      {(['bt', 'labelplus', 'clean'] as const).filter((kind): boolean => kind !== 'clean' || showCleanUpload).map(kind => <Button key={kind} disabled={busy} onClick={() => { importKind.current = kind; if (fileInput.current) { fileInput.current.accept = kind === 'bt' ? '.json' : kind === 'labelplus' ? '.txt' : '.png,.jpg,.jpeg'; fileInput.current.multiple = kind === 'clean'; fileInput.current.click() } }}>{kind === 'bt' ? '開啟 Meo.json' : kind === 'labelplus' ? '匯入LP.txt' : '上傳去字圖'}</Button>)}
      <input hidden ref={fileInput} type="file" onChange={e => { const list = files(e.target.files); e.target.value = ''; void execute(() => importFile(list)) }} />
      <Button onClick={() => add()}>新增文字</Button><Button onClick={() => controller.undo(selection.page)}>撤銷</Button><Button onClick={() => controller.undo(selection.page, true)}>重做</Button>
      <Select aria-label="縮放" title="相對適合寬度的縮放比例" value={zoom} onChange={setZoom} options={[...new Set([.5, .75, 1, 1.5, 2, 3, zoom])].sort((a, b) => a - b).map(value => ({ value, label: value === 1 ? '適合寬度' : `${Math.round(value * 100)}%` }))} />
      <Checkbox checked={compare} onChange={e => setCompare(e.target.checked)}>原圖對照</Checkbox><Checkbox checked={clean} onChange={e => setClean(e.target.checked)}>去字底圖</Checkbox><Checkbox checked={showMeasure} onChange={e => setShowMeasure(e.target.checked)}>偵測框</Checkbox>
    </Space></div>
    {(error || errors.length > 0) && <Alert type="error" message={error || errors[0]} closable onClose={() => setError('')} />}
    <nav className="pl-pages-nav" aria-label="頁面導覽"><div className="pl-section-label">{project.pages.length} 頁</div>{project.pages.map((page, index) => <button key={page.id} className={current === page.id ? 'active' : ''} aria-current={current === page.id ? 'page' : undefined} title={page.name} onClick={() => go(page.id)}><span>{String(index + 1).padStart(2, '0')}</span><span>{page.name}</span></button>)}</nav>
    <div className="pl-layout">
      <ContinuousPages project={project} controller={controller} selection={selection} onSelect={select} zoom={zoom} onZoom={setZoom} compare={compare} clean={clean} showMeasure={showMeasure} jump={jump} onCurrent={currentPage} onMeasure={onMeasure} onPointer={pointerChanged} onFontWheel={fontWheel} onInteractionChange={interactionChanged} />
      <aside className="pl-inspector">
        <h2>文字編輯</h2>{state?.conflict && <Space wrap><Button onClick={() => void execute(() => controller.resolve(selection.page, true))}>保留我的草稿</Button><Button onClick={() => void execute(() => controller.resolve(selection.page, false))}>載入伺服器版</Button></Space>}
        {first ? <><label>文字 {selected.length > 1 && `· 已選 ${selected.length} 條`}<Input.TextArea rows={5} value={first.text} onChange={e => patch({ text: e.target.value })} /></label>
          <div className="pl-two-fields"><label>字級<InputNumber aria-label="字級" value={first['font-size']} min={1} max={999} onChange={v => v !== null && patch({ 'font-size': v })} /></label><label>角度<InputNumber aria-label="角度" value={first.rotation} min={-180} max={180} step={1} onChange={v => v !== null && patch({ rotation: v })} /></label></div>
          <label>方向<Select value={first.orientation} onChange={v => patch({ orientation: v })} options={[{ value: 'vertical', label: '直排' }, { value: 'horizontal', label: '橫排' }]} /></label>
          <div className="pl-two-fields"><label>文字色<input aria-label="文字色" type="color" value={color(first.color)} onChange={e => patch({ color: e.target.value })} /></label><label>描邊色<input aria-label="描邊色" type="color" value={color(first['stroke-color'])} onChange={e => patch({ 'stroke-color': e.target.value })} /></label></div>
          <label>描邊粗細<InputNumber min={0} max={99} value={first['stroke-weight']} onChange={v => v !== null && patch({ 'stroke-weight': v })} /></label><Checkbox checked={!!first.need_inpaint} onChange={e => patch({ need_inpaint: e.target.checked })}>保留修復標記</Checkbox><Checkbox checked={!!first.text_has_stroke} onChange={e => patch({ text_has_stroke: e.target.checked })}>保留原文描邊標記</Checkbox>
          <Space wrap><Button onClick={duplicate}>複製</Button><Button danger onClick={() => { if (state) controller.edit(selection.page, state.data.items.filter(item => !selection.ids.includes(item._id))); setSelection(value => ({ ...value, ids: [] })) }}>刪除</Button><Button onClick={() => void execute(async () => { const values = [...clipboard, { ...first, _id: uid() }]; await request(`${base}/preferences`, body(values, 'PUT')); setClipboard(values) })}>加入常用框</Button></Space>
        </> : <p className="pl-muted">點選頁面上的文字進行編輯。雙擊底圖新增文字；Shift 點選可多選。</p>}
        <details open><summary>本頁文字</summary><Space wrap><Checkbox checked={pendingOnly} onChange={e => setPendingOnly(e.target.checked)}>只看待處理</Checkbox><Button size="small" onClick={() => void execute(nextPending)}>下一個待處理</Button></Space><div className="pl-items-list">{state?.data.items.filter(item => !pendingOnly || ['unmatched', 'duplicate'].includes(item.match_status || '')).map((item, index) => <button key={item._id} className={selection.ids.includes(item._id) ? 'active' : ''} onClick={() => { setSelection({ page: state.data.id, ids: [item._id] }); setJump({ id: state.data.id, y: item.y, version: Date.now() }) }}><span>{index + 1}. {item.text || '空文字'}</span><small>{({ auto: '自動', manual: '手動', duplicate: '待確認', unmatched: '未匹配' } as Record<string, string>)[item.match_status || '']}</small></button>)}</div></details>
        <details><summary>常用文字框</summary>{clipboard.map(item => <div className="pl-clipboard" key={item._id}><button title="暫存此框，再用 F2 貼到指標位置" onClick={() => { setMemory(structuredClone(item)); notices.info('已暫存，將指標移到頁面後按 F2 貼上') }}>{item.text || '空文字'}</button><Button size="small" onClick={() => void execute(async () => { const next = clipboard.filter(i => i._id !== item._id); await request(`${base}/preferences`, body(next, 'PUT')); setClipboard(next) })}>移除</Button></div>)}</details>
        <details><summary>偵測與字級</summary><p className="pl-muted">{availability?.methods[method] ? `本地模型已就緒；提交時檢查 ${availability.device === 'mps' ? 'Apple GPU（MPS）' : 'CUDA GPU'}` : '尚未準備模型；可繼續人工編輯。'}</p>
          <Select value={method} onChange={setMethod} options={[{ value: 'ocr_aligned', label: 'OCR 對齊逐字計算' }, { value: 'single_char', label: '單字框計算' }]} />
          <div className="pl-two-fields"><label>預設字級<InputNumber value={fontBase} min={1} max={999} onChange={v => v !== null && setFontBase(v)} /></label><label>字級步長<InputNumber value={fontStep} min={.1} max={100} onChange={v => v !== null && setFontStep(v)} /></label></div>
          <Button disabled={!availability?.methods[method] || !!availability?.gpu_owner || activeDetection(task)} onClick={() => void execute(async () => { setTask(await request<Detection>(`${projectPath(project.id)}/detections`, body({ method, font_size: fontBase, step: fontStep }))) })}>生成 CTD／字級</Button>
          {task && <p>{({ queued: '等候開始', validating: '檢查環境', detecting: '偵測文字', aligning: '對齊文字框', measuring: '量測字框', previewing: '生成去字預覽', calibrating: '計算字級', publishing: '保存偵測結果', completed: '偵測完成', failed: '偵測失敗', cancelling: '正在停止', cancelled: '已取消', recovery_required: '恢復任務中' } as Record<string, string>)[task.state] || task.state}{task.progress ? ` · ${task.progress.completed}／${task.progress.total} 頁` : ''} · {task.message}</p>}{activeDetection(task) && <Button danger onClick={() => void execute(async () => { setTask(await request<Detection>(`${projectPath(project.id)}/detections/cancel`, body({}))) })}>取消偵測</Button>}
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
