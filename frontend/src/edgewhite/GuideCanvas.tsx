import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { Alert, Button, InputNumber, Space, Tag } from 'antd'
import { addGuide, moveGuide, positions, rectangles, removeGuide, toggleCell } from './guide-layout'
import { api, collectionUrl, json, sourceUrl } from './api'
import type { ActiveGuide, Axis, Collection, Direction, Edit, Page, SnapMatch } from './model'

export interface GuideHandle { flush: (output?: boolean) => Promise<boolean> }
interface Props { cid: string; page: Page; onSaved: (collection: Collection) => void; onNext: () => void; onPrevious: () => void }
type Camera = { zoom: number; x: number; y: number }
type Gesture = { kind: 'guide' | 'new' | 'pan'; axis?: Axis; active?: ActiveGuide; x: number; y: number; camera: Camera; created?: boolean; edit: Edit }
const EMPTY: Edit = { verticalGuides: [], horizontalGuides: [], selectedCells: [] }
function preferences() {
  try {
    const value = JSON.parse(localStorage.getItem('edgewhite-preferences') || '{}')
    const slots: Record<string, number> = {}
    for (const key of ['top', 'bottom', 'left', 'right']) if (Number.isInteger(value.slots?.[key]) && value.slots[key] > 0) slots[key] = value.slots[key]
    return { tolerance: Number.isInteger(value.tolerance) ? Math.max(0, Math.min(255, value.tolerance)) : 30, slots }
  } catch { return { tolerance: 30, slots: {} as Record<string, number> } }
}

