import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Dropdown, Empty, Input, InputNumber, List, Modal, Progress, Select, Space, Spin, Steps, Tag, Typography, message } from 'antd'
import LegacyBatch from './App'
import { ImagePicker } from './ImagePicker'
import { DetectionSettings } from './DetectionSettings'
import { createMaskPlan } from './create-mask-plan'
import { runTiming } from './run-timing'
import { WorkflowProgressSummary } from './WorkflowProgressSummary'
import { friendlyWorkflowText } from './workflow-progress'
import { RasterEditor, type RasterHandle, type ComposeView, type RasterSave } from './RasterEditor'
import { RasterWorkerOwner } from './raster-worker-owner'
import { baselinePageLoad } from './page-load-options'
import { startPageLoad, type PageLoadTrace } from './page-load-performance'
import { clearSourceImageCache, scheduleSourceImagePreload, type SourceImageRequest } from './source-image-cache'
import { active, api, assetUrl, defaultDetectionOptions, json, projectUrl, workflowOptions, type Composition, type DetectionOptions, type Project, type Run, type Workflow } from './workbench-api'

const { Title, Text } = Typography
const remember = 'comic-workbench-project'
type Detection = { state: string; created_at?: string; updated_at?: string; total?: number; message?: string; error?: string; progress?: { stage: string; completed: number; total: number } }
const detectionLabels: Record<string, string> = { queued: '等待檢測', check: '準備檢測', checking: '準備檢測', rf: '識別文字區域', mangalens: '識別文字範圍', classify: '整理檢測結果', saving: '保存檢測結果', cancelling: '正在停止檢測', recovery_required: '檢查上次檢測狀態' }
const detectionActive = (state: string) => ['queued', 'checking', 'rf', 'mangalens', 'classify', 'saving', 'cancelling', 'recovery_required'].includes(state)
function bytes(value = 0) { return value > 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB` }

export default function ProjectWorkbench({ onReadyToLeave }: { onReadyToLeave?: (handler: () => Promise<boolean>) => void }) {
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [legacy, setLegacy] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [createDetectionOptions, setCreateDetectionOptions] = useState<DetectionOptions>(defaultDetectionOptions)
  const [detectOnCreate, setDetectOnCreate] = useState(true)
  const [createDetectionError, setCreateDetectionError] = useState('')
  const createSettingsTouched = useRef(false)
  const [picking, setPicking] = useState(false)
  const [name, setName] = useState(''); const [sources, setSources] = useState<File[]>([]); const [masks, setMasks] = useState<File[]>([])
  const maskPlan = createMaskPlan(sources, masks)
  const [busy, setBusy] = useState(false); const [error, setError] = useState('')
  const [gpuOwner, setGpuOwner] = useState<string | null>(null)
  const reload = useCallback(async () => { setProjects(await api<Project[]>('/api/projects')) }, [])
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        await reload()
        const id = localStorage.getItem(remember)
        if (id) { const p = await api<Project>(projectUrl(id)); if (alive) setCurrent(p) }
      } catch (err) { if (alive) setError(err instanceof Error ? err.message : '項目載入失敗') }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  }, [reload])
  useEffect(() => {
    const check = () => void api<{ gpu_owner: string | null; active_job_id: string | null }>('/api/health')
      .then(h => setGpuOwner(h.gpu_owner || h.active_job_id)).catch(() => setGpuOwner('unavailable'))
    check(); const timer = setInterval(check, 3000); return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    let live = true
    void api<{ defaults?: DetectionOptions }>('/api/detection/availability').then(value => {
      if (live && !createSettingsTouched.current && value.defaults) setCreateDetectionOptions(value.defaults)
    }).catch(() => {})
    return () => { live = false }
  }, [])
  function open(project: Project) { localStorage.setItem(remember, project.id); setCurrent(project) }
  async function action(callback: () => Promise<void>) {
    setBusy(true); setError('')
    try { await callback() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  async function create() {
    await action(async () => {
      const body = new FormData(); body.append('name', name || '未命名項目')
      body.append('detection_options', JSON.stringify(createDetectionOptions))
      for (const f of sources) body.append('source_files', f, f.name)
      for (const f of masks) body.append('mask_files', f, f.name)
      const project = await api<Project>('/api/projects', { method: 'POST', body })
      setCreateDetectionError('')
      if (detectOnCreate && project.pages.some(page => !page.mask_ready)) {
        try {
          await api(`${projectUrl(project.id)}/detect`, json('POST', { expected_revision: project.revision, missing_only: true, options: createDetectionOptions }))
        } catch (err) {
          setCreateDetectionError(`項目已建立，但自動檢測未啟動：${err instanceof Error ? err.message : String(err)}。已匯入 Mask 保留，可按「補充缺少的 Mask」重試。`)
        }
      }
      setCreateOpen(false); setSources([]); setMasks([]); setName(''); open(project); await reload()
    })
  }
  async function importArchive(file: File) {
    await action(async () => {
      const body = new FormData(); body.append('archive', file)
      const project = await api<Project>('/api/projects/import', { method: 'POST', body })
      await reload(); open(project)
    })
  }
  async function deleteProject() {
    if (!deleteTarget || deleting) return
    setDeleting(true); setDeleteError('')
    try {
      await api(`${projectUrl(deleteTarget.id)}?confirm=true`, { method: 'DELETE' })
      setProjects(items => items.filter(item => item.id !== deleteTarget.id))
      setDeleteTarget(null)
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : '刪除失敗，請重試')
    } finally { setDeleting(false) }
  }
  if (legacy) return <><div className="legacy-back"><Button onClick={() => setLegacy(false)}>返回項目工作台</Button></div><LegacyBatch /></>
  if (current) return <ProjectWorkspace key={current.id} initial={current} initialError={createDetectionError} gpuOwner={gpuOwner} onReadyToLeave={onReadyToLeave} onExit={async () => { localStorage.removeItem(remember); setCreateDetectionError(''); setCurrent(null); await reload() }} />
  return <main className="app-shell project-home">
    <header className="project-header"><div><Text className="eyebrow">COMIC WORKSPACE</Text><Title>漫畫修圖項目</Title><Text>保存原圖、修補與合成進度，下次打開接著編輯。</Text></div><Space wrap>
      <Button href="#/edgewhite">邊緣塗白</Button>
      <Button href="#/prelayout">預排版</Button>
      <Button onClick={() => setLegacy(true)}>舊版批次與歷史</Button>
      <label className={`file-picker ${busy || gpuOwner ? 'disabled' : ''}`}>匯入項目<input type="file" accept=".zip" disabled={busy || !!gpuOwner} onChange={e => { const f = e.target.files?.[0]; if (f) void importArchive(f); e.target.value = '' }} /></label>
      <Button type="primary" disabled={!!gpuOwner} onClick={() => setCreateOpen(true)}>新建項目</Button>
    </Space></header>
    {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
    {gpuOwner && <Alert type="info" message={gpuOwner === 'unavailable' ? '無法連接服務，請稍後重試' : 'GPU 任務處理中；暫停新上傳，已保存項目仍可查看'} />}
    {loading || busy ? <Spin><div style={{ height: 120 }} /></Spin> : projects.length ? <div className="project-grid">{projects.map(project => <Card key={project.id} title={project.name} extra={<Tag>{project.pages.length} 頁</Tag>}>
      {project.pages[0] && <img className="project-cover" src={assetUrl(project.id, project.pages[0].thumbnail || project.pages[0].source)} alt={`${project.name} 封面`} loading="lazy" />}
      <p>{new Date(project.updated_at).toLocaleString()} · {bytes(project.storage_bytes)}</p>
      <Space wrap><Button type="primary" onClick={() => open(project)}>繼續編輯</Button><Button disabled={!!gpuOwner} href={`${projectUrl(project.id)}/export`}>導出項目</Button><Button danger disabled={busy || deleting} onClick={() => { setDeleteError(''); setDeleteTarget(project) }}>刪除</Button></Space>
    </Card>)}</div> : <Empty description="還沒有項目，先上傳一組漫畫原圖" />}
    <Modal title={deleteTarget ? `刪除「${deleteTarget.name}」？` : '刪除項目'} open={!!deleteTarget}
      onCancel={() => { if (!deleting) setDeleteTarget(null) }} onOk={() => void deleteProject()}
      okText="刪除項目" cancelText="保留" confirmLoading={deleting} okButtonProps={{ danger: true }} cancelButtonProps={{ disabled: deleting }} closable={!deleting} maskClosable={!deleting} keyboard={!deleting}>
      <p>將刪除此項目的原圖、編輯、修復及合成結果（{bytes(deleteTarget?.storage_bytes)}）。此操作無法復原。</p>
      {deleteError && <Alert type="error" showIcon message={deleteError} />}
    </Modal>
    <Modal title="新建漫畫項目" width={700} styles={{ body: { maxHeight: '70vh', overflowY: 'auto' } }} open={createOpen} onCancel={() => { if (!busy && !picking) setCreateOpen(false) }} onOk={() => void create()} okText="建立項目" confirmLoading={busy} okButtonProps={{ disabled: !sources.length || maskPlan.invalid || !!gpuOwner || picking }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Input aria-label="項目名稱" placeholder="項目名稱" value={name} onChange={e => setName(e.target.value)} maxLength={80} />
        <div className="create-image-inputs">
        <div><p>原圖（必須）· 已選 {sources.length} 張</p><ImagePicker disabled={busy || picking || !!gpuOwner} onBusyChange={setPicking} label="原圖" onSelect={(files, folderName) => { setSources(files); if (!name) setName(folderName || files[0]?.name.replace(/\.[^.]+$/, '') || '') }} /></div>
        <div><p>Mask（可選）· 已選 {masks.length} 張</p><ImagePicker disabled={busy || picking || !!gpuOwner} onBusyChange={setPicking} label="Mask" mask onSelect={setMasks} /></div>
        </div>
        <Text type="secondary">可上傳全部或部分頁面的 Mask；已有 Mask（含全黑）會保留，其餘可自動檢測或人工編輯。資料夾僅匯入第一層，每次選擇整批取代。</Text>
        <section className="create-detection-settings" aria-label="新項目的自動檢測設定">
          <h3>自動檢測設定</h3>
          <Checkbox checked={detectOnCreate && maskPlan.missing > 0} disabled={busy || picking || maskPlan.missing === 0} onChange={e => setDetectOnCreate(e.target.checked)}>自動檢測缺少 Mask 的頁面</Checkbox>
          {maskPlan.invalid ? <Alert type="error" message="請檢查檔名：不可有重複頁碼，每張 Mask 都必須有同檔名的原圖。" /> : sources.length > 0 && <Alert type="info" message={maskPlan.missing === 0 ? `全部 ${maskPlan.supplied} 頁將使用你上傳的 Mask，無須自動檢測。` : `${maskPlan.supplied} 頁使用上傳的 Mask，另外 ${maskPlan.missing} 頁${detectOnCreate ? '將自動檢測' : '需稍後檢測或人工編輯'}。`} />}
          <Text type="secondary">設定會隨項目保存；勾選後在圖片上傳並建立項目完成時立即執行，無須再次按「自動檢測」。</Text>
          <DetectionSettings value={createDetectionOptions} onChange={value => { createSettingsTouched.current = true; setCreateDetectionOptions(value) }} disabled={busy || picking} />
        </section>
      </Space>
    </Modal>
  </main>
}

function ProjectWorkspace({ initial, initialError, gpuOwner, onExit, onReadyToLeave }: { initial: Project; initialError: string; gpuOwner: string | null; onExit: () => Promise<void>; onReadyToLeave?: (handler: () => Promise<boolean>) => void }) {
  const [modal, modalHolder] = Modal.useModal()
  const [project, setProject] = useState(initial)
  const workspaceRoot = useRef<HTMLElement>(null)
  const [pageFilter, setPageFilter] = useState('all')
  const [compareFilter, setCompareFilter] = useState('all')
  const [compareLayout, setCompareLayout] = useState<'multi' | 'context' | 'cards'>(() => {
    try { const value = localStorage.getItem('comic-compare-layout'); return value === 'context' || value === 'cards' ? value : 'multi' } catch { return 'multi' }
  })
  const [pageIndex, setPageIndex] = useState(0); const [step, setStep] = useState(0)
  const [workflow, setWorkflow] = useState<Workflow[]>(['flux2klein_lanpaint', 'firered'])
  const [run, setRun] = useState<Run | null>(null); const [runId, setRunId] = useState(initial.current_run_id)
  const [composition, setComposition] = useState<Composition | null>(null)
  const [assignment, setAssignment] = useState<number[][] | null>(null)
  const [busy, setBusy] = useState(false); const [error, setError] = useState(initialError); const [dirty, setDirty] = useState(false)
  const [editorKey, setEditorKey] = useState(0)
  const [editWorkerOwner] = useState(() => new RasterWorkerOwner())
  const [pageLoadTrace, setPageLoadTrace] = useState(() => startPageLoad(initial.pages[0].id, 'initial'))
  const [availability, setAvailability] = useState<{ available?: boolean; ready?: boolean; available_without_bubbles?: boolean; defaults?: DetectionOptions; errors?: string[]; message?: string } | null>(null)
  const [clock, setClock] = useState(Date.now())
  const [liveRepair, setLiveRepair] = useState<Record<string, boolean>>({})
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer) }, [])
  const [detection, setDetection] = useState<Detection | null>(null)
  const [detectConfirmOpen, setDetectConfirmOpen] = useState(false)
  const [detectError, setDetectError] = useState('')
  const [detectionOptions, setDetectionOptions] = useState<DetectionOptions>(initial.detection_options || defaultDetectionOptions)
  const [feather, setFeather] = useState(1)
  const composeView = useRef<ComposeView>({})
  const editView = useRef<ComposeView>({})
  const editor = useRef<RasterHandle>(null)
  const editRevision = useRef(initial.pages[0].edit_revision)
  const compositionRevision = useRef(0)
  const navigating = useRef(false)
  const wasDetecting = useRef(initial.state === 'detecting')
  const page = project.pages[pageIndex]
  const pageStatus = (item: Project['pages'][number]) => !(liveRepair[item.id] !== undefined || item.mask_ready) ? 'untouched' : (liveRepair[item.id] ?? item.has_repair_mask) ? 'repair' : 'complete'
  const visiblePages = project.pages.map((item, index) => ({item, index})).filter(({item}) => step === 2 ? compareFilter === 'all' || (composition?.pages.find(p => p.page_id === item.id)?.confirmed ? 'confirmed' : 'pending') === compareFilter : pageFilter === 'all' || pageStatus(item) === pageFilter)
  const adjacentPage = (direction: number) => direction > 0 ? visiblePages.find(({index}) => index > pageIndex)?.index : visiblePages.slice().reverse().find(({index}) => index < pageIndex)?.index
  const sourcePreloadRequests = useMemo<SourceImageRequest[]>(() => {
    if (step !== 0) return []
    const visible = project.pages.map((item, index) => ({ item, index })).filter(({ item }) => {
      const status = !(liveRepair[item.id] !== undefined || item.mask_ready) ? 'untouched' : (liveRepair[item.id] ?? item.has_repair_mask) ? 'repair' : 'complete'
      return pageFilter === 'all' || status === pageFilter
    })
    const next = visible.filter(({ index }) => index > pageIndex).slice(0, 2)
    const previous = visible.filter(({ index }) => index < pageIndex).at(-1)
    const selected = [{ item: project.pages[pageIndex], index: pageIndex }, ...next, ...(previous ? [previous] : [])]
    return selected.map(({ item }) => ({ url: assetUrl(project.id, item.source), width: item.width, height: item.height }))
  }, [liveRepair, pageFilter, pageIndex, project.id, project.pages, step])
  const currentPageId = useRef(page.id); currentPageId.current = page.id
  const url = projectUrl(project.id)
  const compUrl = `${url}/compositions/${runId}`
  const detecting = project.state === 'detecting' || !!(detection && detectionActive(detection.state))
  const running = !!(run && active(run.state))
  const detectionReady = !!(availability?.available ?? availability?.ready)
  const detectionCanConfigure = detectionReady || !!availability?.available_without_bubbles
  const chosenDetectionReady = detectionReady || (!detectionOptions.bubble_enabled && !!availability?.available_without_bubbles)

  useEffect(() => () => editWorkerOwner.dispose(), [editWorkerOwner])
  useEffect(() => { if (step !== 0 || detecting) editWorkerOwner.dispose() }, [editWorkerOwner, step, detecting])
  useEffect(() => () => clearSourceImageCache(), [project.id])
  useEffect(() => { scheduleSourceImagePreload(sourcePreloadRequests) }, [sourcePreloadRequests])

  async function execute(fn: () => Promise<void>) {
    if (navigating.current) return
    navigating.current = true
    setBusy(true); setError('')
    try { await fn() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { navigating.current = false; setBusy(false) }
  }
  async function flush(trace?: PageLoadTrace) { return !editor.current || await editor.current.flush(trace) }
  useEffect(() => {
    onReadyToLeave?.(async () => !navigating.current && (!editor.current || await editor.current.flush()))
    return () => onReadyToLeave?.(async () => true)
  }, [onReadyToLeave])
  async function reloadProject() { const p = await api<Project>(url); setProject(p); return p }
  const loadComposition = useCallback(async () => {
    if (!runId) return
    const c = await api<Composition>(`${projectUrl(initial.id)}/compositions/${runId}`)
    compositionRevision.current = c.revision; setComposition(c); setFeather(c.settings.feather_px)
    return c
  }, [initial.id, runId])

  useEffect(() => {
    void api<typeof availability>('/api/detection/availability').then(value => {
      setAvailability(value)
      if (!initial.detection_options && value?.defaults) setDetectionOptions(value.defaults)
    }).catch(() => setAvailability(null))
  }, [initial.detection_options])
  useEffect(() => {
    if (!runId) { setRun(null); return }
    let live = true
    const refresh = () => void api<Run>(`/api/jobs/${runId}`).then(value => { if (live) setRun(value) }).catch(err => { if (live) setError(String(err)) })
    refresh(); const timer = setInterval(refresh, 1000)
    return () => { live = false; clearInterval(timer) }
  }, [runId])
  useEffect(() => {
    let live = true
    const refresh = () => void api<Detection | null>(`${url}/detection`).then(async value => {
      if (!live) return
      setDetection(value)
      if (!value) return
      const nowActive = detectionActive(value.state)
      if (wasDetecting.current && !nowActive) {
        const p = await api<Project>(url)
        if (live) {
          editRevision.current = p.pages.find(item => item.id === currentPageId.current)!.edit_revision
          setProject(p); setLiveRepair({}); setEditorKey(k => k + 1)
        }
      }
      wasDetecting.current = nowActive
    }).catch(() => {})
    refresh(); const timer = setInterval(refresh, 2000)
    return () => { live = false; clearInterval(timer) }
  }, [url])
  useEffect(() => {
    if (step !== 2 || !runId) return
    let live = true
    void (async () => {
      await loadComposition()
      const a = await api<{ revision: number; assignment_rle: number[][] }>(`${compUrl}/pages/${page.id}/assignment`)
      if (live) { compositionRevision.current = a.revision; setAssignment(a.assignment_rle) }
    })().catch(err => { if (live) setError(String(err)) })
    return () => { live = false }
  }, [step, runId, page.id, compUrl, loadComposition, editorKey])

  async function navigate(nextStep: number, nextPage = pageIndex, accepted = false) {
    const trace = nextStep === 0 ? startPageLoad(project.pages[nextPage].id, 'navigate') : undefined
    try {
      if (!await (trace ? trace.measure('save.wait', () => flush(trace)) : flush())) { trace?.finish('cancelled'); return }
      if (nextStep === 2 && run?.state !== 'completed' && !run?.partial_results_accepted && !accepted) { message.info('修復完成後即可比較合成'); return }
      const p = await (trace ? trace.measure('project.reload', reloadProject) : reloadProject())
      editRevision.current = p.pages[nextPage].edit_revision
      if (nextStep === 2) {
        const a = await api<{ revision: number; assignment_rle: number[][] }>(`${compUrl}/pages/${p.pages[nextPage].id}/assignment`)
        compositionRevision.current = a.revision; setAssignment(a.assignment_rle)
      }
      setPageIndex(nextPage); setStep(nextStep); setDirty(false); setEditorKey(k => k + 1)
      if (trace) { pageLoadTrace.finish('superseded'); setPageLoadTrace(trace) }
    } catch (error) { trace?.finish('failed'); throw error }
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (![0, 2].includes(step) || !['PageUp', 'PageDown'].includes(event.key) || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const root = workspaceRoot.current
      const target = event.target instanceof Element ? event.target : null
      if (!root?.getClientRects().length || target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="combobox"]') || document.querySelector('.ant-modal-wrap:not([style*="display: none"])')) return
      event.preventDefault()
      if (event.repeat || navigating.current || detecting) return
      const next = adjacentPage(event.key === 'PageDown' ? 1 : -1)
      if (next !== undefined) void execute(() => navigate(step, next))
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  })
  async function changeCompareLayout(layout: 'multi' | 'context' | 'cards') {
    await execute(async () => {
      if (!await flush()) return
      setCompareLayout(layout)
      try { localStorage.setItem('comic-compare-layout', layout) } catch { /* Storage is optional. */ }
    })
  }
  async function saveEdit(data: RasterSave) {
    const body = new FormData(); body.append('expected_revision', String(editRevision.current))
    body.append('overlay', data.overlay, 'overlay.png'); body.append('other', data.other, 'other.png'); body.append('edited', data.edited, 'edited.png')
    const p = await api<Project>(`${url}/pages/${page.id}/edit`, { method: 'PUT', body })
    editRevision.current = p.pages.find(item => item.id === page.id)!.edit_revision; setProject(p)
  }
  async function saveComposition(data: RasterSave) {
    const c = await api<Composition>(`${compUrl}/pages/${page.id}`, json('PUT', {
      revision: compositionRevision.current, assignment_rle: data.assignment_rle, confirmed: false, settings: { ...composition!.settings, feather_px: feather },
    }))
    compositionRevision.current = c.revision; setComposition(c); setAssignment(data.assignment_rle)
  }
  async function detect(missingOnly = false) {
    await execute(async () => {
      setDetectError('')
      try {
        if (!await flush()) throw new Error('目前修改未能保存，尚未開始重新檢測。')
        const p = await reloadProject()
        await api(`${url}/detect`, json('POST', { expected_revision: p.revision, replace_existing: !missingOnly, missing_only: missingOnly, options: detectionOptions }))
        wasDetecting.current = true
        setProject({ ...p, state: 'detecting', detection_options: detectionOptions }); setDetection({ state: 'queued', message: '等待偵測' })
        setDetectConfirmOpen(false)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (missingOnly) setError(message)
        else setDetectError(message)
      }
    })
  }
  async function submit() {
    await execute(async () => {
      if (!await flush()) return
      const p = await reloadProject()
      const next = await api<Run>(`${url}/jobs`, json('POST', { workflows: workflow, expected_revision: p.revision }))
      setRun(next); setRunId(next.id); setStep(1); await reloadProject()
    })
  }
  async function confirmDisplayedPage() {
    if (!composition || composition.pages.find(p => p.page_id === page.id)?.confirmed) return
    const c = await api<Composition>(`${compUrl}/pages/${page.id}`, json('PUT', { revision: compositionRevision.current, assignment_rle: assignment, confirmed: true, settings: composition.settings }))
    compositionRevision.current = c.revision; setComposition(c)
  }
  async function saveFeather(value: number, changes: Record<string, number> = {}) {
    await execute(async () => {
      if (!await flush() || !composition) return
      const a = await api<{ assignment_rle: number[][] }>(`${compUrl}/pages/${page.id}/assignment`)
      const c = await api<Composition>(`${compUrl}/pages/${page.id}`, json('PUT', { revision: compositionRevision.current,
        assignment_rle: a.assignment_rle, confirmed: false, settings: { ...composition.settings, feather_px: value, ...changes } }))
      compositionRevision.current = c.revision; setComposition(c); setFeather(value); setEditorKey(k => k + 1)
    })
  }
  async function download(path: string) {
    if (!await flush()) return
    window.location.assign(path)
  }
  async function exportResults() {
    await execute(async () => {
      if (!await flush()) return
      if (run?.state !== 'completed' && !run?.partial_results_accepted) { message.info('修復完成後即可導出結果圖片'); return }
      const latest = await loadComposition()
      if (!latest) return
      const pending = latest.pages.filter(item => !item.confirmed)
      if (pending.length) {
        const nextPage = project.pages.findIndex(item => item.id === pending[0].page_id)
        if (nextPage < 0) throw new Error('找不到待確認頁面，請重新載入項目')
        setCompareFilter('pending')
        message.info(`還有 ${pending.length} 頁待確認，已前往 ${project.pages[nextPage].filename}；查看完成後再點導出結果`)
        await navigate(2, nextPage)
        return
      }
      const result = await api<{ download_url: string }>(`${compUrl}/export`, json('POST', { revision: latest.revision }))
      window.location.assign(result.download_url)
    })
  }
  const pendingExportCount = step === 2 ? composition?.pages.filter(item => !item.confirmed).length : undefined
  const cp = composition?.pages.find(item => item.page_id === page.id)
  const candidateOptions = cp?.candidates.filter(item => item.available).map(item => ({ code: item.code,
    label: workflowOptions.find(w => w.value === item.workflow)!.label,
    url: `${compUrl}/pages/${page.id}/image?source=${item.workflow}`, diffUrl: `${compUrl}/pages/${page.id}/image?source=diff:${item.workflow}&revision=${composition?.revision}`,
  })) || []
  return <main ref={workspaceRoot} className={`app-shell project-workspace${step === 0 ? ' compact-edit' : ''}`}>
    {modalHolder}
    <Modal title="自動檢測設定" width={600} open={detectConfirmOpen} onCancel={() => { if (!busy) setDetectConfirmOpen(false) }}
      onOk={() => void detect()} okText="覆蓋並重新檢測" cancelText="取消" confirmLoading={busy}
      okButtonProps={{ danger: true, disabled: !!gpuOwner || detecting || !chosenDetectionReady }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy} keyboard={!busy}>
      <DetectionSettings value={detectionOptions} onChange={setDetectionOptions} disabled={busy} />
      {!chosenDetectionReady && <Alert type="info" showIcon message="氣泡辨識暫不可用，可關閉此選項後檢測。" />}
      <p>將從原圖重新檢測「{project.name}」全部 {project.pages.length} 頁，不只目前這一頁。</p>
      <p>新結果會覆蓋第一部分的純色填充、待修補 Mask、匯入 Mask 與人工修改。原圖及既有修復結果保留。</p>
      <p>檢測結果完成並驗證後才回寫；取消此視窗不會啟動檢測。</p>
      {detectError && <Alert type="error" showIcon message={detectError} />}
    </Modal>
    <header className="project-header"><div><Button onClick={() => void execute(async () => { if (await flush()) await onExit() })}>← 項目列表</Button><Title level={2}>{project.name}</Title><Text>{project.pages.length} 頁 · {dirty ? '有未保存修改' : '項目保存在伺服器'}</Text></div>
      <Space wrap><Button onClick={() => { let nextName = project.name; modal.confirm({ title: '項目名稱', content: <Input defaultValue={nextName} onChange={e => { nextName = e.target.value }} />, onOk: async () => { if (!await flush()) throw new Error('請先保存'); const p = await reloadProject(); setProject(await api<Project>(url, json('PATCH', { name: nextName, expected_revision: p.revision }))) } }) }}>重命名</Button>
        <Button disabled={busy || !!gpuOwner || detecting} onClick={() => void download(`${url}/export`)}>導出項目</Button>
        <div className="result-export-action"><Button type="primary" disabled={busy || !!gpuOwner || detecting} onClick={() => void exportResults()}>導出結果</Button>{!!pendingExportCount && <span>尚有 {pendingExportCount} 頁待確認 · 點擊前往</span>}</div>
      </Space></header>
    {error && <Alert type="error" showIcon closable onClose={() => setError('')} message={error} />}
    <Steps size="small" responsive={false} current={step} onChange={value => void execute(() => navigate(value))} items={[{ title: '準備與編輯' }, { title: '批量修復' }, { title: '比較合成', disabled: run?.state !== 'completed' && !run?.partial_results_accepted }]} />
    <div className={`project-body${step !== 1 ? ' pages-collapsed' : ''}`}><aside id="editing-page-list" className="page-list" hidden={step !== 1}>
      <div className="page-status-legend"><span className="page-untouched">{step === 2 ? '待確認' : '未處理'}</span> · <span className="page-complete">{step === 2 ? '已確認' : '完成'}</span>{step !== 2 && <> · <span className="page-needs-repair">待修補</span></>}</div><List dataSource={project.pages} renderItem={(item, index) => <List.Item className={index === pageIndex ? 'selected' : ''} onClick={() => void execute(() => navigate(step, index))}>
        <strong className={step === 2 ? (composition?.pages.find(p => p.page_id === item.id)?.confirmed ? 'page-complete' : 'page-untouched') : (liveRepair[item.id] !== undefined || item.mask_ready) ? ((liveRepair[item.id] ?? item.has_repair_mask) ? 'page-needs-repair' : 'page-complete') : 'page-untouched'} title={(liveRepair[item.id] !== undefined || item.mask_ready) ? ((liveRepair[item.id] ?? item.has_repair_mask) ? '仍有待修補區域' : '已完成塗白，無待修補區域') : '尚未處理'}>{item.filename}</strong>
      </List.Item>} />
    </aside><section className="project-content">
      {step === 0 && <>
        <Space wrap size={6} className="editor-toolbar page-summary">
          <Button size="small" aria-label="上一頁" title="PageUp" disabled={busy || adjacentPage(-1) === undefined} onClick={() => void execute(() => navigate(0, adjacentPage(-1)!))}>‹</Button>
          <Select size="small" aria-label="選擇頁面" value={pageIndex} popupMatchSelectWidth={260} showSearch optionFilterProp="label" onChange={index => void execute(() => navigate(0, index))} options={visiblePages.map(({item,index}) => ({value:index,label:`${item.filename} · ${index+1}/${project.pages.length}`}))} />
          <Button size="small" aria-label="下一頁" title="PageDown" disabled={busy || adjacentPage(1) === undefined} onClick={() => void execute(() => navigate(0, adjacentPage(1)!))}>›</Button>
          <Button size="small" type={pageFilter === 'all' ? 'text' : 'default'} onClick={() => setPageFilter('all')}>全部 {project.pages.length}</Button>
          {[{key:'untouched',label:'未處理',cls:'page-untouched'},{key:'repair',label:'待修補',cls:'page-needs-repair'},{key:'complete',label:'完成',cls:'page-complete'}].map(status => <Button size="small" key={status.key} className={status.cls} aria-pressed={pageFilter === status.key} type={pageFilter === status.key ? 'default' : 'text'} onClick={() => setPageFilter(pageFilter === status.key ? 'all' : status.key)}>{status.label} {project.pages.filter(item => pageStatus(item) === status.key).length}</Button>)}
          <Button type="primary" loading={detecting} disabled={!!gpuOwner || busy || detecting || !detectionCanConfigure} onClick={() => { setDetectError(''); setDetectConfirmOpen(true) }}>自動檢測</Button>
          <Dropdown menu={{items:[{key:'pairs',label:'導出底圖＋Mask',disabled:detecting || !!gpuOwner},{key:'project',label:'導出項目',disabled:busy || detecting || !!gpuOwner}],onClick:({key}) => void download(`${url}/${key === 'pairs' ? 'export-pair' : 'export'}`)}}><Button size="small">更多 ▾</Button></Dropdown>
          <Button onClick={() => void execute(() => navigate(1))}>下一步 →</Button>
        </Space>
        {!detectionCanConfigure && <span className="detection-unavailable">自動檢測暫不可用，可手動編輯</span>}
        {detecting && <p className="detection-estimate">參考估算：首次準備約 20 秒，每張約 8 秒；第一張合計約 28 秒，之後每張約 8 秒。{project.pages.length} 張合計約 {Math.floor((20 + project.pages.length * 8) / 60)} 分 {(20 + project.pages.length * 8) % 60} 秒（依圖片與設備浮動）。</p>}
        {detecting && detection?.created_at && <p role="timer">{detecting ? '已運行' : '本次耗時'} {Math.max(0, Math.floor(((detecting ? clock : Date.parse(detection.updated_at || detection.created_at)) - Date.parse(detection.created_at)) / 1000))} 秒{detecting && <> · {clock - Date.parse(detection.created_at) < (20 + (detection.total || project.pages.length) * 8) * 1000 ? `預估剩餘約 ${Math.ceil(((20 + (detection.total || project.pages.length) * 8) * 1000 - clock + Date.parse(detection.created_at)) / 1000)} 秒` : '已超過參考時間，仍在處理'}</>}</p>}
        {detecting ? <Alert type="info" showIcon message={detection?.progress ? `${detectionLabels[detection.state] || detectionLabels[detection.progress.stage] || '自動檢測中'} · ${detection.progress.completed} / ${detection.progress.total} 頁` : detectionLabels[detection?.state || ''] || '自動檢測中，完成後即可編輯'} action={<Button danger onClick={() => void execute(async () => { await api(`${url}/detection/${detection?.state === 'recovery_required' ? 'recover' : 'cancel'}`, { method: 'POST' }); await reloadProject(); setEditorKey(k => k + 1) })}>{detection?.state === 'recovery_required' ? '檢查恢復' : '停止偵測'}</Button>} /> : <RasterEditor key={`${page.id}-${editorKey}`} ref={editor} width={page.width} height={page.height} mode="edit" viewState={editView} pageLoadTrace={pageLoadTrace} acquireWorker={baselinePageLoad() ? undefined : editWorkerOwner.acquire}
          baseUrl={assetUrl(project.id, page.source)} overlayUrl={`${assetUrl(project.id, page.overlay)}?v=${page.edit_revision}`} otherUrl={`${assetUrl(project.id, page.other)}?v=${page.edit_revision}`} editedUrl={`${assetUrl(project.id, page.edited)}?v=${page.edit_revision}`}
          detectedTextUrl={page.detected_text ? assetUrl(project.id, page.detected_text) : undefined}
          onSave={saveEdit} onDirty={setDirty} onRepairMaskChange={value => setLiveRepair(previous => ({ ...previous, [page.id]: value }))} disabled={busy} />}
        {project.pages.some(p => !p.mask_ready) && <Button disabled={busy || !!gpuOwner || detecting || !detectionCanConfigure} onClick={() => void detect(true)}>補充缺少的 Mask</Button>}
        {detection?.error && <Alert type="error" message="自動檢測未完成，請重試；若持續失敗，請聯絡管理員查看檢測日誌。" />}
      </>}
      {step === 1 && <>
        <Title level={3}>批量修復</Title><p>確認後固定本次底圖與 Mask。全黑 Mask 直接沿用底圖，最終仍輸出全部 {project.pages.length} 頁。</p>
        {project.runs.length > 0 && <Select className="run-select" aria-label="修復記錄" value={runId} onChange={id => { setRunId(id); setComposition(null) }} options={project.runs.map(r => ({ value: r.id, label: `${new Date(r.created_at).toLocaleString()} · ${r.workflows.length} 套流程` }))} />}
        {run && <Card title={run.name} className="run-card"><Tag>{run.state}</Tag><p role="timer" aria-live="off">{runTiming(run, clock).text}</p><p><Text type="secondary">從任務建立時計算，包含準備、模型載入、生成及打包。</Text></p><Progress percent={Math.round(run.completed_total / Math.max(1, run.total_runs) * 100)} /><p>{friendlyWorkflowText(run.message)}</p><WorkflowProgressSummary workflows={run.workflows} progress={run.workflow_progress} />{run.error && <Alert type="error" message={friendlyWorkflowText(run.error)} />}
          <Space wrap>{run.download_ready && <Button disabled={!!gpuOwner} href={`/api/jobs/${run.id}/download`}>下載候選結果</Button>}
            {run.state === 'failed' && <><Button disabled={!run.completed_total || !!gpuOwner} href={`/api/jobs/${run.id}/download-current`}>下載目前結果</Button><Button disabled={!!gpuOwner} onClick={() => modal.confirm({ title: '續跑未完成圖片？', content: '使用原任務的圖片與 Mask，保留已完成結果。請先確認 ComfyUI 已就緒。', onOk: async () => { setRun(await api<Run>(`/api/jobs/${run.id}/resume`, { method: 'POST' })) } })}>續跑未完成圖片</Button></>}
            {running && <><Button disabled={!run.completed_total} href={`/api/jobs/${run.id}/download-current`}>下載目前結果</Button><Button danger onClick={() => modal.confirm({ title: '放棄修復任務？', content: '已完成圖片會保留。', onOk: async () => { setRun(await api<Run>(`/api/jobs/${run.id}/abandon`, { method: 'POST' })) } })}>放棄任務</Button></>}
            {run.state === 'failed' && !run.partial_results_accepted && <Button disabled={!run.completed_total || !!gpuOwner} onClick={() => modal.confirm({ title: '使用已有結果進下一步？', content: '缺少的候選會標示。完全沒有候選的待修補頁，仍需補跑才能完成導出。', onOk: async () => { setRun(await api<Run>(`/api/jobs/${run.id}/use-results`, { method: 'POST' })); await execute(() => navigate(2, pageIndex, true)) } })}>使用已有結果進下一步</Button>}
            {(run.state === 'completed' || run.partial_results_accepted) && <Button type="primary" onClick={() => void execute(() => navigate(2))}>比較與局部合成 →</Button>}
          </Space>{run.archive_path && <p className="server-path">伺服器下載路徑：{run.archive_path}</p>}
        </Card>}
        {!running && <Card title="建立新的修復版本"><Checkbox.Group value={workflow} onChange={values => setWorkflow(values as Workflow[])} options={workflowOptions} />
          <p>{project.pages.filter(p => p.mask_ready).length} / {project.pages.length} 頁 Mask 已備妥</p>
          <Button type="primary" loading={busy} disabled={!!gpuOwner || detecting || !workflow.length || project.pages.some(p => !p.mask_ready)} onClick={() => void submit()}>開始批量修復</Button>
        </Card>}
      </>}
      {step === 2 && <>
        <Space wrap size={6} className="editor-toolbar compare-page-navigation">
          <Select size="small" aria-label="比較模式" value={compareLayout} disabled={busy || !assignment} onChange={value => void changeCompareLayout(value)} options={[{value:'multi',label:'多圖對比'},{value:'context',label:'整體＋局部'},{value:'cards',label:'區域卡片'}]}/>

          <Button size="small" aria-label="上一頁" title="PageUp" disabled={busy || !assignment || adjacentPage(-1) === undefined} onClick={() => void execute(() => navigate(2, adjacentPage(-1)!))}>‹</Button>
          <Select size="small" aria-label="選擇合成頁面" value={pageIndex} disabled={busy || !assignment} showSearch optionFilterProp="label" popupMatchSelectWidth={260} onChange={index => void execute(() => navigate(2, index))} options={[...visiblePages.map(({item,index}) => ({value:index,label:`${item.filename} · ${index+1}/${project.pages.length}`})), ...(!visiblePages.some(p => p.index === pageIndex) ? [{value:pageIndex,label:`${page.filename} · ${pageIndex+1}/${project.pages.length}`,disabled:true}] : [])]} />
          <Button size="small" aria-label="下一頁" title="PageDown" disabled={busy || !assignment || adjacentPage(1) === undefined} onClick={() => void execute(() => navigate(2, adjacentPage(1)!))}>›</Button>
          <Button size="small" onClick={() => setCompareFilter('all')}>全部 {project.pages.length}</Button>
          <Button size="small" className="page-untouched" aria-pressed={compareFilter === 'pending'} onClick={() => setCompareFilter(compareFilter === 'pending' ? 'all' : 'pending')}>待確認 {composition?.pages.filter(p => !p.confirmed).length ?? '—'}</Button>
          <Button size="small" className="page-complete" aria-pressed={compareFilter === 'confirmed'} onClick={() => setCompareFilter(compareFilter === 'confirmed' ? 'all' : 'confirmed')}>已確認 {composition?.pages.filter(p => p.confirmed).length ?? '—'}</Button>
        </Space>
        <Space wrap className="editor-toolbar">
          <Tag color={cp?.confirmed ? 'green' : 'orange'}>{cp?.passthrough ? '無需修復，沿用底圖' : cp?.confirmed ? '此頁已確認' : '此頁待確認'}</Tag>
          <label>羽化 <InputNumber disabled={busy || !composition} min={0} max={8} value={feather} onChange={v => void saveFeather(v || 0)} /> px</label>
          {composition && <><label>Mask 擴大 <InputNumber min={0} max={80} value={composition.settings.expand_px} onChange={v => void saveFeather(feather, {expand_px:v ?? 5})} /></label><label>差異閾值 <InputNumber min={1} max={255} value={composition.settings.threshold} onChange={v => void saveFeather(feather, {threshold:v ?? 12})} /></label><label>最小區域 <InputNumber min={1} max={10000} value={composition.settings.min_area} onChange={v => void saveFeather(feather, {min_area:v ?? 16})} /></label><Button disabled={busy} onClick={() => void saveFeather(feather)}>重算 Mask</Button></>}
        </Space>
        {cp?.warnings.map(w => <Alert key={w} type="warning" message={w} />)}
        {assignment && cp ? <RasterEditor key={`${runId}-${page.id}-${editorKey}`} ref={editor} width={page.width} height={page.height} mode="compose" compareLayout={compareLayout} viewState={composeView} onPreviewReady={confirmDisplayedPage} baseUrl={cp.base_url} previewUrl={`${cp.preview_url}&revision=${composition?.revision}`}
          candidates={candidateOptions} assignmentRle={assignment} onSave={saveComposition} onDirty={setDirty} disabled={busy || cp.passthrough} /> : <div className="compose-loading"><Spin /></div>}
      </>}
    </section></div>
  </main>
}
