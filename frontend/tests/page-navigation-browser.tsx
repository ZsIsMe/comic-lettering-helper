/* Standalone full ProjectWorkbench navigation harness; production never imports this file. */
/* eslint-disable react-refresh/only-export-components */
import { StrictMode, useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import ProjectWorkbench from '../src/ProjectWorkbench'
import { clearSourceImageCache, getSourceImageCacheStats } from '../src/source-image-cache'
import { clearPageLoadRecords, getPageLoadRecords, subscribePageLoads, type PageLoadRecord } from '../src/page-load-performance'
import type { Project } from '../src/workbench-api'
import '../src/styles.css'

type RequestLog = { at: number; method: string; kind: string; pageId?: string; url: string }
type MockProject = {
  project: Project
  assets: Map<string, Blob>
  assetUrls: Map<string, string>
  saveCounts: Map<string, number>
  resolveAsset: (url: string) => { path: string; blob: Blob; pageId?: string } | null
  dispose: () => void
}
type FixtureApi = {
  ready: () => boolean
  mode: () => 'baseline' | 'optimized'
  pageLoads: () => PageLoadRecord[]
  requests: () => RequestLog[]
  cache: typeof getSourceImageCacheStats
  clearMetrics: () => void
}

declare global {
  interface Window { __pageNavigationFixture: FixtureApi }
}

const PROJECT_ID = 'page-navigation-fixture'
const query = new URLSearchParams(location.search)
const mode = query.get('pageLoadMode') === 'baseline' ? 'baseline' : 'optimized'
const nativeFetch = window.fetch.bind(window)
const NativeImage = window.Image
const NativeWorker = window.Worker
let pageLoadSnapshot: PageLoadRecord[] = []
let requestSnapshot: RequestLog[] = []
let workerCounts = { constructed: 0, terminated: 0, active: 0 }
const workerListeners = new Set<() => void>()
const emitWorkerCounts = () => { for (const listener of workerListeners) listener() }

window.Worker = new Proxy(NativeWorker, {
  construct(Target, args: ConstructorParameters<typeof Worker>) {
    const worker = Reflect.construct(Target, args, Target) as Worker
    let terminated = false
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => {
      if (!terminated) {
        terminated = true
        workerCounts = { ...workerCounts, terminated: workerCounts.terminated + 1, active: workerCounts.active - 1 }
        emitWorkerCounts()
      }
      terminate()
    }
    workerCounts = { ...workerCounts, constructed: workerCounts.constructed + 1, active: workerCounts.active + 1 }
    emitWorkerCounts()
    return worker
  },
}) as typeof Worker

window.__pageNavigationFixture = {
  ready: () => pageLoadSnapshot.some(record => record.status === 'ready'),
  mode: () => mode,
  pageLoads: () => structuredClone(pageLoadSnapshot),
  requests: () => structuredClone(requestSnapshot),
  cache: getSourceImageCacheStats,
  clearMetrics: () => clearPageLoadRecords(),
}

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'Content-Type': 'application/json' },
})

async function png(width: number, height: number, opaque: boolean) {
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d')!
  if (opaque) { context.fillStyle = '#000'; context.fillRect(0, 0, width, height) }
  return await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('fixture PNG encoding failed')), 'image/png'))
}

