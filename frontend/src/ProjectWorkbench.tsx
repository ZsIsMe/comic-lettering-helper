import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Card, Checkbox, Empty, Input, InputNumber, List, Modal, Progress, Select, Space, Spin, Steps, Tag, Typography, message } from 'antd'
import LegacyBatch from './App'
import { ImagePicker } from './ImagePicker'
import { RasterEditor, type RasterHandle, type RasterSave } from './RasterEditor'
import { active, api, assetUrl, json, projectUrl, workflowOptions, type Composition, type Project, type Run, type Workflow } from './workbench-api'

const { Title, Text } = Typography
const remember = 'comic-workbench-project'
type Detection = { state: string; message?: string; error?: string; progress?: { stage: string; completed: number; total: number } }
const detectionLabels: Record<string, string> = { queued: '等待檢測', check: '準備檢測', checking: '準備檢測', rf: '識別文字區域', mangalens: '識別文字範圍', classify: '整理檢測結果', saving: '保存檢測結果', cancelling: '正在停止檢測', recovery_required: '檢查上次檢測狀態' }
const detectionActive = (state: string) => ['queued', 'checking', 'rf', 'mangalens', 'classify', 'saving', 'cancelling', 'recovery_required'].includes(state)
function bytes(value = 0) { return value > 1024 ** 3 ? `${(value / 1024 ** 3).toFixed(1)} GB` : `${(value / 1024 ** 2).toFixed(1)} MB` }

