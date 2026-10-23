const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function harness() {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', 'indexedDB', 'setTimeout', 'clearTimeout', code)(name => load(path.resolve(path.dirname(file), `${name}.ts`)), module, module.exports,
      { open: () => ({}) }, () => 1, () => {})
    return module.exports
  }
  const api = load(path.resolve(__dirname, '../src/prelayout/alignment.ts'))
  const { EditorState } = load(path.resolve(__dirname, '../src/prelayout/editor-state.ts'))
  const controller = new EditorState('alignment-offline')
  const items = ['a', 'b', 'c', 'unselected'].map((id, index) => ({ _id: id, text: id, x: .1 + index * .2, y: .2 + index * .15,
    'font-size': 20 + index * 4, rotation: index * 20, orientation: index === 1 ? 'vertical' : 'horizontal', color: '#000', 'stroke-color': '#fff', 'stroke-weight': index,
    xyxy_pixel: [10 + index * 20, 20, 30 + index * 20, 40] }))
  const page = { id: 'page', name: '測試頁', width: 1000, height: 500, items, measure: [], revision: 0, clean: null, sha256: '' }
  const state = { data: page, undo: [], redo: [], dirty: false, version: 0, error: '', saving: false, conflict: false }
  controller.pages.set('page', state)
  const rects = { a: [10, 20, 30, 60], b: [80, 100, 140, 120], c: [210, 220, 250, 280] }
  return { ...api, controller, state, page, rects, ids: ['a', 'b', 'c'] }
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`)
const delta = (before, after, axis, size) => (after[axis] - before[axis]) * size

test('all six alignments use painted AABB bounds, preserve the other axis, styles and unselected frames', () => {
  const { alignedItems, page, rects, ids } = harness()
  for (const [operation, expected] of Object.entries({ left: [0, -70, -200], 'center-x': [110, 20, -100], right: [220, 110, 0], top: [0, -80, -200], 'center-y': [110, 40, -100], bottom: [220, 160, 0] })) {
    const result = alignedItems(page, ids, rects, operation)
    const horizontal = ['left', 'center-x', 'right'].includes(operation)
    for (let i = 0; i < 3; i++) {
      const before = page.items[i], after = result[i]
      near(delta(before, after, horizontal ? 'x' : 'y', horizontal ? 1000 : 500), expected[i])
      assert.equal(after[horizontal ? 'y' : 'x'], before[horizontal ? 'y' : 'x'])
      for (const key of ['text', 'orientation', 'rotation', 'font-size', 'color', 'stroke-weight']) assert.equal(after[key], before[key])
      assert.deepEqual(after.xyxy_pixel, before.xyxy_pixel.map((value, axis) => value + ((axis % 2 === (horizontal ? 0 : 1)) ? expected[i] : 0)))
    }
    assert.equal(result[3], page.items[3])
  }
})

test('gap and center distributions preserve endpoints with different sizes on both axes', () => {
  const { alignedItems, page, rects, ids } = harness()
  for (const [operation, expected] of [['gap-x', 10], ['centers-x', 15], ['gap-y', 30], ['centers-y', 35]]) {
    const result = alignedItems(page, ids, rects, operation)
    const horizontal = operation.endsWith('-x')
    assert.equal(result[0], page.items[0]); assert.equal(result[2], page.items[2])
    near(delta(page.items[1], result[1], horizontal ? 'x' : 'y', horizontal ? 1000 : 500), expected)
  }
})

test('rotation and vertical direction use supplied measured AABB, not detector xyxy or font size', () => {
  const { alignedItems, page, rects } = harness()
  const result = alignedItems(page, ['a', 'b'], rects, 'right')
  near(delta(page.items[0], result[0], 'x', 1000), 110)
  assert.equal(result[1], page.items[1])
})

test('negative gaps remain mathematical and fixed endpoints stay fixed', () => {
  const { alignedItems, page, ids } = harness()
  const result = alignedItems(page, ids, { a: [0, 0, 100, 30], b: [10, 0, 110, 30], c: [40, 0, 140, 30] }, 'gap-x')
  near(delta(page.items[1], result[1], 'x', 1000), 10)
  assert.equal(result[0], page.items[0]); assert.equal(result[2], page.items[2])
})

test('already aligned is a no-op and missing, invalid or duplicate measurements reject the whole operation', () => {
  const { alignedItems, page, rects, ids } = harness()
  assert.equal(alignedItems(page, ['a', 'b'], { ...rects, b: [10, 100, 70, 120] }, 'left'), page.items)
  for (const invalid of [undefined, [0, 0, NaN, 1], [0, 0, 0, 1], [1, 0, 0, 1]]) assert.throws(() => alignedItems(page, ids, { ...rects, b: invalid }, 'left'), /無法量測/)
  assert.throws(() => alignedItems(page, ['a', 'missing'], rects, 'left'), /已變更/)
  assert.throws(() => alignedItems(page, ['a'], rects, 'left'), /至少 2/)
  assert.throws(() => alignedItems(page, ['a', 'b'], rects, 'gap-x'), /至少 3/)
})

test('async operation measures only the active page selection and is one undo/redo step', async () => {
  const { alignSelection, controller, state, rects } = harness()
  const selection = { page: 'page', ids: ['a', 'b'], byPage: { other: ['c'] } }
  const before = structuredClone(state.data.items)
  const result = await alignSelection(controller, () => selection, 'left', async page => {
    assert.deepEqual(page.items.map(item => item._id), ['a', 'b'])
    return { rects, risks: [] }
  })
  assert.equal(result, 'applied'); assert.equal(state.undo.length, 1)
  const after = structuredClone(state.data.items)
  controller.undo('page'); assert.deepEqual(state.data.items, before)
  controller.undo('page', true); assert.deepEqual(state.data.items, after)
})

test('async no-op adds no history and inline text is finished before capturing the snapshot', async () => {
  const { alignSelection, controller, state, rects } = harness()
  let finished = false
  const session = controller.beginTextDraft('page', () => { finished = true; session.end() })
  const selection = { page: 'page', ids: ['a', 'b'] }
  const result = await alignSelection(controller, () => selection, 'left', async () => {
    assert.equal(finished, true)
    return { rects: { ...rects, b: [10, 0, 50, 20] }, risks: [] }
  })
  assert.equal(result, 'noop'); assert.equal(state.undo.length, 0)
})

for (const cause of ['version', 'selection', 'state', 'inline-draft']) test(`async ${cause} change rejects stale measurement without overwriting edits`, async () => {
  const { alignSelection, controller, state, rects } = harness()
  let selection = { page: 'page', ids: ['a', 'b'] }, resolve
  const pending = alignSelection(controller, () => selection, 'left', () => new Promise(done => { resolve = done }))
  if (cause === 'version') controller.edit('page', state.data.items.map(item => ({ ...item, text: 'new text' })))
  if (cause === 'selection') selection = { page: 'page', ids: ['a', 'c'] }
  if (cause === 'state') controller.pages.set('page', { ...state })
  if (cause === 'inline-draft') controller.beginTextDraft('page', () => {})
  const before = structuredClone(controller.pages.get('page').data.items), history = state.undo.length
  resolve({ rects, risks: [] })
  assert.equal(await pending, 'stale')
  assert.deepEqual(controller.pages.get('page').data.items, before); assert.equal(state.undo.length, history)
})
