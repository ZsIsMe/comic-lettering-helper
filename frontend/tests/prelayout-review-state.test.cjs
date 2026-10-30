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
function harness(fetch, withHost = false, measure = async () => ({ risks: [], rects: {} })) {
  const cache = new Map(), timers = new Map()
  let nextTimer = 0, clock = 0, host, options
  const environment = {
    indexedDB: { open: () => ({}) }, crypto: { randomUUID: () => 'operation-1' }, performance: { now: () => 0 }, fetch,
    setTimeout: (callback, delay) => { const id = ++nextTimer; if (withHost && delay === 25) queueMicrotask(callback); else timers.set(id, { callback, delay }); return id },
    clearTimeout: id => timers.delete(id),
    window: { location: { hash: '#/prelayout' } },
    Date: { now: () => clock += 250 },
    document: { activeElement: null, querySelectorAll: selector => selector.includes('.pl-page') ? [{
      dataset: { page: options.current }, getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      querySelectorAll: () => [{ complete: true, naturalWidth: 100, dataset: { previewReady: 'true' }, decode: async () => {} }],
    }] : [] },
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
  if (withHost) {
    const next = structuredClone(state); next.data.id = 'page-b'; controller.pages.set('page-b', next)
    options = { controller, current: 'page-a', project: { id: controller.project, pages: [state.data, next.data] }, range: [1, 2],
      busy: false, fontReady: true, interacting: { current: false }, compare: false, difference: false, showText: true,
      differenceColor: '#ffff00', differenceOpacity: .5, zoom: 1, focus: false, clean: false,
      refreshProject: async () => {}, go: id => { options.current = id } }
    const code = ts.transpileModule(readFileSync(path.resolve(__dirname, '../src/prelayout/usePrelayoutAgent.tsx'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const module = { exports: {} }
    new Function('require', 'module', 'exports', ...Object.keys(environment), code)(name => {
      if (name === 'react') return { useEffect: fn => fn(), useLayoutEffect: fn => fn(), useRef: current => ({ current }), useState: initial => [initial, () => {}] }
      if (name === 'react/jsx-runtime') return { jsx: () => null }
      if (name === './webmcp') return { registerPrelayoutTools: value => { host = value; return () => {} } }
      if (name === './layout-review') return { measurePage: measure }
      if (name === './LayoutReview') return { LayoutReview: () => null }
      return load(path.resolve(__dirname, '../src/prelayout', `${name}.ts`))
    }, module, module.exports, ...Object.values(environment))
    module.exports.usePrelayoutAgent(options)
  }
  return { controller, state, timers, host, options }
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

const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve() }
const addSecondPage = (controller, state) => {
  const next = structuredClone(state); next.data.id = 'page-b'; controller.pages.set('page-b', next); return next
}

test('background save registers pending immediately and flush waits for both PATCH and review', async () => {
  const patch = deferred(), review = deferred(), calls = []
  const { controller, state } = harness((url, options) => { calls.push([url, JSON.parse(options.body)]); return url.endsWith('/text') ? patch.promise : review.promise })
  controller.edit('page-a', [{ ...state.data.items[0], x: .6 }])
  const task = controller.startSave('page-a', true)
  assert.equal(task.status, 'pending')
  assert.equal(controller.saveStatus.pending_saves[0].page_id, 'page-a')
  assert.equal(controller.dirty, true)
  let flushed = false
  const flushing = controller.flush().then(value => { flushed = true; return value })
  await settle()
  assert.equal(flushed, false)
  patch.resolve(response({ ...state.data, revision: 4 }))
  await settle()
  assert.equal(state.dirty, false)
  assert.equal(controller.dirty, true, 'completion marker remains unsaved')
  assert.equal(flushed, false)
  assert.equal(calls[1][1].expected_revision, 4)
  review.resolve(response({ ...state.data, reviewed_revision: 4 }))
  assert.equal(await flushing, true)
  assert.equal(task.status, 'saved')
  assert.equal(controller.dirty, false)
  controller.dispose()
})

test('flush also joins another page task registered while the first PATCH is pending', async () => {
  const a = deferred(), b = deferred(), review = deferred()
  const { controller, state } = harness(url => url.includes('page-a') ? a.promise : url.endsWith('/text') ? b.promise : review.promise)
  const next = addSecondPage(controller, state)
  controller.edit('page-a', [{ ...state.data.items[0], x: .6 }])
  controller.startSave('page-a')
  let done = false
  const flushing = controller.flush().then(value => { done = true; return value })
  await settle()
  controller.edit('page-b', [{ ...next.data.items[0], x: .7 }])
  controller.startSave('page-b', true)
  a.resolve(response({ ...state.data, revision: 4 }))
  await settle(); assert.equal(done, false)
  b.resolve(response({ ...next.data, revision: 4 }))
  await settle(); assert.equal(done, false)
  review.resolve(response({ ...next.data, reviewed_revision: 4 }))
  assert.equal(await flushing, true)
  assert.equal(controller.dirty, false)
  controller.dispose()
})

test('transport failure retains draft and operation ID, and an explicit flush retries it', async () => {
  let attempts = 0
  const calls = []
  const { controller, state } = harness(async (url, options) => {
    calls.push(JSON.parse(options.body))
    if (!attempts++) throw new Error('network unavailable')
    return response({ ...state.data, revision: 4 })
  })
  controller.edit('page-a', [{ ...state.data.items[0], x: .6 }])
  const task = controller.startSave('page-a')
  assert.equal(await task.promise, false)
  assert.equal(task.status, 'failed')
  assert.equal(state.dirty, true)
  assert.equal(controller.dirty, true)
  assert.match(controller.saveStatus.save_failures[0].error, /network unavailable/)
  assert.equal(await controller.flush(), true)
  assert.equal(calls[1].operation_id, calls[0].operation_id)
  assert.equal(calls[1].expected_revision, calls[0].expected_revision)
  assert.equal(controller.dirty, false)
  controller.dispose()
})

test('failed completion stays globally dirty even after text is saved and retries on flush', async () => {
  let reviews = 0
  const { controller, state } = harness(async () => {
    if (!reviews++) throw new Error('review disconnected')
    return response({ ...state.data, reviewed_revision: 3 })
  })
  assert.equal(await controller.startSave('page-a', true).promise, false)
  assert.equal(state.dirty, false)
  assert.equal(controller.dirty, true)
  assert.match(state.error, /review disconnected/)
  assert.equal(await controller.flush(), true)
  assert.equal(controller.saveStatus.status, 'saved')
  assert.equal(state.data.reviewed_revision, 3)
  controller.dispose()
})

test('omitting reviewed on a same-version retry preserves the failed completion intent', async () => {
  let attempts = 0
  const { controller, state } = harness(async () => {
    if (!attempts++) throw new Error('review disconnected')
    return response({ ...state.data, reviewed_revision: 3 })
  })
  assert.equal(await controller.startSave('page-a', true).promise, false)
  const retry = controller.startSave('page-a')
  assert.equal(retry.reviewed, true)
  assert.equal(await retry.promise, true)
  assert.equal(state.error, '')
  assert.equal(state.data.reviewed_revision, 3)
  assert.equal(controller.saveStatus.status, 'saved')
  controller.dispose()
})

test('409 blocks retry until explicit conflict resolution, then a fresh reviewed save can succeed', async () => {
  let calls = 0, resolved = false
  const { controller, state } = harness(async (url, options) => {
    calls++
    if (!resolved) return { ok: false, status: 409, json: async () => ({ detail: 'revision conflict' }) }
    if (!options) return response({ ...state.data, revision: 5 })
    const body = JSON.parse(options.body)
    assert.equal(body.expected_revision, url.endsWith('/review') ? 6 : 5)
    return response({ ...state.data, revision: 6, ...(url.endsWith('/review') ? { reviewed_revision: 6 } : {}) })
  })
  controller.edit('page-a', [{ ...state.data.items[0], x: .6 }])
  assert.equal(await controller.startSave('page-a', true).promise, false)
  assert.equal(state.conflict, true)
  assert.equal(state.pending.operation_id, 'operation-1')
  assert.equal(state.dirty, true)
  assert.equal(await controller.flush(), false)
  assert.equal(calls, 1)
  assert.equal(controller.saveStatus.save_failures.length, 1)
  resolved = true
  await controller.resolve('page-a', true)
  assert.equal(state.data.items[0].x, .6)
  assert.equal(state.conflict, false)
  assert.equal(await controller.startSave('page-a', true).promise, true)
  assert.equal(state.data.reviewed_revision, 6)
  assert.equal(controller.dirty, false)
  controller.dispose()
})

test('an edit during a background PATCH cannot mark the new draft reviewed, even on retry', async () => {
  const patch = deferred(), calls = []
  const { controller, state } = harness((url) => { calls.push(url); return patch.promise })
  controller.edit('page-a', [{ ...state.data.items[0], x: .6 }])
  const task = controller.startSave('page-a', true)
  await settle()
  controller.edit('page-a', [{ ...state.data.items[0], x: .7 }])
  patch.resolve(response({ ...state.data, revision: 4, items: [{ ...state.data.items[0], x: .6 }] }))
  assert.equal(await task.promise, false)
  assert.equal(calls.length, 1)
  assert.equal(state.data.items[0].x, .7)
  assert.equal(state.data.reviewed_revision, undefined)
  assert.equal(await controller.flush(), false)
  assert.equal(calls.length, 1, 'stale review is never retried against the new version')
  assert.equal(controller.saveStatus.save_failures.length, 1)
  assert.throws(() => controller.startSave('page-a'), /明確指定 reviewed/)
  controller.dispose()
})

test('WebMCP nonblocking save navigates while PATCH is unresolved and inspect reports cross-page failure', async () => {
  const patch = deferred()
  const { controller, state, host, options } = harness(() => patch.promise, true)
  controller.edit('page-a', [{ ...state.data.items[0], x: .6 }])
  const token = (await host.inspect()).token
  const result = await host.save({ token, reviewed: true, wait: false, next_page_id: 'page-b' })
  assert.equal(options.current, 'page-b')
  assert.equal(result.page_id, 'page-b')
  assert.equal(result.status, 'pending')
  assert.equal(result.saved_page_status, 'pending')
  assert.equal(result.pending_saves[0].page_id, 'page-a')
  patch.resolve({ ok: false, status: 409, json: async () => ({ detail: 'remote changed' }) })
  await settle()
  const failed = await host.inspect()
  assert.equal(failed.status, 'failed')
  assert.equal(failed.save_failures[0].page_id, 'page-a')
  await assert.rejects(host.patch({ token: failed.token, patches: [] }), /保存錯誤或衝突/)
  controller.dispose()
})

test('WebMCP default save waits for PATCH and review, and background completion preserves current token', async () => {
  const patch = deferred(), review = deferred()
  const { controller, state, host } = harness(url => url.endsWith('/text') ? patch.promise : review.promise, true)
  controller.edit('page-a', [{ ...state.data.items[0], x: .6 }])
  const initial = await host.inspect()
  let returned = false
  const saving = host.save({ token: initial.token, reviewed: true }).then(value => { returned = true; return value })
  await settle(); assert.equal(returned, false)
  patch.resolve(response({ ...state.data, revision: 4 }))
  await settle(); assert.equal(returned, false)
  review.resolve(response({ ...state.data, reviewed_revision: 4 }))
  const saved = await saving
  assert.equal(saved.status, 'saved')
  assert.equal(saved.token, initial.token)
  assert.equal(saved.reviewed, true)
  controller.dispose()
})

test('WebMCP rejects ambiguous or out-of-range next navigation and requires waiting on final page', async () => {
  const { controller, host, options } = harness(() => assert.fail('invalid calls must not write'), true)
  let token = (await host.inspect()).token
  await assert.rejects(host.save({ token, wait: false, advance: true }), /明確的 next_page_id/)
  await assert.rejects(host.save({ token, advance: true, next_page_id: 'page-b' }), /不可與 next_page_id/)
  await assert.rejects(host.save({ token, wait: false, next_page_id: 'missing' }), /不存在或不在校對範圍/)
  options.current = 'page-b'
  token = (await host.inspect()).token
  await assert.rejects(host.save({ token, wait: false }), /最後一頁必須等待/)
  controller.dispose()
})


test('inspect uses a coherent current snapshot when background PATCH finishes during measurement', async () => {
  const patch = deferred(), measuring = deferred()
  const { controller, state, host } = harness(() => patch.promise, true, () => measuring.promise)
  controller.edit('page-a', [{ ...state.data.items[0], x: .6 }])
  const saving = controller.startSave('page-a')
  const inspecting = host.inspect()
  await settle()
  patch.resolve(response({ ...state.data, revision: 4 }))
  assert.equal(await saving.promise, true)
  measuring.resolve({ risks: [], rects: {} })
  const inspected = await inspecting
  assert.equal(inspected.revision, 4)
  assert.equal(inspected.dirty, false)
  assert.equal(inspected.saving, false)
  assert.equal(inspected.status, 'saved')
  controller.dispose()
})

test('inspect uses the new completion marker when background review finishes during measurement', async () => {
  const review = deferred(), measuring = deferred()
  const { controller, state, host } = harness(() => review.promise, true, () => measuring.promise)
  delete state.data.reviewed_revision
  const saving = controller.startSave('page-a', true)
  await settle()
  const inspecting = host.inspect()
  await settle()
  review.resolve(response({ ...state.data, reviewed_revision: 3 }))
  assert.equal(await saving.promise, true)
  measuring.resolve({ risks: [], rects: {} })
  const inspected = await inspecting
  assert.equal(inspected.reviewed, true)
  assert.equal(inspected.saving, false)
  assert.equal(inspected.status, 'saved')
  assert.equal(inspected.pages[0].reviewed, true)
  controller.dispose()
})

test('a snapshot-only save reports newer dirty edits as pending instead of saved', async () => {
  const patch = deferred(), measuring = deferred()
  let measurements = 0
  const { controller, state, host } = harness(() => patch.promise, true, () => ++measurements === 1 ? Promise.resolve({ risks: [], rects: {} }) : measuring.promise)
  controller.edit('page-a', [{ ...state.data.items[0], x: .6 }])
  const token = (await host.inspect()).token
  const saving = host.save({ token, wait: false, next_page_id: 'page-b' })
  await settle()
  controller.edit('page-a', [{ ...state.data.items[0], x: .7 }])
  patch.resolve(response({ ...state.data, revision: 4, items: [{ ...state.data.items[0], x: .6 }] }))
  await settle()
  measuring.resolve({ risks: [], rects: {} })
  const result = await saving
  assert.equal(result.saved_page_version, 1)
  assert.equal(result.saved_page_dirty, true)
  assert.equal(result.saved_page_status, 'pending')
  assert.equal(result.status, 'pending')
  controller.dispose()
})
