import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Page, Project } from './types'
import { EditorState } from './editor-state'
import { TextPage } from './TextPage'
import type { PagePointer, Selection, VisibleRegion } from './geometry'
type Row = { page: Page; top: number; height: number; scale: number }
type Anchor = { id: string; offset: number; x: number; side: number; viewX: number; viewY: number }

export function ContinuousPages({ project, controller, selection, onSelect, zoom, compare, clean, showMeasure, jump, onCurrent, onMeasure, onZoom, onPointer, onFontWheel, onInteractionChange }: {
  project: Project; controller: EditorState; selection: Selection; onSelect: (value: Selection) => void;
  zoom: number; compare: boolean; clean: boolean; showMeasure: boolean; jump: { id: string; version: number; y?: number } | null;
  onCurrent: (id: string) => void; onMeasure: (index: number, page: string) => void; onZoom: (value: number) => void;
  onPointer: (pointer: PagePointer | null) => void;
  onFontWheel: (event: WheelEvent) => boolean; onInteractionChange: (value: boolean) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null)
  const [area, setArea] = useState({ top: 0, left: 0, width: 900, height: 800 })
  const [interacting, setInteracting] = useState<string | null>(null)
  const interactionChanged = useCallback((id: string | null) => { setInteracting(id); onInteractionChange(id !== null) }, [onInteractionChange])
  const [settled, setSettled] = useState(false)
  const scrollFrame = useRef(0), lastJump = useRef(0)
  const idle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const restored = useRef(false), previousRows = useRef<Row[]>([])
  const previousWide = useRef(0), previousCompare = useRef(compare)
  const anchor = useRef<Anchor | null>(null)
  const rows = useMemo(() => {
    let top = 24
    const width = Math.max(180, (area.width - 48 - (compare ? 20 : 0)) / (compare ? 2 : 1))
    return project.pages.map(page => {
      const scale = width / page.width * zoom
      const row = { page, top, height: page.height * scale + 40, scale }
      top += row.height
      return row
    })
  }, [project.pages, area.width, compare, zoom])
  const wide = Math.max(area.width, (rows[0]?.page.width || 0) * (rows[0]?.scale || 0) * (compare ? 2 : 1) + (compare ? 20 : 0) + 48)
  const currentCallback = useRef(onCurrent); currentCallback.current = onCurrent
  const zoomCallback = useRef(onZoom); zoomCallback.current = onZoom
  const fontWheelCallback = useRef(onFontWheel); fontWheelCallback.current = onFontWheel
  const context = useRef({ rows, wide, compare, zoom, interacting }); context.current = { rows, wide, compare, zoom, interacting }
  function idleLater() { setSettled(false); clearTimeout(idle.current); idle.current = setTimeout(() => setSettled(true), 250) }
  useEffect(() => {
    const element = viewport.current!
    const resize = new ResizeObserver(() => setArea(value => ({ ...value, width: element.clientWidth, height: element.clientHeight })))
    resize.observe(element)
    const wheel = (event: WheelEvent) => {
      if (event.defaultPrevented) return
      if (event.altKey) {
        if (fontWheelCallback.current(event)) event.preventDefault()
        return
      }
      if (!event.ctrlKey && !event.metaKey) return
      event.preventDefault()
      const { rows, wide, compare, zoom, interacting } = context.current
      if (interacting) return
      const bounds = element.getBoundingClientRect(), viewY = event.clientY - bounds.top, viewX = event.clientX - bounds.left
      const row = rows.find(row => row.top + row.height > element.scrollTop + viewY)
      if (row) {
        const width = row.page.width * row.scale, left = (wide - width * (compare ? 2 : 1) - (compare ? 20 : 0)) / 2
        const side = compare && element.scrollLeft + viewX > left + width + 10 ? 1 : 0
        anchor.current = { id: row.page.id, offset: (element.scrollTop + viewY - row.top - 28) / row.scale,
          x: (element.scrollLeft + viewX - left - side * (width + 20)) / row.scale, side, viewX, viewY }
      }
      zoomCallback.current(Math.max(.5, Math.min(3, zoom * (event.deltaY > 0 ? .9 : 1.1))))
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => { resize.disconnect(); element.removeEventListener('wheel', wheel); cancelAnimationFrame(scrollFrame.current); clearTimeout(idle.current) }
  }, [])
  useLayoutEffect(() => {
    const element = viewport.current
    if (!element) return
    // Wait for the actual viewport width before restoring an original-space anchor.
    if (!restored.current && area.width === element.clientWidth) {
      restored.current = true
      try {
        const saved = JSON.parse(localStorage.getItem(`pl-position-${project.id}`) || 'null')
        const row = rows.find(row => row.page.id === saved?.id)
        if (row) {
          element.scrollTop = row.top + saved.offset * row.scale
          element.scrollLeft = Math.max(0, saved.left || 0)
          currentCallback.current(row.page.id)
        }
      } catch { /* Local preferences never replace project data. */ }
    } else if (restored.current && previousRows.current.length && previousRows.current !== rows) {
      const old = previousRows.current.find(row => row.top + row.height > element.scrollTop)
      let target = anchor.current
      if (!target && old) {
        const width = old.page.width * old.scale, sides = previousCompare.current ? 2 : 1
        const left = (previousWide.current - width * sides - (sides === 2 ? 20 : 0)) / 2
        target = { id: old.page.id, offset: (element.scrollTop - old.top - 28) / old.scale,
          x: (element.scrollLeft + element.clientWidth / 2 - left) / old.scale, side: 0, viewX: element.clientWidth / 2, viewY: 0 }
      }
      const row = rows.find(row => row.page.id === target?.id)
      if (row && target) {
        const width = row.page.width * row.scale, left = (wide - width * (compare ? 2 : 1) - (compare ? 20 : 0)) / 2
        element.scrollTop = row.top + 28 + target.offset * row.scale - target.viewY
        element.scrollLeft = left + (compare ? target.side : 0) * (width + 20) + target.x * row.scale - target.viewX
      }
    }
    previousRows.current = rows; previousWide.current = wide; previousCompare.current = compare; anchor.current = null
    setArea(value => ({ ...value, top: element.scrollTop, left: element.scrollLeft }))
    idleLater()
  }, [rows, wide, compare, project.id, area.width])
  useEffect(() => {
    if (!jump || jump.version === lastJump.current) return
    lastJump.current = jump.version
    const row = rows.find(row => row.page.id === jump.id)
    if (row && viewport.current) viewport.current.scrollTop = row.top + (jump.y === undefined ? 0 : 28 + jump.y * row.page.height * row.scale - viewport.current.clientHeight / 2)
  }, [jump, rows])
  const scroll = useCallback(() => {
    if (scrollFrame.current) return
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0
      const element = viewport.current
      if (!element) return
      const top = element.scrollTop, left = element.scrollLeft
      setArea(value => ({ ...value, top, left })); idleLater()
      const row = previousRows.current.find(row => row.top + row.height > top + 30)
      if (row) {
        currentCallback.current(row.page.id)
        try { localStorage.setItem(`pl-position-${project.id}`, JSON.stringify({ id: row.page.id, offset: (top - row.top) / row.scale, left })) } catch { /* Optional scroll preference. */ }
      }
    })
  }, [project.id])
  // Keep the selected/focused page alive through offscreen editing, as well as the active gesture.
  const visible = rows.filter(row => row.page.id === interacting || (selection.ids.length && row.page.id === selection.page) || (row.top + row.height > area.top - area.height && row.top < area.top + area.height * 2))
  const last = rows.at(-1)
  return <div className="pl-viewport" ref={viewport} onScroll={scroll} aria-label="連續漫畫頁面" tabIndex={0}>
    <div className="pl-page-track" style={{ height: (last ? last.top + last.height : 200) + 24, width: wide }}>
      {visible.map(row => {
        const onscreen = row.top + row.height > area.top && row.top < area.top + area.height
        const edge = !settled || !onscreen ? 768 : Math.max(row.page.width, row.page.height) * row.scale * Math.min(devicePixelRatio, 1.5) > 1536 ? 3072 : 1536
        const width = row.page.width * row.scale, left = (wide - width * (compare ? 2 : 1) - (compare ? 20 : 0)) / 2
        const region = (side: number): VisibleRegion | null => {
          const x = Math.max(0, (area.left - left - side * (width + 20)) / row.scale), y = Math.max(0, (area.top - row.top - 28) / row.scale)
          const right = Math.min(row.page.width, (area.left + area.width - left - side * (width + 20)) / row.scale), bottom = Math.min(row.page.height, (area.top + area.height - row.top - 28) / row.scale)
          return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null
        }
        const common = { project: project.id, page: row.page, scale: row.scale, edge, controller, selection, onSelect, onInteracting: interactionChanged, onMeasure, onPointer, detailed: settled, interacting: !!interacting }
        return <section className="pl-page-row" key={row.page.id} style={{ top: row.top, height: row.height, width: wide }}>
          <div className="pl-page-caption">{row.page.name}{compare ? ' · 左：預排版　右：原圖與偵測框' : clean && !row.page.clean ? ' · 原圖（尚無去字預覽）' : clean && row.page.clean_kind === 'inpainted' ? ' · inpainted 預覽' : clean ? ' · 去字圖' : ' · 原圖'}</div>
          <div className="pl-page-pair">
            <TextPage key="editor" {...common} clean={clean} showMeasure={!compare && showMeasure} region={region(0)} />
            {compare && <TextPage key="source" {...common} clean={false} readonly showMeasure={showMeasure} region={region(1)} />}
          </div>
        </section>
      })}
    </div>
  </div>
}
