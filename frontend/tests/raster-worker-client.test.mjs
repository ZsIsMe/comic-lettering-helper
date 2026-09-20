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
const clientSource = (await compile('raster-worker-client'))
  .replaceAll("'./raster-worker-protocol'", JSON.stringify(protocolUrl))
const { RasterWorkerClient } = await import(moduleUrl(clientSource))

class FakePort {
  requests = []
  transfers = []
  listeners = new Map()
  terminated = false
  postMessage(message, transfer = []) { this.transfers.push([...transfer]); this.requests.push(structuredClone(message, { transfer })) }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set()
    listeners.add(listener); this.listeners.set(type, listeners)
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
  emit(type, value) { for (const listener of this.listeners.get(type) || []) listener(value) }
  respond(value) { this.emit('message', { data: value }) }
  terminate() { this.terminated = true }
}

const metadata = revision => ({ revision, history: { undo: revision, redo: 0 }, hasRepairMask: revision > 0 })
function frame(revision, closed) {
  return {
    ...metadata(revision), width: 1, height: 1,
    left: { close: () => closed.push(`left-${revision}`) },
    right: { close: () => closed.push(`right-${revision}`) },
    magicLeft: { close: () => closed.push(`magic-${revision}`) },
  }
}

test('client correlates delayed out-of-order replies without losing mutation commands', async () => {
  const port = new FakePort()
  const client = new RasterWorkerClient({ workerFactory: () => port })
  const first = client.commit({ selection: { kind: 'mask', data: new Uint8Array([1]) }, operation: 'add', category: 'other' })
  const second = client.undo()
  const third = client.redo()
  assert.deepEqual(port.requests.map(({ id, type }) => [id, type]), [[1, 'commit'], [2, 'undo'], [3, 'redo']])

  port.respond({ id: 3, ok: true, type: 'metadata', value: metadata(3) })
  port.respond({ id: 1, ok: true, type: 'metadata', value: metadata(1) })
  port.respond({ id: 2, ok: true, type: 'metadata', value: metadata(2) })
  assert.equal((await first).revision, 1)
  assert.equal((await second).revision, 2)
  assert.equal((await third).revision, 3)
  client.dispose()
})

test('only the newest render is accepted and every superseded bitmap is closed', async () => {
  const port = new FakePort()
  const client = new RasterWorkerClient({ workerFactory: () => port })
  const closed = []
  const options = { maskPercent: 50, maskColor: [255, 255, 255], showOther: true, otherPercent: 30, otherColor: [255, 0, 0] }
  const oldRender = client.render({ ...options, tag: 10 })
  const newRender = client.render({ ...options, tag: 11 })
  port.respond({ id: 2, ok: true, type: 'render', value: frame(2, closed) })
  port.respond({ id: 1, ok: true, type: 'render', value: frame(1, closed) })
  assert.equal((await newRender).revision, 2)
  assert.equal(await oldRender, null)
  assert.deepEqual(closed, ['left-1', 'right-1', 'magic-1'])
  client.dispose()
})

test('unexpected and orphan render responses close transferred bitmap resources', async () => {
  const port = new FakePort()
  const client = new RasterWorkerClient({ workerFactory: () => port })
  const closed = []
  const pending = client.undo()
  port.respond({ id: 1, ok: true, type: 'render', value: frame(1, closed) })
  await assert.rejects(pending, /Unexpected raster worker response: render/)
  port.respond({ id: 999, ok: true, type: 'render', value: frame(9, closed) })
  assert.deepEqual(closed, ['left-1', 'right-1', 'magic-1', 'left-9', 'right-9', 'magic-9'])
  client.dispose()
})

test('idle worker errors are terminal and all later requests reject immediately', async () => {
  const port = new FakePort()
  const client = new RasterWorkerClient({ workerFactory: () => port })
  assert.equal(client.usable, true)
  port.emit('error', new ErrorEvent('error', { message: 'worker crashed' }))
  assert.equal(client.usable, false)
  await assert.rejects(client.undo(), /worker crashed/)
  await assert.rejects(client.snapshot(), /worker crashed/)
  assert.equal(port.requests.length, 0)
  assert.equal(port.terminated, true)
})

test('dispose rejects in-flight work and prevents any later postMessage', async () => {
  const port = new FakePort()
  const client = new RasterWorkerClient({ workerFactory: () => port })
  const pending = client.snapshot()
  client.dispose()
  assert.equal(client.usable, false)
  await assert.rejects(pending, /disposed/)
  await assert.rejects(client.redo(), /disposed/)
  assert.deepEqual(port.requests.map(request => request.type), ['snapshot'])
  assert.equal(port.terminated, true)
})

