import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Dropdown, InputNumber, Select, Slider, Space, Spin, Tooltip } from 'antd'
import { RasterWorkerClient } from './raster-worker-client'
import type { RasterEditCommand, RasterMetadata, RasterMagicPreview, RasterRenderFrame } from './raster-worker-protocol'
import { drawInteraction, type InteractionShape, type InteractionOutline } from './raster-interaction'
import { rectangleSelection, type SelectionOperation } from './selection-core'
import { type EditCategory, type EditRect } from './mask-edit-core'
import { RegionComparison } from './RegionComparison'
import { adoptComparisonRegion, type CompareRegion } from './comparison-regions'
import { LocalEditWindow } from './LocalEditWindow'

type Pixels = { overlay: ImageData; other: ImageData; edited: ImageData; assignment: Uint16Array }
export interface RasterSave {
  overlay: Blob; other: Blob; edited: Blob; assignment_rle: number[][]
}
export interface RasterHandle { flush: () => Promise<boolean> }
interface Candidate { code: number; label: string; url: string; diffUrl: string }
export interface ComposeView { widths?: Record<number, string>; panelScroll?: number; operation?: SelectionOperation; category?: EditCategory; color?: string; tolerance?: number; expand?: number; intersectOffset?: number; fit?: boolean; tool?: string; size?: number; zoom?: number; compare?: number; order?: number[]; show?: boolean; x?: number; y?: number }
interface Props {
  compareLayout?: 'multi' | 'context' | 'cards'
  viewState?: { current: ComposeView }
  onPreviewReady?: () => Promise<void>
  width: number; height: number; baseUrl: string; mode: 'edit' | 'compose'
  overlayUrl?: string; otherUrl?: string; editedUrl?: string
  detectedTextUrl?: string
  assignmentRle?: number[][]; candidates?: Candidate[]
  onSave: (data: RasterSave) => Promise<void>
  onDirty?: (dirty: boolean) => void
  onRepairMaskChange?: (hasMask: boolean) => void
  disabled?: boolean
  local?: boolean
  clipRect?: EditRect
  onClipRectChange?: (rect: EditRect) => void
  initialCategory?: EditCategory
  previewUrl?: string
}
function blank(width: number, height: number, opaque = false) {
  const image = new ImageData(width, height)
  if (opaque) for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255
  return image
}
function copy(pixels: Pixels): Pixels {
  const clone = (im: ImageData) => new ImageData(new Uint8ClampedArray(im.data), im.width, im.height)
  return { overlay: clone(pixels.overlay), other: clone(pixels.other), edited: clone(pixels.edited), assignment: pixels.assignment.slice() }
}
async function load(url: string, width: number, height: number, opaque = false): Promise<ImageData> {
  if (!url) return blank(width, height, opaque)
  const image = new Image(); image.src = url
  await image.decode()
  if (image.naturalWidth !== width || image.naturalHeight !== height) throw new Error('圖片尺寸與頁面不一致，不能對齊編輯')
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height
  const context = canvas.getContext('2d', { willReadFrequently: true })!
  context.drawImage(image, 0, 0)
  return context.getImageData(0, 0, width, height)
}
function rle(values: Uint16Array): number[][] {
  const runs: number[][] = []
  for (const value of values) {
    const last = runs[runs.length - 1]
    if (last && last[0] === value) last[1]++
    else runs.push([value, 1])
  }
  return runs
}

function previewPreference<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(`comic-editor-${key}`) || 'null') ?? fallback }
  catch { return fallback }
}
function rgb(hex: string) { return [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)) }
type Point = { x: number; y: number }
type Gesture = Point & { pointerId: number; lastX: number; lastY: number; code: number; before: Pixels; panX: number; panY: number; kind: string; operation: SelectionOperation | 'clear' | 'swap'; target: EditCategory; selection: Uint8Array; points: Point[]; size: number; intersectOffset: number; clipRect?: EditRect; edge?: string; roi?: EditRect }
function gestureShape(g: Gesture): InteractionShape {
  return g.kind === 'brush' ? { kind: 'brush', points: g.points, size: g.size }
    : { kind: 'rectangle', start: {x:g.x,y:g.y}, end: {x:g.lastX,y:g.lastY} }
}
type LocalDraft = { rect: EditRect; overlayUrl: string; otherUrl: string; editedUrl: string }


