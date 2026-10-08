import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Tooltip } from 'antd'
import { addGuide, moveGuide, positions, removeGuide } from './edgewhite/guide-layout'
import type { ActiveGuide, Axis } from './edgewhite/model'
import { defaultRepairRect, fitRepairGrid, fullRepairRect, repairRectangles, toggleRepairCell, type RepairGrid, type RepairScope, type ScopeUpdate } from './repair-scope'

interface Options {
  pageId?: string; initial?: RepairScope; width: number; height: number; disabled?: boolean
  save?: (update: ScopeUpdate) => Promise<RepairScope>
  exportScope?: () => Promise<void>
  initialEditing?: boolean
  onEnter?: () => boolean
}
type Drag = { pointer: number; kind: 'new' | 'guide' | 'cell'; axis?: Axis; active?: ActiveGuide; x: number; y: number; before: RepairGrid }
export function useRepairScope({ pageId, initial, width, height, disabled, save, exportScope, onEnter, initialEditing }: Options) {
  const [value, setValue] = useState(() => ({ enabled: initial?.enabled ?? false, rect: fitRepairGrid(initial?.pages[pageId || ''] ?? defaultRepairRect(width, height), width, height) }))
  const current = useRef(value)
  const revision = useRef(initial?.revision ?? 0)
  const version = useRef(0), persisted = useRef(0), applyAll = useRef(false)
  const saving = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  const saveRef = useRef(save); saveRef.current = save
  const drag = useRef<Drag | null>(null)
  const [editing, setEditing] = useState(!!initialEditing && !!save && (initial?.enabled ?? false))
  const [active, setActive] = useState<ActiveGuide | null>(null)
  const [status, setStatus] = useState('已保存'), [error, setError] = useState('')
  const flush = useCallback(async (): Promise<boolean> => {
    if (!saveRef.current) return true
    if (drag.current) return false
    if (timer.current) clearTimeout(timer.current)
    if (saving.current) { if (!await saving.current) return false; return flush() }
    if (persisted.current === version.current) return true
    const task = async () => {
      try {
        if (alive.current) setStatus('保存中…')
        while (persisted.current < version.current) {
          if (drag.current) return false
          const target = version.current, all = applyAll.current
          const scope = await saveRef.current!({ ...current.current, revision: revision.current, apply_all: all })
          revision.current = scope.revision; persisted.current = target
          if (all) applyAll.current = false
        }
        if (alive.current) { setStatus('已保存'); setError('') }
        return true
      } catch (err) {
        if (alive.current) { setStatus('保存失敗'); setError(err instanceof Error ? err.message : String(err)) }
        return false
      } finally { saving.current = null }
    }
    saving.current = task()
    return saving.current
  }, [])
  function change(next: typeof value, schedule = true) {
    current.current = next; setValue(next); version.current++; setStatus('尚未保存')
    if (timer.current) clearTimeout(timer.current)
    if (schedule) timer.current = setTimeout(() => void flush(), 500)
  }
  function exit() {
    if (drag.current) { const before = drag.current.before; drag.current = null; change({ ...current.current, rect: before }) }
    setEditing(false); setActive(null)
  }
  function select() {
    if (disabled || !save) return
    if (editing) return
    if (onEnter?.() === false) return
    if (!current.current.enabled) change({ ...current.current, enabled: true })
    setEditing(true)
  }
  useEffect(() => {
    alive.current = true
    const warn = (event: BeforeUnloadEvent) => { if (persisted.current !== version.current) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); window.removeEventListener('beforeunload', warn) }
  }, [])
  function remove() {
    if (!editing || disabled || !active) return
    change({ ...current.current, rect: removeGuide(current.current.rect, active) }); setActive(null)
  }
  function add(axis: Axis) {
    if (!editing || disabled) return
    const dimension = axis === 'vertical' ? width : height
    const next = addGuide(current.current.rect, axis, dimension / 2, dimension)
    if (next) { change({ ...current.current, rect: next.edit }); setActive(next.active) }
  }
  const toolbar = save && <div className="repair-scope-toolbar">
    <Tooltip title="選中裁切後，從圖片四邊拖出多條分割線，再點亮要分別修復的區塊。新增或刪除線後需重新選格；F1／F2 返回 Mask 編輯。">
      <Button size="small" aria-pressed={editing} type={editing ? 'primary' : 'default'} disabled={disabled} onClick={select}>F3 裁切</Button>
    </Tooltip>
    <Checkbox checked={value.enabled} disabled={disabled} onChange={e => { if (!e.target.checked) exit(); change({ ...current.current, enabled: e.target.checked }) }}>限定修復範圍</Checkbox>
    {value.enabled && <>
      <Button size="small" disabled={disabled || !editing} onClick={() => add('vertical')}>新增垂直線</Button>
      <Button size="small" disabled={disabled || !editing} onClick={() => add('horizontal')}>新增水平線</Button>
      <Button size="small" disabled={disabled || !editing || !active} onClick={remove}>刪除分割線</Button>
      <Button size="small" disabled={disabled || !editing || !value.rect.selectedCells.length} onClick={() => change({ ...current.current, rect: { ...current.current.rect, selectedCells: [] } })}>取消點亮</Button>
      <Button size="small" disabled={disabled || !editing} title="清除本頁分割線並點亮整張圖，不影響其他頁。" onClick={() => { setActive(null); change({ ...current.current, rect: fitRepairGrid(fullRepairRect(width, height), width, height) }, false); void flush() }}>本頁改為整張圖</Button>
      <Button size="small" disabled={disabled || !editing || status === '保存中…'} title="用目前分割線和點亮區塊覆蓋本項目所有其他頁。" onClick={() => { applyAll.current = true; change(current.current, false); void flush() }}>將此範圍套用全部頁</Button>
      <span>{value.rect.selectedCells.length} 塊待修復</span>
    </>}
    {exportScope && <Button size="small" disabled={disabled || status === '保存中…'} title="保存後導出全部頁面的裁切範圍，以圖片檔名對應，可在新建項目時導入。" onClick={() => void exportScope()}>導出裁切 JSON</Button>}
    <span role="status" className="repair-scope-save-state">{status}</span>
  </div>
  function overlay(zoom: number) {
    if (!save || !value.enabled) return null
    const interactive = editing && !disabled
    const grid = value.rect, selected = repairRectangles(grid, width, height)
    function point(event: React.PointerEvent<SVGSVGElement>) {
      const box = event.currentTarget.getBoundingClientRect()
      return { x: (event.clientX - box.left) * width / box.width, y: (event.clientY - box.top) * height / box.height }
    }
    function begin(event: React.PointerEvent<SVGSVGElement>) {
      if (!interactive || event.button !== 0 || event.metaKey || event.ctrlKey) return
      const p = point(event), box = event.currentTarget.getBoundingClientRect()
      const target = event.target as SVGElement
      const axis = target.dataset.ruler as Axis | undefined
      let nearest: ActiveGuide | undefined, distance = 9
      if (!axis) for (const a of ['vertical', 'horizontal'] as const) positions(current.current.rect, a).forEach((position, index) => {
        const d = Math.abs(position - (a === 'vertical' ? p.x : p.y)) * (a === 'vertical' ? box.width / width : box.height / height)
        if (d < distance) { nearest = { axis: a, index }; distance = d }
      })
      event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }); event.currentTarget.setPointerCapture(event.pointerId)
      if (timer.current) clearTimeout(timer.current)
      setActive(nearest || null)
      drag.current = { pointer: event.pointerId, kind: axis ? 'new' : nearest ? 'guide' : 'cell', axis, active: nearest, ...p, before: current.current.rect }
    }
    function move(event: React.PointerEvent<SVGSVGElement>) {
      const g = drag.current
      if (!interactive || !g || g.pointer !== event.pointerId) return
      const p = point(event)
      if (g.kind === 'new') {
        const box = event.currentTarget.getBoundingClientRect()
        if (Math.hypot((p.x - g.x) * box.width / width, (p.y - g.y) * box.height / height) < 4 || p.x <= 0 || p.x >= width || p.y <= 0 || p.y >= height) return
        const next = addGuide(current.current.rect, g.axis!, g.axis === 'vertical' ? p.x : p.y, g.axis === 'vertical' ? width : height)
        if (next) { g.active = next.active; g.kind = 'guide'; setActive(next.active); change({ ...current.current, rect: next.edit }, false) }
      } else if (g.kind === 'guide') change({ ...current.current, rect: moveGuide(current.current.rect, g.active!, g.active!.axis === 'vertical' ? p.x : p.y, width, height) }, false)
    }
    function end(event: React.PointerEvent<SVGSVGElement>, cancel = false) {
      const g = drag.current
      if (!g || g.pointer !== event.pointerId) return
      const p = point(event), box = event.currentTarget.getBoundingClientRect()
      drag.current = null
      if (cancel) { change({ ...current.current, rect: g.before }); setActive(null) }
      else if (g.kind === 'cell' && Math.hypot((p.x - g.x) * box.width / width, (p.y - g.y) * box.height / height) < 5 && p.x >= 0 && p.x < width && p.y >= 0 && p.y < height) change({ ...current.current, rect: toggleRepairCell(current.current.rect, p.x, p.y) }, false)
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
      void flush()
    }
    return <svg className={`repair-scope-overlay${interactive ? ' repair-scope-editing' : ''}`} viewBox={`0 0 ${width} ${height}`} tabIndex={interactive ? 0 : undefined} aria-label={interactive ? '裁切分割編輯區' : '修復作用範圍預覽'}
      onPointerDown={begin} onPointerMove={move} onPointerUp={e => end(e)} onPointerCancel={e => end(e, true)} onLostPointerCapture={e => end(e, true)} onContextMenu={e => { if (interactive) e.preventDefault() }}
      onKeyDown={e => {
        if (!interactive || e.altKey || e.ctrlKey || e.metaKey) return
        if (e.key === 'Escape') { e.preventDefault(); exit(); return }
        if (!active) return
        if (['Backspace', 'Delete'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); remove(); return }
        const delta = active.axis === 'vertical' ? e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0 : e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
        if (delta) { e.preventDefault(); e.stopPropagation(); change({ ...current.current, rect: moveGuide(current.current.rect, active, positions(current.current.rect, active.axis)[active.index] + delta, width, height) }) }
      }}>
      <path d={`M0,0H${width}V${height}H0Z ${selected.map(r => `M${r.x},${r.y}v${r.height}h${r.width}v${-r.height}Z`).join(' ')}`} fill="rgba(16,30,42,.30)" fillRule="evenodd" />
      {selected.map((r, i) => <g key={`${r.x}:${r.y}`} data-testid="repair-scope-cell"><rect {...r} fill="rgba(255,213,52,.23)" stroke="#ffca3a" strokeWidth={1} vectorEffect="non-scaling-stroke" /><text x={r.x + r.width - 4 / zoom} y={r.y + r.height + 18 / zoom} textAnchor="end" className="repair-scope-dimensions" fontSize={13 / zoom} strokeWidth={2 / zoom} aria-label={`區塊 ${i + 1} 尺寸 ${r.width} × ${r.height} px`}>{r.width} × {r.height} px</text></g>)}
      {interactive && <>
        <svg x={0} y={0} width={width} height={height} viewBox="0 0 100 100" preserveAspectRatio="none" className="repair-scope-rulers">
          <rect x={0} y={0} width={100} height={2} data-ruler="horizontal" /><rect x={0} y={98} width={100} height={2} data-ruler="horizontal" />
          <rect x={0} y={2} width={2} height={96} data-ruler="vertical" /><rect x={98} y={2} width={2} height={96} data-ruler="vertical" />
        </svg>
      </>}
      {(['vertical', 'horizontal'] as const).flatMap(axis => positions(grid, axis).map((position, index) => {
        const vertical = axis === 'vertical', focused = active?.axis === axis && active.index === index
        return <line key={`${axis}:${index}`} x1={vertical ? position : 0} x2={vertical ? position : width} y1={vertical ? 0 : position} y2={vertical ? height : position}
          stroke={focused ? '#ff8b22' : '#168fa7'} strokeWidth={focused ? 3 : 2} vectorEffect="non-scaling-stroke"
          role={interactive ? 'slider' : undefined} tabIndex={interactive ? 0 : undefined} aria-label={`${vertical ? '垂直' : '水平'}分割線 ${index + 1}`} aria-orientation={vertical ? 'horizontal' : 'vertical'} aria-valuemin={1} aria-valuemax={(vertical ? width : height) - 1} aria-valuenow={position}
          onFocus={() => { if (interactive) setActive({ axis, index }) }} style={{ cursor: interactive ? vertical ? 'ew-resize' : 'ns-resize' : undefined }} />
      }))}
    </svg>
  }
  return { toolbar, overlay, flush, editing, select, exit, error: error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => void flush()}>重試保存</Button>} /> }
}
