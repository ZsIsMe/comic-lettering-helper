/* Standalone browser harness for exercising the production source-image cache. */
/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  clearSourceImageCache,
  getSourceImageCacheStats,
  loadSourceImage,
  scheduleSourceImagePreload,
  type SourceImageRequest,
} from '../src/source-image-cache'

type Page = SourceImageRequest & { id: string; name: string }
type LoadRecord = {
  id: string
  name: string
  index: number
  elapsedMs: number
  cacheHit: boolean
  outcome: 'hit' | 'new-load' | 'joined'
  signature: string
  loads: number
  hits: number
}
type CurrentState = {
  id: string
  name: string
  index: number
  width: number
  height: number
  loading: boolean
  error?: string
  elapsedMs?: number
  cacheHit?: boolean
  outcome?: LoadRecord['outcome']
  signature?: string
}
type SourcePreloadFixtureApi = {
  ready: () => boolean
  pageCount: () => number
  current: () => CurrentState | null
  records: () => LoadRecord[]
  stats: typeof getSourceImageCacheStats
  go: (index: number) => void
  previous: () => void
  next: () => void
  clear: () => void
}

declare global {
  interface Window {
    __sourcePreload: SourcePreloadFixtureApi
  }
}

const MAX_RECORDS = 80
let navigateImpl: (index: number) => void = () => {}
let clearImpl = () => clearSourceImageCache()
let pagesSnapshot: Page[] = []
let currentSnapshot: CurrentState | null = null
let recordsSnapshot: LoadRecord[] = []

window.__sourcePreload = {
  ready: () => !!currentSnapshot && !currentSnapshot.loading && !currentSnapshot.error,
  pageCount: () => pagesSnapshot.length,
  current: () => currentSnapshot ? structuredClone(currentSnapshot) : null,
  records: () => structuredClone(recordsSnapshot),
  stats: getSourceImageCacheStats,
  go: index => navigateImpl(index),
  previous: () => navigateImpl((currentSnapshot?.index ?? 0) - 1),
  next: () => navigateImpl((currentSnapshot?.index ?? -1) + 1),
  clear: () => clearImpl(),
}

function sampledSignature(image: ImageData) {
  let hash = 2166136261
  const step = Math.max(4, Math.floor(image.data.length / 4096 / 4) * 4)
  for (let offset = 0; offset < image.data.length; offset += step) {
    for (let channel = 0; channel < 4; channel++) {
      hash ^= image.data[offset + channel]
      hash = Math.imul(hash, 16777619)
    }
  }
  return `${image.width}x${image.height}:${(hash >>> 0).toString(16).padStart(8, '0')}`
}

function pageFromFile(file: File, ordinal: number, width: number, height: number): Page {
  const url = URL.createObjectURL(file)
  return { id: `${file.name}:${file.size}:${file.lastModified}:${ordinal}`, name: file.name, url, width, height }
}

function preloadWindow(pages: readonly Page[], index: number) {
  // Match ProjectWorkbench's source window: current is foreground, then next two and previous one.
  const requests = [index + 1, index + 2, index - 1].flatMap(candidate => {
    const page = pages[candidate]
    return page ? [{ url: page.url, width: page.width, height: page.height }] : []
  })
  scheduleSourceImagePreload(requests)
}

