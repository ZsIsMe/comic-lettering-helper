import { memo, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { PointerEvent as ReactPointer } from 'react'
import { type Item, type Page, type CharacterBox, uid } from './types'
import { EditorState } from './editor-state'
import { PreviewLayer } from './PreviewLayer'
import { color, moved, resized, transform, type Selection, type PagePointer, type VisibleRegion } from './geometry'
import { adjustedItems, type TextAdjustment } from './shortcuts'
import { CharacterOverlay, type CharacterOverlayHandle } from './CharacterOverlay'
import { InlineTextEditor } from './InlineTextEditor'

const noCharacters: CharacterBox[] = []
const fontLabel = (size?: number) => typeof size === 'number' && Number.isFinite(size) && size > 0 ? String(Math.round(size * 100) / 100) : '—'

const frameControls = [
  { x: 'left', y: 'top', kind: 'font', delta: -2, icon: '−', label: '左上：縮小文字', hint: '字級減少 2；Option／Alt 點擊減少 10' },
  { x: 'right', y: 'top', kind: 'font', delta: 2, icon: '+', label: '右上：放大文字', hint: '字級增加 2；Option／Alt 點擊增加 10' },
  { x: 'left', y: 'bottom', kind: 'rotate', delta: 1, icon: '↶', label: '左下：逆時針旋轉', hint: '逆時針 1°；Option／Alt 點擊 5°' },
  { x: 'right', y: 'bottom', kind: 'rotate', delta: -1, icon: '↷', label: '右下：順時針旋轉', hint: '順時針 1°；Option／Alt 點擊 5°' },
] as const

export const TextPage = memo(function TextPage({ project, page, scale, edge, clean, readonly, controller, selection, onSelect, onInteracting, showMeasure, onMeasure, region, detailed, interacting, onPointer }: {
  project: string; page: Page; scale: number; edge: number; clean: boolean; readonly?: boolean;
  controller: EditorState; selection: Selection; onSelect: (selection: Selection) => void; onInteracting: (id: string | null) => void;
  showMeasure: boolean; onMeasure: (index: number, page: string) => void;
  region: VisibleRegion | null; detailed: boolean; interacting: boolean; onPointer: (pointer: PagePointer | null) => void;
}) {
  useSyncExternalStore(callback => controller.subscribe(page.id, callback), () => controller.tick(page.id))
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<{ id: string; x: number; y: number } | null>(null)
  const state = controller.pages.get(page.id)
  const scene = useRef<HTMLDivElement>(null)
  const characterOverlay = useRef<CharacterOverlayHandle>(null)
  const dragging = useRef<{ pointer: number; start: number[]; mode: string; items: Item[]; originals: Item[]; center: number[]; selected: string[]; angle: number; scale: number } | null>(null)
  const frame = useRef(0)
  const latest = useRef<number[]>([])
  useEffect(() => { controller.load(page.id).catch(e => setError(String(e))) }, [controller, page.id])
  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  function paint() {
    const drag = dragging.current
    if (!drag || latest.current.length !== 2) return
    const [x, y] = latest.current
    const dx = (x - drag.start[0]) / drag.scale, dy = (y - drag.start[1]) / drag.scale
    let delta = -(Math.atan2(y - drag.center[1], x - drag.center[0]) - drag.angle) * 180 / Math.PI
    if (delta > 180) delta -= 360; if (delta < -180) delta += 360
    drag.items = drag.originals.map(item => {
      if (drag.mode === 'rotate') return { ...item, rotation: ((item.rotation + delta + 540) % 360) - 180, match_status: 'manual' }
      if (drag.mode === 'resize') return resized(item, dx, dy, page.width, page.height)
      return moved(item, dx, dy, page.width, page.height)
    })
    for (const item of drag.items) {
      const node = scene.current?.querySelector<HTMLElement>(`[data-item="${item._id}"]`)
      if (node) {
        const original = drag.originals.find(value => value._id === item._id)!
        node.style.transform = `translate(${(item.x - original.x) * page.width}px, ${(item.y - original.y) * page.height}px) ${transform(item)}`
        const box = node.querySelector<HTMLElement>('.pl-source-box')
        if (box && item.xyxy_pixel) { box.style.width = `${item.xyxy_pixel[2] - item.xyxy_pixel[0]}px`; box.style.height = `${item.xyxy_pixel[3] - item.xyxy_pixel[1]}px` }
      }
    }
    frame.current = 0
  }
  function down(event: ReactPointer, item: Item, mode = 'move') {
    if (readonly || event.button !== 0 || !scene.current || !state) return
    event.stopPropagation(); event.preventDefault()
    scene.current.closest<HTMLElement>('.pl-viewport')?.focus({ preventScroll: true })
    let ids = selection.page === page.id && selection.ids.includes(item._id) ? selection.ids : [item._id]
    if (event.shiftKey) ids = selection.page === page.id ? [...new Set([...selection.ids, item._id])] : [item._id]
    onSelect({ page: page.id, ids }); onInteracting(page.id)
    const rect = scene.current.getBoundingClientRect()
    const center = [rect.left + item.x * page.width * scale, rect.top + item.y * page.height * scale]
    const originals = structuredClone(state.data.items.filter(value => ids.includes(value._id)))
    for (const value of originals) {
      const node = scene.current.querySelector<HTMLElement>(`[data-item="${value._id}"]`)
      if (node) node.style.willChange = 'transform'
    }
    dragging.current = { pointer: event.pointerId, start: [event.clientX, event.clientY], mode, items: originals, originals, center, selected: ids, angle: Math.atan2(event.clientY - center[1], event.clientX - center[0]), scale }
    event.currentTarget.setPointerCapture(event.pointerId)
    latest.current = [event.clientX, event.clientY]
  }
  function move(event: ReactPointer) {
    if (!dragging.current || event.pointerId !== dragging.current.pointer) return
    latest.current = [event.clientX, event.clientY]
    if (!frame.current) frame.current = requestAnimationFrame(paint)
  }
  function end(event: ReactPointer, cancel = false) {
    const drag = dragging.current
    if (!drag || event.pointerId !== drag.pointer) return
    cancelAnimationFrame(frame.current); frame.current = 0
    const changedPointer = !cancel && (event.clientX !== drag.start[0] || event.clientY !== drag.start[1])
    if (!changedPointer) drag.items = drag.originals
    else { latest.current = [event.clientX, event.clientY]; paint() }
    // Return DOM ownership to React before committing left/top. An unchanged React
    // transform prop would otherwise leave the temporary drag translation applied twice.
    for (const item of drag.items) {
      const node = scene.current?.querySelector<HTMLElement>(`[data-item="${item._id}"]`)
      if (node) {
        node.style.transform = transform(item); node.style.willChange = ''
        const box = node.querySelector<HTMLElement>('.pl-source-box')
        if (box) { box.style.width = `${item.xyxy_pixel ? item.xyxy_pixel[2] - item.xyxy_pixel[0] : 60}px`; box.style.height = `${item.xyxy_pixel ? item.xyxy_pixel[3] - item.xyxy_pixel[1] : 60}px` }
      }
    }
    dragging.current = null; onInteracting(null)
    if (changedPointer && JSON.stringify(drag.items) !== JSON.stringify(drag.originals)) {
      const changed = new Map(drag.items.map(item => [item._id, item]))
      controller.edit(page.id, controller.pages.get(page.id)!.data.items.map(item => changed.get(item._id) || item))
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  function add(event: React.MouseEvent) {
    if (readonly || !scene.current || !state) return
    const rect = scene.current.getBoundingClientRect()
    const item: Item = { _id: uid(), text: '新文字', x: (event.clientX - rect.left) / (page.width * scale), y: (event.clientY - rect.top) / (page.height * scale), 'font-size': 40, rotation: 0, orientation: 'vertical', color: '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 0, match_status: 'manual' }
    controller.edit(page.id, [...state.data.items, item]); onSelect({ page: page.id, ids: [item._id] })
  }
  function adjust(adjustment: TextAdjustment) {
    const state = controller.pages.get(page.id)
    if (readonly || interacting || dragging.current || !state || selection.page !== page.id) return
    const items = adjustedItems(state.data.items, selection.ids, adjustment, page.width, page.height)
    if (items !== state.data.items) controller.edit(page.id, items)
  }
  const selected = selection.page === page.id ? selection.ids : []
  return <div className="pl-page" data-page={page.id} data-readonly={!!readonly} style={{ width: page.width * scale, height: page.height * scale }} onPointerMove={event => {
    if (interacting || dragging.current) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left) / scale, y = (event.clientY - rect.top) / scale
    if (event.target instanceof Element && event.target.closest('.pl-text')) characterOverlay.current?.clear()
    else if (!interacting) characterOverlay.current?.probe(x, y)
    if (!readonly && !dragging.current) onPointer({ page: page.id, x: x / page.width, y: y / page.height })
  }} onPointerLeave={() => { characterOverlay.current?.clear(); if (!readonly && !dragging.current) onPointer(null) }}>
    <div className="pl-scene" ref={scene} style={{ width: page.width, height: page.height, transform: `scale(${scale})` }} onDoubleClick={add} onPointerDown={event => {
      if (readonly || event.button !== 0) return
      scene.current?.closest<HTMLElement>('.pl-viewport')?.focus({ preventScroll: true })
      onSelect({ page: page.id, ids: [] })
    }}>
      <PreviewLayer project={project} page={page} edge={edge} scale={scale} clean={clean} region={region} detailed={detailed} interacting={interacting} />
      {!readonly && state?.data.items.map(item => <div key={item._id} data-item={item._id} className={`pl-text ${selected.includes(item._id) ? 'selected' : ''} ${editing?.id === item._id ? 'editing' : ''}`} style={{ left: item.x * page.width, top: item.y * page.height, transform: transform(item), fontSize: item['font-size'], writingMode: item.orientation === 'vertical' ? 'vertical-rl' : 'horizontal-tb', color: color(item.color), WebkitTextStroke: `${item['stroke-weight']}px ${color(item['stroke-color'])}`, outlineWidth: selected.includes(item._id) ? 1.5 / scale : 0 }}
        onPointerDown={event => { if (editing?.id !== item._id) down(event, item) }} onPointerMove={move} onPointerUp={event => end(event)} onPointerCancel={event => end(event, true)} onDoubleClick={event => {
          event.stopPropagation()
          if (event.target instanceof Element && event.target.closest('button,.pl-handle,.pl-source-box')) return
          onSelect({ page: page.id, ids: [item._id] })
          characterOverlay.current?.clear()
          setEditing({ id: item._id, x: event.clientX, y: event.clientY })
        }}>
        {editing?.id === item._id ? <InlineTextEditor key={item._id} item={item} page={page.id} controller={controller} point={editing} onFinish={() => setEditing(null)} /> : item.text || '\u200b'}
        <span className="pl-font-label pl-current-font" aria-label={`目前字級 ${fontLabel(item['font-size'])}`} style={{ fontSize: 11 / scale, padding: `${2 / scale}px ${4 / scale}px`, bottom: -19 / scale, transform: `rotate(${item.rotation}deg)`, transformOrigin: 'top right' }}>{fontLabel(item['font-size'])}</span>
        {selected.includes(item._id) && editing?.id !== item._id && <>
          {frameControls.map(corner => <button key={`${corner.x}-${corner.y}`} type="button" className="pl-text-step" aria-label={corner.label} title={`${corner.hint}（套用所有選取文字）`} style={{
            width: 22 / scale, height: 22 / scale, fontSize: 17 / scale, borderWidth: 1 / scale,
            [corner.x]: -6 / scale, [corner.y]: -6 / scale,
            transform: `translate(${corner.x === 'left' ? '-100%' : '100%'}, ${corner.y === 'top' ? '-100%' : '100%'}) rotate(${item.rotation}deg)`,
          }} onPointerDown={event => {
            event.stopPropagation(); event.preventDefault()
            scene.current?.closest<HTMLElement>('.pl-viewport')?.focus({ preventScroll: true })
          }} onClick={event => { event.stopPropagation(); adjust({ kind: corner.kind, delta: corner.delta * (event.altKey ? 5 : 1) }) }}>{corner.icon}</button>)}
          <span className="pl-handle pl-rotate" title="拖曳旋轉" role="button" aria-label="旋轉文字" style={{ width: 12 / scale, height: 12 / scale, top: -26 / scale }} onPointerDown={event => down(event, item, 'rotate')} />
          <span className="pl-source-box" style={{ width: item.xyxy_pixel ? item.xyxy_pixel[2] - item.xyxy_pixel[0] : 60, height: item.xyxy_pixel ? item.xyxy_pixel[3] - item.xyxy_pixel[1] : 60, borderWidth: 1 / scale }}>
            <span className="pl-handle pl-resize" title="調整參考框" style={{ width: 10 / scale, height: 10 / scale }} onPointerDown={event => down(event, item, 'resize')} />
          </span>
        </>}
      </div>)}
      {showMeasure && state?.data.measure.map((measure, index) => {
        const box = measure.xyxy_pixel
        return box && <button key={index} className="pl-measure" aria-label={`套用偵測框 ${index + 1}`} onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); onMeasure(index, page.id) }} style={{ left: box[0], top: box[1], width: box[2] - box[0], height: box[3] - box[1], borderWidth: 2 / scale, fontSize: 13 / scale }}>{index + 1}<span className="pl-font-label pl-calculated-font" aria-label={`計算字級 ${fontLabel(measure.font_size)}`} style={{ fontSize: 11 / scale, padding: `${2 / scale}px ${4 / scale}px` }}>{fontLabel(measure.font_size)}</span></button>
      })}
      {showMeasure && <CharacterOverlay ref={characterOverlay} characters={state?.data.character_boxes || noCharacters} width={page.width} height={page.height} scale={scale} region={region} disabled={interacting} />}
    </div>
    {error && <div className="pl-image-error">{error}</div>}
  </div>
})
