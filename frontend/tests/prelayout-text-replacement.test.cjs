const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function storage() {
  const data = new Map()
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key), data }
}
const response = value => ({ ok: true, json: async () => value })
const failed = (status, message) => ({ ok: false, status, json: async () => ({ detail: message }) })
function harness(fetch) {
  const cache = new Map()
  let operation = 0
  const environment = { fetch, indexedDB: { open: () => ({}) }, performance: { now: () => 0 },
    crypto: { randomUUID: () => `operation-${++operation}` }, setTimeout: () => 1, clearTimeout: () => {} }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', ...Object.keys(environment), code)(name => load(path.resolve(path.dirname(file), `${name}.ts`)),
      module, module.exports, ...Object.values(environment))
    return module.exports
  }
  return {
    ...load(path.resolve(__dirname, '../src/prelayout/text-replacement.ts')),
    ...load(path.resolve(__dirname, '../src/prelayout/editor-state.ts')),
  }
}
const match = { page_id: 'page-a', item_id: 'text-a', before: '甲甲', after: '乙乙', occurrences: 2, page_number: 1, page_name: '1.png' }
const preview = { project_revision: 5, matches: [match], summary: { pages: 1, items: 1, occurrences: 2 } }

test('preview only sends literal query, while apply sends exactly the selected stable IDs', async () => {
  const calls = []
  const { TextReplacementClient } = harness(async (url, init) => { calls.push({ url, payload: JSON.parse(init.body) }); return response(url.endsWith('/preview') ? preview : { project: {}, summary: preview.summary }) })
  const client = new TextReplacementClient('project-a', storage())
  await client.preview('甲', '$1\\n')
  await client.apply(preview, '甲', '$1\\n', [match])
  assert.deepEqual(calls[0].payload, { find: '甲', replacement: '$1\\n' })
  assert.deepEqual(calls[1].payload, { find: '甲', replacement: '$1\\n', expected_revision: 5, selected: [{ page_id: 'page-a', item_id: 'text-a' }], operation_id: 'operation-1' })
  assert.equal(client.pending, null)
})

test('an unknown apply outcome survives refresh and retries with the exact same operation ID', async () => {
  const local = storage(), sent = []
  const { TextReplacementClient } = harness(async (_url, init) => {
    sent.push(JSON.parse(init.body))
    if (sent.length === 1) throw new TypeError('connection lost after server commit')
    return response({ project: { revision: 6 }, summary: preview.summary })
  })
  const client = new TextReplacementClient('project-a', local)
  await assert.rejects(client.apply(preview, '甲', '乙', [match]), /connection lost/)
  assert(client.pending)
  assert.throws(() => client.preview('丙', '丁'), /先重試/)
  const restored = new TextReplacementClient('project-a', local)
  assert.equal(restored.pending.payload.operation_id, 'operation-1')
  await restored.retry()
  assert.deepEqual(sent[1], sent[0])
  assert.equal(restored.pending, null); assert.equal(local.data.size, 0)
})

test('a rejected stale preview can be replaced by a fresh request with a new operation ID', async () => {
  const local = storage(), sent = []
  const { TextReplacementClient } = harness(async (_url, init) => {
    sent.push(JSON.parse(init.body))
    return sent.length === 1 ? failed(409, 'preview expired') : response({ project: {}, summary: preview.summary })
  })
  const client = new TextReplacementClient('project-a', local)
  await assert.rejects(client.apply(preview, '甲', '乙', [match]), /expired/)
  assert.equal(client.pending, null)
  await client.apply({ ...preview, project_revision: 8 }, '甲', '乙', [match])
  assert.notEqual(sent[1].operation_id, sent[0].operation_id)
  assert.equal(sent[1].expected_revision, 8)
})

