// Build this isolated browser regression page with esbuild; no project/API data.
import { createRoot } from 'react-dom/client'
import { useState } from 'react'
import { InlineTextEditor } from '../src/prelayout/InlineTextEditor'
import { TextPage } from '../src/prelayout/TextPage'
import { moveVerticalCaret, resetVerticalCaret } from '../src/prelayout/caret-navigation'
import { readEditableText } from '../src/prelayout/editable-text'
import type { EditorState } from '../src/prelayout/editor-state'
import type { Item } from '../src/prelayout/types'
import type { Selection } from '../src/prelayout/geometry'
import '../src/prelayout/styles.css'

const sample = '也有幾位選手\n剛好被下放二軍調整時\n曾和我交手過'
const result = document.querySelector<HTMLOutputElement>('#result')!
const probe = document.querySelector<HTMLDivElement>('#probe')!
const assert = (condition: boolean, detail: string) => { if (!condition) throw new Error(detail) }
const key = (name: string, shiftKey = false) => new KeyboardEvent('keydown', { key: name, shiftKey })
const selection = () => document.getSelection()!
const offset = () => readEditableText(probe).offsetAt(selection().focusNode!, selection().focusOffset)
const place = (index: number) => {
  resetVerticalCaret(probe)
  const p = readEditableText(probe).pointAt(index)
  probe.focus(); selection().setPosition(p.node, p.offset)
}
document.querySelector<HTMLButtonElement>('#run')!.onclick = () => {
  let checks = 0
  try {
    const fixtures = [
      [sample, sample],
      ['也有幾位選手<div>剛好被下放二軍調整時</div><div>曾和我交手過</div>', sample],
      ['<div>也有幾位選手</div><div>剛好被下放二軍調整時</div><div>曾和我交手過</div>', sample],
      ['也有幾位選手<br>剛好被下放二軍調整時<br>曾和我交手過', sample],
      ['也有<span>幾位</span>選手\n剛好被下放二軍調整時\n曾和我交手過', sample],
      ['甲\n\n乙\n\n', '甲\n\n乙\n'],
      ['甲<div><br></div><div>乙</div><div><br></div>', '甲\n\n乙\n'],
      ['甲\n<div><br></div><div><br></div>', '甲\n\n'],
      ['甲<br><br>乙<br><br>', '甲\n\n乙\n'],
      ['<br>', ''], ['\n\n', '\n'],
    ]
    for (const [html, expected] of fixtures) {
      for (const scale of [.5, 1, 3]) {
        probe.innerHTML = html; probe.style.transform = `scale(${scale})`
        assert(readEditableText(probe).text === expected, `read ${html}`); checks++
        const lines = expected.split('\n')
        for (let start = 0; start <= expected.length; start++) {
          const prefix = expected.slice(0, start), column = prefix.split('\n').length - 1
          const row = start - (prefix.lastIndexOf('\n') + 1)
          for (const direction of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
            place(start)
            assert(offset() === start, `round trip ${html} offset ${start}`); checks++
            let target = start
            if (direction === 'ArrowUp') target = Math.max(0, start - 1)
            if (direction === 'ArrowDown') target = Math.min(expected.length, start + 1)
            if (direction === 'ArrowLeft' && column < lines.length - 1) target = start - row + lines[column].length + 1 + Math.min(row, lines[column + 1].length)
            if (direction === 'ArrowRight' && column > 0) target = start - row - lines[column - 1].length - 1 + Math.min(row, lines[column - 1].length)
            moveVerticalCaret(probe, key(direction))
            assert(offset() === target, `${direction} ${html} ${start}: ${offset()} != ${target}`); checks++
          }
        }
        assert(readEditableText(probe).text === expected && probe.innerHTML === html, `navigation mutated DOM ${html}`); checks++
      }
    }
    probe.textContent = sample; probe.style.transform = ''
    place(16)
    for (const [direction, expected] of [['ArrowLeft',24], ['ArrowRight',16], ['ArrowRight',6], ['ArrowLeft',16]] as const) {
      moveVerticalCaret(probe, key(direction, true)); assert(offset() === expected, `preferred row ${direction}`); checks++
      const s = selection(), map = readEditableText(probe)
      assert(map.offsetAt(s.anchorNode!,s.anchorOffset) === 16, 'Shift anchor'); checks++
    }
    place(6); moveVerticalCaret(probe, key('ArrowDown'))
    const s = selection(), range = document.createRange()
    range.setStart(s.focusNode!, s.focusOffset); range.collapse(true)
    const caret = range.getBoundingClientRect()
    range.setStart(probe.firstChild!,7);range.setEnd(probe.firstChild!,8)
    const glyph = range.getBoundingClientRect()
    assert(Math.abs(caret.y - glyph.y) < 2 && Math.abs(caret.x - glyph.x) < 2, 'caret at next column head');checks++
    result.textContent = `PASS ${checks} DOM/navigation checks; native editor below ready.`
  } catch (error) { result.textContent = `FAIL after ${checks}: ${error}` }
}

