const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const source = { exports: {} }
new Function('module', 'exports', ts.transpileModule(readFileSync(path.join(__dirname, '../src/prelayout/question-page-loader.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(source, source.exports)
const { loadQuestionPages, questionPriorityPageIds } = source.exports
const pageIds = ['one', 'two', 'three', 'four', 'five']
const deferred = () => {
  let resolve, reject
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve))

test('priorities cover middle, first, last, missing current and empty projects', () => {
  assert.deepEqual(questionPriorityPageIds(pageIds, 'three'), ['three', 'two', 'four'])
  assert.deepEqual(questionPriorityPageIds(pageIds, 'one'), ['one', 'two'])
  assert.deepEqual(questionPriorityPageIds(pageIds, 'five'), ['five', 'four'])
  assert.deepEqual(questionPriorityPageIds(pageIds, 'removed'), ['one', 'two'])
  assert.deepEqual(questionPriorityPageIds(pageIds), ['one', 'two'])
  assert.deepEqual(questionPriorityPageIds([], 'one'), [])
})

test('background waits for every priority page and priority notification, with one settled update', async () => {
  const reads = new Map(), events = []
  const run = loadQuestionPages({ pageIds, currentPageId: 'three', isActive: () => true,
    load: id => { events.push(`load:${id}`); const task = deferred(); reads.set(id, task); return task.promise },
    onBatch: (loaded, errors, priorityDone) => events.push({ loaded: [...loaded], errors: [...errors], priorityDone }),
  })
  assert.deepEqual(events, ['load:three', 'load:two', 'load:four'])
  reads.get('three').resolve('page-three'); reads.get('four').resolve('page-four')
  await nextTurn()
  assert.equal(events.length, 3)
  reads.get('two').resolve('page-two')
  await nextTurn()
  assert.deepEqual(events[3], { loaded: [['three', 'page-three'], ['two', 'page-two'], ['four', 'page-four']], errors: [], priorityDone: true })
  assert.deepEqual(events.slice(4), ['load:one', 'load:five'])
  reads.get('one').resolve('page-one'); reads.get('five').resolve('page-five')
  await run
  assert.equal(events.length, 7)
})

test('cached priority and background pages are delivered without fetching or mutating the cache', async () => {
  const cached = new Map([['two', { local: true }], ['five', { background: true }]])
  const loaded = [], batches = []
  await loadQuestionPages({ pageIds, currentPageId: 'three', cached, isActive: () => true,
    load: async id => { loaded.push(id); return { id } },
    onBatch: (pages, errors, ready) => batches.push({ pages, errors, ready }),
  })
  assert.deepEqual(loaded, ['three', 'four', 'one'])
  assert.equal(batches[0].pages.get('two'), cached.get('two'))
  assert.equal(batches[1].pages.get('five'), cached.get('five'))
  assert.equal(cached.size, 2)
  assert.ok(batches.every(batch => batch.ready && batch.errors.size === 0))
})

test('failed priority pages settle the barrier and background failures do not stop later batches', async () => {
  const ids = Array.from({ length: 16 }, (_, index) => String(index)), batches = [], requested = []
  await loadQuestionPages({ pageIds: ids, currentPageId: '7', isActive: () => true,
    load: async id => { requested.push(id); if (id === '7') throw new Error('priority failed'); if (id === '0') throw 'background failed'; return id },
    onBatch: (pages, errors, ready) => batches.push({ pages, errors, ready }),
  })
  assert.deepEqual(requested.slice(0, 3), ['7', '6', '8'])
  assert.deepEqual([...batches[0].errors], [['7', 'priority failed']])
  assert.equal(batches[1].errors.get('0'), 'background failed')
  assert.equal(batches.at(-1).pages.get('15'), '15')
  assert.equal(requested.length, 16)
})

test('empty projects still notify that initial positioning is ready', async () => {
  const batches = []
  await loadQuestionPages({ pageIds: [], load: async () => assert.fail('no page should load'), isActive: () => true,
    onBatch: (pages, errors, ready) => batches.push([pages.size, errors.size, ready]),
  })
  assert.deepEqual(batches, [[0, 0, true]])
})

test('cancellation before loading does nothing and during priority suppresses all updates and background reads', async () => {
  let active = false, called = 0
  const options = { pageIds, currentPageId: 'three', isActive: () => active,
    load: async () => { called++; return 'page' }, onBatch: () => assert.fail('cancelled update'),
  }
  await loadQuestionPages(options)
  assert.equal(called, 0)
  active = true
  const pending = deferred(), requested = []
  const run = loadQuestionPages({ ...options, load: id => { requested.push(id); return pending.promise } })
  active = false; pending.resolve('page')
  await run
  assert.deepEqual(requested, ['three', 'two', 'four'])
})

test('cancellation at the priority update prevents starting the background', async () => {
  let active = true
  const requested = []
  await loadQuestionPages({ pageIds, currentPageId: 'three', isActive: () => active,
    load: async id => { requested.push(id); return id }, onBatch: () => { active = false },
  })
  assert.deepEqual(requested, ['three', 'two', 'four'])
})

test('cancelling an in-flight background batch suppresses its update and all later batches', async () => {
  const ids = Array.from({ length: 18 }, (_, index) => String(index)), pending = deferred(), requested = []
  let active = true, notifications = 0
  const run = loadQuestionPages({ pageIds: ids, currentPageId: '8', isActive: () => active,
    load: async id => { requested.push(id); if (['8', '7', '9'].includes(id)) return id; return pending.promise },
    onBatch: () => { notifications++ },
  })
  await nextTurn()
  assert.equal(requested.length, 9)
  assert.equal(notifications, 1)
  active = false; pending.resolve('page')
  await run
  assert.equal(requested.length, 9)
  assert.equal(notifications, 1)
})

test('background batches never exceed six concurrent reads or six delivered pages and duplicate ids load once', async () => {
  const ids = Array.from({ length: 23 }, (_, index) => String(index)), batches = []
  let pending = 0, maximum = 0, requests = 0
  await loadQuestionPages({ pageIds: [...ids, '5'], currentPageId: '10', isActive: () => true,
    load: async id => {
      requests++; pending++; maximum = Math.max(maximum, pending)
      await nextTurn(); pending--; return id
    },
    onBatch: (pages, errors) => { assert.equal(pending, 0); batches.push(pages.size + errors.size) },
  })
  assert.equal(maximum, 6)
  assert.equal(requests, ids.length)
  assert.deepEqual(batches, [3, 6, 6, 6, 2])
})
