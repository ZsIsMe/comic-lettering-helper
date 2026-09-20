import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = ts.transpileModule(await readFile(new URL('../src/raster-worker-scheduler.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { createRasterScheduler } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
const render = (id, previewOnly = false) => ({ id, type: 'render', payload: { previewOnly } })
const tick = () => new Promise(resolve => setTimeout(resolve, 2))
async function until(predicate) {
  const deadline = Date.now() + 1000
  while (!predicate() && Date.now() < deadline) await tick()
  assert.ok(predicate(), 'scheduler completed within deadline')
}

test('document renders outrank previews, and each channel only retains its latest request', async () => {
  const ran = [], cancelled = []
  const enqueue = createRasterScheduler(async request => { ran.push(request.id) }, request => cancelled.push(request.id))
  enqueue(render(1, true)); enqueue(render(2)); enqueue(render(3, true)); enqueue(render(4))
  await until(() => ran.length === 2)
  assert.deepEqual(ran, [4, 3])
  assert.deepEqual(cancelled, [1, 2])
})

test('edits discard stale queued renders without dropping or reordering commands', async () => {
  const ran = [], cancelled = []
  const enqueue = createRasterScheduler(async request => { ran.push(request.id) }, request => cancelled.push(request.id))
  enqueue(render(1, true)); enqueue(render(2))
  enqueue({ id: 3, type: 'undo' }); enqueue({ id: 4, type: 'redo' }); enqueue(render(5))
  await until(() => ran.length === 3)
  assert.deepEqual(ran, [3, 4, 5]); assert.deepEqual(cancelled, [2, 1])
})

test('snapshot encoding is a FIFO barrier and queued edits run before preview after it', async () => {
  const ran = [], cancelled = []
  let finishSnapshot
  const encode = new Promise(resolve => { finishSnapshot = resolve })
  const enqueue = createRasterScheduler(async request => {
    ran.push(request.id)
    if (request.type === 'snapshot') await encode
  }, request => cancelled.push(request.id))
  enqueue({ id: 1, type: 'snapshot' })
  await until(() => ran.length === 1)
  enqueue(render(2, true)); enqueue({ id: 3, type: 'undo' }); enqueue(render(4))
  await tick(); assert.deepEqual(ran, [1]); assert.deepEqual(cancelled, [2])
  finishSnapshot()
  await until(() => ran.length === 3)
  assert.deepEqual(ran, [1, 3, 4])
})

test('late cancellation of an older hover cannot cancel a newer preview or a document frame', async () => {
  const ran = [], cancelled = []
  const enqueue = createRasterScheduler(async request => { ran.push(request.id) }, request => cancelled.push(request.id))
  enqueue(render(1, true)); enqueue(render(2, true)); enqueue(render(3))
  enqueue({ id: 0, type: 'cancelPreview', beforeId: 1 })
  await until(() => ran.length === 2)
  assert.deepEqual(ran, [3, 2]); assert.deepEqual(cancelled, [1])
  enqueue(render(4, true)); enqueue({ id: 0, type: 'cancelPreview', beforeId: 4 })
  await tick(); assert.deepEqual(cancelled, [1, 4]); assert.deepEqual(ran, [3, 2])
})
