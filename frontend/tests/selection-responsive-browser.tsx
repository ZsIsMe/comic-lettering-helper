/* This standalone browser harness intentionally exports no reusable React component. */
/* eslint-disable react-refresh/only-export-components */
import { createRef, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { ConfigProvider } from 'antd'
import { RasterEditor, type RasterHandle, type RasterSave } from '../src/RasterEditor'
import '../src/styles.css'

type FixtureMetrics = {
  elapsedMs: number
  frames: number[]
  pointerToRaf: number[]
  pointerToLeftPaint: number[]
  pointerToCanvasFrame: number[]
  pointerToScroll: number[]
  eventDurations: number[]
  longTasks: number[]
}
type FixtureApi = {
  ready: boolean
  width: number
  height: number
  saveCount: number
  resetMetrics: () => void
  metrics: () => FixtureMetrics
  flush: () => Promise<boolean>
  reopen: () => Promise<void>
  workerDelay: () => number
  setWorkerDelay: (delayMs: number) => void
  setStress: (workers?: number, burnMs?: number, periodMs?: number) => void
  stopStress: () => void
}

declare global {
  interface Window {
    __selectionResponsive: FixtureApi
  }
}

const query = new URLSearchParams(location.search)
const square4k = query.get('preset') === 'square4k'
const DEFAULT_WIDTH = square4k ? 4096 : 2048
const DEFAULT_HEIGHT = square4k ? 4096 : 3072
const INITIAL_WORKER_DELAY = Math.max(0, Number(query.get('workerDelay') || 0))
const cap = <T,>(values: T[], value: T) => { if (values.length < 20_000) values.push(value) }

// The harness always wraps Worker so delayed delivery can be enabled or disabled
// on an already mounted editor. Production code never imports this file.
const NativeWorker = window.Worker
let workerDelayMs = INITIAL_WORKER_DELAY
const delayedWorkers = new Set<{ flushPending: () => void }>()
function setHarnessWorkerDelay(delayMs: number) {
  workerDelayMs = Math.max(0, Number.isFinite(delayMs) ? delayMs : 0)
  if (!workerDelayMs) for (const worker of delayedWorkers) worker.flushPending()
}
if (NativeWorker) {
  class DelayedWorker {
    private worker: Worker
    private wrappers = new Map<EventListenerOrEventListenerObject, EventListener>()
    private deliveries: { timer: ReturnType<typeof setTimeout>; deliver: () => void }[] = []
    onerror: ((this: Worker, ev: ErrorEvent) => unknown) | null = null
    onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null
    private messageHandler: ((this: Worker, ev: MessageEvent) => unknown) | null = null
    constructor(url: string | URL, options?: WorkerOptions) {
      this.worker = new NativeWorker(url, options)
      delayedWorkers.add(this)
      this.worker.onerror = event => this.onerror?.call(this as unknown as Worker, event)
      this.worker.onmessageerror = event => this.onmessageerror?.call(this as unknown as Worker, event)
      this.worker.onmessage = event => this.schedule(() => this.messageHandler?.call(this as unknown as Worker, event))
    }
    get onmessage() { return this.messageHandler }
    set onmessage(value) { this.messageHandler = value }
    postMessage(message: unknown, options?: StructuredSerializeOptions | Transferable[]) { this.worker.postMessage(message, options as StructuredSerializeOptions) }
    terminate() { this.worker.terminate(); this.clearPending(); delayedWorkers.delete(this) }
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      if (!listener) return
      if (type !== 'message') { this.worker.addEventListener(type, listener, options); return }
      const wrapped: EventListener = event => this.schedule(() => typeof listener === 'function' ? listener.call(this, event) : listener.handleEvent(event))
      this.wrappers.set(listener, wrapped); this.worker.addEventListener(type, wrapped, options)
    }
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
      if (!listener) return
      this.worker.removeEventListener(type, this.wrappers.get(listener) || listener, options); this.wrappers.delete(listener)
    }
    dispatchEvent(event: Event) { return this.worker.dispatchEvent(event) }
    flushPending() {
      const pending = this.deliveries.splice(0)
      for (const item of pending) { clearTimeout(item.timer); item.deliver() }
    }
    private clearPending() {
      for (const item of this.deliveries) clearTimeout(item.timer)
      this.deliveries = []
    }
    private schedule(deliver: () => void) {
      if (!workerDelayMs) { deliver(); return }
      const item = { timer: 0 as unknown as ReturnType<typeof setTimeout>, deliver }
      item.timer = setTimeout(() => {
        const index = this.deliveries.indexOf(item)
        if (index >= 0) this.deliveries.splice(index, 1)
        deliver()
      }, workerDelayMs)
      this.deliveries.push(item)
    }
  }
  window.Worker = DelayedWorker as unknown as typeof Worker
}