export const GuideCanvas = forwardRef<GuideHandle, Props>(function GuideCanvas({ cid, page, onSaved, onNext, onPrevious }, ref) {
  const root = useRef<HTMLElement>(null), viewport = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ width: 650, height: 700 })
  const [edit, setEdit] = useState<Edit>(page.edit), current = useRef(page.edit)
  const [active, setActive] = useState<ActiveGuide | null>(null), activeRef = useRef<ActiveGuide | null>(null)
  const [camera, setCamera] = useState<Camera>({ zoom: 1, x: 0, y: 0 })
  const [prefs, setPrefs] = useState(preferences)
  const [ready, setReady] = useState(false), [error, setError] = useState(''), [status, setStatus] = useState('從四邊標尺拖出參考線，再指定方向尋找空白位置')
  const [saveStatus, setSaveStatus] = useState('草稿已保存'), [outputRevision, setOutputRevision] = useState(page.output_revision)
  const [pending, setPending] = useState(false), [undoEnabled, setUndoEnabled] = useState(false)
  const worker = useRef<Worker | null>(null), generation = useRef(0)
  const request = useRef<{ id: number; guide: ActiveGuide; start: number } | null>(null)
  const undo = useRef<{ guide: ActiveGuide; position: number } | null>(null)
  const version = useRef(0), persisted = useRef(0), revision = useRef(page.revision)
  const saving = useRef<Promise<boolean> | null>(null), timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const gesture = useRef<Gesture | null>(null), alive = useRef(true)
  const callback = useRef(onSaved); callback.current = onSaved
  const source = sourceUrl(cid, page.id), imageKey = `${cid}:${page.id}:${page.source_sha256}`
  const fit = Math.min((size.width - 96) / page.width, (size.height - 96) / page.height)
  const scale = Math.max(.0001, fit) * camera.zoom
  const iw = page.width * scale, ih = page.height * scale
  const ix = (size.width - iw) / 2 + camera.x, iy = (size.height - ih) / 2 + camera.y
  const clamped = (c: Camera): Camera => {
    const x = Math.max(0, (page.width * fit * c.zoom - (size.width - 56)) / 2)
    const y = Math.max(0, (page.height * fit * c.zoom - (size.height - 56)) / 2)
    return { ...c, x: Math.max(-x, Math.min(x, c.x)), y: Math.max(-y, Math.min(y, c.y)) }
  }
  function invalidate() {
    generation.current++; request.current = null; undo.current = null
    setPending(false); setUndoEnabled(false)
  }
  function select(guide: ActiveGuide | null) { invalidate(); activeRef.current = guide; setActive(guide) }
  function change(next: Edit) {
    invalidate(); current.current = next; setEdit(next); version.current++; setSaveStatus('尚未保存')
  }
  const flush = useCallback(async (output = false): Promise<boolean> => {
    if (gesture.current) return false
    if (timer.current) clearTimeout(timer.current)
    if (saving.current) { if (!await saving.current) return false; return flush(output) }
    if (!output && persisted.current === version.current) return true
    const task = async () => {
      try {
        const force = output
        do {
          const target = version.current
          const collection = await api<Collection>(`${collectionUrl(cid)}/pages/${page.id}`, json('PUT', { revision: revision.current, edit: current.current, output: force }))
          const saved = collection.pages.find(p => p.id === page.id)!
          revision.current = saved.revision; persisted.current = target
          if (alive.current) { setOutputRevision(saved.output_revision); callback.current(collection) }
        } while (persisted.current !== version.current)
        if (alive.current) { setSaveStatus('草稿已保存'); setError('') }
        return true
      } catch (err) {
        if (alive.current) { setSaveStatus('保存失敗'); setError(err instanceof Error ? err.message : String(err)) }
        return false
      } finally { saving.current = null }
    }
    setSaveStatus(output ? '正在保存圖片…' : '正在保存草稿…')
    saving.current = task()
    return saving.current
  }, [cid, page.id])
  useImperativeHandle(ref, () => ({ flush }), [flush])
  function schedule() { if (timer.current) clearTimeout(timer.current); timer.current = setTimeout(() => void flush(), 500) }
  function apply(next: Edit) { change(next); schedule() }

  useEffect(() => {
    alive.current = true
    const node = viewport.current!
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    observer.observe(node)
    const warn = (event: BeforeUnloadEvent) => { if (persisted.current !== version.current || saving.current) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => { alive.current = false; observer.disconnect(); window.removeEventListener('beforeunload', warn); if (timer.current) clearTimeout(timer.current) }
  }, [])
  useEffect(() => {
    const node = viewport.current!
    const wheel = (event: WheelEvent) => { event.preventDefault(); setCamera(c => { const zoom = Math.max(1, Math.min(5, c.zoom - event.deltaY * .004)); return { zoom, x: zoom === 1 ? 0 : c.x, y: zoom === 1 ? 0 : c.y } }) }
    node.addEventListener('wheel', wheel, { passive: false })
    return () => node.removeEventListener('wheel', wheel)
  }, [])
  useEffect(() => { localStorage.setItem('edgewhite-preferences', JSON.stringify(prefs)) }, [prefs])
  useEffect(() => {
    let cancelled = false
    const w = new Worker(new URL('./guide-snap.worker.ts', import.meta.url), { type: 'module' })
    worker.current = w
    w.onerror = () => { if (!cancelled) { setError('搜尋工具載入失敗，請重新開啟頁面'); setPending(false) } }
    w.onmessage = (event: MessageEvent<{ kind: string; key: string; id: number; match: SnapMatch | null; message: string; elapsed: number }>) => {
      if (cancelled || event.data.key !== imageKey) return
      if (event.data.kind === 'ready') { setReady(true); return }
      if (event.data.kind === 'error') { setError(event.data.message); setPending(false); return }
      const r = request.current
      if (!r || r.id !== event.data.id || r.id !== generation.current) return
      request.current = null; setPending(false)
      const match = event.data.match
      if (!match) { setStatus('指定方向 64 px 內沒有完整空白段（不跨相鄰線）；線位未移動'); return }
      if (match.position === r.start) { setStatus(`目前通過 ${match.passingCount}/${match.total} 段；範圍內無更多段通過，保持原位`); return }
      const next = moveGuide(current.current, r.guide, match.position, page.width, page.height)
      current.current = next; setEdit(next); version.current++; setSaveStatus('尚未保存')
      undo.current = { guide: r.guide, position: r.start }; setUndoEnabled(true)
      setStatus(`已吸附至 ${match.position} px（${match.position - r.start > 0 ? '+' : ''}${match.position - r.start} px），通過 ${match.passingCount}/${match.total} 段 · ${event.data.elapsed.toFixed(1)} ms`)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => void flush(), 500)
    }
    void (async () => {
      const image = new Image(); image.src = source; await image.decode()
      if (cancelled) return
      if (image.naturalWidth !== page.width || image.naturalHeight !== page.height) throw new Error('原圖尺寸不一致，請重新載入集合')
      const canvas = document.createElement('canvas'); canvas.width = page.width; canvas.height = page.height
      const context = canvas.getContext('2d', { willReadFrequently: true })!
      context.drawImage(image, 0, 0)
      const rgba = context.getImageData(0, 0, page.width, page.height).data.buffer
      w.postMessage({ kind: 'load', key: imageKey, width: page.width, height: page.height, rgba }, [rgba])
      canvas.width = 0; canvas.height = 0
    })().catch(err => { if (!cancelled) setError(String(err)) })
    return () => { cancelled = true; w.terminate(); worker.current = null }
  }, [imageKey, source, page.width, page.height, flush])

  function snap(direction: Direction) {
    const guide = activeRef.current
    const horizontal = direction === 'up' || direction === 'down'
    invalidate()
    if (!ready || !guide || (guide.axis === 'horizontal') !== horizontal) return
    const start = positions(current.current, guide.axis)[guide.index], id = generation.current
    request.current = { id, guide, start }; setPending(true); setStatus('正在尋找完整空白分段最多的位置…')
    worker.current?.postMessage({ kind: 'find', key: imageKey, id, request: { horizontal, position: start,
      step: direction === 'left' || direction === 'up' ? -1 : 1, parallel: positions(current.current, guide.axis),
      perpendicular: positions(current.current, horizontal ? 'vertical' : 'horizontal'), whiteTolerance: prefs.tolerance } })
  }
  function undoSnap() {
    const saved = undo.current
    if (!saved) return
    apply(moveGuide(current.current, saved.guide, saved.position, page.width, page.height)); setStatus('已撤銷上次吸附')
  }
  function remove() { if (activeRef.current) apply(removeGuide(current.current, activeRef.current)); select(null) }
  function key(event: React.KeyboardEvent) {
    if ((event.target as HTMLElement).closest('input,select,textarea,[role="dialog"],[contenteditable="true"]')) return
    const directions: Record<string, Direction> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
    const cmd = event.metaKey || event.ctrlKey
    if (cmd && event.altKey && event.key.toLowerCase() === 'z') { event.preventDefault(); undoSnap(); return }
    if (cmd && event.key.toLowerCase() === 's') { event.preventDefault(); void flush(true); return }
    if (cmd && event.key === 'Enter') { event.preventDefault(); void flush(true).then(ok => { if (ok) onNext() }); return }
    if (cmd && event.key === 'ArrowLeft') { event.preventDefault(); onPrevious(); return }
    if (cmd && event.key === 'ArrowRight') { event.preventDefault(); onNext(); return }
    if (cmd && ['+', '=', '-', '0'].includes(event.key)) { event.preventDefault(); setCamera(c => clamped(event.key === '0' ? { zoom: 1, x: 0, y: 0 } : { ...c, zoom: Math.max(1, Math.min(5, c.zoom + (event.key === '-' ? -.25 : .25))) })); return }
    const direction = directions[event.key]
    if (direction && !cmd) {
      event.preventDefault()
      if (event.altKey) snap(direction)
      else {
        const a = activeRef.current, horizontal = direction === 'up' || direction === 'down'
        if (a && (a.axis === 'horizontal') === horizontal) apply(moveGuide(current.current, a, positions(current.current, a.axis)[a.index] + (direction === 'left' || direction === 'up' ? -1 : 1), page.width, page.height))
      }
    } else if (['Backspace', 'Delete'].includes(event.key)) { event.preventDefault(); remove() }
  }
  function point(event: React.PointerEvent<SVGSVGElement>) {
    const r = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - r.left, y: event.clientY - r.top }
  }
  function hit(x: number, y: number): ActiveGuide | null {
    let best: ActiveGuide | null = null, distance = 8
    for (const axis of ['vertical', 'horizontal'] as const) positions(current.current, axis).forEach((p, index) => {
      const d = Math.abs((axis === 'vertical' ? x - ix : y - iy) - p * scale)
      if (d < distance) { best = { axis, index }; distance = d }
    })
    return best
  }
  function down(event: React.PointerEvent<SVGSVGElement>) {
    if (!ready || event.button !== 0) return
    root.current?.focus({ preventScroll: true }); if (timer.current) clearTimeout(timer.current)
    const p = point(event), g: Gesture = { kind: 'pan', ...p, camera, edit: current.current }
    const ruler = p.y < 28 || p.y > size.height - 28 ? 'horizontal' : p.x < 28 || p.x > size.width - 28 ? 'vertical' : null
    if (ruler) { g.kind = 'new'; g.axis = ruler; invalidate() }
    else if (p.x >= ix && p.x < ix + iw && p.y >= iy && p.y < iy + ih) {
      const a = hit(p.x, p.y)
      if (a) { g.kind = 'guide'; g.active = a; select(a) }
      else invalidate()
    } else return
    gesture.current = g; event.currentTarget.setPointerCapture(event.pointerId)
  }
  function move(event: React.PointerEvent<SVGSVGElement>) {
    const g = gesture.current
    if (!g) return
    const p = point(event), x = (p.x - ix) / scale, y = (p.y - iy) / scale
    if (g.kind === 'new') {
      if (x < 0 || x >= page.width || y < 0 || y >= page.height) return
      const added = addGuide(current.current, g.axis!, g.axis === 'vertical' ? x : y, g.axis === 'vertical' ? page.width : page.height)
      if (added) { change(added.edit); select(added.active); g.active = added.active; g.kind = 'guide'; g.created = true }
    } else if (g.kind === 'guide') change(moveGuide(current.current, g.active!, g.active!.axis === 'vertical' ? x : y, page.width, page.height))
    else if (Math.hypot(p.x - g.x, p.y - g.y) > 5 && camera.zoom > 1) setCamera(clamped({ ...g.camera, x: g.camera.x + p.x - g.x, y: g.camera.y + p.y - g.y }))
  }
  function up(event: React.PointerEvent<SVGSVGElement>, cancel = false) {
    const g = gesture.current
    if (!g) return
    const p = point(event), x = (p.x - ix) / scale, y = (p.y - iy) / scale
    gesture.current = null
    if (cancel) { change(g.edit); select(null) }
    else if (g.kind === 'guide') {
      const out = g.created ? x < 0 || x > page.width || y < 0 || y > page.height : g.active!.axis === 'vertical' ? x < 0 || x > page.width : y < 0 || y > page.height
      if (out) { change(removeGuide(current.current, g.active!)); select(null) }
    } else if (g.kind === 'pan' && Math.hypot(p.x - g.x, p.y - g.y) <= 5 && x >= 0 && y >= 0 && x < page.width && y < page.height) change(toggleCell(current.current, x, y))
    schedule()
  }
  const fills = rectangles(edit, page.width, page.height)
  const activePosition = active ? positions(edit, active.axis)[active.index] : null
  const dirtyOutput = outputRevision !== revision.current || version.current !== persisted.current
  const tickStep = Math.max(100, Math.ceil(60 / scale / 100) * 100)
  const visibleX = Math.max(0, Math.ceil(-ix / scale / tickStep) * tickStep)
  const visibleY = Math.max(0, Math.ceil(-iy / scale / tickStep) * tickStep)
  return <section className="ew-editor" ref={root} tabIndex={0} onKeyDown={key} aria-label="參考線編輯區">
    {error && <Alert type="error" showIcon message={error} action={<Button onClick={() => void flush()}>重試保存</Button>} />}
    <div className="ew-tools">
      <div className="ew-search"><strong>尋找合適位置</strong><Space size={4}>
        {(['left', 'right', 'up', 'down'] as const).map((d, i) => <Button key={d} type="primary" disabled={!ready || !active || (active.axis === 'horizontal') !== (d === 'up' || d === 'down')} onClick={() => snap(d)} aria-label={`向${['左', '右', '上', '下'][i]}尋找`}>{['←', '→', '↑', '↓'][i]}</Button>)}
      </Space><span className="ew-muted">64 px · Option / Alt ＋方向鍵</span></div>
      <Space wrap><label>白色容差 <InputNumber aria-label="白色容差" min={0} max={255} precision={0} value={prefs.tolerance} onChange={v => { invalidate(); setPrefs(p => ({ ...p, tolerance: v ?? 30 })) }} /></label>
        <Button onClick={undoSnap} disabled={!undoEnabled}>撤銷吸附</Button>
        <Tag color={pending ? 'processing' : 'orange'}>{active ? `${active.axis === 'vertical' ? 'X' : 'Y'} ${activePosition} px` : '請選中參考線'}</Tag></Space>
    </div>
    <div className="ew-secondary"><Space wrap size={6}>
      <Button onClick={() => setCamera(c => clamped({ ...c, zoom: Math.max(1, c.zoom - .25) }))}>−</Button>
      <span>{camera.zoom.toFixed(2)}× 適窗</span><Button onClick={() => setCamera(c => clamped({ ...c, zoom: Math.min(5, c.zoom + .25) }))}>＋</Button>
      <Button onClick={() => setCamera({ zoom: 1, x: 0, y: 0 })}>適合視窗</Button>
      <span className="ew-muted">快捷線</span>
      {(['top', 'bottom', 'left', 'right'] as const).map((slot, i) => {
        const axis: Axis = i < 2 ? 'horizontal' : 'vertical'
        return <Space.Compact key={slot}><Button title={prefs.slots[slot] ? `${prefs.slots[slot]} px` : '尚未設定'} disabled={!prefs.slots[slot]} onClick={() => {
          const added = addGuide(current.current, axis, prefs.slots[slot], axis === 'vertical' ? page.width : page.height)
          if (added) { apply(added.edit); select(added.active) }
        }}>{['上', '下', '左', '右'][i]}</Button><Button size="small" title={`將活動線設為${['上', '下', '左', '右'][i]}線`} disabled={active?.axis !== axis} onClick={() => setPrefs(p => ({ ...p, slots: { ...p.slots, [slot]: activePosition! } }))}>設為</Button></Space.Compact>
      })}
    </Space><Space wrap><Button disabled={!active} onClick={remove}>刪除線</Button><Button disabled={!edit.selectedCells.length} onClick={() => apply({ ...current.current, selectedCells: [] })}>取消選區</Button>
      <Button onClick={() => { apply(EMPTY); select(null) }}>清除全部</Button></Space></div>
    <div className="ew-canvases">
      <div className="ew-canvas-panel"><div className="ew-panel-caption"><strong>編輯</strong><span>先放線，再選格 · 滾輪縮放，放大後拖圖平移</span></div>
        <svg ref={viewport} className="ew-stage" data-testid="guide-canvas" onPointerDown={down} onPointerMove={move} onPointerUp={e => up(e)} onPointerCancel={e => up(e, true)} onDoubleClick={e => {
          const r = e.currentTarget.getBoundingClientRect(), a = hit(e.clientX - r.left, e.clientY - r.top)
          if (a) { apply(removeGuide(current.current, a)); select(null) }
        }}>
          <defs><clipPath id={`clip-${page.id}`}><rect x={28} y={28} width={Math.max(0, size.width - 56)} height={Math.max(0, size.height - 56)} /></clipPath></defs>
          <g clipPath={`url(#clip-${page.id})`}>
            <image href={source} x={ix} y={iy} width={iw} height={ih} />
            {fills.map((r, i) => <rect key={i} x={ix + r.x * scale} y={iy + r.y * scale} width={r.width * scale} height={r.height * scale} fill="white" fillOpacity={.68} stroke="#cf612c" />)}
            {(['vertical', 'horizontal'] as const).flatMap(axis => positions(edit, axis).map((p, index) => {
              const chosen = active?.axis === axis && active.index === index, v = axis === 'vertical'
              return <g key={`${axis}${index}`} data-guide={`${axis}-${index}`} data-position={p}><line x1={v ? ix + p * scale : ix} x2={v ? ix + p * scale : ix + iw} y1={v ? iy : iy + p * scale} y2={v ? iy + ih : iy + p * scale} stroke={chosen ? '#ff8b22' : '#187d94'} strokeWidth={chosen ? 2.5 : 1} />{chosen && <text x={v ? ix + p * scale + 6 : Math.max(34, ix + 8)} y={v ? Math.max(45, iy + 18) : iy + p * scale - 6} fill="#a4470b" stroke="white" strokeWidth={3} paintOrder="stroke" fontSize={12}>{v ? 'X' : 'Y'} {p}</text>}</g>
            }))}
          </g>
          <g className="ew-rulers"><rect width={size.width} height={28} /><rect y={size.height - 28} width={size.width} height={28} /><rect width={28} height={size.height} /><rect x={size.width - 28} width={28} height={size.height} />
            {Array.from({ length: Math.max(0, Math.min(100, Math.ceil((page.width - visibleX) / tickStep))) }, (_, i) => visibleX + i * tickStep).map(p => <g key={`x${p}`}><text x={ix + p * scale + 3} y={15}>{p}</text><path d={`M ${ix + p * scale} 22 v 6 M ${ix + p * scale} ${size.height - 28} v 6`} /></g>)}
            {Array.from({ length: Math.max(0, Math.min(100, Math.ceil((page.height - visibleY) / tickStep))) }, (_, i) => visibleY + i * tickStep).map(p => <g key={`y${p}`}><text transform={`translate(12 ${iy + p * scale - 3}) rotate(-90)`}>{p}</text><path d={`M 22 ${iy + p * scale} h 6 M ${size.width - 28} ${iy + p * scale} h 6`} /></g>)}
          </g>
        </svg>
        {camera.zoom > 1 && <svg className="ew-navigator" aria-label="Navigator" viewBox={`0 0 ${page.width} ${page.height}`} onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); const r = e.currentTarget.getBoundingClientRect(); setCamera(clamped({ ...camera, x: (0.5 - (e.clientX - r.left) / r.width) * iw, y: (0.5 - (e.clientY - r.top) / r.height) * ih })) }} onPointerMove={e => { if (e.buttons !== 1) return; const r = e.currentTarget.getBoundingClientRect(); setCamera(clamped({ ...camera, x: (0.5 - (e.clientX - r.left) / r.width) * iw, y: (0.5 - (e.clientY - r.top) / r.height) * ih })) }}>
          <image href={source} width={page.width} height={page.height} /><rect x={Math.max(0, (28 - ix) / scale)} y={Math.max(0, (28 - iy) / scale)} width={Math.min(page.width, (size.width - 56) / scale)} height={Math.min(page.height, (size.height - 56) / scale)} fill="#15778b33" stroke="#15778b" strokeWidth={Math.max(2, page.width / 80)} />
        </svg>}
      </div>
      <div className="ew-canvas-panel ew-preview"><div className="ew-panel-caption"><strong>輸出預覽</strong><span>保持原尺寸 · 只塗白選中格子</span></div><svg data-testid="output-preview" viewBox={`0 0 ${page.width} ${page.height}`}><image href={source} width={page.width} height={page.height} />{fills.map((r, i) => <rect key={i} {...r} fill="white" />)}</svg></div>
    </div>
    <div className="ew-status" role="status"><span>{ready ? status : '載入原圖與搜尋工具…'}</span><span>{page.width} × {page.height} px · {saveStatus} · {dirtyOutput ? '輸出待更新' : '輸出已更新'}</span></div>
    <div className="ew-footer"><span>搜尋只協助落線；塗白前請確認正文、對白及出框筆畫。</span><Button onClick={() => void flush(true)} disabled={!ready}>保存圖片</Button></div>
  </section>
})