async function createMockProject(files: readonly File[], width: number, height: number): Promise<MockProject> {
  const transparent = await png(width, height, false)
  const opaque = await png(width, height, true)
  const assets = new Map<string, Blob>()
  const assetUrls = new Map<string, string>()
  const saveCounts = new Map<string, number>()
  const now = new Date().toISOString()
  const pages = files.map((file, index) => {
    const id = `page-${index + 1}`
    const extension = file.name.match(/\.[^.]+$/)?.[0] || '.jpg'
    const source = `source/${id}${extension}`
    const overlay = `layers/${id}/overlay.png`
    const other = `layers/${id}/other.png`
    const edited = `layers/${id}/edited.png`
    assets.set(source, file); assets.set(overlay, transparent); assets.set(other, opaque); assets.set(edited, opaque)
    return {
      id,
      stem: file.name.replace(/\.[^.]+$/, ''),
      filename: file.name,
      width,
      height,
      original: source,
      source,
      overlay,
      other,
      edited,
      edit_revision: 1,
      mask_ready: true,
      has_repair_mask: false,
    }
  })
  const project: Project = {
    id: PROJECT_ID,
    name: `Navigation fixture · ${files.length} pages`,
    revision: 1,
    state: 'ready',
    pages,
    runs: [],
    current_run_id: null,
    created_at: now,
    updated_at: now,
    storage_bytes: files.reduce((sum, file) => sum + file.size, 0),
  }
  const updateAssetUrl = (path: string, blob: Blob) => {
    const previous = assetUrls.get(path)
    if (previous) URL.revokeObjectURL(previous)
    assets.set(path, blob)
    assetUrls.set(path, URL.createObjectURL(blob))
  }
  for (const [path, blob] of assets) updateAssetUrl(path, blob)
  const resolveAsset = (rawUrl: string) => {
    const url = new URL(rawUrl, location.href)
    const prefix = `/api/projects/${PROJECT_ID}/assets/`
    if (!url.pathname.startsWith(prefix)) return null
    const path = url.pathname.slice(prefix.length).split('/').map(decodeURIComponent).join('/')
    const blob = assets.get(path)
    if (!blob) return null
    const pageId = pages.find(page => [page.source, page.overlay, page.other, page.edited].includes(path))?.id
    return { path, blob, pageId }
  }
  return {
    project,
    assets,
    assetUrls,
    saveCounts,
    resolveAsset,
    dispose: () => { for (const url of assetUrls.values()) URL.revokeObjectURL(url) },
  }
}

