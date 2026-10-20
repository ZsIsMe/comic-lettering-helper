const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function harness(fetch = () => assert.fail('History edits must not fetch immediately')) {
  const cache = new Map(), timers = new Map()
  let timer = 0, operation = 0
  const environment = {
    indexedDB: { open: () => ({}) }, performance: { now: () => 0 }, fetch,
    crypto: { randomUUID: () => `operation-${++operation}` },
    setTimeout: callback => { timers.set(++timer, callback); return timer }, clearTimeout: id => timers.delete(id),
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', ...Object.keys(environment), code)(name => load(path.resolve(path.dirname(file), `${name}.ts`)), module, module.exports, ...Object.values(environment))
    return module.exports
  }
  const { EditorState } = load(path.resolve(__dirname, '../src/prelayout/editor-state.ts'))
  const controller = new EditorState('batch-test')
  // IndexedDB persistence is orthogonal to transaction history; keep it offline.
  controller.persist = () => {}
  for (const id of ['a', 'b', 'c']) controller.pages.set(id, {
    data: { id, revision: 3, reviewed_revision: 3, items: [{ _id: id, text: id, 'font-size': 24 }], measure: [] },
    undo: [], redo: [], dirty: false, version: 0, error: '', saving: false, conflict: false,
  })
  const state = id => controller.pages.get(id)
  const items = (id, size) => state(id).data.items.map(item => ({ ...item, 'font-size': size }))
  const size = id => state(id).data.items[0]['font-size']
  const batch = (ids, value) => controller.editBatch(new Map(ids.map(id => [id, items(id, value)])))
  return { controller, state, items, size, batch, timers }
}
const response = data => ({ ok: true, json: async () => data })

test('cross-page edits, undo and redo update every page before notifying subscribers', () => {
  const { controller, state, size, batch, timers } = harness()
  const observed = []
  controller.subscribe('*', () => observed.push([size('a'), size('b')]))
  batch(['a', 'b'], 30)
  assert(observed.every(values => values[0] === 30 && values[1] === 30))
  assert.equal(state('a').data.reviewed_revision, undefined)
  assert.equal(state('b').data.reviewed_revision, undefined)
  assert.equal(state('c').data.reviewed_revision, 3)
  assert.equal(timers.size, 2)
  observed.length = 0; controller.undo('b')
  assert.deepEqual([size('a'), size('b')], [24, 24])
  assert(observed.every(values => values[0] === 24 && values[1] === 24))
  controller.undo('a', true)
  assert.deepEqual([size('a'), size('b')], [30, 30])
  for (const id of ['a', 'b']) {
    assert.equal(state(id).undo.length, 1); assert.equal(state(id).redo.length, 0)
    assert.equal(state(id).data.revision, 3); assert.equal(state(id).version, 3)
  }
  controller.dispose()
})

test('undo a batch first unwinds a later edit on another member page', () => {
  const { controller, state, items, size, batch } = harness()
  batch(['a', 'b'], 30); controller.edit('b', items('b', 40))
  controller.undo('a')
  assert.deepEqual([size('a'), size('b')], [30, 30], 'The later single-page edit is undone first')
  assert.equal(state('a').undo.length, 1)
  controller.undo('a'); assert.deepEqual([size('a'), size('b')], [24, 24])
  controller.undo('b', true); assert.deepEqual([size('a'), size('b')], [30, 30])
  controller.undo('b', true); assert.deepEqual([size('a'), size('b')], [30, 40])
  controller.dispose()
})

test('overlapping batches retain their transaction boundaries', () => {
  const { controller, size, batch } = harness()
  batch(['a', 'b'], 30); batch(['b', 'c'], 40)
  controller.undo('a'); assert.deepEqual(['a', 'b', 'c'].map(size), [30, 30, 24])
  controller.undo('a'); assert.deepEqual(['a', 'b', 'c'].map(size), [24, 24, 24])
  controller.undo('c', true); assert.deepEqual(['a', 'b', 'c'].map(size), [30, 30, 24], 'Earlier batch must redo first')
  controller.undo('c', true); assert.deepEqual(['a', 'b', 'c'].map(size), [30, 40, 40])
  controller.dispose()
})

test('redo a batch first restores an earlier single-page prerequisite', () => {
  const { controller, items, size, batch } = harness()
  controller.edit('a', items('a', 26)); batch(['a', 'b'], 30)
  controller.undo('b'); controller.undo('a')
  controller.undo('b', true); assert.deepEqual([size('a'), size('b')], [26, 24])
  controller.undo('b', true); assert.deepEqual([size('a'), size('b')], [30, 30])
  controller.dispose()
})

