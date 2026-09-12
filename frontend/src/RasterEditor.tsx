import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Dropdown, InputNumber, Select, Slider, Space, Spin } from 'antd'
import { renderEditViews } from './edit-preview'
import { combineSelection, magicSelection, polygonSelection, rectangleSelection, type SelectionOperation } from './selection-core'
import { applyCategoryMask, applySpecialSelection, textRepairMask, categoryMask, mergeLayerRegion, type EditCategory, type EditLayers, type EditRect } from './mask-edit-core'
import { LocalEditWindow } from './LocalEditWindow'

type Pixels = { overlay: ImageData; other: ImageData; edited: ImageData; assignment: Uint16Array }
export interface RasterSave {
  overlay: Blob; other: Blob; edited: Blob; assignment_rle: number[][]
}
export interface RasterHandle { flush: () => Promise<boolean> }
interface Candidate { code: number; label: string; url: string; diffUrl: string }
export interface ComposeView { widths?: Record<number, string>; panelScroll?: number; operation?: SelectionOperation; category?: EditCategory; color?: string; tolerance?: number; expand?: number; intersectOffset?: number; fit?: boolean; tool?: string; size?: number; zoom?: number; compare?: number; order?: number[]; show?: boolean; x?: number; y?: number }
interface Props {
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
  initialColor?: string
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
function surface(im: ImageData) {
  const canvas = document.createElement('canvas'); canvas.width = im.width; canvas.height = im.height
  canvas.getContext('2d')!.putImageData(im, 0, 0)
  return canvas
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
async function png(im: ImageData): Promise<Blob> {
  return new Promise((resolve, reject) => surface(im).toBlob(blob => blob ? resolve(blob) : reject(new Error('圖片編碼失敗')), 'image/png'))
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
function layers(p: Pixels): EditLayers { return { overlay: p.overlay.data, other: p.other.data, edited: p.edited.data } }
function replaceLayers(p: Pixels, next: EditLayers, width: number, height: number): Pixels {
  return { ...p, overlay: new ImageData(next.overlay as Uint8ClampedArray<ArrayBuffer>, width, height), other: new ImageData(next.other as Uint8ClampedArray<ArrayBuffer>, width, height), edited: new ImageData(next.edited as Uint8ClampedArray<ArrayBuffer>, width, height) }
}
type Point = { x: number; y: number }
type Gesture = Point & { lastX: number; lastY: number; code: number; before: Pixels; panX: number; panY: number; kind: string; operation: SelectionOperation | 'clear' | 'swap'; target: EditCategory; fillColor: string; selection: Uint8Array; edge?: string; roi?: EditRect }
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
  const repairText = useRef<Uint8Array | null>(null)
  const frame = useRef<number | null>(null)
  const candidates = useRef<Map<number, { image: ImageData; diff: ImageData }>>(new Map())
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map())
  const viewRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const history = useRef<Pixels[]>([]); const future = useRef<Pixels[]>([])
  const gesture = useRef<Gesture | null>(null)
  const lasso = useRef<Point[]>([])
  const hover = useRef<Point | null>(null)
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const preview = useRef<{ add: Uint8Array; remove: Uint8Array } | null>(null)
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
  const [expand, setExpand] = useState(props.viewState?.current.expand ?? 0)
  const [intersectOffset, setIntersectOffset] = useState(props.viewState?.current.intersectOffset ?? 0)
  const [color, setColor] = useState(props.initialColor || props.viewState?.current.color || '#ffffff'); const [size, setSize] = useState(props.viewState?.current.size || 16)
  const [zoom, setZoom] = useState(props.viewState?.current.zoom || Math.min(1, 550 / width)); const [compare, setCompare] = useState(props.viewState?.current.compare || 0)
  const [panelOrder, setPanelOrder] = useState(() => props.viewState?.current.order?.filter(code => props.candidates?.some(c => c.code === code)).concat((props.candidates || []).map(c => c.code).filter(code => !props.viewState?.current.order?.includes(code))) || (props.candidates || []).map(c => c.code))
  const divider = useRef(false)
  const savedPreview = useRef<ImageData | null>(null)
  const previewVersion = useRef(-1)
  const [previewReady, setPreviewReady] = useState('')
  const [previewRetry, setPreviewRetry] = useState(0)
  const previewCallback = useRef(props.onPreviewReady); previewCallback.current = props.onPreviewReady
  const redrawRef = useRef<() => void>(() => {})
  const [maskPercent, setMaskPercent] = useState(() => previewPreference('mask-percent', 70))
  const [maskColor, setMaskColor] = useState(() => previewPreference('mask-color', '#ffffff'))
  const [showMask, setShowMask] = useState(() => previewPreference('show-other', true))
  const [otherPercent, setOtherPercent] = useState(() => previewPreference('other-percent', 38))
  const [otherColor, setOtherColor] = useState(() => previewPreference('other-color', '#ff6ea5'))
  const [showSources, setShowSources] = useState(props.viewState?.current.show || false)
  const [historyState, setHistoryState] = useState([0, 0])

  const drawNow = useCallback(() => {
    const p = pixels.current; const b = base.current
    if (!p || !b) return
    if (mode === 'edit') {
      const views = renderEditViews({ base: b.data, overlay: p.overlay.data, other: p.other.data, edited: p.edited.data,
        detectedText: detectedText.current?.data }, { maskPercent, maskColor: rgb(maskColor), showOther: showMask,
        otherPercent, otherColor: rgb(otherColor) })
      for (const [code, canvas] of canvasRefs.current) {
        const ctx = canvas.getContext('2d')!
        const data = code === 0 ? views.left : views.right
        if (code === 0 && preview.current) {
          for (let n = 0; n < width * height; n++) {
            const tint = preview.current.remove[n] ? [245, 70, 70] : preview.current.add[n] ? [25, 210, 150] : null
            if (tint) for (let c = 0; c < 3; c++) data[n * 4 + c] = Math.round(data[n * 4 + c] * .4 + tint[c] * .6)
          }
        }
        ctx.putImageData(new ImageData(data, width, height), 0, 0)
        const roi = props.clipRect
        if (roi) {
          ctx.strokeStyle = '#168cff'; ctx.lineWidth = 2 / zoom; ctx.setLineDash([])
          ctx.strokeRect(roi.x, roi.y, roi.width, roi.height)
        }
        if (code === 0) {
          const g = gesture.current
          ctx.strokeStyle = '#168cff'; ctx.lineWidth = 2 / zoom; ctx.setLineDash([5 / zoom, 4 / zoom])
          if (g && ['rectangle', 'local'].includes(g.kind)) ctx.strokeRect(g.x, g.y, g.lastX - g.x, g.lastY - g.y)
          if (lasso.current.length) {
            ctx.beginPath(); ctx.moveTo(lasso.current[0].x, lasso.current[0].y)
            for (const point of lasso.current.slice(1)) ctx.lineTo(point.x, point.y)
            if (hover.current) ctx.lineTo(hover.current.x, hover.current.y)
            ctx.stroke()
          }
          ctx.setLineDash([])
        }
      }
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
      }
      const g = gesture.current
      if (g?.kind === 'rectangle') { ctx.strokeStyle = g.code === 1 ? '#d59a45' : '#2daf98'; ctx.lineWidth = 2/zoom; ctx.setLineDash([5/zoom,4/zoom]); ctx.strokeRect(g.x,g.y,g.lastX-g.x,g.lastY-g.y); ctx.setLineDash([]) }
    }
  }, [width, height, mode, compare, showMask, showSources, maskPercent, maskColor, otherPercent, otherColor, props.clipRect, zoom])
  const redraw = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => { frame.current = null; drawNow() })
  }, [drawNow])
  redrawRef.current = redraw
  useEffect(() => {
    if (props.viewState) Object.assign(props.viewState.current, {tool, size, zoom, compare, order: panelOrder, show: showSources, operation, category, color, tolerance, expand, intersectOffset})
  }, [props.viewState, tool, size, zoom, compare, panelOrder, showSources, operation, category, color, tolerance, expand, intersectOffset])
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); if (hoverTimer.current) clearTimeout(hoverTimer.current) }, [])
  useEffect(() => {
    if (mode !== 'edit') return
    try {
      for (const [key, value] of Object.entries({ 'mask-percent': maskPercent, 'mask-color': maskColor, 'show-other': showMask, 'other-percent': otherPercent, 'other-color': otherColor }))
        localStorage.setItem(`comic-editor-${key}`, JSON.stringify(value))
    } catch { /* Display preferences are optional when browser storage is unavailable. */ }
  }, [mode, maskPercent, maskColor, showMask, otherPercent, otherColor])

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
      repairText.current = textRepairMask(text?.data, p.width, p.height)
      base.current = b; detectedText.current = text; pixels.current = { overlay, other, edited, assignment }
      candidates.current = new Map(decoded.map(item => [item.code, item]))
      setLoading(false)
    })().catch(err => { if (!cancelled) { setLoading(false); setError(String(err)) } })
    return () => { cancelled = true; alive.current = false; if (timer.current) clearTimeout(timer.current) }
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
      if (mode !== 'compose' && !event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const source = event.currentTarget as HTMLDivElement
      const bounds = source.getBoundingClientRect(); const x = event.clientX-bounds.left; const y = event.clientY-bounds.top
      const next = Math.max(.05, Math.min(4, zoom * (event.deltaY < 0 ? 1.1 : 1/1.1)))
      const sx = (source.scrollLeft+x)/zoom; const sy = (source.scrollTop+y)/zoom
      if (props.viewState) props.viewState.current.fit = false
      setZoom(next)
      requestAnimationFrame(() => { for (const view of views) { view.scrollLeft=sx*next-x; view.scrollTop=sy*next-y } })
    }
    views.forEach(view => view.addEventListener('wheel', wheel, { passive: false }))
    return () => views.forEach(view => view.removeEventListener('wheel', wheel))
  }, [loading, mode, zoom, panelOrder, props.viewState])
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
    if (initial.current.viewState) requestAnimationFrame(() => { for (const v of viewRefs.current.values()) { v.scrollLeft=(initialView.current.x || 0)*v.scrollWidth; v.scrollTop=(initialView.current.y || 0)*v.scrollHeight } })
    setZoom(roi ? Math.max(.05, Math.min(4, (view.clientWidth - 24) / roi.width, (view.clientHeight - 24) / roi.height)) : Math.min(1, view.clientWidth / width))
  }, [loading, width, height, mode])
  useEffect(() => {
    const roi = props.clipRect
    if (!roi || loading || gesture.current?.kind === 'bounds') return
    for (const view of viewRefs.current.values()) { view.scrollLeft = Math.max(0, (roi.x + roi.width / 2) * zoom - view.clientWidth / 2); view.scrollTop = Math.max(0, (roi.y + roi.height / 2) * zoom - view.clientHeight / 2) }
  }, [zoom, loading, props.clipRect])
  useEffect(() => {
    history.current = []; future.current = []; setHistoryState([0, 0])
  }, [props.clipRect?.x, props.clipRect?.y, props.clipRect?.width, props.clipRect?.height])
  useEffect(() => { previewHandler.current(hover.current) }, [tolerance, expand, operation, category, special, tool, intersectOffset])
  useEffect(() => () => {
    if (localDraft) for (const url of [localDraft.overlayUrl, localDraft.otherUrl, localDraft.editedUrl]) URL.revokeObjectURL(url)
  }, [localDraft])

  const flush = useCallback(async (): Promise<boolean> => {
    if (gesture.current || lasso.current.length || localBlocked.current) return false
    if (timer.current) clearTimeout(timer.current)
    if (saving.current) return saving.current
    if (persisted.current >= version.current) return true
    const task = async () => {
      try {
        while (pixels.current && persisted.current < version.current) {
          const target = version.current; const snapshot = copy(pixels.current)
          if (alive.current) setSaveState('保存中…')
          const [overlay, other, edited] = initial.current.mode === 'edit'
            ? await Promise.all([png(snapshot.overlay), png(snapshot.other), png(snapshot.edited)])
            : [new Blob(), new Blob(), new Blob()]
          await saveCallback.current({ overlay, other, edited, assignment_rle: initial.current.mode === 'compose' ? rle(snapshot.assignment) : [] })
          persisted.current = target
        }
        if (alive.current) { setSaveState('已保存'); setError('') }
        dirtyCallback.current?.(false)
        return true
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
    if (mode === 'edit' && pixels.current) props.onRepairMaskChange?.(pixels.current.other.data.some((value, index) => index % 4 === 0 && value >= 128))
    preview.current = null
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    version.current++; dirtyCallback.current?.(true); setSaveState('尚未保存')
    setHistoryState([history.current.length, future.current.length]); redraw()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 800)
  }
  function clip(selection: Uint8Array) {
    const roi = props.clipRect
    if (roi) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (x < roi.x || x >= roi.x + roi.width || y < roi.y || y >= roi.y + roi.height) selection[y * width + x] = 0
    return selection
  }
  function inside(point: Point) {
    const r = props.clipRect
    return !r || (point.x >= r.x && point.x < r.x + r.width && point.y >= r.y && point.y < r.y + r.height)
  }
  function editedSelection(before: Pixels, selection: Uint8Array, op: Gesture['operation'], target = category, fillColor = color): Pixels {
    const data = layers(before)
    if (op === 'clear' || op === 'swap') return replaceLayers(before, applySpecialSelection(data, selection, op, rgb(fillColor), repairText.current), width, height)
    const current = categoryMask(data, target)
    const next = combineSelection(current, selection, width, height, op, intersectOffset)
    const paint = ['add', 'selection_inner', 'add_selection_inner'].includes(op) ? combineSelection(new Uint8Array(width * height), selection, width, height, op) : undefined
    return replaceLayers(before, applyCategoryMask(data, current, next, target, rgb(fillColor), props.clipRect ? clip(new Uint8Array(width * height).fill(1)) : undefined, paint), width, height)
  }
  function applyGesture(g: Gesture) {
    if (mode === 'edit') pixels.current = editedSelection(g.before, clip(g.selection), g.operation, g.target, g.fillColor)
    else {
      pixels.current = copy(g.before)
      for (let n = 0; n < g.selection.length; n++) if (g.selection[n] && (g.code <= 1 || (candidates.current.get(g.code)?.diff.data[n * 4] || 0) >= 128)) pixels.current.assignment[n] = g.code
    }
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
  function magic(point: Point) {
    if (!base.current || !inside(point)) return new Uint8Array(width * height)
    const roi = props.clipRect
    if (!roi) return magicSelection(base.current.data, width, height, point.x, point.y, tolerance, expand)
    const crop = new Uint8ClampedArray(roi.width * roi.height * 4)
    for (let y = 0; y < roi.height; y++) crop.set(base.current.data.subarray(((roi.y + y) * width + roi.x) * 4, ((roi.y + y) * width + roi.x + roi.width) * 4), y * roi.width * 4)
    const selected = magicSelection(crop, roi.width, roi.height, point.x - roi.x, point.y - roi.y, tolerance, expand)
    const result = new Uint8Array(width * height)
    for (let y = 0; y < roi.height; y++) result.set(selected.subarray(y * roi.width, (y + 1) * roi.width), (roi.y + y) * width + roi.x)
    return result
  }
  function previewMagic(point: Point | null) {
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    preview.current = null
    if (!point || tool !== 'magic' || special || disabled || gesture.current || !pixels.current) { redraw(); return }
    hoverTimer.current = setTimeout(() => {
      if (!pixels.current) return
      const before = layers(pixels.current)
      const next = layers(editedSelection(pixels.current, magic(point), operation))
      const add = new Uint8Array(width * height); const remove = new Uint8Array(width * height)
      const a = categoryMask(before, category); const b = categoryMask(next, category)
      for (let n = 0; n < a.length; n++) { add[n] = +((!a[n] && !!b[n]) || (category === 'solid' && !!b[n] && [0, 1, 2].some(c => before.overlay[n * 4 + c] !== next.overlay[n * 4 + c]))); remove[n] = +(!!a[n] && !b[n]) }
      preview.current = { add, remove }; redraw()
    }, 30)
  }
  previewHandler.current = previewMagic
  function chooseCategory(value: EditCategory) {
    if (disabled || props.local || gesture.current) return
    setCategory(value); lasso.current = []; preview.current = null
    try { localStorage.setItem('comic-editor-edit-category', JSON.stringify(value)) } catch { /* Optional UI preference. */ }
    if (persisted.current < version.current) timer.current = setTimeout(() => void flush(), 800)
    redraw()
  }
  function chooseTool(value: string) { lasso.current = []; hover.current = null; preview.current = null; setSpecial(null); setTool(value); if ((value !== 'magic' && ['selection_inner', 'add_selection_inner'].includes(operation)) || (value === 'magic' && operation === 'local_intersect')) setOperation('add'); if (persisted.current < version.current) timer.current = setTimeout(() => void flush(), 800); redraw() }
  function commitSelection(selection: Uint8Array, op: Gesture['operation'] = operation) {
    if (!pixels.current) return
    const before = copy(pixels.current)
    pixels.current = editedSelection(before, clip(selection), op)
    preview.current = null; pushHistory(before); future.current = []; changed()
  }
  function finishLasso() {
    if (lasso.current.length < 3 || disabled) return
    const selection = polygonSelection(lasso.current, width, height)
    lasso.current = []; hover.current = null; commitSelection(selection)
  }
  async function openLocal(rect: EditRect) {
    if (!pixels.current) return
    setOpeningLocal(true)
    try {
      const snapshot = copy(pixels.current)
      const blobs = await Promise.all([png(snapshot.overlay), png(snapshot.other), png(snapshot.edited)])
      setLocalDraft({ rect, overlayUrl: URL.createObjectURL(blobs[0]), otherUrl: URL.createObjectURL(blobs[1]), editedUrl: URL.createObjectURL(blobs[2]) })
    } catch (err) { setError(String(err)) }
    finally { setOpeningLocal(false) }
  }
  async function applyLocal(data: RasterSave, rect: EditRect) {
    if (!pixels.current) return
    const urls = [data.overlay, data.other, data.edited].map(blob => URL.createObjectURL(blob))
    try {
      const [overlay, other, edited] = await Promise.all(urls.map(url => load(url, width, height)))
      const before = copy(pixels.current)
      pixels.current = replaceLayers(before, mergeLayerRegion(layers(before), { overlay: overlay.data, other: other.data, edited: edited.data }, width, height, rect), width, height)
      pushHistory(before); future.current = []; setLocalDraft(null); changed()
    } finally { urls.forEach(url => URL.revokeObjectURL(url)) }
  }
  function down(event: React.PointerEvent<HTMLCanvasElement>, code: number) {
    if (!pixels.current || disabled || confirming.current || ![0, 1, 2].includes(event.button)) return
    const pan = event.button === 1 || (event.button === 0 && (event.metaKey || event.ctrlKey)) || tool === 'pan'
    if ((mode === 'edit' && code !== 0 || mode === 'compose' && code === 0) && !pan) return
    const p = point(event)
    if (!pan && tool !== 'bounds' && !inside(p)) return
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true })
    if (timer.current) clearTimeout(timer.current)
    if (hoverTimer.current) clearTimeout(hoverTimer.current)
    preview.current = null
    if (!pan && event.button === 0 && !special && tool === 'magic') { commitSelection(magic(p)); return }
    if (!pan && event.button === 0 && !special && tool === 'lasso') { lasso.current.push(p); hover.current = p; redraw(); return }
    const right = event.button === 2
    const kind = pan ? 'pan' : right || special ? 'rectangle' : tool
    const op = right ? (event.metaKey || event.ctrlKey ? 'swap' : 'clear') : special || operation
    const g: Gesture = { ...p, lastX: p.x, lastY: p.y, code: mode === 'compose' ? (event.button === 2 ? 1 : code || 1) : 0, before: copy(pixels.current), panX: event.clientX, panY: event.clientY, kind, operation: op, target: category, fillColor: color, selection: new Uint8Array(width * height) }
    if (kind === 'bounds' && props.clipRect) {
      const r = props.clipRect
      const outsideX = Math.max(r.x-p.x, 0, p.x-r.x-r.width); const outsideY = Math.max(r.y-p.y, 0, p.y-r.y-r.height)
      const distances = [{edge:'left', d:Math.hypot(p.x-r.x,outsideY)}, {edge:'right',d:Math.hypot(p.x-r.x-r.width,outsideY)}, {edge:'top',d:Math.hypot(p.y-r.y,outsideX)}, {edge:'bottom',d:Math.hypot(p.y-r.y-r.height,outsideX)}].sort((a,b)=>a.d-b.d)
      if (distances[0].d > 14 / zoom) return
      g.edge = distances[0].edge; g.roi = {...r}
    }
    event.currentTarget.setPointerCapture(event.pointerId); gesture.current = g
    if (kind === 'local') redraw()
    if (kind === 'brush') { stroke(g.selection, p, p); applyGesture(g) }
    else if (kind === 'rectangle') { g.selection = rectangleSelection(p.x, p.y, p.x, p.y, width, height); applyGesture(g) }
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>, code: number) {
    const p = point(event); const g = gesture.current
    if (!g) {
      if (mode === 'edit' && code === 0) { hover.current = p; if (tool === 'magic') previewMagic(p); else if (lasso.current.length) redraw() }
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
    if (g.kind === 'brush') stroke(g.selection, {x:g.lastX,y:g.lastY}, p)
    else if (g.kind === 'rectangle') g.selection = rectangleSelection(g.x, g.y, p.x, p.y, width, height)
    g.lastX = p.x; g.lastY = p.y
    if (g.kind !== 'local') applyGesture(g); else redraw()
  }
  function end() {
    const g = gesture.current; gesture.current = null
    if (!g) return
    if (['pan', 'bounds'].includes(g.kind)) { if (persisted.current < version.current) timer.current = setTimeout(() => void flush(), 800); return }
    if (g.kind === 'local') { void openLocal({x:Math.min(g.x,g.lastX), y:Math.min(g.y,g.lastY), width:Math.abs(g.x-g.lastX)+1, height:Math.abs(g.y-g.lastY)+1}); redraw(); return }
    pushHistory(g.before); future.current = []; changed()
  }
  function cancelGesture() {
    const g = gesture.current
    if (g) { pixels.current = g.before; gesture.current = null }
    lasso.current = []; hover.current = null; preview.current = null
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
  const categoryName = category === 'solid' ? '純色填充' : '待修補'
  const historyControls = <div className="editor-history-controls">
    <Button size="small" disabled={disabled || !historyState[0]} onClick={() => undo()}>撤銷</Button>
    <Button size="small" disabled={disabled || !historyState[1]} onClick={() => undo(true)}>重做</Button>
    {(mode === 'edit' || saveState.includes('失敗')) && <Button size="small" onClick={() => void flush()} disabled={disabled}>{props.local ? '更新副本' : '保存'}</Button>}
    <span className="editor-save-state" role="status">{props.local && saveState === '已保存' ? '副本・尚未套用' : saveState}</span>
  </div>
  const zoomControls = <div className="editor-zoom-controls" onClickCapture={() => { if (props.viewState) props.viewState.current.fit = false }} onChangeCapture={() => { if (props.viewState) props.viewState.current.fit = false }}><Button size="small" aria-label="縮小圖片" onClick={() => setZoom(z => Math.max(.05, z / 1.25))}>−</Button><Button size="small" aria-label="放大圖片" onClick={() => setZoom(z => Math.min(4, z * 1.25))}>＋</Button><Button size="small" onClick={() => setZoom(1)}>原尺寸</Button><label>縮放 <InputNumber size="small" aria-label="縮放百分比" min={5} max={400} value={Math.round(zoom * 100)} onChange={v => setZoom((v || 100) / 100)} /> %</label><Button size="small" onClick={fit}>適合視窗</Button></div>
  const panels = mode === 'edit' ? [{ code: 0, label: 'Mask / 原圖' }, { code: -1, label: '填色預覽' }]
    : [{ code: 0, label: '合成結果' }, ...panelOrder.map(code => props.candidates!.find(c => c.code === code)!)]
  return <div className="raster-editor" onKeyDown={event => {
    const tag = (event.target as HTMLElement).tagName
    if (mode === 'edit' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && ['F1', 'F2'].includes(event.key)) { event.preventDefault(); chooseCategory(event.key === 'F1' ? 'solid' : 'other'); return }
    if (mode === 'compose' && !['INPUT','TEXTAREA','SELECT'].includes(tag)) {
      if (event.key.toLowerCase() === 'm') { event.preventDefault(); setShowSources(v => !v) }
      if (event.key === '[' || event.key === ']') { event.preventDefault(); setSize(v => Math.max(2,Math.min(200,v+(event.key === '[' ? -4 : 4)))) }
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
        {category === 'solid' && <label className="fill-color-control">填色 <input aria-label="填充顏色" type="color" disabled={disabled} value={color} onChange={event => setColor(event.target.value)} /></label>}
        {historyControls}
      </div>
      <div className="edit-control-row">
        <span className="edit-row-label">工具</span>
        <div role="group" aria-label="編輯工具" className="selection-tools">
          {[{value:'rectangle',label:'矩形'},{value:'brush',label:'畫筆'},{value:'magic',label:'魔法棒'},{value:'lasso',label:'套索'}, props.local ? {value:'bounds',label:'調整邊框'} : {value:'local',label:'局部視窗'}].map(item =>
            <Button key={item.value} aria-pressed={tool === item.value && !special} type={tool === item.value && !special ? 'primary' : 'default'} disabled={disabled} onClick={() => chooseTool(item.value)}>{item.label}</Button>)}
        </div>
        {tool === 'brush' && !special && <label className="tool-setting">大小 <InputNumber size="small" disabled={disabled} aria-label="筆刷像素" min={1} max={200} value={size} onChange={v => setSize(v || 1)} /> px</label>}
        {tool === 'magic' && !special && <div className="tool-settings">
          <label>容差 <InputNumber size="small" aria-label="魔法棒容差" disabled={disabled} min={0} max={100} value={tolerance} onChange={v => setTolerance(v ?? 28)} /></label>
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
      <div className="edit-control-footer">
        <div className="editor-context-hint">
          <span className="mask-action-hint" title="純色轉待修補只保留文字及人工範圍，撤掉框內氣泡擴展填色" aria-label="Mask 互換">純色填充 ↔ 待修補</span>
          <small>{special === 'clear' ? '左鍵框選，同時清除兩類 Mask' : tool === 'lasso' ? '逐點選取 · Enter 閉合 · Backspace 退點 · Esc 取消' : tool === 'local' ? '框選局部範圍，套用才回寫' : tool === 'bounds' ? '拖動藍色範圍四邊' : tool === 'magic' ? '綠色預覽添加，紅色預覽減去；點擊套用' : '右鍵清除 · Cmd／Ctrl＋右鍵拖框互換'}</small>
        </div>
        {zoomControls}
      </div>
    </div> : <>
      <Space wrap className="editor-toolbar">
        <Select aria-label="編輯工具" value={tool} onChange={chooseTool} options={[{value:'brush',label:'筆刷'},{value:'rectangle',label:'矩形'},{value:'pan',label:'平移'}]} />
        <Dropdown menu={{items:[{key:'base',label:'本頁恢復為修復前底圖'},{key:'first',label:`本頁重新採用 ${props.candidates?.[0]?.label || '第一組'}`}],onClick:({key}) => adoptAll(key === 'base' ? 1 : props.candidates?.[0]?.code || 1, true)}} disabled={disabled}><Button>重設本頁 ▾</Button></Dropdown>
        {tool === 'brush' && <label>筆刷 <InputNumber disabled={disabled} aria-label="筆刷像素" min={1} max={200} value={size} onChange={v => setSize(v || 1)} /> px</label>}
        {historyControls}
      </Space>
      <Space wrap className="editor-toolbar">{zoomControls}<Checkbox checked={showSources} onChange={e => setShowSources(e.target.checked)}>M 顯示選區（深色已採用／淡色未採用）</Checkbox><label className="compare-slider">原圖顯示範圍 <Slider value={compare} onChange={setCompare} /></label></Space>
    <small className="compose-hint">左鍵框選／筆刷採用所在候選 · 右鍵固定拖框保留底圖 · 中鍵拖動 · 滾輪縮放 · [／] 調筆刷 · 拖動黃色分隔線比較原圖</small></>}
    <div className={`canvas-panels ${mode}`} aria-busy={loading} ref={node => { if (node && loading) node.scrollLeft = initialView.current.panelScroll || 0 }} onScroll={event => { if (props.viewState && event.target === event.currentTarget) props.viewState.current.panelScroll = event.currentTarget.scrollLeft }}>
      {panels.map(panel => <section key={panel.code} className={mode === 'compose' ? 'compare-panel' : undefined} style={mode === 'compose' && initialView.current.widths?.[panel.code] ? {width: initialView.current.widths[panel.code]} : undefined} onPointerUp={event => { if (props.viewState && event.currentTarget.style.width) { props.viewState.current.widths ||= {}; props.viewState.current.widths[panel.code] = event.currentTarget.style.width } }}>
        {mode === 'compose' && panel.code === 0 && <div className="candidate-controls result-controls">{loading ? '載入中…' : previewReady !== props.previewUrl || saveState !== '已保存' ? '更新中…' : '與輸出一致 · 顯示即確認'}</div>}
        {mode === 'compose' && panel.code > 1 && <Space wrap className="candidate-controls"><Select aria-label={`比較面板 ${panel.code} 的來源`} value={panel.code} options={(props.candidates || []).map(c => ({value:c.code,label:c.label}))} onChange={next => setPanelOrder(order => order.map(c => c === panel.code ? next : c === next ? panel.code : c))} /><Button disabled={disabled} onClick={() => adoptAll(panel.code)}>本頁全部採用</Button></Space>}
        <strong>{panel.label}{mode === 'edit' && <span className="panel-note">{panel.code === 0 ? `正在編輯：${categoryName}` : '即時更新'}</span>}</strong>
        {mode === 'edit' && <div className="panel-controls">{panel.code === 0 ? <>
          <div className="mask-mix"><Button size="small" onClick={() => setMaskPercent(0)}>原圖</Button><Slider aria-label="Mask / 原圖混合比例" min={0} max={100} value={maskPercent} onChange={setMaskPercent} /><Button size="small" onClick={() => setMaskPercent(100)}>Mask</Button><span>{maskPercent}%</span></div>
          <label>Mask 顯示顏色 <input type="color" aria-label="Mask 顯示顏色" value={maskColor} onChange={e => setMaskColor(e.target.value)} /></label>
        </> : <>
          <Checkbox checked={showMask} onChange={e => setShowMask(e.target.checked)}>顯示圖像修補</Checkbox>
          <label>標記顏色 <input type="color" aria-label="圖像修補標記顏色" value={otherColor} onChange={e => setOtherColor(e.target.value)} /></label>
          <label>透明度 <InputNumber aria-label="图像修補標記透明度" min={0} max={100} value={otherPercent} onChange={v => setOtherPercent(v ?? 38)} /> %</label>
        </>}</div>}
        <div className="canvas-scroll" ref={node => { if (node) viewRefs.current.set(panel.code, node) }}
          onScroll={event => { const el = event.currentTarget; if (props.viewState && !loading) Object.assign(props.viewState.current, {x:el.scrollLeft/(width*zoom), y:el.scrollTop/(height*zoom)}); for (const view of viewRefs.current.values()) if (view !== el && (view.scrollLeft !== el.scrollLeft || view.scrollTop !== el.scrollTop)) { view.scrollLeft = el.scrollLeft; view.scrollTop = el.scrollTop } }}>
          <canvas tabIndex={0} aria-label={panel.label} width={width} height={height} style={{ width: width * zoom, height: height * zoom, cursor: tool === 'pan' ? 'grab' : 'crosshair', touchAction: 'none' }}
            ref={node => { if (node) { canvasRefs.current.set(panel.code, node); redraw() } else canvasRefs.current.delete(panel.code) }}
            onContextMenu={e => e.preventDefault()} onPointerDown={e => { if (mode === 'compose' && panel.code > 1 && e.button === 0 && Math.abs(point(e).x-width*compare/100)*zoom < 10) { divider.current=true; e.preventDefault(); e.currentTarget.setPointerCapture(e.pointerId); return } down(e,panel.code) }} onPointerMove={e => { if (divider.current) { setCompare(Math.max(0,Math.min(100,point(e).x/width*100))); return } move(e,panel.code) }}
            onPointerUp={() => { if (divider.current) { divider.current=false; return } end() }} onPointerCancel={() => { divider.current=false; cancelGesture() }} onDoubleClick={() => { if (mode === 'edit' && tool === 'lasso') finishLasso() }}
            onPointerLeave={() => { if (!gesture.current) { hover.current=null; previewMagic(null) } }} />
        </div>
      </section>)}
    </div>
    {loading && <Spin />}
    {localDraft && <LocalEditWindow open width={width} height={height} initialRect={localDraft.rect} baseUrl={props.baseUrl}
      overlayUrl={localDraft.overlayUrl} otherUrl={localDraft.otherUrl} editedUrl={localDraft.editedUrl} detectedTextUrl={props.detectedTextUrl}
      initialCategory={category} initialColor={color} onApply={applyLocal} onCancel={() => setLocalDraft(null)} />}
  </div>
})
