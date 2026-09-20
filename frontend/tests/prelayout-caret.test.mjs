import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

async function moduleURL(name) {
  let source = await readFile(new URL(`../src/prelayout/${name}.ts`, import.meta.url), 'utf8')
  if (name === 'caret-navigation') source = source.replace("'./editable-text'", JSON.stringify(await moduleURL('editable-text')))
  return `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText).toString('base64')}`
}
const { verticalCaretAction, verticalCaretTarget: move } = await import(await moduleURL('caret-navigation'))
const text = '也有幾位選手\n剛好被下放二軍調整時\n曾和我交手過'

test('vertical navigation leaves IME and modified system shortcuts untouched', () => {
  for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    for (const extra of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
      assert.equal(verticalCaretAction({ key, ...extra }), null)
    }
  }
  assert.equal(verticalCaretAction({ key: 'Backspace' }), null)
})

test('every character and newline is one step, including consecutive and trailing newlines', () => {
  for (const value of [text, '\n甲\n\n乙\n', '', '\n\n']) {
    for (let offset = 0; offset <= value.length; offset++) {
      assert.equal(move(value, offset, 'ArrowDown').offset, Math.min(offset + 1, value.length))
      assert.equal(move(value, offset, 'ArrowUp').offset, Math.max(offset - 1, 0))
    }
  }
})

test('unequal columns clamp only the destination and retain the preferred row on return', () => {
  assert.deepEqual(move(text, 16, 'ArrowLeft'), { offset: 24, preferredRow: 9 })
  assert.equal(move(text, 24, 'ArrowRight', 9).offset, 16)
  assert.deepEqual(move(text, 16, 'ArrowRight'), { offset: 6, preferredRow: 9 })
  assert.equal(move(text, 6, 'ArrowLeft', 9).offset, 16)
  assert.equal(move(text, 6, 'ArrowLeft').offset, 13) // A fresh click resets the preferred row.
  assert.equal(move(text, 7, 'ArrowRight').offset, 0)
  assert.equal(move(text, 17, 'ArrowLeft').offset, 24)
  assert.equal(move(text, 18, 'ArrowRight').offset, 7)
})

test('empty columns stay navigable and the outer boundaries do not wrap', () => {
  assert.deepEqual(move('甲乙\n\n丙丁', 2, 'ArrowLeft'), { offset: 3, preferredRow: 2 })
  assert.equal(move('甲乙\n\n丙丁', 3, 'ArrowLeft', 2).offset, 6)
  assert.equal(move(text, 4, 'ArrowRight').offset, 4)
  assert.equal(move(text, 22, 'ArrowLeft').offset, 22)
})

test('surrogate pairs, combining marks and emoji sequences move as whole characters', () => {
  const value = '甲𠮷e\u0301👨‍👩‍👧\n乙'
  const stops = [0, 1, 3, 5, 13, 14, 15]
  for (let i = 0; i < stops.length - 1; i++) {
    assert.equal(move(value, stops[i], 'ArrowDown').offset, stops[i + 1])
    assert.equal(move(value, stops[i + 1], 'ArrowUp').offset, stops[i])
  }
  assert.equal(move('𠮷甲\n乙丙', 2, 'ArrowLeft').offset, 5)
})