function installMock(mock: MockProject, onRequest: (entry: RequestLog) => void) {
  const log = (method: string, kind: string, url: string, pageId?: string) => onRequest({ at: performance.now(), method, kind, pageId, url })
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null
    const url = new URL(request?.url || String(input), location.href)
    const method = (init?.method || request?.method || 'GET').toUpperCase()
    const asset = mock.resolveAsset(url.href)
    if (asset) {
      log(method, asset.path.includes('/overlay.') ? 'overlay' : asset.path.includes('/other.') ? 'other' : asset.path.includes('/edited.') ? 'edited' : 'source', url.pathname, asset.pageId)
      return new Response(asset.blob, { status: 200, headers: { 'Content-Type': asset.blob.type || 'application/octet-stream' } })
    }
    if (url.pathname === '/api/projects' && method === 'GET') { log(method, 'projects', url.pathname); return jsonResponse([mock.project]) }
    if (url.pathname === `/api/projects/${PROJECT_ID}` && method === 'GET') { log(method, 'project', url.pathname); return jsonResponse(mock.project) }
    if (url.pathname === '/api/health') { log(method, 'health', url.pathname); return jsonResponse({ gpu_owner: null, active_job_id: null }) }
    if (url.pathname === '/api/detection/availability') {
      log(method, 'availability', url.pathname)
      return jsonResponse({ available: false, ready: false, available_without_bubbles: false, errors: ['fixture disables detection'] })
    }
    if (url.pathname === `/api/projects/${PROJECT_ID}/detection`) { log(method, 'detection', url.pathname); return jsonResponse(null) }
    const scopeMatch = url.pathname.match(new RegExp(`^/api/projects/${PROJECT_ID}/pages/([^/]+)/repair-scope$`))
    if (scopeMatch && method === 'PUT') {
      const update = JSON.parse(String(init?.body))
      const scope = mock.project.repair_scope || { enabled: false, revision: 0, pages: {} }
      if (scope.revision !== update.revision) return jsonResponse({ detail: '作用範圍修訂衝突' }, 409)
      scope.enabled = update.enabled; scope.revision++
      for (const p of mock.project.pages) if (update.apply_all || p.id === scopeMatch[1]) scope.pages[p.id] = { ...update.rect }
      mock.project.repair_scope = scope; mock.project.revision++
      log(method, 'scope-save', url.pathname, scopeMatch[1])
      return jsonResponse(mock.project)
    }
    const save = url.pathname.match(new RegExp(`^/api/projects/${PROJECT_ID}/pages/([^/]+)/edit$`))
    if (save && method === 'PUT') {
      const pageId = decodeURIComponent(save[1])
      const page = mock.project.pages.find(item => item.id === pageId)
      if (!page) return jsonResponse({ detail: 'fixture page not found' }, 404)
      const form = init?.body instanceof FormData ? init.body : request ? await request.clone().formData() : null
      if (!form) return jsonResponse({ detail: 'fixture expected multipart edit' }, 400)
      for (const key of ['overlay', 'other', 'edited'] as const) {
        const blob = form.get(key)
        const path = page[key]
        if (blob instanceof Blob && path) {
          const previous = mock.assetUrls.get(path)
          if (previous) URL.revokeObjectURL(previous)
          mock.assets.set(path, blob)
          mock.assetUrls.set(path, URL.createObjectURL(blob))
        }
      }
      page.edit_revision++
      mock.saveCounts.set(pageId, (mock.saveCounts.get(pageId) || 0) + 1)
      mock.project.revision++
      mock.project.updated_at = new Date().toISOString()
      log(method, 'save', url.pathname, pageId)
      return jsonResponse(mock.project)
    }
    log(method, 'unexpected', `${url.pathname}${url.search}`)
    return jsonResponse({ detail: `Unhandled fixture request: ${method} ${url.pathname}` }, 404)
  }

  const ImageProxy = new Proxy(NativeImage, {
    construct(Target, args: ConstructorParameters<typeof Image>) {
      const image = new Target(...args)
      const descriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!
      Object.defineProperty(image, 'src', {
        configurable: true,
        enumerable: true,
        get: () => descriptor.get!.call(image),
        set: (value: string) => {
          const asset = mock.resolveAsset(value)
          if (asset) {
            const kind = asset.path.includes('/overlay.') ? 'overlay' : asset.path.includes('/other.') ? 'other' : asset.path.includes('/edited.') ? 'edited' : 'source-image'
            log('IMG', kind, new URL(value, location.href).pathname, asset.pageId)
            descriptor.set!.call(image, mock.assetUrls.get(asset.path)!)
          } else descriptor.set!.call(image, value)
        },
      })
      return image
    },
  })
  window.Image = ImageProxy as typeof Image
  return () => { window.fetch = nativeFetch; window.Image = NativeImage }
}

