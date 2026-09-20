import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const compilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
const compile = async name => ts.transpileModule(
  await readFile(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'),
  { compilerOptions },
).outputText
const moduleUrl = code => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`

const protocolUrl = moduleUrl(await compile('raster-worker-protocol'))
const clientUrl = moduleUrl((await compile('raster-worker-client'))
  .replaceAll("'./raster-worker-protocol'", JSON.stringify(protocolUrl)))
const ownerUrl = moduleUrl((await compile('raster-worker-owner'))
  .replaceAll("'./raster-worker-client'", JSON.stringify(clientUrl)))
const { RasterWorkerClient } = await import(clientUrl)
const { RasterWorkerOwner } = await import(ownerUrl)

class FakePort {
  requests = []
  listeners = new Map()
  terminateCount = 0
  postMessage(message, transfer) { this.requests.push({ message, transfer: transfer || [] }) }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set()
    listeners.add(listener); this.listeners.set(type, listeners)
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  emit(type, value) { for (const listener of this.listeners.get(type) || []) listener(value) }
  respond(value) { this.emit('message', { data: value }) }
  terminate() { this.terminateCount++ }
}

const metadata = revision => ({ revision, history: { undo: revision, redo: 0 }, hasRepairMask: false })
const init = value => ({
  width: 1,
  height: 1,
  base: new Uint8ClampedArray([value, value, value, 255]),
  overlay: new Uint8ClampedArray(4),
  other: new Uint8ClampedArray([0, 0, 0, 255]),
  edited: new Uint8ClampedArray(4),
})
function frame(revision, closed) {
  return {
    ...metadata(revision), width: 1, height: 1,
    left: { close: () => closed.push(`left-${revision}`) },
    right: { close: () => closed.push(`right-${revision}`) },
    magicLeft: { close: () => closed.push(`magic-${revision}`) },
  }
}

test('owner constructs lazily, reuses a healthy client, replaces a terminal client, and disposes its lease', () => {
  const ports = []
  const owner = new RasterWorkerOwner(() => {
    const port = new FakePort()
    ports.push(port)
    return new RasterWorkerClient({ workerFactory: () => port })
  })

  assert.equal(ports.length, 0)
  const first = owner.acquire()
  assert.equal(first.reused, false)
  assert.equal(owner.acquire().client, first.client)
  assert.equal(owner.acquire().reused, true)
  assert.equal(ports.length, 1)

  ports[0].emit('error', new ErrorEvent('error', { message: 'page worker crashed' }))
  assert.equal(first.client.usable, false)
  const replacement = owner.acquire()
  assert.equal(replacement.reused, false)
  assert.notEqual(replacement.client, first.client)
  assert.equal(ports.length, 2)
  assert.ok(ports[0].terminateCount >= 1)

  owner.dispose()
  assert.equal(replacement.client.usable, false)
  assert.equal(ports[1].terminateCount, 1)
  owner.dispose()
  assert.equal(ports[1].terminateCount, 1, 'owner disposal is idempotent')

  const afterDispose = owner.acquire()
  assert.equal(afterDispose.reused, false)
  assert.equal(ports.length, 3)
  owner.dispose()
})

test('a reused client keeps page init FIFO ids and rejects a frame from the previous document', async () => {
  const port = new FakePort()
  const owner = new RasterWorkerOwner(() => new RasterWorkerClient({ workerFactory: () => port }))
  const client = owner.acquire().client

  const firstInit = client.init(init(10))
  port.respond({ id: 1, ok: true, type: 'metadata', value: metadata(0) })
  await firstInit

  const closed = []
  const oldFrame = client.render({ tag: 1 })
  const nextInit = client.init(init(20))
  assert.deepEqual(port.requests.map(({ message }) => [message.id, message.type]), [
    [1, 'init'], [2, 'render'], [3, 'init'],
  ])

  port.respond({ id: 3, ok: true, type: 'metadata', value: metadata(0) })
  port.respond({ id: 2, ok: true, type: 'render', value: frame(1, closed) })
  assert.equal((await nextInit).revision, 0)
  assert.equal(await oldFrame, null)
  assert.deepEqual(closed, ['left-1', 'right-1', 'magic-1'])
  assert.equal(owner.acquire().reused, true)
  owner.dispose()
})

const selectionUrl = moduleUrl(await compile('selection-core'))
const maskEditUrl = moduleUrl(await compile('mask-edit-core'))
const previewUrl = moduleUrl(await compile('edit-preview'))
const engineUrl = moduleUrl((await compile('raster-worker-engine'))
  .replaceAll("'./selection-core'", JSON.stringify(selectionUrl))
  .replaceAll("'./mask-edit-core'", JSON.stringify(maskEditUrl))
  .replaceAll("'./edit-preview'", JSON.stringify(previewUrl))
  .replaceAll("'./raster-worker-protocol'", JSON.stringify(protocolUrl)))
const schedulerUrl = moduleUrl((await compile('raster-worker-scheduler'))
  .replaceAll("'./raster-worker-protocol'", JSON.stringify(protocolUrl)))
const { RasterWorkerEngine } = await import(engineUrl)
const { createRasterScheduler } = await import(schedulerUrl)

const tick = () => new Promise(resolve => setTimeout(resolve, 2))
async function until(predicate) {
  const deadline = Date.now() + 1000
  while (!predicate() && Date.now() < deadline) await tick()
  assert.ok(predicate(), 'worker pipeline completed within deadline')
}
function page(base) {
  return {
    width: 2,
    height: 1,
    base: new Uint8ClampedArray([...base, 255, ...base, 255]),
    overlay: new Uint8ClampedArray(8),
    other: new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 255]),
    edited: new Uint8ClampedArray(8),
  }
}

test('a cross-page init waits for snapshot serialization, resets history, and cancels the old queued frame', async () => {
  const engine = new RasterWorkerEngine()
  const events = []
  const cancelled = []
  let releaseSnapshot
  const snapshotBarrier = new Promise(resolve => { releaseSnapshot = resolve })
  let saved
  const enqueue = createRasterScheduler(async request => {
    events.push(request.type)
    if (request.type === 'init') engine.init(request.payload, { copyInputs: false })
    else if (request.type === 'commit') engine.commit(request.payload)
    else if (request.type === 'snapshot') {
      saved = engine.snapshot()
      await snapshotBarrier
    } else if (request.type === 'render') engine.render(request.payload)
  }, request => cancelled.push(request.id))

  enqueue({ id: 1, type: 'init', payload: page([10, 20, 30]) })
  enqueue({ id: 2, type: 'commit', payload: {
    selection: { kind: 'rectangle', x1: 0, y1: 0, x2: 0, y2: 0 },
    operation: 'add', category: 'other',
  } })
  enqueue({ id: 3, type: 'snapshot' })
  enqueue({ id: 4, type: 'render', payload: { previewOnly: false } })
  enqueue({ id: 5, type: 'init', payload: page([91, 92, 93]) })

  await until(() => events.includes('snapshot'))
  assert.deepEqual(events, ['init', 'commit', 'snapshot'])
  assert.deepEqual(cancelled, [4])
  assert.equal(saved.revision, 1)
  assert.equal(saved.history.undo, 1)
  assert.equal(saved.other[0], 255, 'save captured the edited first page before the next init')

  releaseSnapshot()
  await until(() => events.length === 4)
  assert.deepEqual(events, ['init', 'commit', 'snapshot', 'init'])
  assert.deepEqual(engine.metadata(), metadata(0))
  const next = engine.snapshot()
  assert.deepEqual([...next.other], [0, 0, 0, 255, 0, 0, 0, 255])
  const rendered = engine.render({
    maskPercent: 0, maskColor: [255, 255, 255], showOther: false,
    otherPercent: 0, otherColor: [255, 110, 165],
  })
  assert.deepEqual([...rendered.right], [91, 92, 93, 255, 91, 92, 93, 255])
})