/** All masks and selections use original image pixels; zoom affects CSS only. */
export const RasterEditor = forwardRef<RasterHandle, Props>(function RasterEditor(props, ref) {
  const { width, height, mode } = props
  const [localDraft, setLocalDraft] = useState<LocalDraft | null>(null)
  const [openingLocal, setOpeningLocal] = useState(false)
  const disabled = props.disabled || !!localDraft || openingLocal
  const localBlocked = useRef(false); localBlocked.current = !!localDraft || openingLocal
  const initialView = useRef({...props.viewState?.current})
  const confirming = useRef(false)
  const initial = useRef(props)
  const pixels = useRef<Pixels | null>(null)
  const base = useRef<ImageData | null>(null)
  const detectedText = useRef<ImageData | null>(null)
  const frame = useRef<number | null>(null)
  const candidates = useRef<Map<number, { image: ImageData; diff: ImageData }>>(new Map())
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map())
  const viewRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const history = useRef<Pixels[]>([]); const future = useRef<Pixels[]>([])
  const gesture = useRef<Gesture | null>(null)
  const lasso = useRef<Point[]>([])
  const hover = useRef<Point | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preview = useRef<RasterMagicPreview | null>(null)
  const magicCanvas = useRef<HTMLCanvasElement | null>(null)
  const hoverGeneration = useRef(0)
  const clearMagicPreview = useCallback(() => {
    preview.current = null
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    hoverGeneration.current++
    if (magicCanvas.current) magicCanvas.current.style.visibility = 'hidden'
  }, [])
  const worker = useRef<RasterWorkerClient | null>(null)
  const workerFailure = useRef<Error | null>(null)
  const pendingWork = useRef<Promise<void>>(Promise.resolve())
  const pendingCount = useRef(0)
  const projectedHistory = useRef({ undo: 0, redo: 0 })
  const interactionSvg = useRef<SVGSVGElement | null>(null)
  const previewClipSvg = useRef<SVGSVGElement | null>(null)
  const pendingOutlines = useRef<(InteractionOutline & { version: number })[]>([])
  const renderGeneration = useRef(0)
  const readyFrame = useRef<{ frame: RasterRenderFrame; generation: number; target: number } | null>(null)
  const presentFrameRef = useRef<() => void>(() => {})
  const renderBusy = useRef(false)
  const renderWanted = useRef(false)
  const renderTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestRenderRef = useRef<() => void>(() => {})
  const repairCallback = useRef(props.onRepairMaskChange); repairCallback.current = props.onRepairMaskChange
  const [computing, setComputing] = useState(false)
  const previewHandler = useRef<(point: Point | null) => void>(() => {})
  const version = useRef(0); const persisted = useRef(0)
  const saving = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  const saveCallback = useRef(props.onSave); saveCallback.current = props.onSave
  const dirtyCallback = useRef(props.onDirty); dirtyCallback.current = props.onDirty
  const [loading, setLoading] = useState(true); const [error, setError] = useState('')
  const [saveState, setSaveState] = useState('已保存')
  const [tool, setTool] = useState(props.viewState?.current.tool || (mode === 'compose' ? 'rectangle' : 'brush')); const [category, setCategory] = useState<EditCategory>(() => props.initialCategory || props.viewState?.current.category || (previewPreference<string>('edit-category', 'other') === 'solid' ? 'solid' : 'other'))
  const [operation, setOperation] = useState<SelectionOperation>(props.viewState?.current.operation || 'add')
  const [special, setSpecial] = useState<'clear' | null>(null)
  const [tolerance, setTolerance] = useState(props.viewState?.current.tolerance ?? 28)
  const [magicPreviewEnabled, setMagicPreviewEnabled] = useState(() => previewPreference('magic-preview', true))
  const [expand, setExpand] = useState(props.viewState?.current.expand ?? 0)
  const [intersectOffset, setIntersectOffset] = useState(props.viewState?.current.intersectOffset ?? 0)
  const [size, setSize] = useState(props.viewState?.current.size || 16)
  const [zoom, setZoom] = useState(props.viewState?.current.zoom || Math.min(1, 550 / width)); const [compare, setCompare] = useState(props.viewState?.current.compare || 0)
  const [panelOrder, setPanelOrder] = useState(() => props.viewState?.current.order?.filter(code => props.candidates?.some(c => c.code === code)).concat((props.candidates || []).map(c => c.code).filter(code => !props.viewState?.current.order?.includes(code))) || (props.candidates || []).map(c => c.code))
  const divider = useRef(false)
  const savedPreview = useRef<ImageData | null>(null)
  const previewVersion = useRef(-1)
  const [previewReady, setPreviewReady] = useState('')
  const [previewRetry, setPreviewRetry] = useState(0)
  const previewCallback = useRef(props.onPreviewReady); previewCallback.current = props.onPreviewReady
  const redrawRef = useRef<() => void>(() => {})
  const [previewLayout, setPreviewLayout] = useState(() => { const saved = previewPreference<string>('preview-layout-v2', 'right'); return ['right', 'bottom', 'hidden'].includes(saved) ? saved : 'right' })
  const [maskPercent, setMaskPercent] = useState(() => previewPreference('mask-percent', 70))
  const [maskColor, setMaskColor] = useState(() => previewPreference('mask-color', '#ffffff'))
  const showMask = true
  const [otherPercent, setOtherPercent] = useState(() => previewPreference('other-percent', 38))
  const [otherColor, setOtherColor] = useState(() => previewPreference('other-color', '#ff6ea5'))
  const [showSources, setShowSources] = useState(props.viewState?.current.show || false)
  const [historyState, setHistoryState] = useState([0, 0])

  const drawNow = useCallback(() => {
    const p = pixels.current; const b = base.current
    if (!p || !b) return
    if (mode === 'edit') {
      const svg = interactionSvg.current
      if (previewClipSvg.current) drawInteraction(previewClipSvg.current, [], zoom, props.clipRect)
      if (!svg) return
      const outlines: InteractionOutline[] = [...pendingOutlines.current]
      const g = gesture.current
      if (g && ['brush', 'rectangle', 'local'].includes(g.kind)) outlines.push({ shape: gestureShape(g), color: g.operation === 'subtract' || g.operation === 'clear' ? '#f54646' : '#168cff' })
      if (lasso.current.length) outlines.push({ shape: { kind: 'polygon', points: hover.current ? [...lasso.current, hover.current] : lasso.current }, color: '#168cff' })
      if (tool === 'magic' && hover.current && !g) outlines.push({ shape: { kind: 'magic', point: hover.current }, color: '#168cff' })
      drawInteraction(svg, outlines, zoom, props.clipRect, tool === 'brush' && hover.current ? { point: hover.current, size } : undefined)
      return
    }
    for (const [code, canvas] of canvasRefs.current) {
      const ctx = canvas.getContext('2d')!
      const out = new ImageData(new Uint8ClampedArray(code === 0 && savedPreview.current && previewVersion.current === version.current && !gesture.current && persisted.current === version.current ? savedPreview.current.data : b.data), width, height)
      if (mode === 'compose') {
        if (code === 0) {
          for (let n = 0; n < p.assignment.length; n++) {
            const source = candidates.current.get(p.assignment[n])?.image
            if (source && !(savedPreview.current && previewVersion.current === version.current && !gesture.current && persisted.current === version.current)) for (let c = 0; c < 3; c++) out.data[n * 4 + c] = source.data[n * 4 + c]

          }
        } else {
          const source = candidates.current.get(code)?.image
          if (source) {
            for (let y = 0; y < height; y++) for (let x = Math.floor(width * compare / 100); x < width; x++) {
              const i = (y * width + x) * 4
              for (let c = 0; c < 3; c++) out.data[i + c] = source.data[i + c]
            }
          }
        }
      }
      if (code > 1 && showSources) {
        const diff = candidates.current.get(code)?.diff.data
        const tint = [[225, 130, 65], [65, 180, 105], [110, 125, 225]][(code - 2) % 3]
        if (diff) for (let n = 0; n < width * height; n++) if (diff[n * 4] >= 128) {
          const edge = n % width === 0 || n % width === width - 1 || n < width || n >= width * (height - 1) || [n-1,n+1,n-width,n+width].some(i => diff[i*4] < 128)
          const alpha = edge ? .75 : p.assignment[n] === code ? .42 : .11
          for (let c = 0; c < 3; c++) out.data[n*4+c] = Math.round(out.data[n*4+c]*(1-alpha)+tint[c]*alpha)
        }
      }
      ctx.putImageData(out, 0, 0)
      if (code > 1) {
        ctx.strokeStyle = '#ffca55'; ctx.lineWidth = 2 / zoom; ctx.beginPath(); ctx.moveTo(width*compare/100,0); ctx.lineTo(width*compare/100,height); ctx.stroke()
        const markerX = width * compare / 100; ctx.fillStyle = '#ffca55'; ctx.beginPath(); ctx.moveTo(markerX - 8 / zoom, 0); ctx.lineTo(markerX + 8 / zoom, 0); ctx.lineTo(markerX, 12 / zoom); ctx.closePath(); ctx.fill()
      }
      const g = gesture.current
      if (g?.kind === 'rectangle') { ctx.strokeStyle = g.code === 1 ? '#d59a45' : '#2daf98'; ctx.lineWidth = 2/zoom; ctx.setLineDash([5/zoom,4/zoom]); ctx.strokeRect(g.x,g.y,g.lastX-g.x,g.lastY-g.y); ctx.setLineDash([]) }
    }
  }, [width, height, mode, compare, showSources, props.clipRect, zoom, tool, size])
  const redraw = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => { frame.current = null; drawNow(); presentFrameRef.current() })
  }, [drawNow])
  redrawRef.current = redraw
  const renderOptions = useRef({ maskPercent, maskColor: rgb(maskColor), showOther: showMask, otherPercent, otherColor: rgb(otherColor) })
  renderOptions.current = { maskPercent, maskColor: rgb(maskColor), showOther: showMask, otherPercent, otherColor: rgb(otherColor) }
  const requestRender = useCallback(() => {
    if (initial.current.mode !== 'edit' || !worker.current || !alive.current) return
    renderWanted.current = true
    if (renderBusy.current || renderTimer.current) return
    // Coalesce preview work; pointer feedback has its own animation frame.
    renderTimer.current = setTimeout(() => {
      renderTimer.current = null
      const client = worker.current
      if (!client || !alive.current) return
      renderWanted.current = false; renderBusy.current = true
      const generation = renderGeneration.current, target = version.current
      void client.render({ ...renderOptions.current, magicPreview: preview.current, tag: generation }).then(result => {
        if (!result) return
        if (!alive.current || worker.current !== client || generation !== renderGeneration.current) {
          result.left.close(); result.right.close(); result.magicLeft?.close(); return
        }
        readyFrame.current?.frame.left.close(); readyFrame.current?.frame.right.close(); readyFrame.current?.frame.magicLeft?.close()
        readyFrame.current = { frame: result, generation, target }
        presentFrameRef.current()
      }).catch(reason => {
        if (alive.current && worker.current === client) setError(`預覽更新失敗：${String(reason)}`)
      }).finally(() => {
        if (worker.current !== client) return
        renderBusy.current = false
        if (renderWanted.current) requestRenderRef.current()
      })
    }, 0)
  }, [])
  requestRenderRef.current = requestRender
  // Full-frame bitmap adoption is lower priority than an active input gesture.
  // Keep at most one ready frame; a committed edit may supersede it before display.
  presentFrameRef.current = () => {
    const ready = readyFrame.current
    if (!ready || gesture.current || lasso.current.length) return
    readyFrame.current = null
    if (ready.generation === renderGeneration.current && alive.current) {
      for (const [code, bitmap] of [[0, ready.frame.left], [-1, ready.frame.right]] as const) {
        const canvas = canvasRefs.current.get(code)
        if (!canvas) continue
        const context = canvas.getContext('bitmaprenderer')
        if (context) context.transferFromImageBitmap(bitmap)
        else canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
        if (canvas.dataset.renderVersion !== String(ready.target)) canvas.dataset.renderVersion = String(ready.target)
      }
      const magic = magicCanvas.current
      if (magic) {
        magic.style.visibility = 'hidden'
        if (ready.frame.magicLeft && preview.current?.requestId === ready.frame.previewRequestId) {
          const context = magic.getContext('bitmaprenderer')
          if (context) context.transferFromImageBitmap(ready.frame.magicLeft)
          else magic.getContext('2d')?.drawImage(ready.frame.magicLeft, 0, 0)
          magic.style.visibility = 'visible'
        }
      }
      pendingOutlines.current = pendingOutlines.current.filter(outline => outline.version > ready.target)
      redrawRef.current()
    }
    ready.frame.left.close(); ready.frame.right.close(); ready.frame.magicLeft?.close()
  }
  useEffect(() => {
    if (mode !== 'edit' || loading) return
    clearMagicPreview(); renderGeneration.current++; requestRender()
  }, [mode, loading, maskPercent, maskColor, showMask, otherPercent, otherColor, requestRender, clearMagicPreview])

  const trackMutation = useCallback((task: Promise<RasterMetadata>, action: 'commit' | 'undo' | 'redo' | 'reset' = 'commit') => {
    const client = worker.current
    const history = projectedHistory.current
    const limit = Math.max(1, Math.min(20, Math.floor(96 * 1024 * 1024 / (width * height * 14))))
    if (action === 'reset') { history.undo = 0; history.redo = 0 }
    else if (action === 'undo') { history.undo--; history.redo++ }
    else if (action === 'redo') { history.undo = Math.min(limit, history.undo + 1); history.redo-- }
    else { history.undo = Math.min(limit, history.undo + 1); history.redo = 0 }
    setHistoryState([history.undo, history.redo])
    pendingCount.current++; setComputing(true)
    const settled = task.then(metadata => {
      if (!alive.current || worker.current !== client) return
      if (pendingCount.current === 1) {
        projectedHistory.current = { ...metadata.history }
        setHistoryState([metadata.history.undo, metadata.history.redo])
      }
      repairCallback.current?.(metadata.hasRepairMask)
    }).catch(reason => {
      if (!alive.current || worker.current !== client) return
      workerFailure.current = reason instanceof Error ? reason : new Error(String(reason))
      setError(`編輯計算失敗，尚未保存：${String(reason)}`)
    }).finally(() => {
      if (!alive.current || worker.current !== client) return
      pendingCount.current--; setComputing(pendingCount.current > 0)
      requestRenderRef.current()
    })
    pendingWork.current = Promise.all([pendingWork.current, settled]).then(() => {})
  }, [width, height])
  function submitEdit(command: RasterEditCommand, outline?: InteractionShape) {
    const client = worker.current
    if (!client || workerFailure.current) return
    clearMagicPreview(); renderGeneration.current++
    // Enqueue synchronously before changed()/flush can observe the new UI version.
    trackMutation(client.commit(command))
    if (outline) pendingOutlines.current.push({ version: version.current + 1, shape: outline, color: command.operation === 'subtract' || command.operation === 'clear' ? '#f54646' : '#168cff' })
    changed()
    requestRender()
  }
  useEffect(() => {
    if (props.viewState) Object.assign(props.viewState.current, {tool, size, zoom, compare, order: panelOrder, show: showSources, operation, category, tolerance, expand, intersectOffset})
  }, [props.viewState, tool, size, zoom, compare, panelOrder, showSources, operation, category, tolerance, expand, intersectOffset])
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); if (hoverTimer.current) clearTimeout(hoverTimer.current) }, [])
  useEffect(() => {
    if (mode !== 'edit') return
    try {
      for (const [key, value] of Object.entries({ 'magic-preview': magicPreviewEnabled, 'preview-layout-v2': previewLayout, 'mask-percent': maskPercent, 'mask-color': maskColor, 'show-other': showMask, 'other-percent': otherPercent, 'other-color': otherColor }))
        localStorage.setItem(`comic-editor-${key}`, JSON.stringify(value))
    } catch { /* Display preferences are optional when browser storage is unavailable. */ }
  }, [mode, magicPreviewEnabled, previewLayout, maskPercent, maskColor, showMask, otherPercent, otherColor])

  useEffect(() => {
    alive.current = true
    let cancelled = false
    const p = initial.current
    void (async () => {
      const [b, overlay, other, edited, text] = await Promise.all([
        load(p.baseUrl, p.width, p.height), load(p.overlayUrl || '', p.width, p.height),
        load(p.otherUrl || '', p.width, p.height, true), load(p.editedUrl || '', p.width, p.height, true),
        p.detectedTextUrl ? load(p.detectedTextUrl, p.width, p.height, true) : Promise.resolve(null),
      ])
      const assignment = new Uint16Array(p.width * p.height)
      let offset = 0
      for (const [value, count] of p.assignmentRle || []) { assignment.fill(value, offset, offset + count); offset += count }
      const decoded = await Promise.all((p.candidates || []).map(async candidate => ({ code: candidate.code,
        image: await load(candidate.url, p.width, p.height), diff: await load(candidate.diffUrl, p.width, p.height) })))
      if (cancelled) return
      base.current = b; detectedText.current = text; pixels.current = { overlay, other, edited, assignment }
      candidates.current = new Map(decoded.map(item => [item.code, item]))
      if (p.mode === 'edit') {
        const client = new RasterWorkerClient()
        worker.current = client
        await client.init({ width: p.width, height: p.height, base: b.data, overlay: overlay.data, other: other.data, edited: edited.data, detectedText: text?.data })
        if (cancelled) { client.dispose(); return }
      }
      setLoading(false)
    })().catch(err => { if (!cancelled) { if (p.mode === 'edit') workerFailure.current = err instanceof Error ? err : new Error(String(err)); setLoading(false); setError(String(err)) } })
    return () => { cancelled = true; alive.current = false; worker.current?.dispose(); worker.current = null; readyFrame.current?.frame.left.close(); readyFrame.current?.frame.right.close(); readyFrame.current?.frame.magicLeft?.close(); readyFrame.current = null; if (renderTimer.current) clearTimeout(renderTimer.current); if (timer.current) clearTimeout(timer.current) }
  }, [])
  useEffect(() => { if (!loading) redraw() }, [loading, redraw])
  useEffect(() => {
    let cancelled = false
    if (mode === 'compose' && props.previewUrl && !loading && pixels.current && base.current) {
      const key = props.previewUrl; const targetVersion = version.current
      void load(key, width, height).then(async image => {
        if (cancelled) return
        setError(''); savedPreview.current = image; previewVersion.current = targetVersion; setPreviewReady(key); redrawRef.current()
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
        if (cancelled || targetVersion !== version.current || persisted.current !== version.current || gesture.current) return
        confirming.current = true
        const task = previewCallback.current?.()
        if (task) { const pending = task.then(() => true); saving.current = pending; try { await pending } finally { if (saving.current === pending) saving.current = null; confirming.current = false } } else confirming.current = false
      }).catch(err => { if (!cancelled) setError(`成品載入或確認失敗：${String(err)}`) })
    }
    return () => { cancelled = true }
  }, [mode, props.previewUrl, width, height, loading, previewRetry])
  useEffect(() => {
    if (loading) return
    const views = [...viewRefs.current.values()]
    const wheel = (event: WheelEvent) => {
      event.preventDefault()
      const source = event.currentTarget as HTMLDivElement
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? source.clientHeight : 1
      if (!event.altKey) {
        if (event.ctrlKey || event.metaKey) source.scrollLeft += (event.deltaX || event.deltaY) * unit
        else { source.scrollLeft += event.deltaX * unit; source.scrollTop += event.deltaY * unit }
        return
      }
      if (!event.deltaY) return
      const next = Math.max(.05, Math.min(4, zoom * (event.deltaY < 0 ? 1.1 : 1/1.1)))
      if (props.viewState) props.viewState.current.fit = false
      setZoom(next)
    }
    views.forEach(view => view.addEventListener('wheel', wheel, { passive: false }))
    return () => views.forEach(view => view.removeEventListener('wheel', wheel))
  }, [loading, mode, zoom, panelOrder, props.viewState, props.compareLayout])
  useEffect(() => {
    if (loading || props.clipRect) return
    const frameId = requestAnimationFrame(() => {
      for (const view of viewRefs.current.values()) {
        view.scrollLeft = Math.max(0, (width * zoom - view.clientWidth) / 2)
        view.scrollTop = Math.max(0, (height * zoom - view.clientHeight) / 2)
      }
    })
    return () => cancelAnimationFrame(frameId)
  }, [zoom, loading, width, height, props.clipRect])
  useEffect(() => {
    if (loading) return
    const view = viewRefs.current.get(0)
    if (!view) return
    const roi = initial.current.clipRect
    if (initialView.current.zoom && initialView.current.fit === false) {
      const state = initialView.current
      requestAnimationFrame(() => { for (const v of viewRefs.current.values()) { v.scrollLeft=(state.x || 0)*width*state.zoom!; v.scrollTop=(state.y || 0)*height*state.zoom! } })
      return
    }
    if (initial.current.viewState && initialView.current.y !== undefined) requestAnimationFrame(() => { for (const v of viewRefs.current.values()) { v.scrollLeft=(initialView.current.x || 0)*v.scrollWidth; v.scrollTop=(initialView.current.y || 0)*v.scrollHeight } })
    setZoom(roi ? Math.max(.05, Math.min(4, (view.clientWidth - 24) / roi.width, (view.clientHeight - 24) / roi.height)) : Math.min(1, view.clientWidth / width))
  }, [loading, width, height, mode])
  useEffect(() => {
    const roi = props.clipRect
    if (!roi || loading || gesture.current?.kind === 'bounds') return
    for (const view of viewRefs.current.values()) { view.scrollLeft = Math.max(0, (roi.x + roi.width / 2) * zoom - view.clientWidth / 2); view.scrollTop = Math.max(0, (roi.y + roi.height / 2) * zoom - view.clientHeight / 2) }
  }, [zoom, loading, props.clipRect])
  useEffect(() => {
    history.current = []; future.current = []; setHistoryState([0, 0])
    if (worker.current) trackMutation(worker.current.resetHistory(), 'reset')
  }, [props.clipRect?.x, props.clipRect?.y, props.clipRect?.width, props.clipRect?.height, trackMutation])
  useEffect(() => { previewHandler.current(hover.current) }, [tolerance, expand, operation, category, special, tool, intersectOffset, magicPreviewEnabled, disabled, props.clipRect])
  useEffect(() => () => {
    if (localDraft) for (const url of [localDraft.overlayUrl, localDraft.otherUrl, localDraft.editedUrl]) URL.revokeObjectURL(url)
  }, [localDraft])

  const flush = useCallback(async (): Promise<boolean> => {
    if (gesture.current || lasso.current.length || localBlocked.current || workerFailure.current) return false
    if (timer.current) clearTimeout(timer.current)
    if (saving.current) return saving.current
    if (persisted.current >= version.current) return true
    const task = async () => {
      try {
        while (pixels.current && persisted.current < version.current) {
          if (gesture.current || lasso.current.length || localBlocked.current) return false
          const target = version.current
          if (alive.current) setSaveState('保存中…')
          if (initial.current.mode === 'edit') {
            // Snapshot is queued behind all accepted edits. Later input gets a later version.
            const snapshotTask = worker.current!.snapshot()
            const [snapshot] = await Promise.all([snapshotTask, pendingWork.current])
            if (workerFailure.current) throw workerFailure.current
            await saveCallback.current({ overlay: snapshot.overlay, other: snapshot.other, edited: snapshot.edited, assignment_rle: [] })
          } else {
            const snapshot = copy(pixels.current)
            await saveCallback.current({ overlay: new Blob(), other: new Blob(), edited: new Blob(), assignment_rle: rle(snapshot.assignment) })
          }
          persisted.current = target
        }
        if (alive.current) { setSaveState('已保存'); setError('') }
        dirtyCallback.current?.(false)
        // Saved pixels are current even when an unfinished gesture still prevents navigation.
        return !(gesture.current || lasso.current.length || localBlocked.current)
      } catch (err) {
        if (alive.current) { setError(err instanceof Error ? err.message : '保存失敗'); setSaveState('保存失敗，請重試') }
        return false
      } finally { saving.current = null }
    }
    saving.current = task()
    return saving.current
  }, [])
  useImperativeHandle(ref, () => ({ flush }), [flush])
  useEffect(() => {
    if (!localDraft && !openingLocal && persisted.current < version.current) {
      timer.current = setTimeout(() => void flush(), 800)
      return () => { if (timer.current) clearTimeout(timer.current) }
    }
  }, [localDraft, openingLocal, flush])
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (persisted.current < version.current) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  function changed() {
    clearMagicPreview()
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    version.current++; dirtyCallback.current?.(true); setSaveState('尚未保存')
    if (mode !== 'edit') setHistoryState([history.current.length, future.current.length])
    redraw()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 800)
  }
  function inside(point: Point) {
    const r = props.clipRect
    return !r || (point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height)
  }
  function applyGesture(g: Gesture) {
    pixels.current = copy(g.before)
    for (let n = 0; n < g.selection.length; n++) if (g.selection[n] && (g.code <= 1 || (candidates.current.get(g.code)?.diff.data[n * 4] || 0) >= 128)) pixels.current.assignment[n] = g.code
    redraw()
  }
  function stroke(selection: Uint8Array, a: Point, b: Point) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y)))
    const radius = size / 2
    for (let s = 0; s <= steps; s++) {
      const x = a.x + (b.x - a.x) * s / steps; const y = a.y + (b.y - a.y) * s / steps
      for (let yy = Math.max(0, Math.floor(y - radius)); yy <= Math.min(height - 1, y + radius); yy++)
        for (let xx = Math.max(0, Math.floor(x - radius)); xx <= Math.min(width - 1, x + radius); xx++)
          if ((xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2) selection[yy * width + xx] = 1
    }
  }
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(width - 1, Math.floor((event.clientX - rect.left) * width / rect.width))), y: Math.max(0, Math.min(height - 1, Math.floor((event.clientY - rect.top) * height / rect.height))) }
  }
  function previewMagic(point: Point | null) {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    clearMagicPreview()
    redraw()
    if (!magicPreviewEnabled || !point || tool !== 'magic' || special || disabled || gesture.current || !inside(point)) return
    hoverTimer.current = setTimeout(() => {
      preview.current = { requestId: hoverGeneration.current, point, tolerance, expand, operation, category, clipRect: props.clipRect, intersectOffset }
      requestRender()
    }, 60)
  }
  previewHandler.current = previewMagic
  function chooseCategory(value: EditCategory) {
    if (disabled || props.local || gesture.current) return
    setCategory(value); lasso.current = []; clearMagicPreview()
    try { localStorage.setItem('comic-editor-edit-category', JSON.stringify(value)) } catch { /* Optional UI preference. */ }
    if (persisted.current < version.current) timer.current = setTimeout(() => void flush(), 800)
    redraw()
  }
  function chooseTool(value: string) { if (gesture.current) return; lasso.current = []; hover.current = null; clearMagicPreview(); setSpecial(null); setTool(value); if ((value !== 'magic' && ['selection_inner', 'add_selection_inner'].includes(operation)) || (value === 'magic' && operation === 'local_intersect')) setOperation('add'); if (persisted.current < version.current) timer.current = setTimeout(() => void flush(), 800); redraw() }
  function finishLasso() {
    if (lasso.current.length < 3 || disabled) return
    const points = lasso.current
    lasso.current = []; hover.current = null
    submitEdit({ selection: { kind: 'polygon', points }, operation, category, clipRect: props.clipRect, intersectOffset }, { kind: 'polygon', points, closed: true })
  }
  async function openLocal(rect: EditRect) {
    if (!pixels.current) return
    setOpeningLocal(true)
    try {
      const snapshot = await worker.current!.snapshot()
      await pendingWork.current
      if (workerFailure.current) throw workerFailure.current
      const blobs = [snapshot.overlay, snapshot.other, snapshot.edited]
      setLocalDraft({ rect, overlayUrl: URL.createObjectURL(blobs[0]), otherUrl: URL.createObjectURL(blobs[1]), editedUrl: URL.createObjectURL(blobs[2]) })
    } catch (err) { setError(String(err)) }
    finally { setOpeningLocal(false) }
  }
  async function applyLocal(data: RasterSave, rect: EditRect) {
    if (!pixels.current) return
    const urls = [data.overlay, data.other, data.edited].map(blob => URL.createObjectURL(blob))
    try {
      const [overlay, other, edited] = await Promise.all(urls.map(url => load(url, width, height)))
      const task = worker.current!.merge({ layers: { overlay: overlay.data, other: other.data, edited: edited.data }, rect })
      renderGeneration.current++; trackMutation(task)
      await task
      setLocalDraft(null); changed()
    } finally { urls.forEach(url => URL.revokeObjectURL(url)) }
  }
  function down(event: React.PointerEvent<HTMLCanvasElement>, code: number) {
    if (!pixels.current || (mode === 'edit' && !worker.current) || loading || workerFailure.current || gesture.current || disabled || confirming.current || ![0, 1, 2].includes(event.button)) return
    const pan = event.button === 1 || (event.button === 0 && (event.metaKey || event.ctrlKey)) || tool === 'pan'
    if ((mode === 'edit' && code !== 0 || mode === 'compose' && code === 0) && !pan) return
    const p = point(event)
    if (!pan && tool !== 'bounds' && !inside(p)) return
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true })
    if (timer.current) clearTimeout(timer.current)
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    clearMagicPreview()
    if (!pan && event.button === 0 && !special && tool === 'magic') { submitEdit({ selection: {kind:'magic',point:p,tolerance,expand}, operation, category, clipRect:props.clipRect, intersectOffset }, {kind:'magic',point:p}); return }
    if (!pan && event.button === 0 && !special && tool === 'lasso') { lasso.current.push(p); hover.current = p; redraw(); return }
    const right = event.button === 2
    const kind = pan ? 'pan' : right || special ? 'rectangle' : tool
    const op = right ? (event.metaKey || event.ctrlKey ? 'swap' : 'clear') : special || operation
    const g: Gesture = { ...p, pointerId: event.pointerId, lastX: p.x, lastY: p.y, code: mode === 'compose' ? (event.button === 2 ? 1 : code || 1) : 0, before: mode === 'edit' ? pixels.current : copy(pixels.current), panX: event.clientX, panY: event.clientY, kind, operation: op, target: category, selection: new Uint8Array(mode === 'edit' ? 0 : width * height), points: [p], size, intersectOffset, clipRect: props.clipRect ? {...props.clipRect} : undefined }
    if (kind === 'bounds' && props.clipRect) {
      const r = props.clipRect
      const outsideX = Math.max(r.x-p.x, 0, p.x-r.x-r.width); const outsideY = Math.max(r.y-p.y, 0, p.y-r.y-r.height)
      const distances = [{edge:'left', d:Math.hypot(p.x-r.x,outsideY)}, {edge:'right',d:Math.hypot(p.x-r.x-r.width,outsideY)}, {edge:'top',d:Math.hypot(p.y-r.y,outsideX)}, {edge:'bottom',d:Math.hypot(p.y-r.y-r.height,outsideX)}].sort((a,b)=>a.d-b.d)
      if (distances[0].d > 14 / zoom) return
      g.edge = distances[0].edge; g.roi = {...r}
    }
    event.currentTarget.setPointerCapture(event.pointerId); gesture.current = g
    if (mode === 'edit') { renderGeneration.current++; requestRender(); redraw(); return }
    if (kind === 'local') redraw()
    if (kind === 'brush') { stroke(g.selection, p, p); applyGesture(g) }
    else if (kind === 'rectangle') { g.selection = rectangleSelection(p.x, p.y, p.x, p.y, width, height); applyGesture(g) }
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>, code: number) {
    const p = point(event); const g = gesture.current
    if (g && g.pointerId !== event.pointerId) return
    if (!g) {
      if (mode === 'edit' && code === 0) { hover.current = p; if (tool === 'magic') previewMagic(p); else redraw() }
      return
    }
    if (g.kind === 'pan') {
      const view = viewRefs.current.get(code)
      if (view) { view.scrollLeft -= event.clientX - g.panX; view.scrollTop -= event.clientY - g.panY }
      g.panX = event.clientX; g.panY = event.clientY; return
    }
    if (g.kind === 'bounds' && g.roi) {
      const r = g.roi; let {x,y,width:w,height:h} = r
      if (g.edge === 'left') { x = Math.min(p.x,r.x+r.width-1); w = r.x+r.width-x }
      if (g.edge === 'right') w = Math.max(1,p.x-r.x+1)
      if (g.edge === 'top') { y = Math.min(p.y,r.y+r.height-1); h = r.y+r.height-y }
      if (g.edge === 'bottom') h = Math.max(1,p.y-r.y+1)
      props.onClipRectChange?.({x,y,width:w,height:h}); return
    }
    if (mode === 'edit') {
      if (g.kind === 'brush') {
        const rect = event.currentTarget.getBoundingClientRect()
        const events = event.nativeEvent.getCoalescedEvents?.() || []
        for (const sample of events) {
          const next = { x: Math.max(0, Math.min(width - 1, Math.floor((sample.clientX - rect.left) * width / rect.width))), y: Math.max(0, Math.min(height - 1, Math.floor((sample.clientY - rect.top) * height / rect.height))) }
          const last = g.points[g.points.length - 1]
          if (last.x !== next.x || last.y !== next.y) g.points.push(next)
        }
        const last = g.points[g.points.length - 1]
        if (last.x !== p.x || last.y !== p.y) g.points.push(p)
      }
      g.lastX = p.x; g.lastY = p.y; hover.current = p; redraw(); return
    }
    if (g.kind === 'brush') stroke(g.selection, {x:g.lastX,y:g.lastY}, p)
    else if (g.kind === 'rectangle') g.selection = rectangleSelection(g.x, g.y, p.x, p.y, width, height)
    g.lastX = p.x; g.lastY = p.y
    if (g.kind !== 'local') applyGesture(g); else redraw()
  }
  function end() {
    const g = gesture.current; gesture.current = null
    if (!g) return
    if (['pan', 'bounds'].includes(g.kind)) { redraw(); if (persisted.current < version.current) timer.current = setTimeout(() => void flush(), 800); return }
    if (g.kind === 'local') { void openLocal({x:Math.min(g.x,g.lastX), y:Math.min(g.y,g.lastY), width:Math.abs(g.x-g.lastX)+1, height:Math.abs(g.y-g.lastY)+1}); redraw(); return }
    if (mode === 'edit') {
      const shape = gestureShape(g)
      const selection = g.kind === 'brush' ? { kind: 'brush' as const, points: g.points, size: g.size }
        : { kind: 'rectangle' as const, x1: g.x, y1: g.y, x2: g.lastX, y2: g.lastY }
      submitEdit({ selection, operation: g.operation, category: g.target, clipRect: g.clipRect, intersectOffset: g.intersectOffset }, shape)
      return
    }
    pushHistory(g.before); future.current = []; changed()
  }
  function cancelGesture() {
    const g = gesture.current
    if (g) { if (mode !== 'edit') pixels.current = g.before; gesture.current = null }
    lasso.current = []; hover.current = null; clearMagicPreview()
    renderGeneration.current++; requestRender()
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    redraw()
    if (persisted.current < version.current) timer.current = setTimeout(() => void flush(), 800)
  }
  function fit() {
    if (props.viewState) props.viewState.current.fit = true
    const r = props.clipRect
    setZoom(r ? Math.max(.05, Math.min(4, ((viewRefs.current.get(0)?.clientWidth || 550) - 24)/r.width, ((viewRefs.current.get(0)?.clientHeight || 400) - 24)/r.height)) : Math.min(1, (viewRefs.current.get(0)?.clientWidth || 550)/width))
  }
  function pushHistory(value: Pixels) {
    history.current.push(value)
    const limit = Math.max(1, Math.min(20, Math.floor(96 * 1024 * 1024 / (width * height * 14))))
    while (history.current.length > limit) history.current.shift()
  }
  function undo(redo = false) {
    if (gesture.current || disabled) return
    if (mode === 'edit') {
      const client = worker.current
      if (!client || workerFailure.current || !(redo ? projectedHistory.current.redo : projectedHistory.current.undo)) return
      renderGeneration.current++; pendingOutlines.current = []; clearMagicPreview()
      trackMutation(redo ? client.redo() : client.undo(), redo ? 'redo' : 'undo'); changed(); return
    }
    const from = redo ? future.current : history.current; const to = redo ? history.current : future.current
    const previous = from.pop()
    if (previous && pixels.current) { to.push(copy(pixels.current)); pixels.current = previous; changed() }
  }
  function adoptAll(chosen = 1, reset = false) {
    if (!pixels.current) return
    pushHistory(copy(pixels.current)); future.current = []
    for (let n = 0; n < width * height; n++) if (chosen <= 1 || (candidates.current.get(chosen)?.diff.data[n * 4] || 0) >= 128) pixels.current.assignment[n] = chosen; else if (reset) pixels.current.assignment[n] = 0
    changed()
  }
  function adoptRegion(region: CompareRegion, code: number) {
    if (!pixels.current || disabled || confirming.current) return
    const next = adoptComparisonRegion(pixels.current.assignment, width, height, region, code, new Map([...candidates.current].map(([key,value]) => [key,value.diff.data])))
    if (next.every((value,index) => value === pixels.current!.assignment[index])) return
    pushHistory(copy(pixels.current)); future.current = []; pixels.current.assignment = next; changed()
  }
  const regional = mode === 'compose' && props.compareLayout && props.compareLayout !== 'multi'
  const regionCandidates = useMemo(() => loading ? [] : [...candidates.current].map(([code,value]) => ({...value,code,label:initial.current.candidates?.find(c=>c.code===code)?.label || String(code)})), [loading])
  const categoryName = category === 'solid' ? '純色填充' : '待修補'
  const historyControls = <div className="editor-history-controls">
    <Button size="small" disabled={disabled || !historyState[0]} onClick={() => undo()}>撤銷</Button>
    <Button size="small" disabled={disabled || !historyState[1]} onClick={() => undo(true)}>重做</Button>
    {(mode === 'edit' || saveState.includes('失敗')) && <Button size="small" onClick={() => void flush()} disabled={disabled}>{props.local ? '更新副本' : '保存'}</Button>}
    <span className="editor-save-state" role="status">{computing ? '正在處理選區…' : props.local && saveState === '已保存' ? '副本・尚未套用' : saveState}</span>
  </div>
  const zoomControls = <div className="editor-zoom-controls" onClickCapture={() => { if (props.viewState) props.viewState.current.fit = false }} onChangeCapture={() => { if (props.viewState) props.viewState.current.fit = false }}><Button size="small" aria-label="縮小圖片" onClick={() => setZoom(z => Math.max(.05, z / 1.25))}>−</Button><Button size="small" aria-label="放大圖片" onClick={() => setZoom(z => Math.min(4, z * 1.25))}>＋</Button><Button size="small" onClick={() => setZoom(1)}>原尺寸</Button><label>縮放 <InputNumber size="small" aria-label="縮放百分比" min={5} max={400} value={Math.round(zoom * 100)} onChange={v => setZoom((v || 100) / 100)} /> %</label><Button size="small" onClick={fit}>適合視窗</Button></div>
  const panels = mode === 'edit' ? [{ code: 0, label: 'Mask / 原圖' }, { code: -1, label: '填色預覽' }]
    : [{ code: 0, label: '合成結果' }, ...panelOrder.map(code => props.candidates!.find(c => c.code === code)!)]
  return <div className="raster-editor" onKeyDown={event => {
    const tag = (event.target as HTMLElement).tagName
    if (mode === 'edit' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && ['F1', 'F2'].includes(event.key)) { event.preventDefault(); chooseCategory(event.key === 'F1' ? 'solid' : 'other'); return }
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (event.target as HTMLElement).isContentEditable
    if (!typing && !disabled && (tool === 'brush' || mode === 'edit' && tool === 'magic') && !special && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const direction = event.code === 'BracketLeft' || event.key === '[' ? -1 : event.code === 'BracketRight' || event.key === ']' ? 1 : 0
      if (direction) {
        event.preventDefault()
        if (tool === 'magic') setTolerance(value => Math.max(0, Math.min(100, value + direction)))
        else setSize(value => Math.max(1, Math.min(200, value + direction * 4)))
        return
      }
    }
    if (mode === 'compose' && !['INPUT','TEXTAREA','SELECT'].includes(tag)) {
      if (event.key.toLowerCase() === 'm') { event.preventDefault(); setShowSources(v => !v) }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z' && tag !== 'CANVAS') { event.preventDefault(); undo(event.shiftKey) }
    }
    if (tag !== 'CANVAS') return
    if (event.key === 'F4') { event.preventDefault(); fit() }
    if (event.key === 'Escape') { event.preventDefault(); cancelGesture() }
    if (tool === 'lasso' && event.key === 'Enter') { event.preventDefault(); finishLasso() }
    if (tool === 'lasso' && event.key === 'Backspace') { event.preventDefault(); lasso.current.pop(); redraw() }
    if (mode === 'edit' && !disabled) {
      const tools: Record<string, string> = {F5:'rectangle', F6:'brush', F7:'magic', F8:'lasso'}
      if (tools[event.key]) { event.preventDefault(); chooseTool(tools[event.key]) }
      const ops: Record<string, SelectionOperation> = {F9:'add',F10:'subtract',F11:'local_intersect'}
      if (ops[event.key] && (tool !== 'magic' || event.key !== 'F11')) { event.preventDefault(); setSpecial(null); setOperation(ops[event.key]) }
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey) }
  }}>
    {error && <Alert type="error" showIcon message={error} action={<Button onClick={() => { if (mode === 'compose' && persisted.current === version.current) setPreviewRetry(v => v + 1); else void flush() }}>重試</Button>} />}
    {mode === 'edit' ? <div className="edit-control-panel">
      <div className="edit-control-row category-row">
        <span className="edit-row-label">編輯</span>
        <div role="group" aria-label="編輯類別" className="category-buttons">
          <Button aria-pressed={category === 'solid'} type={category === 'solid' ? 'primary' : 'default'} disabled={disabled || props.local} onClick={() => chooseCategory('solid')}>F1 純色填充</Button>
          <Button aria-pressed={category === 'other'} type={category === 'other' ? 'primary' : 'default'} disabled={disabled || props.local} onClick={() => chooseCategory('other')}>F2 待修補</Button>
        </div>
        {historyControls}
      </div>
      <div className="edit-control-row">
        <span className="edit-row-label">工具</span>
        <div role="group" aria-label="編輯工具" className="selection-tools">
          {[{value:'rectangle',label:'矩形'},{value:'brush',label:'畫筆'},{value:'magic',label:'魔法棒'},{value:'lasso',label:'套索'}, props.local ? {value:'bounds',label:'調整邊框'} : {value:'local',label:'局部視窗'}].map(item =>
            <Button key={item.value} aria-pressed={tool === item.value && !special} type={tool === item.value && !special ? 'primary' : 'default'} disabled={disabled} onClick={() => chooseTool(item.value)}>{item.label}</Button>)}
        </div>
        {tool === 'brush' && !special && <div className="tool-settings brush-settings"><label>大小 <InputNumber size="small" disabled={disabled} aria-label="筆刷像素" min={1} max={200} value={size} onChange={v => setSize(v || 1)} /> px</label><Slider ariaLabelForHandle="筆刷大小" min={1} max={200} value={size} disabled={disabled} onChange={setSize} /><span className="brush-shortcut-hint">[ 縮小 · ] 放大</span></div>}
        {tool === 'magic' && !special && <div className="tool-settings">
          <Checkbox checked={magicPreviewEnabled} disabled={disabled} onChange={e => { clearMagicPreview(); setMagicPreviewEnabled(e.target.checked) }}>魔法棒預覽</Checkbox>
          <label>容差 <InputNumber size="small" aria-label="魔法棒容差" disabled={disabled} min={0} max={100} value={tolerance} onChange={v => setTolerance(v ?? 28)} /></label>
          <span className="brush-shortcut-hint">[ 減少容差 · ] 增加容差</span>
          <label>擴展 <InputNumber size="small" aria-label="魔法棒擴展" disabled={disabled} min={0} max={80} value={expand} onChange={v => setExpand(v ?? 0)} /> px</label>
        </div>}
      </div>
      <div className="edit-control-row">
        <span className="edit-row-label">操作</span>
        {!['local','bounds'].includes(tool) && <div role="group" aria-label="選區操作" className="selection-tools">
          {([{value:'add',label:'添加'},{value:'subtract',label:'減去'}, ...(tool === 'magic' ? [{value:'selection_inner',label:'選區內部'},{value:'add_selection_inner',label:'選區＋選區內部'}] : [{value:'local_intersect',label:'局部交集'}])] as {value:SelectionOperation;label:string}[]).map(item => <Button key={item.value} aria-pressed={!special && operation === item.value} type={!special && operation === item.value ? 'primary' : 'default'} disabled={disabled} onClick={() => { setSpecial(null); setOperation(item.value) }}>{item.label}</Button>)}
        </div>}
        {!props.local && <div className="selection-tools shortcut-actions" role="group" aria-label="框選快捷操作">
          <Button disabled={disabled} aria-pressed={special === 'clear'} type={special === 'clear' ? 'primary' : 'default'} title="右鍵框選清除兩類 Mask" onClick={() => { setSpecial(special === 'clear' ? null : 'clear'); lasso.current=[] }}>清除框內 Mask</Button>
        </div>}
        {operation === 'local_intersect' && ['rectangle', 'brush', 'lasso'].includes(tool) && !special && <label className="tool-setting">偏移 <InputNumber size="small" aria-label="交集偏移" disabled={disabled} min={-80} max={80} value={intersectOffset} onChange={v => setIntersectOffset(v ?? 0)} /> px</label>}
      </div>
      <Tooltip title="右鍵框選清除；Cmd／Ctrl＋右鍵拖框互換兩類 Mask；Cmd／Ctrl＋左鍵平移；滾輪上下移動；Cmd／Ctrl＋滾輪左右移動；Option／Alt＋滾輪縮放；F4 適合視窗；PageUp／PageDown 切頁。套索：Enter 閉合，Backspace 退點，Esc 取消。魔法棒：綠色預覽添加，紅色預覽減去。"><Button size="small" aria-label="操作說明">?</Button></Tooltip>
    </div> : regional ? <Space wrap className="editor-toolbar">{historyControls}<span className="region-help">選擇共用同一份合成內容 · 自動保存</span></Space> : <>
      <Space wrap className="editor-toolbar">
        <Select aria-label="編輯工具" value={tool} onChange={chooseTool} options={[{value:'brush',label:'筆刷'},{value:'rectangle',label:'矩形'},{value:'pan',label:'平移'}]} />
        <Dropdown menu={{items:[{key:'base',label:'本頁恢復為修復前底圖'},{key:'first',label:`本頁重新採用 ${props.candidates?.[0]?.label || '第一組'}`}],onClick:({key}) => adoptAll(key === 'base' ? 1 : props.candidates?.[0]?.code || 1, true)}} disabled={disabled}><Button>重設本頁 ▾</Button></Dropdown>
        {tool === 'brush' && <div className="tool-settings brush-settings"><label>大小 <InputNumber size="small" disabled={disabled} aria-label="筆刷像素" min={1} max={200} value={size} onChange={v => setSize(v || 1)} /> px</label><Slider ariaLabelForHandle="筆刷大小" min={1} max={200} value={size} disabled={disabled} onChange={setSize} /><span className="brush-shortcut-hint">[ 縮小 · ] 放大</span></div>}
        {historyControls}
      </Space>
      <Space wrap className="editor-toolbar">{zoomControls}<Checkbox checked={showSources} onChange={e => setShowSources(e.target.checked)}>M 顯示選區（深色已採用／淡色未採用）</Checkbox></Space>
    <small className="compose-hint">左鍵框選／筆刷採用所在候選 · 右鍵固定拖框保留底圖 · 中鍵／Cmd＋左鍵拖動 · 滾輪上下移動 · Cmd／Ctrl＋滾輪左右移動 · Option／Alt＋滾輪縮放 · [／] 調筆刷 · 拖動黃色分隔線比較原圖</small></>}
    {regional ? (!loading && base.current && pixels.current ? <RegionComparison layout={props.compareLayout as 'context' | 'cards'} base={base.current} preview={savedPreview.current && previewVersion.current === version.current && persisted.current === version.current ? savedPreview.current : null} candidates={regionCandidates} assignment={pixels.current.assignment} disabled={!!disabled} onAdopt={adoptRegion}/> : <div className="region-loading"><Spin /></div>) : <div className={`canvas-panels ${mode}${mode === 'edit' ? ` preview-${previewLayout}` : ''}`} aria-busy={loading} ref={node => { if (node && loading) node.scrollLeft = initialView.current.panelScroll || 0 }} onScroll={event => { if (props.viewState && event.target === event.currentTarget) props.viewState.current.panelScroll = event.currentTarget.scrollLeft }}>
      {panels.map(panel => <section key={panel.code} hidden={mode === 'edit' && panel.code === -1 && previewLayout === 'hidden'} className={mode === 'compose' ? 'compare-panel' : undefined} style={mode === 'compose' && initialView.current.widths?.[panel.code] ? {width: initialView.current.widths[panel.code]} : undefined} onPointerUp={event => { if (props.viewState && event.currentTarget.style.width) { props.viewState.current.widths ||= {}; props.viewState.current.widths[panel.code] = event.currentTarget.style.width } }}>
        {mode === 'compose' && panel.code === 0 && <div className="candidate-controls result-controls">{loading ? '載入中…' : previewReady !== props.previewUrl || saveState !== '已保存' ? '更新中…' : '與輸出一致 · 顯示即確認'}</div>}
        {mode === 'compose' && panel.code > 1 && <Space wrap className="candidate-controls"><Select aria-label={`比較面板 ${panel.code} 的來源`} value={panel.code} options={(props.candidates || []).map(c => ({value:c.code,label:c.label}))} onChange={next => setPanelOrder(order => order.map(c => c === panel.code ? next : c === next ? panel.code : c))} /><Button disabled={disabled} onClick={() => adoptAll(panel.code)}>本頁全部採用</Button></Space>}
        <strong>{panel.label}{mode === 'edit' && <span className="panel-note">{panel.code === 0 ? `正在編輯：${categoryName}` : computing ? '更新中…' : '背景更新'}</span>}</strong>
        {mode === 'compose' && <div className="compare-image-controls">{panel.code > 1 ? <><span>原圖</span><Slider aria-label={`${panel.label} 原圖顯示範圍`} value={compare} onChange={setCompare}/><span>{Math.round(compare)}%</span></> : <span>合成結果 · 原圖比例只影響候選預覽</span>}</div>}
        {mode === 'edit' && panel.code === 0 && <div className="panel-controls">
          {zoomControls}
          <label>填色預覽 <Select size="small" aria-label="填色預覽位置" value={previewLayout} onChange={setPreviewLayout} options={[{value:'right',label:'右側'},{value:'bottom',label:'下方'},{value:'hidden',label:'收起'}]} /></label>
          <div className="mask-mix"><Button size="small" onClick={() => setMaskPercent(0)}>原圖</Button><Slider aria-label="Mask / 原圖混合比例" min={0} max={100} value={maskPercent} onChange={setMaskPercent} /><Button size="small" onClick={() => setMaskPercent(100)}>Mask</Button><span>{maskPercent}%</span></div>
          <label>Mask 顯示顏色 <input type="color" aria-label="Mask 顯示顏色" value={maskColor} onChange={e => setMaskColor(e.target.value)} /></label>
          <label>填色透明度 <InputNumber size="small" aria-label="填色透明度" min={0} max={100} value={otherPercent} onChange={v => setOtherPercent(v ?? 38)} /> %</label>
          <label title="圖像修補標記顏色"><input type="color" aria-label="圖像修補標記顏色" value={otherColor} onChange={e => setOtherColor(e.target.value)} /></label>
        </div>}
        <div className="canvas-scroll" ref={node => { if (node) viewRefs.current.set(panel.code, node); else viewRefs.current.delete(panel.code) }}
          onScroll={event => { const el = event.currentTarget; if (props.viewState && !loading) Object.assign(props.viewState.current, {x:el.scrollLeft/(width*zoom), y:el.scrollTop/(height*zoom)}); for (const view of viewRefs.current.values()) if (view !== el && (view.scrollLeft !== el.scrollLeft || view.scrollTop !== el.scrollTop)) { view.scrollLeft = el.scrollLeft; view.scrollTop = el.scrollTop } }}>
          <div className={mode === 'edit' ? 'raster-stage' : 'raster-compose-stage'} style={{ width: width * zoom, height: height * zoom }}>
          <canvas tabIndex={0} aria-label={panel.label} width={width} height={height} style={{ width: width * zoom, height: height * zoom, cursor: tool === 'pan' ? 'grab' : 'crosshair', touchAction: 'none' }}
            ref={node => { if (node) { canvasRefs.current.set(panel.code, node); redraw() } else canvasRefs.current.delete(panel.code) }}
            onContextMenu={e => e.preventDefault()} onPointerDown={e => { if (mode === 'compose' && panel.code > 1 && e.button === 0 && !e.metaKey && !e.ctrlKey && Math.abs(point(e).x-width*compare/100)*zoom < 10) { divider.current=true; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); return } down(e,panel.code) }} onPointerMove={e => { if (divider.current) { setCompare(Math.max(0,Math.min(100,point(e).x/width*100))); return } move(e,panel.code) }}
            onPointerUp={e => { if (gesture.current && gesture.current.pointerId !== e.pointerId) return; if (gesture.current && !['pan', 'bounds'].includes(gesture.current.kind)) move(e, panel.code); if (divider.current) { divider.current=false; return } end() }} onPointerCancel={e => { if (gesture.current && gesture.current.pointerId !== e.pointerId) return; divider.current=false; cancelGesture() }} onDoubleClick={() => { if (mode === 'edit' && tool === 'lasso') finishLasso() }}
            onPointerLeave={() => { if (!gesture.current) { hover.current=null; previewMagic(null) } }} />
          {mode === 'edit' && panel.code === 0 && <canvas aria-hidden="true" className="raster-magic-preview" ref={magicCanvas} width={width} height={height} />}
          {mode === 'edit' && (panel.code === 0 || props.clipRect) && <svg aria-hidden="true" className="raster-interaction" viewBox={`0 0 ${width} ${height}`} ref={panel.code === 0 ? interactionSvg : previewClipSvg} />}
          </div>
        </div>
      </section>)}
    </div>}
    {loading && !regional && <Spin />}
    {localDraft && <LocalEditWindow open width={width} height={height} initialRect={localDraft.rect} baseUrl={props.baseUrl}
      overlayUrl={localDraft.overlayUrl} otherUrl={localDraft.otherUrl} editedUrl={localDraft.editedUrl} detectedTextUrl={props.detectedTextUrl}
      initialCategory={category} onApply={applyLocal} onCancel={() => setLocalDraft(null)} />}
  </div>
})
