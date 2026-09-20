// Build this isolated browser regression page with esbuild; no project/API data.
import { createRoot } from 'react-dom/client'
import { InlineTextEditor } from '../src/prelayout/InlineTextEditor'
import { moveVerticalCaret, resetVerticalCaret } from '../src/prelayout/caret-navigation'
import { readEditableText } from '../src/prelayout/editable-text'
import type { EditorState } from '../src/prelayout/editor-state'
import type { Item } from '../src/prelayout/types'

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
const controller = {
  beginTextDraft: () => ({ change() {}, end() {} }),
  pages: new Map([['fixture',{data:{items:[item]}}]]),
  edit: (_page: string, items: Item[]) => { stored = items[0].text },
  flush: async () => {},
} as unknown as EditorState
const root = createRoot(document.querySelector('#mount')!)
function mount() {
  root.render(<InlineTextEditor item={{...item,text:stored}} page="fixture" controller={controller} point={{x:0,y:0}} onFinish={() => { root.render(null); document.querySelector('#saved')!.textContent = JSON.stringify(stored) }} />)
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