let measuring = false
let measureStart = 0
let lastFrame = 0
let pointerAt = -1
let canvasActionAt = -1
let canvasActionBaseline: number | null = null
let pointerPending = false
let metrics: FixtureMetrics = { elapsedMs: 0, frames: [], pointerToRaf: [], pointerToLeftPaint: [], pointerToCanvasFrame: [], pointerToScroll: [], eventDurations: [], longTasks: [] }
let stressWorkers: Worker[] = []
let feedbackObserver: MutationObserver | null = null
let canvasFrameObserver: MutationObserver | null = null
let latestSaved: { overlay: Blob; other: Blob; edited: Blob } | null = null

function frame(time: number) {
  if (measuring) {
    if (lastFrame) cap(metrics.frames, time - lastFrame)
    lastFrame = time
    if (pointerPending) { cap(metrics.pointerToRaf, performance.now() - pointerAt); pointerPending = false }
  }
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)

addEventListener('pointermove', event => {
  if (!measuring) return
  pointerAt = event.timeStamp
  pointerPending = true
}, { capture: true, passive: true })

const isLeftCanvas = (target: EventTarget | null): target is HTMLCanvasElement =>
  target instanceof HTMLCanvasElement && target.getAttribute('aria-label') === 'Mask / 原圖'
const magicToolPressed = () =>
  document.querySelector('[role="group"][aria-label="編輯工具"] button[aria-pressed="true"]')?.textContent?.includes('魔法棒') === true
const startCanvasAction = (event: PointerEvent) => {
  const version = Number(event.target instanceof HTMLCanvasElement ? event.target.dataset.renderVersion : NaN)
  if (!Number.isSafeInteger(version)) return
  canvasActionAt = event.timeStamp
  canvasActionBaseline = version
}

addEventListener('pointerdown', event => {
  if (!measuring || !isLeftCanvas(event.target) || event.button !== 0 || event.metaKey || event.ctrlKey || !magicToolPressed()) return
  // Magic commits on pointerdown; waiting for pointerup can miss its completed frame.
  startCanvasAction(event)
}, { capture: true, passive: true })
addEventListener('pointerup', event => {
  if (!measuring || !isLeftCanvas(event.target) || magicToolPressed()) return
  startCanvasAction(event)
}, { capture: true, passive: true })
addEventListener('scroll', event => {
  if (!measuring || pointerAt < 0) return
  const firstScroller = document.querySelector('.canvas-scroll')
  if (event.target === firstScroller) cap(metrics.pointerToScroll, performance.now() - pointerAt)
}, { capture: true, passive: true })

try {
  new PerformanceObserver(list => {
    if (!measuring) return
    for (const entry of list.getEntries()) cap(metrics.longTasks, entry.duration)
  }).observe({ type: 'longtask', buffered: false })
  new PerformanceObserver(list => {
    if (!measuring) return
    for (const entry of list.getEntries()) if (entry.name === 'pointermove') cap(metrics.eventDurations, entry.duration)
  }).observe({ type: 'event', buffered: false, durationThreshold: 16 } as PerformanceObserverInit)
} catch { /* Event Timing and Long Tasks are optional browser capabilities. */ }

function observeLeftFeedback() {
  feedbackObserver?.disconnect()
  canvasFrameObserver?.disconnect()
  const overlay = document.querySelector('.raster-interaction')
  if (overlay) {
    feedbackObserver = new MutationObserver(() => {
      if (measuring && pointerAt >= 0) { cap(metrics.pointerToLeftPaint, performance.now() - pointerAt); pointerAt = -1 }
    })
    feedbackObserver.observe(overlay, { attributes: true, childList: true, subtree: true })
  }
  const canvas = document.querySelector<HTMLCanvasElement>('canvas[aria-label="Mask / 原圖"]')
  if (canvas) {
    canvasFrameObserver = new MutationObserver(records => {
      if (!measuring || canvasActionAt < 0 || canvasActionBaseline === null
        || !records.some(record => record.attributeName === 'data-render-version')) return
      const renderedVersion = Number(canvas.dataset.renderVersion)
      if (!Number.isSafeInteger(renderedVersion) || renderedVersion <= canvasActionBaseline) return
      cap(metrics.pointerToCanvasFrame, performance.now() - canvasActionAt)
      canvasActionAt = -1; canvasActionBaseline = null
    })
    canvasFrameObserver.observe(canvas, { attributes: true, attributeFilter: ['data-render-version'] })
  }
}