const item = { _id:'fixture', text:sample, x:.5, y:.5, 'font-size':36, rotation:0, orientation:'vertical', color:'#000', 'stroke-color':'#fff', 'stroke-weight':0 } satisfies Item
let stored = sample
let saves = 0, edits = 0
const controller = {
  beginTextDraft: () => ({ change() {}, end() {} }),
  pages: new Map([['fixture',{data:{items:[item]}}]]),
  edit: (_page: string, items: Item[]) => { stored = items[0].text; edits++ },
  flush: async () => { document.querySelector('#saved')!.textContent = JSON.stringify({text:stored,saves:++saves,edits}) },
} as unknown as EditorState
const root = createRoot(document.querySelector('#mount')!)
function mount() {
  root.render(<InlineTextEditor item={{...item,text:stored}} page="fixture" controller={controller} point={{x:0,y:0}} pageWidth={800} scale={1}
    onSplit={() => {}} onFinish={() => { root.render(null); document.querySelector('#saved')!.textContent = JSON.stringify(stored) }} />)
}
document.querySelector<HTMLButtonElement>('#edit')!.onclick = mount
const status = document.querySelector('#status')!
function inspect() {
  const editor = document.querySelector<HTMLElement>('.pl-inline-editor'), s = selection()
  if (!editor || !s.focusNode || !editor.contains(s.focusNode)) return
  const map = readEditableText(editor), range = document.createRange()
  range.setStart(s.focusNode,s.focusOffset); range.collapse(true)
  const rect = range.getBoundingClientRect()
  status.textContent = JSON.stringify({text:map.text,offset:map.offsetAt(s.focusNode,s.focusOffset),anchor:map.offsetAt(s.anchorNode!,s.anchorOffset),x:rect.x,y:rect.y,html:editor.innerHTML})
}
document.addEventListener('selectionchange',inspect)
document.addEventListener('input',inspect)
document.querySelector<HTMLButtonElement>('#place')!.onmousedown = event => event.preventDefault()
document.querySelector<HTMLButtonElement>('#place')!.onclick = () => {
  const editor = document.querySelector<HTMLElement>('.pl-inline-editor')!
  const p = readEditableText(editor).pointAt(16)
  editor.focus();resetVerticalCaret(editor);selection().setPosition(p.node,p.offset);inspect()
}

