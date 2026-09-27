const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const source = readFileSync(path.resolve(__dirname, '../src/prelayout/view-modes.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const moduleValue = { exports: {} }
new Function('module', 'exports', code)(moduleValue, moduleValue.exports)
const { currentViewMode, resolveViewChange } = moduleValue.exports
const initial = () => ({ clean: true, difference: true, showText: true, differenceColor: '#ff288c', differenceOpacity: .64 })

test('three modes change only review layers and leave style preference intact', () => {
  const before = initial()
  const original = resolveViewChange(before, { mode: 'original' }, true)
  assert.deepEqual(original, { ...before, clean: false, difference: false, showText: false })
  assert.equal(currentViewMode(original, true), 'original')
  assert.equal(currentViewMode(resolveViewChange(original, { mode: 'final' }, true), true), 'final')
  assert.equal(currentViewMode(resolveViewChange(original, { mode: 'overlay' }, true), true), 'overlay')
  assert.deepEqual(before, initial())
})

test('legacy layer switch and independent color/opacity remain supported', () => {
  const before = initial()
  const after = resolveViewChange(before, { difference_highlight: false, show_text: false, difference_color: '#C0FFEE', difference_opacity: 0 }, true)
  assert.deepEqual(after, { ...before, difference: false, showText: false, differenceColor: '#c0ffee', differenceOpacity: 0 })
  assert.equal(currentViewMode(after, true), 'custom')
  assert.deepEqual(resolveViewChange(before, {}, true), before)
})

test('mode contradiction, missing clean background, and invalid style reject atomically', () => {
  const before = initial(), unchanged = structuredClone(before)
  for (const change of [
    { mode: 'overlay', show_text: false }, { mode: 'original', clean: true },
    { mode: 'final', difference_highlight: true },
    { mode: 'final', difference_color: 'red' },
    { mode: 'final', difference_opacity: 1.1 },
    { mode: 'original', difference_opacity: NaN },
    { show_text: 'false' },
  ]) assert.throws(() => resolveViewChange(before, change, true))
  assert.throws(() => resolveViewChange(before, { mode: 'overlay' }, false), /沒有去字底圖/)
  assert.throws(() => resolveViewChange(before, { mode: 'final' }, false), /沒有去字底圖/)
  assert.equal(currentViewMode(before, false), 'custom')
  assert.deepEqual(before, unchanged)
})