function resetMetrics() {
  metrics = { elapsedMs: 0, frames: [], pointerToRaf: [], pointerToLeftPaint: [], pointerToCanvasFrame: [], pointerToScroll: [], eventDurations: [], longTasks: [] }
  measureStart = performance.now(); lastFrame = 0; pointerAt = -1; canvasActionAt = -1; canvasActionBaseline = null; pointerPending = false; measuring = true
  observeLeftFeedback()
}
function readMetrics() {
  metrics.elapsedMs = measuring ? performance.now() - measureStart : metrics.elapsedMs
  return structuredClone(metrics)
}

function stopStress() { stressWorkers.forEach(worker => worker.terminate()); stressWorkers = [] }
function setStress(workers = 2, burnMs = 12, periodMs = 16) {
  stopStress()
  const source = `onmessage=e=>{const {burn,period}=e.data;const run=()=>{const end=performance.now()+burn;while(performance.now()<end){};setTimeout(run,Math.max(0,period-burn))};run()}`
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  for (let n = 0; n < workers; n++) { const worker = new NativeWorker(url); worker.postMessage({ burn: burnMs, period: periodMs }); stressWorkers.push(worker) }
  URL.revokeObjectURL(url)
}

async function shortHash(blobs: Blob[]) {
  const data = await new Blob(blobs).arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(digest).subarray(0, 8)].map(value => value.toString(16).padStart(2, '0')).join('')
}

async function rasterUrl(kind: 'base' | 'transparent' | 'opaque', width: number, height: number) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d', { alpha: true })!
  if (kind === 'base') {
    const gradient = context.createLinearGradient(0, 0, width, height)
    gradient.addColorStop(0, '#f8f2df'); gradient.addColorStop(1, '#c8d8e6')
    context.fillStyle = gradient; context.fillRect(0, 0, width, height)
    context.fillStyle = '#25231f'
    for (let y = 96; y < height; y += 192) context.fillRect(width * .15, y, width * .7, Math.max(4, width / 512))
  } else if (kind === 'opaque') {
    context.fillStyle = '#000'; context.fillRect(0, 0, width, height)
  } else context.clearRect(0, 0, width, height)
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error('fixture PNG failed')), 'image/png'))
  return URL.createObjectURL(blob)
}

const editor = createRef<RasterHandle>()
let saveCount = 0
let reopenImpl = async () => {}
const api: FixtureApi = {
  ready: false, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, saveCount,
  resetMetrics, metrics: readMetrics,
  flush: () => editor.current?.flush() || Promise.resolve(false),
  reopen: () => reopenImpl(), workerDelay: () => workerDelayMs, setWorkerDelay: setHarnessWorkerDelay, setStress, stopStress,
}
window.__selectionResponsive = api