const actionPage = { id: 'actions', name: 'quick-actions.png', width: 760, height: 430, revision: 0, sha256: '', clean: null }
const actionItems: Item[] = [
  { _id:'t_11111111111111111111111111111111', index: 1, groupId: 4, text:'短句 ABC',x:.25,y:.28,'font-size':32,rotation:0,orientation:'horizontal',color:'000','stroke-color':'#ffffff','stroke-weight':0,match_status:'auto',xyxy_pixel:[120,80,260,150] },
  { _id:'t_22222222222222222222222222222222', index: 2, groupId: 5, text:'跨行選取\n旋轉直排測試',x:.58,y:.55,'font-size':34,rotation:28,orientation:'vertical',color:'#c03030','stroke-color':'#ffffff','stroke-weight':3,match_status:'auto',xyxy_pixel:[390,150,520,350] },
]
// This is an esbuild-only browser fixture, not a hot-reloaded application module.
// eslint-disable-next-line react-refresh/only-export-components
function ActionFixture() {
  const [, rerender] = useState(0)
  const [selected, setSelected] = useState<Selection>({ page: actionPage.id, ids: [] })
  const [interacting, setInteracting] = useState<string | null>(null)
  const state = actionFixtureState
  const updateStatus = () => {
    const output = document.querySelector('#action-status')
    if (output) output.textContent = JSON.stringify({ edits: actionFixtureEdits, undo: state.undo.length, selected: actionFixtureSelection.ids, items: state.data.items.map(value => ({ id:value._id,text:value.text,x:+value.x.toFixed(4),y:+value.y.toFixed(4),color:value.color,stroke:value['stroke-weight'],strokeColor:value['stroke-color'],orientation:value.orientation,rotation:value.rotation,index:value.index,groupId:value.groupId,hasBox:!!value.xyxy_pixel })) }, null, 2)
  }
  actionFixtureRender = () => { rerender(value => value + 1); updateStatus() }
  actionFixtureSelection = selected
  queueMicrotask(updateStatus)
  return <div className="pl-viewport action-fixture" tabIndex={0} style={{width:760,height:430,overflow:'visible'}}>
    <TextPage project="fixture" page={actionPage} scale={1} edge={768} clean={false} controller={actionController}
      selection={selected} onSelect={value => { actionFixtureSelection = value; setSelected(value) }} onInteracting={setInteracting}
      showMeasure={false} onMeasure={() => {}} region={null} detailed={false} interacting={!!interacting} onPointer={() => {}} />
  </div>
}
let actionFixtureEdits = 0, actionFixtureSelection: Selection = { page: actionPage.id, ids: [] }, actionFixtureRender = () => {}
let actionFixtureTick = 0
const actionFixtureListeners = new Set<() => void>()
const actionFixtureState = { data: {...actionPage,items:structuredClone(actionItems),measure:[],character_boxes:[]}, undo: [] as Item[][], redo: [] as Item[][], dirty:false,version:0,error:'',saving:false,conflict:false }
const actionController = {
  pages: new Map([[actionPage.id,actionFixtureState]]), subscribe: (_page:string, listener:() => void) => { actionFixtureListeners.add(listener); return () => actionFixtureListeners.delete(listener) }, tick: () => actionFixtureTick, load: async () => actionFixtureState,
  beginTextDraft: () => ({change() {},end() {}}), flush: async () => true,
  edit: (_page:string,items:Item[],_record=true,_group?:string,_continuing=false,undoSnapshot?:Item[]) => {
    void _record; void _continuing
    actionFixtureState.undo.push(structuredClone(undoSnapshot || actionFixtureState.data.items)); actionFixtureState.redo=[]
    actionFixtureState.data.items=structuredClone(items); actionFixtureEdits++; actionFixtureTick++; actionFixtureListeners.forEach(listener => listener()); actionFixtureRender()
  },
  undo: (_page:string,redo=false) => {
    const from=redo?actionFixtureState.redo:actionFixtureState.undo, to=redo?actionFixtureState.undo:actionFixtureState.redo, items=from.pop()
    if (!items) return
    to.push(structuredClone(actionFixtureState.data.items)); actionFixtureState.data.items=structuredClone(items)
    actionFixtureEdits++; actionFixtureTick++; actionFixtureListeners.forEach(listener => listener()); actionFixtureRender()
  },
} as unknown as EditorState
createRoot(document.querySelector('#action-mount')!).render(<ActionFixture />)
document.querySelector<HTMLButtonElement>('#action-undo')!.onclick = () => actionController.undo(actionPage.id)
document.querySelector<HTMLButtonElement>('#action-redo')!.onclick = () => actionController.undo(actionPage.id,true)

function selectActionRange(start: number, end: number) {
  const editor = document.querySelector<HTMLElement>('.action-fixture .pl-inline-editor')
  if (!editor) { document.querySelector('#action-status')!.textContent = '請先雙擊一段文字開啟編輯器'; return }
  const map = readEditableText(editor), a = map.pointAt(start), b = map.pointAt(end)
  editor.focus(); selection().setBaseAndExtent(a.node,a.offset,b.node,b.offset)
}
for (const [id,start,end] of [['select-partial',2,6],['select-multiline',2,10]] as const) {
  const button = document.querySelector<HTMLButtonElement>('#'+id)!
  button.onpointerdown = event => event.preventDefault()
  button.onclick = () => selectActionRange(start,end)
}