function App() {
  const cleanupMock = useRef<(() => void) | null>(null)
  const mock = useRef<MockProject | null>(null)
  const selectionGeneration = useRef(0)
  const [started, setStarted] = useState(false)
  const [fixtureKey, setFixtureKey] = useState(0)
  const [width, setWidth] = useState(1121)
  const [height, setHeight] = useState(1600)
  const [status, setStatus] = useState('請選擇真實頁面；建議 15.jpg–18.jpg')
  const [pageLoads, setPageLoads] = useState<PageLoadRecord[]>([])
  const [requests, setRequests] = useState<RequestLog[]>([])
  const [workers, setWorkers] = useState(workerCounts)

  pageLoadSnapshot = pageLoads
  requestSnapshot = requests
  useEffect(() => subscribePageLoads(() => setPageLoads(getPageLoadRecords())), [])
  useEffect(() => {
    const update = () => setWorkers({ ...workerCounts })
    workerListeners.add(update)
    return () => { workerListeners.delete(update) }
  }, [])
  useEffect(() => () => {
    cleanupMock.current?.()
    mock.current?.dispose()
    clearSourceImageCache()
    localStorage.removeItem('comic-workbench-project')
  }, [])

  const changeMode = (next: string) => {
    const url = new URL(location.href)
    if (next === 'baseline') url.searchParams.set('pageLoadMode', 'baseline')
    else url.searchParams.delete('pageLoadMode')
    location.assign(url.href)
  }

  async function chooseFiles(list: FileList | null) {
    if (!list?.length) return
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) { setStatus('請輸入有效寬高'); return }
    const files = [...list]
      .filter(file => /^image\/(?:jpeg|png)$/.test(file.type) || /\.(?:jpe?g|png)$/i.test(file.name))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    if (!files.length) { setStatus('沒有可用的 JPG／PNG'); return }
    const generation = ++selectionGeneration.current
    setStatus(`建立 ${files.length} 頁 mock project…`)
    setStarted(false)
    cleanupMock.current?.(); cleanupMock.current = null
    mock.current?.dispose(); mock.current = null
    clearSourceImageCache(); clearPageLoadRecords(); localStorage.removeItem('comic-workbench-project')
    const next = await createMockProject(files, width, height)
    if (generation !== selectionGeneration.current) { next.dispose(); return }
    mock.current = next
    setRequests([])
    cleanupMock.current = installMock(next, entry => setRequests(previous => [...previous.slice(-99), entry]))
    localStorage.setItem('comic-workbench-project', PROJECT_ID)
    setStarted(true); setFixtureKey(value => value + 1)
    setStatus(`${files.length} 頁 ready · ${width}×${height} · ${mode}`)
  }

  const latest = pageLoads.at(-1)
  const currentPage = mock.current?.project.pages.find(page => page.id === latest?.pageId) || mock.current?.project.pages[0]
  const requestCounts = requests.reduce<Record<string, number>>((counts, request) => {
    counts[request.kind] = (counts[request.kind] || 0) + 1
    return counts
  }, {})
  const saveRecords = requests.filter(request => request.kind === 'save')
  return <div className="page-navigation-fixture">
    <header>
      <strong>ProjectWorkbench page navigation probe</strong>
      <label>模式 <select aria-label="量測模式" value={mode} onChange={event => changeMode(event.target.value)}><option value="optimized">optimized</option><option value="baseline">baseline</option></select></label>
      <label>寬 <input aria-label="圖片寬度" type="number" min="1" value={width} disabled={started} onChange={event => setWidth(Number(event.target.value))} /></label>
      <label>高 <input aria-label="圖片高度" type="number" min="1" value={height} disabled={started} onChange={event => setHeight(Number(event.target.value))} /></label>
      <label>真實頁面 <input aria-label="真實頁面" type="file" multiple accept="image/jpeg,image/png,.jpg,.jpeg,.png" onChange={event => { void chooseFiles(event.currentTarget.files); event.currentTarget.value = '' }} /></label>
      <button onClick={() => { clearPageLoadRecords(); setRequests([]) }}>清除量測</button>
      <span data-testid="fixture-status">{status}</span>
      <span data-testid="worker-counts">Workers 建立 {workers.constructed} · 終止 {workers.terminated} · 活躍 {workers.active}</span>
      <span data-testid="current-save-state">{currentPage ? `${currentPage.filename} · saves ${mock.current?.saveCounts.get(currentPage.id) || 0} · revision ${currentPage.edit_revision}` : '尚無頁面保存狀態'}</span>
      <output data-testid="cache-stats">{JSON.stringify(getSourceImageCacheStats())}</output>
      <output className="fixture-log" data-testid="page-load-records">{latest ? JSON.stringify(latest) : '尚無 page load record'}</output>
      <output className="fixture-log" data-testid="page-load-history">{pageLoads.length ? pageLoads.map(record => JSON.stringify(record)).join('\n') : '尚無切頁歷史'}</output>
      <output className="fixture-log" data-testid="request-summary">{requests.length
        ? `counts ${JSON.stringify(requestCounts)}\nsaves ${saveRecords.map(record => `${record.pageId}@${record.at.toFixed(1)}ms`).join(', ') || 'none'}\nrecent ${requests.slice(-12).map(record => `${record.method} ${record.kind}${record.pageId ? `:${record.pageId}` : ''}`).join(' | ')}`
        : '尚無 request/save records'}</output>
    </header>
    {started && <ProjectWorkbench key={fixtureKey} />}
  </div>
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
