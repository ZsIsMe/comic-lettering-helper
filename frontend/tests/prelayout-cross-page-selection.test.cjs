const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const moduleSource = { exports: {} }
new Function('module', 'exports', ts.transpileModule(readFileSync(path.join(__dirname, '../src/prelayout/geometry.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(moduleSource, moduleSource.exports)
const { selectionPages, selectionIds, selectionOrder, selectTextItem } = moduleSource.exports

test('Shift selection retains pages and scopes identical item IDs by page', () => {
  let selection = selectTextItem({ page: 'a', ids: [] }, 'a', 'same', false)
  selection = selectTextItem(selection, 'b', 'same', true)
  assert.deepEqual(selectionPages(selection), { a: ['same'], b: ['same'] })
  assert.equal(selection.page, 'b')
  assert.deepEqual(selectionIds(selection, 'a'), ['same'])
  assert.deepEqual(selectionIds(selection, 'unselected'), [])
})
test('Shift toggles a frame off, chooses a remaining active page, then clears all', () => {
  let selection = selectTextItem({ page: 'a', ids: ['one'] }, 'b', 'two', true)
  selection = selectTextItem(selection, 'b', 'two', true)
  assert.equal(selection.page, 'a')
  assert.deepEqual(selectionPages(selection), { a: ['one'] })
  selection = selectTextItem(selection, 'a', 'one', true)
  assert.deepEqual(selectionPages(selection), {})
  assert.deepEqual(selection.ids, [])
})
test('normal click on a selected frame preserves the batch and updates active page', () => {
  let selection = selectTextItem({ page: 'a', ids: ['one'] }, 'b', 'two', true)
  selection = selectTextItem(selection, 'a', 'one', false)
  assert.equal(selection.page, 'a')
  assert.deepEqual(selectionPages(selection), { a: ['one'], b: ['two'] })
  selection = selectTextItem(selection, 'b', 'new', false)
  assert.deepEqual(selectionPages(selection), { b: ['new'] })
})
test('clear selection drops all pages and does not retain stale IDs', () => {
  const selected = selectTextItem({ page: 'a', ids: ['one'] }, 'b', 'two', true)
  const cleared = { page: selected.page, ids: [] }
  assert.deepEqual(selectionPages(cleared), {})
  assert.deepEqual(selectionIds(cleared, 'a'), [])
})

test('interleaved pages retain click order and reselection appends at the end', () => {
  let selection = { page: 'b', ids: ['two'] }
  selection = selectTextItem(selection, 'a', 'one', true)
  selection = selectTextItem(selection, 'b', 'three', true)
  assert.deepEqual(selectionOrder(selection), [{ page: 'b', id: 'two' }, { page: 'a', id: 'one' }, { page: 'b', id: 'three' }])
  selection = selectTextItem(selection, 'b', 'two', true)
  selection = selectTextItem(selection, 'b', 'two', true)
  assert.deepEqual(selectionOrder(selection), [{ page: 'a', id: 'one' }, { page: 'b', id: 'three' }, { page: 'b', id: 'two' }])
  selection = selectTextItem(selection, 'b', 'new', false)
  assert.deepEqual(selectionOrder(selection), [{ page: 'b', id: 'new' }])
})