export default function ProjectWorkbench() {
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [legacy, setLegacy] = useState(false)
  const [projects, setProjects] = useState<Project[]>([])
  const [current, setCurrent] = useState<Project | null>(null)
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [name, setName] = useState(''); const [sources, setSources] = useState<File[]>([]); const [masks, setMasks] = useState<File[]>([])
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
  function open(project: Project) { localStorage.setItem(remember, project.id); setCurrent(project) }
  async function action(callback: () => Promise<void>) {
    setBusy(true); setError('')
    try { await callback() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  async function create() {
    await action(async () => {
      const body = new FormData(); body.append('name', name || '未命名項目')
      for (const f of sources) body.append('source_files', f, f.name)
      for (const f of masks) body.append('mask_files', f, f.name)
      const project = await api<Project>('/api/projects', { method: 'POST', body })
      setCreateOpen(false); setSources([]); setMasks([]); setName(''); await reload(); open(project)
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
  if (current) return <ProjectWorkspace key={current.id} initial={current} gpuOwner={gpuOwner} onExit={async () => { localStorage.removeItem(remember); setCurrent(null); await reload() }} />
  return <main className="app-shell project-home">
    <header className="project-header"><div><Text className="eyebrow">COMIC WORKSPACE</Text><Title>漫畫修圖項目</Title><Text>保存原圖、修補與合成進度，下次打開接著編輯。</Text></div><Space wrap>
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
    <Modal title="新建漫畫項目" open={createOpen} onCancel={() => { if (!busy && !picking) setCreateOpen(false) }} onOk={() => void create()} okText="建立項目" confirmLoading={busy} okButtonProps={{ disabled: !sources.length || !!gpuOwner || picking }}>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        <Input aria-label="項目名稱" placeholder="項目名稱" value={name} onChange={e => setName(e.target.value)} maxLength={80} />
        <div><p>原圖（必須）· 已選 {sources.length} 張</p><ImagePicker disabled={busy || picking || !!gpuOwner} onBusyChange={setPicking} label="原圖" onSelect={(files, folderName) => { setSources(files); if (!name) setName(folderName || files[0]?.name.replace(/\.[^.]+$/, '') || '') }} /></div>
        <div><p>Mask（可選）· 已選 {masks.length} 張</p><ImagePicker disabled={busy || picking || !!gpuOwner} onBusyChange={setPicking} label="Mask" mask onSelect={setMasks} /></div>
        <Text type="secondary">已有 Mask 可直接進入批量修復；只上傳原圖則先自動檢測或人工編輯。資料夾僅匯入第一層，每次選擇整批取代。</Text>
      </Space>
    </Modal>
  </main>
}

function ProjectWorkspace({ initial, gpuOwner, onExit }: { initial: Project; gpuOwner: string | null; onExit: () => Promise<void> }) {
  const [modal, modalHolder] = Modal.useModal()
  const [project, setProject] = useState(initial)
  const [pageIndex, setPageIndex] = useState(0); const [step, setStep] = useState(0)
  const [workflow, setWorkflow] = useState<Workflow[]>(['flux2klein_lanpaint'])
  const [run, setRun] = useState<Run | null>(null); const [runId, setRunId] = useState(initial.current_run_id)
  const [composition, setComposition] = useState<Composition | null>(null)
  const [assignment, setAssignment] = useState<number[][] | null>(null)
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [dirty, setDirty] = useState(false)
  const [editorKey, setEditorKey] = useState(0)
  const [availability, setAvailability] = useState<{ available?: boolean; ready?: boolean; errors?: string[]; message?: string; device?: string } | null>(null)
  const [detection, setDetection] = useState<Detection | null>(null)
  const [feather, setFeather] = useState(1)
  const editor = useRef<RasterHandle>(null)
  const editRevision = useRef(initial.pages[0].edit_revision)
  const compositionRevision = useRef(0)
  const navigating = useRef(false)
  const wasDetecting = useRef(initial.state === 'detecting')
  const page = project.pages[pageIndex]
  const currentPageId = useRef(page.id); currentPageId.current = page.id
  const url = projectUrl(project.id)
  const compUrl = `${url}/compositions/${runId}`
  const detecting = project.state === 'detecting' || !!(detection && detectionActive(detection.state))
  const running = !!(run && active(run.state))

  async function execute(fn: () => Promise<void>) {
    if (navigating.current) return
    navigating.current = true
    setBusy(true); setError('')
    try { await fn() } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { navigating.current = false; setBusy(false) }
  }
  async function flush() { return !editor.current || await editor.current.flush() }
  async function reloadProject() { const p = await api<Project>(url); setProject(p); return p }
  const loadComposition = useCallback(async () => {
    if (!runId) return
    const c = await api<Composition>(`${projectUrl(initial.id)}/compositions/${runId}`)
    compositionRevision.current = c.revision; setComposition(c); setFeather(c.settings.feather_px)
    return c
  }, [initial.id, runId])

  useEffect(() => {
    void api<typeof availability>('/api/detection/availability').then(setAvailability).catch(() => setAvailability(null))
  }, [])
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
          setProject(p); setEditorKey(k => k + 1)
        }
      }
      wasDetecting.current = nowActive
    }).catch(() => {})
    refresh(); const timer = setInterval(refresh, 2000)
    return () => { live = false; clearInterval(timer) }
  }, [url])
  useEffect(() => {
    if (step !== 2 || !runId) return
    let live = true; setAssignment(null)
    void (async () => {
      await loadComposition()
      const a = await api<{ revision: number; assignment_rle: number[][] }>(`${compUrl}/pages/${page.id}/assignment`)
      if (live) { compositionRevision.current = a.revision; setAssignment(a.assignment_rle) }
    })().catch(err => { if (live) setError(String(err)) })
    return () => { live = false }
  }, [step, runId, page.id, compUrl, loadComposition, editorKey])

  async function navigate(nextStep: number, nextPage = pageIndex) {
    if (!await flush()) return
    if (nextStep === 2 && run?.state !== 'completed') { message.info('修復完成後即可比較合成'); return }
    const p = await reloadProject()
    editRevision.current = p.pages[nextPage].edit_revision
    setPageIndex(nextPage); setStep(nextStep); setDirty(false); setEditorKey(k => k + 1)
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
    compositionRevision.current = c.revision; setComposition(c)
  }
  async function detect() {
    await execute(async () => {
      if (!await flush()) return
      const p = await reloadProject()
      await api(`${url}/detect`, json('POST', { expected_revision: p.revision }))
      wasDetecting.current = true
      setProject({ ...p, state: 'detecting' }); setDetection({ state: 'queued', message: '等待偵測' })
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
  async function confirmPage(all = false) {
    await execute(async () => {
      if (!await flush()) return
      let c: Composition
      if (all) c = await api<Composition>(`${compUrl}/confirm`, json('POST', { revision: compositionRevision.current }))
      else {
        const a = await api<{ assignment_rle: number[][] }>(`${compUrl}/pages/${page.id}/assignment`)
        c = await api<Composition>(`${compUrl}/pages/${page.id}`, json('PUT', { revision: compositionRevision.current, assignment_rle: a.assignment_rle, confirmed: true, settings: { ...composition!.settings, feather_px: feather } }))
      }
      compositionRevision.current = c.revision; setComposition(c)
    })
  }
  async function saveFeather(value: number) {
    await execute(async () => {
      if (!await flush() || !composition) return
      const a = await api<{ assignment_rle: number[][] }>(`${compUrl}/pages/${page.id}/assignment`)
      const c = await api<Composition>(`${compUrl}/pages/${page.id}`, json('PUT', { revision: compositionRevision.current,
        assignment_rle: a.assignment_rle, confirmed: false, settings: { ...composition.settings, feather_px: value } }))
      compositionRevision.current = c.revision; setComposition(c); setFeather(value)
    })
  }
  async function download(path: string) {
    if (!await flush()) return
    window.location.assign(path)
  }
  const cp = composition?.pages.find(item => item.page_id === page.id)
  const candidateOptions = cp?.candidates.filter(item => item.available).map(item => ({ code: item.code,
    label: workflowOptions.find(w => w.value === item.workflow)!.label,
    url: `${compUrl}/pages/${page.id}/image?source=${item.workflow}`, diffUrl: `${compUrl}/pages/${page.id}/image?source=diff:${item.workflow}`,
  })) || []
  return <main className="app-shell project-workspace">
    {modalHolder}
    <header className="project-header"><div><Button onClick={() => void execute(async () => { if (await flush()) await onExit() })}>← 項目列表</Button><Title level={2}>{project.name}</Title><Text>{project.pages.length} 頁 · {dirty ? '有未保存修改' : '項目保存在伺服器'}</Text></div>
      <Space wrap><Button onClick={() => { let nextName = project.name; modal.confirm({ title: '項目名稱', content: <Input defaultValue={nextName} onChange={e => { nextName = e.target.value }} />, onOk: async () => { if (!await flush()) throw new Error('請先保存'); const p = await reloadProject(); setProject(await api<Project>(url, json('PATCH', { name: nextName, expected_revision: p.revision }))) } }) }}>重命名</Button>
        <Button disabled={busy || !!gpuOwner || detecting} onClick={() => void download(`${url}/export`)}>導出項目</Button>
      </Space></header>
    {error && <Alert type="error" showIcon closable onClose={() => setError('')} message={error} />}
    <Steps current={step} onChange={value => void execute(() => navigate(value))} items={[{ title: '準備與編輯' }, { title: '批量修復' }, { title: '比較合成', disabled: run?.state !== 'completed' }]} />
    <div className="project-body"><aside className="page-list">
      <List dataSource={project.pages} renderItem={(item, index) => <List.Item className={index === pageIndex ? 'selected' : ''} onClick={() => void execute(() => navigate(step, index))}>
        <img src={assetUrl(project.id, item.thumbnail || item.source)} alt="" loading="lazy" /><div><strong>{item.filename}</strong><small>{item.mask_ready ? 'Mask 已備妥' : '待偵測／編輯'}</small></div>
      </List.Item>} />
    </aside><section className="project-content">
      {step === 0 && <>
        <Space wrap className="editor-toolbar"><Button type="primary" loading={detecting} disabled={!!gpuOwner || busy || detecting || !(availability?.available ?? availability?.ready)} onClick={() => void detect()}>自動檢測</Button>
          <Button disabled={detecting || !!gpuOwner} onClick={() => void download(`${url}/export-pair`)}>導出底圖＋Mask</Button>
          <Button onClick={() => void execute(() => navigate(1))}>前往批量修復 →</Button>
        </Space>
        {!(availability?.available ?? availability?.ready) && <Alert type="info" message="自動檢測暫不可用，可先手動編輯。" />}
        {detecting ? <Alert type="info" showIcon message={detection?.progress ? `${detectionLabels[detection.state] || detectionLabels[detection.progress.stage] || '自動檢測中'} · ${detection.progress.completed} / ${detection.progress.total} 頁` : detectionLabels[detection?.state || ''] || '自動檢測中，完成後即可編輯'} action={<Button danger onClick={() => void execute(async () => { await api(`${url}/detection/${detection?.state === 'recovery_required' ? 'recover' : 'cancel'}`, { method: 'POST' }); await reloadProject(); setEditorKey(k => k + 1) })}>{detection?.state === 'recovery_required' ? '檢查恢復' : '停止偵測'}</Button>} /> : <RasterEditor key={`${page.id}-${editorKey}`} ref={editor} width={page.width} height={page.height} mode="edit"
          baseUrl={assetUrl(project.id, page.source)} overlayUrl={`${assetUrl(project.id, page.overlay)}?v=${page.edit_revision}`} otherUrl={`${assetUrl(project.id, page.other)}?v=${page.edit_revision}`} editedUrl={`${assetUrl(project.id, page.edited)}?v=${page.edit_revision}`}
          detectedTextUrl={page.detected_text ? assetUrl(project.id, page.detected_text) : undefined}
          onSave={saveEdit} onDirty={setDirty} disabled={busy} />}
        {detection?.error && <Alert type="error" message="自動檢測未完成，請重試；若持續失敗，請聯絡管理員查看檢測日誌。" />}
      </>}
      {step === 1 && <>
        <Title level={3}>批量修復</Title><p>確認後固定本次底圖與 Mask。全黑 Mask 直接沿用底圖，最終仍輸出全部 {project.pages.length} 頁。</p>
        {project.runs.length > 0 && <Select className="run-select" aria-label="修復記錄" value={runId} onChange={id => { setRunId(id); setComposition(null) }} options={project.runs.map(r => ({ value: r.id, label: `${new Date(r.created_at).toLocaleString()} · ${r.workflows.length} 套流程` }))} />}
        {run && <Card title={run.name} className="run-card"><Tag>{run.state}</Tag><Progress percent={Math.round(run.completed_total / Math.max(1, run.total_runs) * 100)} /><p>{run.message}</p>{run.error && <Alert type="error" message={run.error} />}
          <Space wrap>{run.download_ready && <Button disabled={!!gpuOwner} href={`/api/jobs/${run.id}/download`}>下載候選結果</Button>}
            {running && <><Button disabled={!run.completed_total} href={`/api/jobs/${run.id}/download-current`}>下載目前結果</Button><Button danger onClick={() => modal.confirm({ title: '放棄修復任務？', content: '已完成圖片會保留。', onOk: async () => { setRun(await api<Run>(`/api/jobs/${run.id}/abandon`, { method: 'POST' })) } })}>放棄任務</Button></>}
            {run.state === 'completed' && <Button type="primary" onClick={() => void execute(() => navigate(2))}>比較與局部合成 →</Button>}
          </Space>{run.archive_path && <p className="server-path">伺服器下載路徑：{run.archive_path}</p>}
        </Card>}
        {!running && <Card title="建立新的修復版本"><Checkbox.Group value={workflow} onChange={values => setWorkflow(values as Workflow[])} options={workflowOptions} />
          <p>{project.pages.filter(p => p.mask_ready).length} / {project.pages.length} 頁 Mask 已備妥</p>
          <Button type="primary" loading={busy} disabled={!!gpuOwner || detecting || !workflow.length || project.pages.some(p => !p.mask_ready)} onClick={() => void submit()}>開始批量修復</Button>
        </Card>}
      </>}
      {step === 2 && <>
        <Space wrap className="editor-toolbar"><Text>{composition?.pages.filter(p => p.confirmed).length || 0} / {project.pages.length} 頁已確認</Text>
          <Tag color={cp?.confirmed ? 'green' : 'orange'}>{cp?.passthrough ? '無需修復，沿用底圖' : cp?.confirmed ? '此頁已確認' : '此頁待確認'}</Tag>
          <label>羽化 <InputNumber disabled={busy || !composition} min={0} max={8} value={feather} onChange={v => void saveFeather(v || 0)} /> px</label>
          <Button disabled={!composition || busy || dirty} onClick={() => void confirmPage()}>確認此頁</Button>
          <Button disabled={!composition || busy || dirty} onClick={() => void confirmPage(true)}>確認全部目前預覽</Button>
          <Button type="primary" disabled={!composition || busy || dirty || !!gpuOwner || composition.pages.some(p => !p.confirmed)} onClick={() => void execute(async () => { if (!await flush()) return; const result = await api<{ download_url: string }>(`${compUrl}/export`, json('POST', { revision: compositionRevision.current })); window.location.assign(result.download_url) })}>只導出成品</Button>
        </Space>
        {cp?.warnings.map(w => <Alert key={w} type="warning" message={w} />)}
        {assignment && cp ? <RasterEditor key={`${runId}-${page.id}-${editorKey}`} ref={editor} width={page.width} height={page.height} mode="compose" baseUrl={cp.base_url}
          candidates={candidateOptions} assignmentRle={assignment} onSave={saveComposition} onDirty={setDirty} disabled={busy || cp.passthrough} /> : <Spin />}
        {cp && <details className="saved-preview"><summary>查看已保存的成品效果（包含羽化）</summary><img src={`${cp.preview_url}&revision=${composition?.revision}`} alt="已保存成品" /></details>}
      </>}
    </section></div>
  </main>
}
