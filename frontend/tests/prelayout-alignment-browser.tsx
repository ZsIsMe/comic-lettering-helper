import { createRoot } from 'react-dom/client'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { AlignmentControls } from '../src/prelayout/AlignmentControls'
import { DisplayText } from '../src/prelayout/DisplayText'
import { EditorState } from '../src/prelayout/editor-state'
import { selectTextItem, type Selection } from '../src/prelayout/geometry'
import { measurePage, textStyle, type PageMeasurement } from '../src/prelayout/layout-review'
import type { PageData } from '../src/prelayout/types'
import '../src/prelayout/styles.css'

const original: PageData = {
  id: 'fixture', name: '離線測試頁', width: 860, height: 600, revision: 0, sha256: '', clean: null, measure: [],
  items: [
    { _id: 'a', text: 'A 橫排\n不同尺寸', x: .2, y: .24, 'font-size': 26, rotation: 0, orientation: 'horizontal', color: '#66328a', 'stroke-color': '#fff', 'stroke-weight': 2, xyxy_pixel: [120, 100, 220, 180] },
    { _id: 'b', text: 'B直排文字', x: .48, y: .47, 'font-size': 34, rotation: 0, orientation: 'vertical', color: '#135b74', 'stroke-color': '#fff', 'stroke-weight': 0, xyxy_pixel: [390, 180, 440, 370] },
    { _id: 'c', text: 'C 旋轉文字', x: .78, y: .72, 'font-size': 42, rotation: 23, orientation: 'horizontal', color: '#753f25', 'stroke-color': '#fff', 'stroke-weight': 4, xyxy_pixel: [540, 390, 780, 470] },
  ],
}
function seed() {
  const controller = new EditorState('offline-alignment-fixture')
  controller.pages.set('fixture', { data: structuredClone(original), undo: [], redo: [], dirty: false, version: 0, error: '', saving: false, conflict: false })
  controller.save = async () => true
  return controller
}

// Browser fixture is a standalone Vite entry.
// eslint-disable-next-line react-refresh/only-export-components
function Fixture() {
  const controller = useMemo(seed, [])
  const tick = useSyncExternalStore(callback => controller.subscribe('*', callback), () => controller.tick('*'))
  const [selection, setSelection] = useState<Selection>({ page: 'fixture', ids: ['a', 'b', 'c'] })
  const [measurement, setMeasurement] = useState<PageMeasurement | null>(null)
  const state = controller.pages.get('fixture')!, page = state.data
  useEffect(() => {
    let live = true
    void measurePage(structuredClone(controller.pages.get('fixture')!.data)).then(value => { if (live) setMeasurement(value) })
    return () => { live = false }
  }, [controller, tick])
  useEffect(() => () => controller.dispose(), [controller])
  const rects = measurement?.rects || {}
  const ordered = (axis: number) => page.items.map(item => rects[item._id]).filter(Boolean).sort((a, b) => a[axis] - b[axis])
  const gaps = (axis: number) => ordered(axis).slice(1).map((box, index) => +(box[axis] - ordered(axis)[index][axis + 2]).toFixed(4))
  const centers = (axis: number) => ordered(axis).slice(1).map((box, index) => +((box[axis] + box[axis + 2] - ordered(axis)[index][axis] - ordered(axis)[index][axis + 2]) / 2).toFixed(4))
  return <main className="pl-shell fixture"><h1>對齊／分佈離線回歸</h1><p>單擊選取；Shift 點擊多選。三框包含不同尺寸、直排及旋轉。資料只保存在瀏覽器草稿。</p>
    <div className="fixture-toolbar">
      <button onClick={() => setSelection({ page: 'fixture', ids: ['a'] })}>單選 A</button>
      <button onClick={() => setSelection({ page: 'fixture', ids: ['a', 'b'] })}>多選 A+B</button>
      <button onClick={() => setSelection({ page: 'fixture', ids: ['a', 'b', 'c'] })}>全選 A+B+C</button>
      <button onClick={() => { controller.edit('fixture', structuredClone(original.items)); state.undo = []; state.redo = []; setSelection({ page: 'fixture', ids: ['a', 'b', 'c'] }) }}>重設</button>
      <button disabled={!state.undo.length} onClick={() => controller.undo('fixture')}>撤銷</button>
      <button disabled={!state.redo.length} onClick={() => controller.undo('fixture', true)}>重做</button>
    </div>
    <div className="fixture-layout"><aside className="pl-inspector"><AlignmentControls controller={controller} selection={selection} pageLabel="離線測試頁" /></aside>
      <div className="fixture-page" style={{ width: page.width, height: page.height }}>{page.items.map(item => <div key={item._id}
        className={`pl-text${selection.ids.includes(item._id) ? ' selected' : ''}`} style={textStyle(item, page)}
        onClick={event => setSelection(value => selectTextItem(value, 'fixture', item._id, event.shiftKey))}><DisplayText text={item.text} orientation={item.orientation} /></div>)}</div>
    </div>
    <output id="geometry-summary">{JSON.stringify({ selection, undo: state.undo.length, redo: state.redo.length, version: state.version,
      gaps: { horizontal: gaps(0), vertical: gaps(1) }, centers: { horizontal: centers(0), vertical: centers(1) },
      items: page.items.map(item => ({ id: item._id, x: +(item.x * page.width).toFixed(4), y: +(item.y * page.height).toFixed(4), box: rects[item._id], xyxy: item.xyxy_pixel, size: item['font-size'], rotation: item.rotation, orientation: item.orientation })) }, null, 2)}</output>
  </main>
}
createRoot(document.querySelector('#root')!).render(<Fixture />)
