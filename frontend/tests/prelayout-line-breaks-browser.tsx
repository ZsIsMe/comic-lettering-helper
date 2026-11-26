import { createRoot } from 'react-dom/client'
import { useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { EditorState } from '../src/prelayout/editor-state'
import { LineBreakControls } from '../src/prelayout/LineBreakControls'
import { TextPage } from '../src/prelayout/TextPage'
import { lineBreakPreviewMatches, type LineBreakPreview } from '../src/prelayout/line-breaks'
import { selectionPages, type Selection } from '../src/prelayout/geometry'
import type { Item, PageData } from '../src/prelayout/types'
import { loadLocalFont } from '../src/prelayout/local-fonts'
import '../src/prelayout/styles.css'

const original = '這是一段測試文字，請確認斷句。'
const vertical: Item = { _id: 'vertical', text: original, x: .32, y: .43, 'font-size': 27, rotation: 0, orientation: 'vertical', color: '#000', 'stroke-color': '#fff', 'stroke-weight': 0, custom: { retained: true } }
const initial: PageData = { id: 'page-a', name: '001.png', width: 800, height: 700, revision: 0, sha256: 'synthetic-line-break-fixture', clean: null, measure: [],
  items: [vertical, { ...vertical, _id: 'horizontal', orientation: 'horizontal', x: .68, y: .68, 'font-size': 20 }], line_break_suggestions: Object.fromEntries(['vertical', 'horizontal'].map(id => [id, { original_text: original, source_line_count: 3, candidates: [
    { line_count: 4, text: '這是一段\n測試文字，\n請確認\n斷句。' }, { line_count: 3, text: '這是一段測試\n文字，請確認\n斷句。' }, { line_count: 2, text: '這是一段測試文字，\n請確認斷句。' },
  ] }])) }
let server = structuredClone(initial), writes = 0
// Never request a real project or server. The synthetic background and saves
// exist only inside this fixture; its IDB draft uses a separate fixture ID.
window.fetch = async (input, init) => {
  const url = String(input), prefix = '/api/prelayout/projects/offline-line-break-fixture/pages/page-a'
  if (url.startsWith(prefix + '/preview?')) return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="800" height="700"><rect width="800" height="700" fill="#f0ebe3"/><ellipse cx="256" cy="300" rx="150" ry="220" fill="white" stroke="#776b60" stroke-width="2"/><ellipse cx="540" cy="475" rx="220" ry="105" fill="white" stroke="#776b60" stroke-width="2"/></svg>', { headers: { 'Content-Type': 'image/svg+xml' } })
  if (url === prefix + '/text' && init?.method === 'PATCH') {
    const payload = JSON.parse(String(init.body)); writes++
    server = { ...server, revision: server.revision + 1, items: payload.items }
    return Response.json(server)
  }
  throw new Error(`離線 fixture 拒絕請求：${url}`)
}

// eslint-disable-next-line react-refresh/only-export-components
function Fixture() {
  const controller = useMemo(() => {
    const value = new EditorState('offline-line-break-fixture')
    value.pages.set(initial.id, { data: structuredClone(initial), version: 0, undo: [], redo: [], dirty: false, saving: false, conflict: false, error: '' })
    return value
  }, [])
  useSyncExternalStore(callback => controller.subscribe('*', callback), () => controller.tick('*'))
  const [selection, setSelection] = useState<Selection>({ page: initial.id, ids: ['vertical'] })
  const [preview, setPreview] = useState<LineBreakPreview | null>(null)
  const [interacting, setInteracting] = useState(false), [currentPage, setCurrentPage] = useState(initial.id)
  const state = controller.pages.get(initial.id)!, first = state.data.items.find(item => item._id === selection.ids[0])
  const key = JSON.stringify(selectionPages(selection))
  useLayoutEffect(() => { setPreview(null) }, [key, currentPage])
  const active = preview && !interacting && lineBreakPreviewMatches(controller, selection, preview) ? preview : null
  const canvas = useRef<HTMLDivElement>(null)
  const patch = (changes: Partial<Item>) => controller.edit(initial.id, state.data.items.map(item => item._id === first?._id ? { ...item, ...changes } : item))
  return <main className="pl-shell fixture"><h1>單框斷句離線驗證</h1><p>全部資料為合成樣本。預覽只改畫布顯示；下方資料與模擬保存次數可核對。</p>
    <div className="fixture-tools"><button onClick={() => setSelection({ page: initial.id, ids: [] })}>清除選取</button><button onClick={() => { setPreview(null); setSelection({ page: initial.id, ids: ['vertical'] }) }}>選直排框</button><button onClick={() => { setPreview(null); setSelection({ page: initial.id, ids: ['horizontal'] }) }}>選橫排框</button>
      <button onClick={() => setSelection({ page: initial.id, ids: ['vertical', 'horizontal'] })}>本頁多選</button><button onClick={() => setSelection({ page: initial.id, ids: ['vertical'], byPage: { 'page-unloaded': ['other'] } })}>跨頁多選</button>
      <button onClick={() => setCurrentPage(value => value === initial.id ? 'other-page' : initial.id)}>切換目前頁</button><button onClick={() => controller.undo(initial.id)}>撤銷</button><button onClick={() => controller.undo(initial.id, true)}>重做</button></div>
    <div className="fixture-layout"><aside className="pl-inspector"><h2>文字編輯</h2><label>目前文字<textarea aria-label="目前文字" value={first?.text || ''} onChange={event => patch({ text: event.target.value })} /></label>
      <label>字體<select aria-label="字體" value={first?.font || ''} onChange={event => { void loadLocalFont(event.target.value).catch(() => {}); patch({ font: event.target.value }) }}><option value="">預設</option><option value="TimesNewRomanPSMT">Times New Roman</option><option value="PingFangTC-Regular">蘋方</option></select></label>
      <LineBreakControls controller={controller} selection={selection} preview={active} disabled={interacting} onPreview={setPreview} onApplied={() => {}} />
    </aside><div className="pl-viewport" tabIndex={0} ref={canvas}><TextPage project="offline-line-break-fixture" page={initial} scale={.9} edge={768} clean={false} difference={false} differenceColor="#ff0000" differenceOpacity={.5}
      controller={controller} selection={selection} textPreview={active} onSelect={value => { setPreview(null); setSelection(value) }}
      onInteracting={id => { setInteracting(!!id); if (id) setPreview(null) }} onMeasure={() => {}} onPointer={() => {}} showMeasure={false} region={null} detailed={false} interacting={interacting} /></div></div>
    <output id="fixture-state">{JSON.stringify({ writes, currentPage, preview: active?.text || null, undo: state.undo.length, data: state.data.items, error: state.error }, null, 2)}</output>
  </main>
}
createRoot(document.querySelector('#root')!).render(<Fixture />)