function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const objectUrls = useRef<string[]>([])
  const batchGeneration = useRef(0)
  const displayGeneration = useRef(0)
  const signatures = useRef(new Map<string, string>())
  const [pages, setPages] = useState<Page[]>([])
  const [index, setIndex] = useState(0)
  const [current, setCurrent] = useState<CurrentState | null>(null)
  const [records, setRecords] = useState<LoadRecord[]>([])
  const [stats, setStats] = useState(getSourceImageCacheStats())
  const [status, setStatus] = useState('請選擇多張 JPG／PNG 真實圖片')
  const [requestWidth, setRequestWidth] = useState(1121)
  const [requestHeight, setRequestHeight] = useState(1600)

  pagesSnapshot = pages
  currentSnapshot = current
  recordsSnapshot = records
  navigateImpl = next => setIndex(value => Math.max(0, Math.min(pages.length - 1, Number.isFinite(next) ? Math.trunc(next) : value)))
  clearImpl = () => {
    clearSourceImageCache()
    setStats(getSourceImageCacheStats())
  }

  useEffect(() => {
    const timer = window.setInterval(() => setStats(getSourceImageCacheStats()), 50)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => () => {
    clearSourceImageCache()
    for (const url of objectUrls.current) URL.revokeObjectURL(url)
  }, [])

  useEffect(() => {
    const page = pages[index]
    if (!page) { setCurrent(null); return }
    const generation = ++displayGeneration.current
    const started = performance.now()
    setCurrent({ id: page.id, name: page.name, index, width: page.width, height: page.height, loading: true })

    const before = getSourceImageCacheStats()
    const request = loadSourceImage(page.url, page.width, page.height)
    // Cache counters change synchronously when the foreground request is accepted,
    // before background preload completion can make this classification ambiguous.
    const accepted = getSourceImageCacheStats()
    const cacheHit = accepted.hits > before.hits
    const outcome: LoadRecord['outcome'] = cacheHit ? 'hit' : accepted.loads > before.loads ? 'new-load' : 'joined'
    preloadWindow(pages, index)

    void request.then(image => {
      if (generation !== displayGeneration.current) return
      const elapsedMs = performance.now() - started
      const signature = sampledSignature(image)
      const expected = signatures.current.get(page.id)
      if (expected && expected !== signature) throw new Error(`像素簽章不一致：預期 ${expected}，收到 ${signature}`)
      signatures.current.set(page.id, signature)
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = image.width
      canvas.height = image.height
      canvas.getContext('2d')!.putImageData(image, 0, 0)
      const totals = getSourceImageCacheStats()
      const record: LoadRecord = { id: page.id, name: page.name, index, elapsedMs, cacheHit, outcome, signature, loads: totals.loads, hits: totals.hits }
      setRecords(previous => [record, ...previous].slice(0, MAX_RECORDS))
      setCurrent({ id: page.id, name: page.name, index, width: page.width, height: page.height, loading: false, elapsedMs, cacheHit, outcome, signature })
      setStatus(`${index + 1}/${pages.length} ${page.name} · ${outcome} · ${elapsedMs.toFixed(1)} ms · ${signature}`)
      setStats(totals)
    }).catch(error => {
      if (generation !== displayGeneration.current) return
      const message = String(error)
      setCurrent({ id: page.id, name: page.name, index, width: page.width, height: page.height, loading: false, error: message })
      setStatus(`載入失敗：${message}`)
      setStats(getSourceImageCacheStats())
    })
  }, [pages, index])

  async function chooseFiles(files: FileList | null) {
    if (!files?.length) return
    if (!Number.isSafeInteger(requestWidth) || !Number.isSafeInteger(requestHeight) || requestWidth <= 0 || requestHeight <= 0) {
      setStatus('請輸入有效的圖片寬高')
      return
    }
    const generation = ++batchGeneration.current
    displayGeneration.current++
    setStatus(`建立 ${files.length} 張圖片的 cache requests…`)
    clearSourceImageCache()
    for (const url of objectUrls.current) URL.revokeObjectURL(url)
    objectUrls.current = []
    signatures.current.clear()
    setPages([]); setRecords([]); setIndex(0); setCurrent(null)
    try {
      const selected = [...files]
        .filter(file => /^image\/(?:jpeg|png)$/.test(file.type) || /\.(?:jpe?g|png)$/i.test(file.name))
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
      const next = selected.map((file, ordinal) => pageFromFile(file, ordinal, requestWidth, requestHeight))
      if (generation !== batchGeneration.current) {
        for (const page of next) URL.revokeObjectURL(page.url)
        return
      }
      if (!next.length) throw new Error('沒有可用的 JPG／PNG')
      objectUrls.current = next.map(page => page.url)
      setPages(next)
      setStatus(`已選擇 ${next.length} 張；載入第 1 張並預載相鄰圖片…`)
      setStats(getSourceImageCacheStats())
    } catch (error) {
      setStatus(`選檔失敗：${String(error)}`)
    }
  }

  return <main>
    <header>
      <strong>Source image preload probe</strong>
      <label>寬 <input aria-label="圖片寬度" type="number" min="1" value={requestWidth} onChange={event => setRequestWidth(Number(event.target.value))} /></label>
      <label>高 <input aria-label="圖片高度" type="number" min="1" value={requestHeight} onChange={event => setRequestHeight(Number(event.target.value))} /></label>
      <label>真實圖片 <input aria-label="真實圖片" type="file" multiple accept="image/jpeg,image/png,.jpg,.jpeg,.png" onChange={event => { void chooseFiles(event.currentTarget.files); event.currentTarget.value = '' }} /></label>
      <button disabled={index <= 0} onClick={() => setIndex(value => Math.max(0, value - 1))}>← 上一張</button>
      <button disabled={!pages.length || index >= pages.length - 1} onClick={() => setIndex(value => Math.min(pages.length - 1, value + 1))}>下一張 →</button>
      <button disabled={!pages.length} onClick={() => clearImpl()}>清除 cache</button>
      <span data-testid="current-page">{current ? `${current.index + 1}/${pages.length} ${current.name} ${current.width}×${current.height}` : '未載入'}</span>
      <output data-testid="status">{status}</output>
      <output data-testid="cache-stats">{`hits=${stats.hits} misses=${stats.misses} loads=${stats.loads} failures=${stats.failures} evictions=${stats.evictions} entries=${stats.entries} decoded=${stats.decodedBytes} queued=${stats.queued} preloading=${stats.preloading}`}</output>
    </header>
    <section className="viewer">
      <canvas ref={canvasRef} aria-label="目前原圖" />
      <output data-testid="load-history" hidden={!records.length}>{records.map(record =>
        `${record.index + 1}. ${record.name} ${record.outcome} cacheHit=${record.cacheHit} ${record.elapsedMs.toFixed(1)}ms ${record.signature} totals(loads=${record.loads},hits=${record.hits})`,
      ).join('\n')}</output>
    </section>
  </main>
}

createRoot(document.getElementById('root')!).render(<App />)