test('optimized init transfers only disposable edit inputs and forwards the legacy copy switch', async () => {
  const port = new FakePort()
  const client = new RasterWorkerClient({ workerFactory: () => port })
  const base = new Uint8ClampedArray(4)
  const overlay = new Uint8ClampedArray(4)
  const other = new Uint8ClampedArray(4)
  const edited = new Uint8ClampedArray(4)
  const detectedText = new Uint8ClampedArray(4)
  const ownedBuffers = [overlay.buffer, other.buffer, edited.buffer, detectedText.buffer]
  const init = client.init({ width: 1, height: 1, base, overlay, other, edited, detectedText }, { transferOwned: true, copyInputs: true })

  assert.equal(port.requests[0].copyInputs, true)
  assert.deepEqual(new Set(port.transfers[0]), new Set(ownedBuffers))
  assert.equal(port.transfers[0].includes(base.buffer), false, 'the source-cache base must never be detached')
  assert.equal(base.byteLength, 4)
  assert.deepEqual([overlay.byteLength, other.byteLength, edited.byteLength, detectedText.byteLength], [0, 0, 0, 0])
  assert.deepEqual([port.requests[0].payload.overlay.byteLength, port.requests[0].payload.other.byteLength, port.requests[0].payload.edited.byteLength, port.requests[0].payload.detectedText.byteLength], [4, 4, 4, 4])
  port.respond({ id: 1, ok: true, type: 'metadata', value: metadata(0) })
  assert.equal((await init).revision, 0)
  client.dispose()
})

test('init invalidates render tokens from the previous document', async () => {
  const port = new FakePort()
  const client = new RasterWorkerClient({ workerFactory: () => port })
  const closed = []
  const oldDocument = client.render({})
  const oldPreview = client.render({ previewOnly: true })
  const pixels = () => new Uint8ClampedArray(4)
  const init = client.init({ width: 1, height: 1, base: pixels(), overlay: pixels(), other: pixels(), edited: pixels() })

  port.respond({ id: 3, ok: true, type: 'metadata', value: metadata(0) })
  port.respond({ id: 1, ok: true, type: 'render', value: frame(1, closed) })
  port.respond({ id: 2, ok: true, type: 'render', value: frame(2, closed) })
  assert.equal((await init).revision, 0)
  assert.equal(await oldDocument, null)
  assert.equal(await oldPreview, null)
  assert.deepEqual(closed, ['left-1', 'right-1', 'magic-1', 'left-2', 'right-2', 'magic-2'])
  client.dispose()
})

test('an application-level init rejection leaves a shared client usable for retry', async () => {
  const port = new FakePort()
  const client = new RasterWorkerClient({ workerFactory: () => port })
  const pixels = () => new Uint8ClampedArray(4)
  const failed = client.init({ width: 1, height: 1, base: pixels(), overlay: pixels(), other: pixels(), edited: pixels() })
  port.respond({ id: 1, ok: false, error: 'bad dimensions' })
  await assert.rejects(failed, /bad dimensions/)
  assert.equal(client.usable, true)

  const retry = client.init({ width: 1, height: 1, base: pixels(), overlay: pixels(), other: pixels(), edited: pixels() })
  port.respond({ id: 2, ok: true, type: 'metadata', value: metadata(0) })
  await retry
  assert.equal(client.usable, true)
  client.dispose()
})

test('preview cancellation settles normally without invalidating an independent document frame', async () => {
  const port = new FakePort()
  const client = new RasterWorkerClient({ workerFactory: () => port })
  const closed = []
  const doc = client.render({})
  const oldPreview = client.render({ previewOnly: true })
  client.cancelPreview()
  assert.deepEqual(port.requests.at(-1), { id: 0, type: 'cancelPreview', beforeId: 2 })
  const preview = client.render({ previewOnly: true })
  port.respond({ id: 2, ok: true, type: 'render', value: null })
  port.respond({ id: 3, ok: true, type: 'render', value: frame(3, closed) })
  port.respond({ id: 1, ok: true, type: 'render', value: frame(1, closed) })
  assert.equal(await oldPreview, null)
  assert.equal((await preview).revision, 3)
  assert.equal((await doc).revision, 1)
  assert.deepEqual(closed, [])
  client.dispose()
})
