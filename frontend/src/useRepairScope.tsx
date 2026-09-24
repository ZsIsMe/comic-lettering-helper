import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Tooltip } from 'antd'
import { defaultRepairRect, fullRepairRect, moveScopeEdge, type RepairRect, type RepairScope, type ScopeEdge, type ScopeUpdate } from './repair-scope'

interface Options {
  pageId?: string; initial?: RepairScope; width: number; height: number; disabled?: boolean
  save?: (update: ScopeUpdate) => Promise<RepairScope>
}
const labels = { left: '左', right: '右', top: '上', bottom: '下' }

export function useRepairScope({ pageId, initial, width, height, disabled, save }: Options) {
  const [value, setValue] = useState(() => ({ enabled: initial?.enabled ?? false, rect: initial?.pages[pageId || ''] ?? defaultRepairRect(width, height) }))
  const current = useRef(value)
  const revision = useRef(initial?.revision ?? 0)
  const version = useRef(0), persisted = useRef(0), applyAll = useRef(false)
  const saving = useRef<Promise<boolean> | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)
  const saveRef = useRef(save); saveRef.current = save
  const drag = useRef<{ pointer: number; edge: ScopeEdge; before: RepairRect } | null>(null)
  const [active, setActive] = useState<ScopeEdge | null>(null)
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
  useEffect(() => {
    alive.current = true
    const warn = (event: BeforeUnloadEvent) => { if (persisted.current !== version.current) event.preventDefault() }
    window.addEventListener('beforeunload', warn)
    return () => { alive.current = false; if (timer.current) clearTimeout(timer.current); window.removeEventListener('beforeunload', warn) }
  }, [])
  const toolbar = save && <div className="repair-scope-toolbar">
      <Tooltip title={`只修復四線中間的區域；拖線或用方向鍵微調。X ${value.rect.x} · Y ${value.rect.y} · ${value.rect.width} × ${value.rect.height} px`}>
        <Checkbox checked={value.enabled} disabled={disabled} onChange={e => change({ ...current.current, enabled: e.target.checked })}>限定修復範圍</Checkbox>
      </Tooltip>
      {value.enabled && <>
        <Button size="small" disabled={disabled} title="將當頁四條線移到圖片四邊，不影響其他頁。" onClick={() => { change({ ...current.current, rect: fullRepairRect(width, height) }, false); void flush() }}>本頁改為整張圖</Button>
        <Button size="small" disabled={disabled || status === '保存中…'} title="用目前四條線的位置覆蓋本項目所有其他頁，包括已單獨調整的範圍。" onClick={() => { applyAll.current = true; change(current.current, false); void flush() }}>將此範圍套用全部頁</Button>
      </>}
      <span role="status" className={status === '已保存' ? 'repair-scope-saved' : undefined}>{status}</span>
  </div>
  function overlay(editable: boolean) {
    if (!save || !value.enabled) return null
    const r = value.rect
    return <svg className="repair-scope-overlay" viewBox={`0 0 ${width} ${height}`} aria-label={editable ? '修復作用範圍四條線' : '修復作用範圍預覽'}>
      <path d={`M0,0H${width}V${height}H0Z M${r.x},${r.y}v${r.height}h${r.width}v${-r.height}Z`} fill="rgba(16,30,42,.24)" fillRule="evenodd" />
      {(['left', 'right', 'top', 'bottom'] as ScopeEdge[]).map(edge => {
        const vertical = edge === 'left' || edge === 'right'
        const position = edge === 'left' ? r.x : edge === 'right' ? r.x + r.width : edge === 'top' ? r.y : r.y + r.height
        const coords = { x1: vertical ? position : 0, x2: vertical ? position : width, y1: vertical ? 0 : position, y2: vertical ? height : position }
        return <g key={edge}>
          <line {...coords} stroke={active === edge ? '#ff8b22' : '#168fa7'} strokeWidth={2} vectorEffect="non-scaling-stroke" />
          {editable && <line {...coords} className="repair-scope-handle" stroke="transparent" strokeWidth={16} vectorEffect="non-scaling-stroke" tabIndex={disabled ? -1 : 0} role="slider" aria-label={`${labels[edge]}作用範圍線`} aria-orientation={vertical ? 'horizontal' : 'vertical'} aria-valuemin={0} aria-valuemax={vertical ? width : height} aria-valuenow={position}
            style={{ pointerEvents: disabled ? 'none' : 'stroke', cursor: vertical ? 'ew-resize' : 'ns-resize' }}
            onFocus={() => setActive(edge)} onPointerDown={e => {
              if (disabled || e.button !== 0) return
              e.preventDefault(); e.stopPropagation(); e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId)
              if (timer.current) clearTimeout(timer.current)
              setActive(edge); drag.current = { pointer: e.pointerId, edge, before: { ...current.current.rect } }
            }} onPointerMove={e => {
              if (!drag.current || drag.current.pointer !== e.pointerId) return
              const bounds = e.currentTarget.ownerSVGElement!.getBoundingClientRect()
              const p = vertical ? (e.clientX - bounds.left) * width / bounds.width : (e.clientY - bounds.top) * height / bounds.height
              change({ ...current.current, rect: moveScopeEdge(current.current.rect, edge, p, width, height) }, false)
            }} onPointerUp={e => { if (drag.current?.pointer !== e.pointerId) return; drag.current = null; e.currentTarget.releasePointerCapture(e.pointerId); void flush() }}
            onPointerCancel={e => { if (drag.current?.pointer !== e.pointerId) return; const before = drag.current.before; drag.current = null; change({ ...current.current, rect: before }); }}
            onLostPointerCapture={e => { if (drag.current?.pointer !== e.pointerId) return; const before = drag.current.before; drag.current = null; change({ ...current.current, rect: before }); }}
            onKeyDown={e => {
              if (disabled || e.altKey || e.ctrlKey || e.metaKey) return
              const delta = vertical ? e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0 : e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
              if (!delta) return
              e.preventDefault(); e.stopPropagation()
              change({ ...current.current, rect: moveScopeEdge(current.current.rect, edge, position + delta, width, height) })
            }} />}
        </g>
      })}
    </svg>
  }
  return { toolbar, overlay, flush, error: error && <Alert type="error" showIcon message={error} action={<Button size="small" onClick={() => void flush()}>重試保存</Button>} /> }
}
