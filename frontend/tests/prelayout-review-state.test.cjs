const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function harness(fetch) {
  const cache = new Map(), timers = new Map()
  let nextTimer = 0
  const environment = {
    indexedDB: { open: () => ({}) }, crypto: { randomUUID: () => 'operation-1' }, performance: { now: () => 0 }, fetch,
    setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', ...Object.keys(environment), code)(name => {
      assert(name.startsWith('./'))
      return load(path.resolve(path.dirname(file), `${name}.ts`))
    }, module, module.exports, ...Object.values(environment))
    return module.exports
  }
  const { EditorState } = load(path.resolve(__dirname, '../src/prelayout/editor-state.ts'))
  const controller = new EditorState('review-test')
  const item = { _id: 'text-a', text: '甲乙', x: .5, y: .5, 'font-size': 32, orientation: 'vertical', rotation: 0, color: '#000', 'stroke-color': '#fff', 'stroke-weight': 0 }
  const state = { data: { id: 'page-a', width: 100, height: 100, revision: 3, reviewed_revision: 3, sha256: 'sha', clean: null, items: [item], measure: [] },
    undo: [], redo: [], dirty: false, version: 0, error: '', saving: false, conflict: false }
  controller.pages.set('page-a', state)
  return { controller, state, timers }
}
const response = data => ({ ok: true, json: async () => data })

test('an edit invalidates page completion immediately', () => {
  const { controller, state } = harness(() => assert.fail('Edit should not fetch immediately'))
  controller.edit('page-a', [{ ...state.data.items[0], x: .6 }])
  assert.equal(state.data.reviewed_revision, undefined)
  assert.equal(state.dirty, true)
  controller.dispose()
})

test('markReviewed records the current saved revision', async () => {
  const calls = []
  const { controller, state } = harness(async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) })
    return response({ ...state.data, reviewed_revision: 3 })
  })
  await controller.markReviewed('page-a', true)
  assert.equal(state.data.reviewed_revision, 3)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].body.expected_revision, 3)
  assert.equal(calls[0].body.reviewed, true)
  controller.dispose()
})

test('a concurrent edit never receives an older review response marker', async () => {
  const pending = deferred()
  const { controller, state } = harness(() => pending.promise)
  const marking = controller.markReviewed('page-a', true)
  await Promise.resolve()
  controller.edit('page-a', [{ ...state.data.items[0], text: '甲\n乙' }])
  pending.resolve(response({ ...state.data, reviewed_revision: 3 }))
  await assert.rejects(marking, /保存期間文字已有修改/)
  assert.equal(state.data.reviewed_revision, undefined)
  assert.equal(state.dirty, true)
  assert.equal(state.data.items[0].text, '甲\n乙')
  controller.dispose()
})

test('a concurrent edit during autosave retains the newer local draft', async () => {
  const pending = deferred()
  const { controller, state } = harness(() => pending.promise)
  controller.edit('page-a', [{ ...state.data.items[0], text: '甲\n乙' }])
  const saving = controller.save('page-a')
  controller.edit('page-a', [{ ...state.data.items[0], text: '甲乙' }])
  pending.resolve(response({ ...state.data, revision: 4, items: [{ ...state.data.items[0], text: '甲\n乙' }] }))
  assert.equal(await saving, true)
  assert.equal(state.data.revision, 4)
  assert.equal(state.data.items[0].text, '甲乙')
  assert.equal(state.dirty, true)
  assert.equal(state.data.reviewed_revision, undefined)
  controller.dispose()
})