function Fixture() {
  const [assets, setAssets] = useState<{ width: number; height: number; label: string; base: string; overlay: string; other: string; edited: string } | null>(null)
  const [revision, setRevision] = useState(0)
  const [saved, setSaved] = useState<{ overlay: Blob; other: Blob; edited: Blob } | null>(null)
  const [shownSaveCount, setShownSaveCount] = useState(0)
  const [report, setReport] = useState('尚未量測')
  const [harnessStatus, setHarnessStatus] = useState('尚未保存副本')
  const [workerDelay, setWorkerDelay] = useState(INITIAL_WORKER_DELAY)
  useEffect(() => {
    void Promise.all([
      rasterUrl('base', DEFAULT_WIDTH, DEFAULT_HEIGHT),
      rasterUrl('transparent', DEFAULT_WIDTH, DEFAULT_HEIGHT),
      rasterUrl('opaque', DEFAULT_WIDTH, DEFAULT_HEIGHT),
    ]).then(([base, overlay, opaque]) => {
      setAssets({ width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, label: 'synthetic', base, overlay, other: opaque, edited: opaque })
    })
  }, [])
  useEffect(() => {
    api.ready = !!assets
    if (assets) { api.width = assets.width; api.height = assets.height; requestAnimationFrame(observeLeftFeedback) }
    return () => { api.ready = false }
  }, [assets])
  reopenImpl = async () => {
    const snapshot = latestSaved || saved
    if (!assets || !snapshot) throw new Error('尚無已保存副本')
    const next = { ...assets, overlay: URL.createObjectURL(snapshot.overlay), other: URL.createObjectURL(snapshot.other), edited: URL.createObjectURL(snapshot.edited) }
    setAssets(next); setRevision(value => value + 1)
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
    setHarnessStatus(`已從保存副本重開 · ${snapshot.overlay.size}/${snapshot.other.size}/${snapshot.edited.size} bytes`)
  }
  const loadRealImage = async (file: File) => {
    if (!/^image\/(?:jpeg|png)$/.test(file.type)) throw new Error('只接受 JPG 或 PNG')
    setHarnessStatus(`載入 ${file.name}…`); api.ready = false
    const bitmap = await createImageBitmap(file)
    const width = bitmap.width, height = bitmap.height
    bitmap.close()
    if (!width || !height) throw new Error('圖片尺寸無效')
    const [overlay, opaque] = await Promise.all([rasterUrl('transparent', width, height), rasterUrl('opaque', width, height)])
    latestSaved = null; setSaved(null)
    setAssets({ width, height, label: file.name, base: URL.createObjectURL(file), overlay, other: opaque, edited: opaque })
    setRevision(value => value + 1); setHarnessStatus(`已載入 ${file.name} · ${width} × ${height}`)
  }
  return <main className="selection-responsive-fixture">
    <header><strong>RasterEditor responsiveness probe</strong><span>{assets ? `${assets.width} × ${assets.height} · ${assets.label}` : '載入中'}</span>
      <label><input type="checkbox" checked={workerDelay > 0} onChange={event => { const delay = event.target.checked ? 1000 : 0; setHarnessWorkerDelay(delay); setWorkerDelay(delay) }} /> 模擬慢速回覆（1 秒）</label>
      <span data-testid="worker-delay">實際延遲 {workerDelay} ms</span><span data-testid="save-count">saves {shownSaveCount}</span>
      <label>真實圖片 <input aria-label="真實圖片" type="file" accept="image/jpeg,image/png,.jpg,.jpeg,.png" onChange={event => { const file = event.target.files?.[0]; if (file) void loadRealImage(file).catch(error => setHarnessStatus(`載入失敗：${String(error)}`)) }} /></label>
      <button onClick={resetMetrics}>開始量測</button><button onClick={() => { const snapshot = readMetrics(); measuring = false; setReport(JSON.stringify(snapshot)) }}>讀取量測</button>
      <button onClick={() => setStress()}>Worker 壓力</button><button onClick={stopStress}>停止壓力</button>
      <button onClick={() => void api.flush().then(ok => setHarnessStatus(ok ? 'flush 完成' : 'flush 未完成'))}>保存</button>
      <button onClick={() => void api.flush().then(async ok => { if (!ok) { setHarnessStatus('保存失敗，未重開'); return } await api.reopen() }).catch(error => setHarnessStatus(`重開失敗：${String(error)}`))}>保存並重開</button></header>
    <output data-testid="metrics" style={{ display: 'block', maxHeight: 80, overflow: 'auto', font: '11px monospace' }}>{report}</output>
    <output data-testid="persistence-status" style={{ display: 'block', font: '11px monospace' }}>{harnessStatus}</output>
    {assets && <RasterEditor key={revision} ref={editor} width={assets.width} height={assets.height} mode="edit"
      baseUrl={assets.base} overlayUrl={assets.overlay} otherUrl={assets.other} editedUrl={assets.edited}
      initialCategory="other" onSave={async (data: RasterSave) => {
        latestSaved = data; setSaved(data); saveCount++; api.saveCount = saveCount; setShownSaveCount(saveCount)
        setHarnessStatus(`已保存 ${await shortHash([data.overlay, data.other, data.edited])} · ${data.overlay.size}/${data.other.size}/${data.edited.size} bytes`)
      }} />}
  </main>
}

createRoot(document.getElementById('root')!).render(<ConfigProvider><Fixture /></ConfigProvider>)
