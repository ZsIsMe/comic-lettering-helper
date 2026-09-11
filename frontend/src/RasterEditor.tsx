import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Alert, Button, Checkbox, InputNumber, Select, Slider, Space, Spin, Tag } from 'antd'

type Pixels = { overlay: ImageData; other: ImageData; edited: ImageData; assignment: Uint16Array }
export interface RasterSave {
  overlay: Blob; other: Blob; edited: Blob; assignment_rle: number[][]
}
export interface RasterHandle { flush: () => Promise<boolean> }
interface Candidate { code: number; label: string; url: string; diffUrl: string }
interface Props {
  width: number; height: number; baseUrl: string; mode: 'edit' | 'compose'
  overlayUrl?: string; otherUrl?: string; editedUrl?: string
  assignmentRle?: number[][]; candidates?: Candidate[]
  onSave: (data: RasterSave) => Promise<void>
  onDirty?: (dirty: boolean) => void
  disabled?: boolean
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

/** All masks and selections use original image pixels; zoom affects CSS only. */
export const RasterEditor = forwardRef<RasterHandle, Props>(function RasterEditor(props, ref) {
  const { width, height, mode, disabled } = props
  const initial = useRef(props)
  const pixels = useRef<Pixels | null>(null)
  const base = useRef<ImageData | null>(null)
  const candidates = useRef<Map<number, { image: ImageData; diff: ImageData }>>(new Map())
  const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map())
  const viewRefs = useRef<Map<number, HTMLDivElement>>(new Map())
  const history = useRef<Pixels[]>([]); const future = useRef<Pixels[]>([])
  const gesture = useRef<{ x: number; y: number; lastX: number; lastY: number; code: number; before: Pixels; panX: number; panY: number } | null>(null)
  const version = useRef(0); const persisted = useRef(0)
  const saving = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  const saveCallback = useRef(props.onSave); saveCallback.current = props.onSave
  const dirtyCallback = useRef(props.onDirty); dirtyCallback.current = props.onDirty
  const [loading, setLoading] = useState(true); const [error, setError] = useState('')
  const [saveState, setSaveState] = useState('已保存')
  const [tool, setTool] = useState('brush'); const [category, setCategory] = useState('other')
  const [color, setColor] = useState('#ffffff'); const [size, setSize] = useState(16)
  const [zoom, setZoom] = useState(Math.min(1, 550 / width)); const [compare, setCompare] = useState(100)
  const [sourceCode, setSourceCode] = useState(1)
  const [showMask, setShowMask] = useState(true)
  const [showSources, setShowSources] = useState(false)
  const [historyState, setHistoryState] = useState([0, 0])

  const redraw = useCallback(() => {
    const p = pixels.current; const b = base.current
    if (!p || !b) return
    for (const [code, canvas] of canvasRefs.current) {
      const ctx = canvas.getContext('2d')!
      const out = new ImageData(new Uint8ClampedArray(b.data), width, height)
      if (mode === 'edit' && code === 0) {
        for (let i = 0; i < out.data.length; i += 4) {
          const alpha = p.overlay.data[i + 3] / 255
          for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(out.data[i + c] * (1 - alpha) + p.overlay.data[i + c] * alpha)
          if (showMask && p.other.data[i] >= 128) {
            out.data[i] = Math.round(out.data[i] * .5 + 255 * .5)
            out.data[i + 1] = Math.round(out.data[i + 1] * .5 + 70 * .5)
            out.data[i + 2] = Math.round(out.data[i + 2] * .5 + 160 * .5)
          }
        }
      } else if (mode === 'compose') {
        if (code === 0) {
          for (let n = 0; n < p.assignment.length; n++) {
            const source = candidates.current.get(p.assignment[n])?.image
            if (source) for (let c = 0; c < 3; c++) out.data[n * 4 + c] = source.data[n * 4 + c]
            if (showSources && p.assignment[n] > 1) {
              const tint = [[225, 130, 65], [65, 180, 105], [110, 125, 225]][(p.assignment[n] - 2) % 3]
              for (let c = 0; c < 3; c++) out.data[n * 4 + c] = Math.round(out.data[n * 4 + c] * .6 + tint[c] * .4)
            }
          }
        } else {
          const source = candidates.current.get(code)?.image
          if (source) {
            for (let y = 0; y < height; y++) for (let x = 0; x < width * compare / 100; x++) {
              const i = (y * width + x) * 4
              for (let c = 0; c < 3; c++) out.data[i + c] = source.data[i + c]
            }
          }
        }
      }
      ctx.putImageData(out, 0, 0)
    }
  }, [width, height, mode, compare, showMask, showSources])

  useEffect(() => {
    alive.current = true
    let cancelled = false
    const p = initial.current
    void (async () => {
      const [b, overlay, other, edited] = await Promise.all([
        load(p.baseUrl, p.width, p.height), load(p.overlayUrl || '', p.width, p.height),
        load(p.otherUrl || '', p.width, p.height, true), load(p.editedUrl || '', p.width, p.height, true),
      ])
      const assignment = new Uint16Array(p.width * p.height)
      let offset = 0
      for (const [value, count] of p.assignmentRle || []) { assignment.fill(value, offset, offset + count); offset += count }
      const decoded = await Promise.all((p.candidates || []).map(async candidate => ({ code: candidate.code,
        image: await load(candidate.url, p.width, p.height), diff: await load(candidate.diffUrl, p.width, p.height) })))
      if (cancelled) return
      base.current = b; pixels.current = { overlay, other, edited, assignment }
      candidates.current = new Map(decoded.map(item => [item.code, item]))
      setLoading(false)
    })().catch(err => { if (!cancelled) { setLoading(false); setError(String(err)) } })
    return () => { cancelled = true; alive.current = false; if (timer.current) clearTimeout(timer.current) }
  }, [])
  useEffect(() => { if (!loading) redraw() }, [loading, redraw])
  useEffect(() => {
    if (!loading) {
      const available = viewRefs.current.get(0)?.clientWidth
      if (available) setZoom(Math.min(1, available / width))
    }
  }, [loading, width])

  const flush = useCallback(async (): Promise<boolean> => {
    if (gesture.current) return false
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
    const warn = (event: BeforeUnloadEvent) => { if (persisted.current < version.current) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  function changed() {
    version.current++; dirtyCallback.current?.(true); setSaveState('尚未保存')
    setHistoryState([history.current.length, future.current.length]); redraw()
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 800)
  }
  function mark(x: number, y: number, code: number) {
    const p = pixels.current!
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const n = y * width + x; const i = n * 4
    if (mode === 'compose') {
      if (code <= 1 || (candidates.current.get(code)?.diff.data[i] || 0) >= 128) p.assignment[n] = code
      return
    }
    const rgba = [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16), 255]
    p.edited.data.set([255, 255, 255, 255], i)
    if (category === 'solid') { p.overlay.data.set(rgba, i); p.other.data.set([0, 0, 0, 255], i) }
    else if (category === 'other') { p.overlay.data.set([0, 0, 0, 0], i); p.other.data.set([255, 255, 255, 255], i) }
    else { p.overlay.data.set([0, 0, 0, 0], i); p.other.data.set([0, 0, 0, 255], i) }
  }
  function stroke(x1: number, y1: number, x2: number, y2: number, code: number) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)))
    const radius = size / 2
    for (let s = 0; s <= steps; s++) {
      const x = x1 + (x2 - x1) * s / steps; const y = y1 + (y2 - y1) * s / steps
      for (let yy = Math.max(0, Math.floor(y - radius)); yy <= Math.min(height - 1, y + radius); yy++)
        for (let xx = Math.max(0, Math.floor(x - radius)); xx <= Math.min(width - 1, x + radius); xx++)
          if ((xx - x) ** 2 + (yy - y) ** 2 <= radius ** 2) mark(xx, yy, code)
    }
  }
  function point(event: React.PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: Math.max(0, Math.min(width - 1, Math.floor((event.clientX - rect.left) * width / rect.width))),
      y: Math.max(0, Math.min(height - 1, Math.floor((event.clientY - rect.top) * height / rect.height))) }
  }
  function down(event: React.PointerEvent<HTMLCanvasElement>, code: number) {
    if (!pixels.current || disabled || (mode === 'edit' && code !== 0 && tool !== 'pan')) return
    const p = point(event)
    event.currentTarget.focus({ preventScroll: true })
    if (timer.current) clearTimeout(timer.current)
    if (tool === 'eyedropper' && base.current) {
      const i = (p.y * width + p.x) * 4
      setColor('#' + [...base.current.data.slice(i, i + 3)].map(v => v.toString(16).padStart(2, '0')).join('')); return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    const appliedCode = mode === 'compose' ? (event.button === 2 ? 1 : code || sourceCode) : 0
    gesture.current = { ...p, lastX: p.x, lastY: p.y, code: appliedCode, before: copy(pixels.current), panX: event.clientX, panY: event.clientY }
    if (tool === 'brush') { stroke(p.x, p.y, p.x, p.y, appliedCode); redraw() }
  }
  function move(event: React.PointerEvent<HTMLCanvasElement>, code: number) {
    const g = gesture.current
    if (!g || !pixels.current) return
    if (tool === 'pan') {
      const view = viewRefs.current.get(code)
      if (view) { view.scrollLeft -= event.clientX - g.panX; view.scrollTop -= event.clientY - g.panY }
      g.panX = event.clientX; g.panY = event.clientY; return
    }
    const p = point(event)
    if (tool === 'brush') stroke(g.lastX, g.lastY, p.x, p.y, g.code)
    else if (tool === 'rectangle') {
      pixels.current = copy(g.before)
      for (let y = Math.min(g.y, p.y); y <= Math.max(g.y, p.y); y++)
        for (let x = Math.min(g.x, p.x); x <= Math.max(g.x, p.x); x++) mark(x, y, g.code)
    }
    g.lastX = p.x; g.lastY = p.y; redraw()
  }
  function end() {
    const g = gesture.current; gesture.current = null
    if (!g || tool === 'pan') return
    pushHistory(g.before)
    future.current = []; changed()
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
  function adoptAll() {
    if (!pixels.current) return
    pushHistory(copy(pixels.current)); future.current = []
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) mark(x, y, sourceCode)
    changed()
  }
  const panels = mode === 'edit' ? [{ code: 0, label: '填色與待修補區域' }, { code: -1, label: '原圖' }]
    : [{ code: 0, label: '局部採用預覽（邊緣羽化於保存後預覽）' }, ...(props.candidates || [])]
  return <div className="raster-editor" onKeyDown={event => {
    if ((event.target as HTMLElement).tagName !== 'CANVAS') return
    if (mode === 'edit' && ['F1', 'F2'].includes(event.key)) { event.preventDefault(); setCategory(event.key === 'F1' ? 'solid' : 'other') }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(event.shiftKey) }
  }}>
    {error && <Alert type="error" showIcon message={error} action={<Button onClick={() => void flush()}>重試保存</Button>} />}
    <Space wrap className="editor-toolbar">
      <Select aria-label="編輯工具" value={tool} onChange={setTool} options={[
        { value: 'brush', label: '筆刷' }, { value: 'rectangle', label: '矩形' }, { value: 'pan', label: '平移' },
        ...(mode === 'edit' ? [{ value: 'eyedropper', label: '取色' }] : []),
      ]} />
      {mode === 'edit' ? <>
        <Select aria-label="編輯類別" value={category} onChange={setCategory} options={[{ value: 'other', label: 'F2 待修補' }, { value: 'solid', label: 'F1 純色填充' }, { value: 'erase', label: '擦除並保留原圖' }]} />
        <input aria-label="填充顏色" type="color" value={color} onChange={event => setColor(event.target.value)} />
      </> : <>
        <Select aria-label="採用來源" value={sourceCode} onChange={setSourceCode} options={[{ value: 1, label: '保留底圖' }, ...(props.candidates || []).map(c => ({ value: c.code, label: c.label }))]} />
        <Button disabled={disabled} onClick={adoptAll}>整組採用</Button>
      </>}
      <label>筆刷 <InputNumber aria-label="筆刷像素" min={1} max={200} value={size} onChange={v => setSize(v || 1)} /> px</label>
      <Button disabled={disabled || !historyState[0]} onClick={() => undo()}>撤銷</Button>
      <Button disabled={disabled || !historyState[1]} onClick={() => undo(true)}>重做</Button>
      <Button onClick={() => void flush()} disabled={disabled}>保存</Button><Tag color={saveState === '已保存' ? 'green' : 'orange'}>{saveState}</Tag>
    </Space>
    <Space wrap className="editor-toolbar">
      <label>縮放 <InputNumber aria-label="縮放百分比" min={5} max={400} value={Math.round(zoom * 100)} onChange={v => setZoom((v || 100) / 100)} /> %</label>
      <Button onClick={() => setZoom(Math.min(1, (viewRefs.current.get(0)?.clientWidth || 550) / width))}>適合視窗</Button>
      {mode === 'edit' ? <Checkbox checked={showMask} onChange={e => setShowMask(e.target.checked)}>顯示待修補 Mask</Checkbox>
        : <Checkbox checked={showSources} onChange={e => setShowSources(e.target.checked)}>顯示來源顏色</Checkbox>}
      {mode === 'compose' && <label className="compare-slider">候選顯示比例 <Slider value={compare} onChange={setCompare} /></label>}
    </Space>
    {loading ? <Spin tip="載入原尺寸圖片…"><div style={{ height: 240 }} /></Spin> : <div className={`canvas-panels ${mode}`}>
      {panels.map(panel => <section key={panel.code}>
        <strong>{panel.label}</strong>
        <div className="canvas-scroll" ref={node => { if (node) viewRefs.current.set(panel.code, node) }}
          onScroll={event => { const el = event.currentTarget; for (const view of viewRefs.current.values()) if (view !== el && (view.scrollLeft !== el.scrollLeft || view.scrollTop !== el.scrollTop)) { view.scrollLeft = el.scrollLeft; view.scrollTop = el.scrollTop } }}>
          <canvas tabIndex={0} aria-label={panel.label} width={width} height={height} style={{ width: width * zoom, height: height * zoom, cursor: tool === 'pan' ? 'grab' : 'crosshair', touchAction: 'none' }}
            ref={node => { if (node) { canvasRefs.current.set(panel.code, node); requestAnimationFrame(redraw) } }}
            onContextMenu={e => e.preventDefault()} onPointerDown={e => down(e, panel.code)} onPointerMove={e => move(e, panel.code)}
            onPointerUp={end} onPointerCancel={() => { const g = gesture.current; if (g) { pixels.current = g.before; gesture.current = null; redraw(); if (persisted.current < version.current) timer.current = setTimeout(() => void flush(), 800) } }} />
        </div>
      </section>)}
    </div>}
  </div>
})
