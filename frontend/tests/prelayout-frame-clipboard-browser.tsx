import { createRoot } from 'react-dom/client'
import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { TextPage } from '../src/prelayout/TextPage'
import { EditorState } from '../src/prelayout/editor-state'
import { pasteFrame } from '../src/prelayout/frame-clipboard'
import { useFrameClipboard } from '../src/prelayout/use-frame-clipboard'
import { uid, type Item, type Page } from '../src/prelayout/types'
import type { PagePointer, Selection } from '../src/prelayout/geometry'
import '../src/prelayout/styles.css'

const pages: Page[] = [
  { id: 'wide', name: '寬頁（80%）', width: 720, height: 420, revision: 0, sha256: '', clean: null },
  { id: 'tall', name: '直頁（60%）', width: 520, height: 680, revision: 0, sha256: '', clean: null },
]
const original: Record<string, Item[]> = {
  wide: [
    { _id: 'source-a', index: 1, groupId: 7, text: '樣式來源 A', x: .25, y: .3, 'font-size': 34, rotation: 12, orientation: 'horizontal', color: '#5426a8', 'stroke-color': '#ffffff', 'stroke-weight': 3, match_status: 'auto', match_source_block_index: 4, xyxy_pixel: [90, 70, 270, 150] },
    { _id: 'source-b', index: 2, groupId: 9, text: '來源 B', x: .68, y: .58, 'font-size': 42, rotation: -20, orientation: 'vertical', color: '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 0, match_status: 'auto', xyxy_pixel: [420, 170, 560, 330] },
  ],
  tall: [],
}

function seedController() {
  const controller = new EditorState('isolated-frame-clipboard-fixture')
  for (const page of pages) controller.pages.set(page.id, { data: { ...page, items: structuredClone(original[page.id]), measure: [], character_boxes: [] }, undo: [], redo: [], dirty: false, version: 0, error: '', saving: false, conflict: false })
  // Keep the fixture offline while retaining the real EditorState edit/undo path.
  controller.save = async () => true
  return controller
}

type ClipboardMode = 'success' | 'empty' | 'denied' | 'unavailable' | 'slow'

// This is an esbuild-only browser fixture, not a hot-reloaded application module.
// eslint-disable-next-line react-refresh/only-export-components
function Fixture() {
  const controller = useMemo(seedController, [])
  useSyncExternalStore(callback => controller.subscribe('*', callback), () => controller.tick('*'))
  const [selection, setSelection] = useState<Selection>({ page: 'wide', ids: [] })
  const [interacting, setInteracting] = useState<string | null>(null)
  const [mode, setMode] = useState<ClipboardMode>('success')
  const [clipboardText, setClipboardText] = useState('系統剪貼簿第一行\r\n第二行')
  const [messages, setMessages] = useState<string[]>([])
  const [slowWaiting, setSlowWaiting] = useState(false)
  const [shownPointer, setShownPointer] = useState<PagePointer | null>(null)
  const pointer = useRef<PagePointer | null>(null)
  const slowResolve = useRef<((value: string) => void) | null>(null)
  const selectedState = controller.pages.get(selection.page)
  const selected = selectedState?.data.items.filter(item => selection.ids.includes(item._id)) || []
  const notify = useCallback((value: string) => setMessages(list => [...list.slice(-8), value]), [])
  const pointerChanged = useCallback((value: PagePointer | null) => { pointer.current = value; setShownPointer(value) }, [])
  const blocked = useCallback((event: KeyboardEvent) => {
    const editing = (target: EventTarget | null) => target instanceof Element && !!target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')
    return event.defaultPrevented || editing(event.target) || editing(document.activeElement)
  }, [])
  const readText = useCallback(() => {
    if (mode === 'empty') return Promise.resolve('')
    if (mode === 'denied') return Promise.reject(new DOMException('denied', 'NotAllowedError'))
    if (mode === 'unavailable') return Promise.reject(new Error('瀏覽器無法讀取系統剪貼簿'))
    if (mode === 'slow') return new Promise<string>(resolve => { slowResolve.current = resolve; setSlowWaiting(true) })
    return Promise.resolve(clipboardText)
  }, [mode, clipboardText])

  useFrameClipboard({
    blocked, selectionCount: selection.ids.length, selected, selectedPage: pages.find(page => page.id === selection.page), pointer, notify, readText,
    paste: async (capture, valid) => {
      const page = pages.find(value => value.id === capture.pointer.page)
      if (!page) throw new Error('找不到滑鼠所在頁面')
      const state = await controller.load(page.id)
      if (!valid()) return
      const item = pasteFrame(capture.frame, capture.pointer, page, uid, capture.text)
      controller.edit(page.id, [...state.data.items, item])
      setSelection({ page: page.id, ids: [item._id] })
      notify(`已貼上到 ${page.name} (${item.x.toFixed(3)}, ${item.y.toFixed(3)})`)
    },
  })

  const press = (key: string) => {
    ;(document.activeElement as HTMLElement | null)?.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key, metaKey: true, bubbles: true }))
  }
  const itemSummary = pages.flatMap(page => controller.pages.get(page.id)!.data.items.map(item => ({ page: page.id, id: item._id, text: item.text, x: +item.x.toFixed(3), y: +item.y.toFixed(3), group: item.groupId, size: item['font-size'], status: item.match_status, index: item.index, detector: item.match_source_block_index, box: item.xyxy_pixel })))
  return <main>
    <h1>文字框剪貼快捷鍵回歸</h1>
    <p>在文字框上單擊選取，按 ⌘／Ctrl＋C；把滑鼠移到任一左側測試頁，再按 ⌘／Ctrl＋V 或 ⌘／Ctrl＋P。</p>
    <div className="fixture-tools">
      <button onClick={() => setSelection({ page: 'wide', ids: ['source-a'] })}>選取 A</button>
      <button onClick={() => setSelection({ page: 'wide', ids: ['source-a', 'source-b'] })}>多選 A+B</button>
      <button onClick={() => setSelection(value => ({ ...value, ids: [] }))}>清除選取</button>
      <button onClick={() => pointerChanged({ page: 'wide', x: .35, y: .65 })}>指標→寬頁 (.35, .65)</button>
      <button onClick={() => pointerChanged({ page: 'tall', x: .72, y: .22 })}>指標→直頁 (.72, .22)</button>
      <button onClick={() => pointerChanged(null)}>指標移出頁面</button>
      <button onClick={() => press('c')}>觸發 ⌘C</button><button onClick={() => press('v')}>觸發 ⌘V</button><button onClick={() => press('p')}>觸發 ⌘P</button>
      <button onClick={() => controller.undo(selection.page)}>撤銷目前頁</button><button onClick={() => controller.undo(selection.page, true)}>重做目前頁</button>
    </div>
    <fieldset><legend>系統剪貼簿模擬</legend>
      <select aria-label="剪貼簿模式" value={mode} onChange={event => setMode(event.target.value as ClipboardMode)}>
        <option value="success">成功</option><option value="empty">空文字</option><option value="denied">拒絕權限</option><option value="unavailable">不可用</option><option value="slow">延遲讀取</option>
      </select>
      <textarea aria-label="剪貼簿文字" value={clipboardText} onChange={event => setClipboardText(event.target.value)} />
      <button disabled={!slowWaiting} onClick={() => { slowResolve.current?.(clipboardText); slowResolve.current = null; setSlowWaiting(false) }}>完成延遲讀取</button>
    </fieldset>
    <div className="pages">
      {pages.map((page, index) => <section key={page.id}><h2>{page.name}</h2><div className="pl-viewport" tabIndex={0} style={{ width: page.width * (index ? .6 : .8), height: page.height * (index ? .6 : .8), overflow: 'visible' }}>
        <TextPage project="fixture" page={page} scale={index ? .6 : .8} edge={768} clean={false} controller={controller} selection={selection} onSelect={setSelection} onInteracting={setInteracting} showMeasure={false} onMeasure={() => {}} region={null} detailed={false} interacting={!!interacting} onPointer={pointerChanged} />
      </div></section>)}
    </div>
    <output>{JSON.stringify({ selection, pointer: shownPointer, clipboardMode: mode, messages, history: Object.fromEntries(pages.map(page => { const state = controller.pages.get(page.id)!; return [page.id, { dirty: state.dirty, undo: state.undo.length, redo: state.redo.length }] })), items: itemSummary }, null, 2)}</output>
  </main>
}

createRoot(document.querySelector('#root')!).render(<Fixture />)