test('a new edit invalidates the whole linked redo branch, including later snapshots', () => {
  const { controller, state, items, size, batch } = harness()
  batch(['a', 'b'], 30); controller.edit('b', items('b', 40)); batch(['b', 'c'], 50)
  controller.undo('c'); controller.undo('b'); controller.undo('a')
  controller.edit('a', items('a', 28))
  for (const id of ['a', 'b', 'c']) assert.equal(state(id).redo.length, 0)
  controller.undo('b', true); assert.deepEqual(['a', 'b', 'c'].map(size), [28, 24, 24])
  controller.dispose()
})

test('batch validation is all-or-nothing and no-op edits create no history', () => {
  const { controller, state, items, size } = harness()
  assert.throws(() => controller.editBatch(new Map([['a', items('a', 30)], ['not-loaded', []]])), /先載入/)
  assert.equal(size('a'), 24); assert.equal(state('a').undo.length, 0); assert.equal(controller.dirty, false)
  controller.editBatch(new Map([['a', items('a', 24)]]))
  assert.equal(state('a').undo.length, 0); assert.equal(controller.dirty, false)
  const input = items('a', 30)
  controller.editBatch(new Map([['a', input]])); input[0]['font-size'] = 99
  assert.equal(size('a'), 30)
  controller.dispose()
})

test('batch edits end held-key undo groups on each affected page', () => {
  const { controller, state, items, size, batch } = harness()
  controller.edit('a', items('a', 26), true, 'font', true)
  batch(['a', 'b'], 30)
  controller.edit('a', items('a', 32), true, 'font', true)
  assert.equal(state('a').undo.length, 3)
  controller.undo('a'); assert.deepEqual([size('a'), size('b')], [30, 30])
  controller.undo('a'); assert.deepEqual([size('a'), size('b')], [26, 24])
  controller.dispose()
})

test('history trimming creates a barrier on other batch pages instead of skipping the batch', () => {
  const { controller, state, items, size, batch } = harness()
  controller.edit('b', items('b', 26)); batch(['a', 'b'], 30)
  for (let step = 0; step < 100; step++) controller.edit('a', items('a', 31 + step))
  assert.equal(state('a').undo.length, 100); assert.equal(state('b').undo.length, 0)
  controller.undo('b'); assert.equal(size('b'), 30)
  controller.dispose()
})

test('a remote text replacement invalidates linked stale history while retaining later unrelated edits', async () => {
  const { controller, state, items, size, batch } = harness(async () => response({ id: 'a', revision: 4, items: [{ _id: 'a', text: 'replacement', 'font-size': 30 }], measure: [] }))
  controller.edit('b', items('b', 26)); batch(['a', 'b'], 30); controller.edit('b', items('b', 40))
  for (const page of controller.pages.values()) page.dirty = false
  await controller.acceptTextReplacement({ id: 'batch-test', pages: [{ id: 'a', revision: 4 }] })
  assert.equal(state('a').undo.length, 0); assert.equal(state('b').undo.length, 1)
  controller.undo('b'); assert.equal(size('b'), 30)
  controller.undo('b'); assert.equal(size('b'), 30, 'Cannot undo past the discarded batch')
  assert.equal(state('a').data.items[0].text, 'replacement')
  controller.dispose()
})

test('each page still saves with its own revision and retains its own conflict', async () => {
  const calls = []
  const fixture = harness(async (url, options) => {
    const sent = JSON.parse(options.body); calls.push({ url, sent })
    if (url.includes('/pages/b/')) return { ok: false, status: 409, json: async () => ({ detail: 'conflict' }) }
    return response({ ...fixture.state('a').data, revision: 4 })
  })
  const { controller, state, batch } = fixture
  batch(['a', 'b'], 30)
  assert.equal(await controller.save('a'), true); assert.equal(await controller.save('b'), false)
  assert.equal(state('a').dirty, false); assert.equal(state('a').data.revision, 4)
  assert.equal(state('b').dirty, true); assert.equal(state('b').conflict, true); assert.equal(state('b').data.revision, 3)
  assert(calls.every(call => call.sent.expected_revision === 3))
  assert.notEqual(calls[0].sent.operation_id, calls[1].sent.operation_id)
  controller.undo('a')
  assert.equal(state('a').dirty, true); assert.equal(state('b').conflict, true)
  controller.dispose()
})