test('undo network retries retain their ID and do not fall back to a new apply request', async () => {
  const local = storage(), sent = []
  const { TextReplacementClient } = harness(async (url, init) => {
    sent.push({ url, payload: JSON.parse(init.body) })
    return sent.length === 1 ? failed(503, 'temporarily unavailable') : response({ project: {}, summary: preview.summary })
  })
  const client = new TextReplacementClient('project-a', local)
  await assert.rejects(client.undo({ operation_id: 'applied-batch', summary: preview.summary }, 10), /unavailable/)
  const restored = new TextReplacementClient('project-a', local)
  await restored.retry()
  assert.deepEqual(sent[1], sent[0]); assert(sent[0].url.endsWith('/undo'))
})

test('a request is not sent if its retry record cannot be persisted', async () => {
  const { TextReplacementClient } = harness(() => assert.fail('must not send'))
  const client = new TextReplacementClient('project-a', { getItem: () => null, setItem: () => { throw new Error('storage full') }, removeItem: () => {} })
  await assert.rejects(client.apply(preview, '甲', '乙', [match]), /storage full/)
  assert.equal(client.pending, null)
})

test('unavailable storage does not prevent opening the editor, but still prevents an unrecorded mutation', async () => {
  const { TextReplacementClient } = harness(() => assert.fail('must not send'))
  const unavailable = () => { throw new Error('storage unavailable') }
  const client = new TextReplacementClient('project-a', { getItem: unavailable, setItem: unavailable, removeItem: unavailable })
  assert.equal(client.pending, null)
  await assert.rejects(client.apply(preview, '甲', '乙', [match]), /storage unavailable/)
  assert.doesNotThrow(() => new TextReplacementClient('project-a', { getItem: () => 'invalid', setItem: unavailable, removeItem: unavailable }))
})

function pageState(id, revision, text) {
  return { data: { id, revision, reviewed_revision: revision, items: [{ _id: `text-${id}`, text, x: .6 }], measure: [] },
    undo: [[{ text: 'old snapshot' }]], redo: [[{ text: 'old redo' }]], version: 0, dirty: false, saving: false, conflict: false, error: '' }
}
test('remote replacement refreshes only cached changed pages and cannot reuse stale per-page undo', async () => {
  const calls = []
  const { EditorState } = harness(async url => {
    calls.push(url); return response({ id: 'page-a', revision: 4, items: [{ _id: 'text-page-a', text: '乙', x: .6 }], measure: [] })
  })
  const controller = new EditorState('project-a')
  controller.persist = () => {}
  const changed = pageState('page-a', 3, '甲'), untouched = pageState('page-b', 2, '丙')
  controller.pages.set('page-a', changed); controller.pages.set('page-b', untouched)
  await controller.acceptTextReplacement({ id: 'project-a', pages: [{ id: 'page-a', revision: 4 }, { id: 'page-b', revision: 2 }, { id: 'never-opened', revision: 5 }] })
  assert.equal(calls.length, 1); assert(calls[0].endsWith('/pages/page-a'))
  assert.equal(changed.data.items[0].text, '乙'); assert.equal(changed.data.items[0].x, .6)
  assert.equal(changed.data.reviewed_revision, undefined); assert.deepEqual(changed.undo, []); assert.deepEqual(changed.redo, [])
  assert.equal(untouched.data.items[0].text, '丙'); assert.equal(untouched.undo.length, 1)
  assert(!controller.pages.has('never-opened'))
  controller.dispose()
})

test('a local edit during remote refresh is preserved and rejects all cached updates', async () => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const { EditorState } = harness(() => pending)
  const controller = new EditorState('project-a'); controller.persist = () => {}
  const state = pageState('page-a', 3, '甲'); controller.pages.set('page-a', state)
  const updating = controller.acceptTextReplacement({ id: 'project-a', pages: [{ id: 'page-a', revision: 4 }] })
  controller.edit('page-a', [{ ...state.data.items[0], text: 'local edit' }])
  resolve(response({ ...state.data, revision: 4, items: [{ text: 'remote text' }] }))
  await assert.rejects(updating, /載入期間文字已有修改/)
  assert.equal(state.data.items[0].text, 'local edit'); assert.equal(state.data.revision, 3)
  controller.dispose()
})
