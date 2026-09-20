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

const selectionUrl = moduleUrl(await compile('selection-core'))
const maskEditUrl = moduleUrl(await compile('mask-edit-core'))
const previewUrl = moduleUrl(await compile('edit-preview'))
const protocolUrl = moduleUrl(await compile('raster-worker-protocol'))
const engineSource = (await compile('raster-worker-engine'))
  .replaceAll("'./selection-core'", JSON.stringify(selectionUrl))
  .replaceAll("'./mask-edit-core'", JSON.stringify(maskEditUrl))
  .replaceAll("'./edit-preview'", JSON.stringify(previewUrl))
  .replaceAll("'./raster-worker-protocol'", JSON.stringify(protocolUrl))
const schedulerUrl = moduleUrl(await compile('raster-worker-scheduler'))
const engineUrl = moduleUrl(engineSource)

const { RasterWorkerEngine } = await import(engineUrl)
const { combineSelection, magicSelection, polygonSelection, rectangleSelection } = await import(selectionUrl)
const { applyCategoryMask, applySpecialSelection, categoryMask, mergeLayerRegion } = await import(maskEditUrl)
const { renderEditViews } = await import(previewUrl)

function image(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let n = 0; n < width * height; n++) data.set(pixel(n % width, Math.floor(n / width)), n * 4)
  return data
}

function fixture(width = 7, height = 6) {
  const base = image(width, height, (x, y) => {
    const value = x < 3 ? 25 + y : 215 - y
    return [value, value, value, 255]
  })
  const overlay = image(width, height, () => [0, 0, 0, 0])
  const other = image(width, height, () => [0, 0, 0, 255])
  const edited = new Uint8ClampedArray(width * height * 4)
  return { width, height, base, overlay, other, edited, assignment: Uint16Array.from({ length: width * height }, (_, n) => n % 4 === 0 ? 513 : 0) }
}

function layers(snapshot) {
  return { overlay: snapshot.overlay, other: snapshot.other, edited: snapshot.edited }
}

function assertLayers(actual, expected) {
  assert.deepEqual(actual.overlay, expected.overlay)
  assert.deepEqual(actual.other, expected.other)
  assert.deepEqual(actual.edited, expected.edited)
}

test('worker engine rectangle, polygon, mask, and magic commits match the existing pure cores', () => {
  const initial = fixture()
  const engine = new RasterWorkerEngine()
  engine.init(initial)
  let expected = { overlay: initial.overlay.slice(), other: initial.other.slice(), edited: initial.edited.slice() }

  const apply = (selection, operation, category, commandSelection, intersectOffset = 0) => {
    const before = categoryMask(expected, category)
    const after = combineSelection(before, selection, initial.width, initial.height, operation, intersectOffset)
    const paint = ['add', 'selection_inner', 'add_selection_inner'].includes(operation)
      ? combineSelection(new Uint8Array(selection.length), selection, initial.width, initial.height, operation)
      : undefined
    expected = applyCategoryMask(expected, before, after, category, [0, 0, 0], undefined, paint, {
      base: initial.base,
      width: initial.width,
      height: initial.height,
      exclude: null,
    })
    engine.commit({ selection: commandSelection, operation, category, intersectOffset })
    assertLayers(engine.snapshot(), expected)
  }

  const rectangle = rectangleSelection(1, 1, 4, 3, initial.width, initial.height)
  apply(rectangle, 'add', 'other', { kind: 'rectangle', x1: 1, y1: 1, x2: 4, y2: 3 })

  const points = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 2, y: 2 }]
  apply(polygonSelection(points, initial.width, initial.height), 'add', 'solid', { kind: 'polygon', points })

  const subtract = Uint8Array.from({ length: initial.width * initial.height }, (_, n) => Number(n % initial.width === 2))
  apply(subtract, 'subtract', 'other', { kind: 'mask', data: subtract })

  const magic = magicSelection(initial.base, initial.width, initial.height, 6, 5, 2, 1)
  apply(magic, 'add', 'other', { kind: 'magic', point: { x: 6, y: 5 }, tolerance: 2, expand: 1 })
})

test('brush, clipping, clear, and swap preserve the current editor semantics', () => {
  const initial = fixture(9, 7)
  // Seed both categories so clear and swap have observable work.
  for (const n of [10, 11, 19]) initial.other.set([255, 255, 255, 255], n * 4)
  for (const n of [21, 22]) initial.overlay.set([30, 30, 30, 255], n * 4)
  const engine = new RasterWorkerEngine()
  engine.init(initial)

  // A one-pixel brush uses the same radius test as RasterEditor.stroke.
  const brushMask = new Uint8Array(initial.width * initial.height)
  brushMask[3 * initial.width + 4] = 1
  const expectedBrush = applyCategoryMask(
    layers(engine.snapshot()), new Uint8Array(brushMask.length), brushMask, 'other', [0, 0, 0], undefined, brushMask,
    { base: initial.base, width: initial.width, height: initial.height, exclude: null },
  )
  engine.commit({ selection: { kind: 'brush', points: [{ x: 4, y: 3 }], size: 1 }, operation: 'add', category: 'other' })
  assertLayers(engine.snapshot(), expectedBrush)

  const beforeClear = layers(engine.snapshot())
  const unclipped = rectangleSelection(0, 0, 8, 6, initial.width, initial.height)
  const clipped = unclipped.slice()
  for (let y = 0; y < initial.height; y++) for (let x = 0; x < initial.width; x++) {
    if (x < 1 || x >= 5 || y < 1 || y >= 5) clipped[y * initial.width + x] = 0
  }
  const expectedClear = applySpecialSelection(beforeClear, clipped, 'clear', [0, 0, 0], null, {
    base: initial.base, width: initial.width, height: initial.height, exclude: null,
  })
  engine.commit({
    selection: { kind: 'rectangle', x1: 0, y1: 0, x2: 8, y2: 6 },
    operation: 'clear', category: 'other', clipRect: { x: 1, y: 1, width: 4, height: 4 },
  })
  assertLayers(engine.snapshot(), expectedClear)

  const swapMask = rectangleSelection(0, 0, 3, 3, initial.width, initial.height)
  const beforeSwap = layers(engine.snapshot())
  const expectedSwap = applySpecialSelection(beforeSwap, swapMask, 'swap', [0, 0, 0], null, {
    base: initial.base, width: initial.width, height: initial.height, exclude: null,
  })
  engine.commit({ selection: { kind: 'mask', data: swapMask }, operation: 'swap', category: 'other' })
  assertLayers(engine.snapshot(), expectedSwap)
})

test('history is atomic, redo is cleared by a new edit, and returned snapshots cannot mutate engine state', () => {
  const initial = fixture(5, 4)
  const engine = new RasterWorkerEngine()
  engine.init(initial)
  const original = engine.snapshot()

  engine.commit({ selection: { kind: 'rectangle', x1: 0, y1: 0, x2: 1, y2: 1 }, operation: 'add', category: 'other' })
  const afterFirst = engine.snapshot()
  engine.commit({ selection: { kind: 'rectangle', x1: 3, y1: 2, x2: 4, y2: 3 }, operation: 'add', category: 'solid' })
  const afterSecond = engine.snapshot()
  assert.deepEqual(afterSecond.history, { undo: 2, redo: 0 })

  assert.deepEqual(engine.undo().history, { undo: 1, redo: 1 })
  assertLayers(engine.snapshot(), afterFirst)
  assert.deepEqual(engine.redo().history, { undo: 2, redo: 0 })
  assertLayers(engine.snapshot(), afterSecond)
  engine.undo()
  engine.commit({ selection: { kind: 'rectangle', x1: 2, y1: 0, x2: 2, y2: 0 }, operation: 'add', category: 'other' })
  assert.deepEqual(engine.metadata().history, { undo: 2, redo: 0 })
  const stable = engine.snapshot()
  stable.overlay.fill(77); stable.other.fill(88); stable.edited.fill(99); stable.assignment.fill(42)
  assert.notDeepEqual(engine.snapshot().overlay, stable.overlay)
  assert.deepEqual(engine.snapshot().assignment, original.assignment)
  assert.deepEqual(initial.overlay, original.overlay, 'init must retain ownership of caller buffers')
})

test('merge is one undoable region operation and never aliases the supplied draft', () => {
  const initial = fixture(4, 3)
  const engine = new RasterWorkerEngine()
  engine.init(initial)
  const before = engine.snapshot()
  const draft = {
    overlay: image(4, 3, () => [70, 80, 90, 255]),
    other: image(4, 3, () => [255, 255, 255, 255]),
    edited: image(4, 3, () => [255, 255, 255, 255]),
  }
  const rect = { x: 1, y: 1, width: 2, height: 1 }
  const expected = mergeLayerRegion(layers(before), draft, 4, 3, rect)
  engine.merge({ layers: draft, rect })
  assertLayers(engine.snapshot(), expected)
  draft.overlay.fill(0); draft.other.fill(0); draft.edited.fill(0)
  assertLayers(engine.snapshot(), expected)
  engine.undo()
  assertLayers(engine.snapshot(), before)
})

test('render and magic preview are immutable; plain render equals the existing preview core', () => {
  const initial = fixture(6, 5)
  const engine = new RasterWorkerEngine()
  engine.init(initial)
  engine.commit({ selection: { kind: 'rectangle', x1: 1, y1: 1, x2: 3, y2: 3 }, operation: 'add', category: 'other' })
  const before = engine.snapshot()
  const options = { maskPercent: 70, maskColor: [255, 255, 255], showOther: true, otherPercent: 38, otherColor: [255, 110, 165], tag: 19 }
  const plain = engine.render(options)
  const direct = renderEditViews({ base: initial.base, ...layers(before) }, options)
  assert.deepEqual(plain.left, direct.left)
  assert.deepEqual(plain.right, direct.right)
  assert.equal(plain.tag, 19)

  const preview = engine.render({ ...options, magicPreview: {
    requestId: 41, point: { x: 5, y: 4 }, tolerance: 2, expand: 0, operation: 'add', category: 'solid',
  } })
  assert.equal(preview.previewRequestId, 41)
  assert.deepEqual(preview.left, plain.left, 'the stable left frame stays clean while hover changes')
  assert.notDeepEqual(preview.magicLeft, plain.left, 'magic hover has a separately disposable tinted frame')
  assert.deepEqual(preview.right, plain.right, 'hover preview must not alter the filled preview')
  assertLayers(engine.snapshot(), before)
  assert.deepEqual(engine.metadata(), { revision: before.revision, history: before.history, hasRepairMask: before.hasRepairMask })
})

test('a matching magic commit reuses preview selection and layers with pure-core parity', () => {
  const initial = fixture(8, 7)
  const engine = new RasterWorkerEngine()
  engine.init(initial)
  const command = {
    selection: { kind: 'magic', point: { x: 6, y: 5 }, tolerance: 3, expand: 1 },
    operation: 'add', category: 'solid', intersectOffset: 0,
  }
  const options = { maskPercent: 70, maskColor: [255, 255, 255], showOther: true, otherPercent: 38, otherColor: [255, 110, 165] }
  engine.render({ ...options, magicPreview: { requestId: 7, point: command.selection.point,
    tolerance: command.selection.tolerance, expand: command.selection.expand,
    operation: command.operation, category: command.category, intersectOffset: command.intersectOffset } })
  const cached = engine.magicCache
  assert.ok(cached)
  const selection = magicSelection(initial.base, initial.width, initial.height, 6, 5, 3, 1)
  const current = new Uint8Array(initial.width * initial.height)
  const expected = applyCategoryMask(layers(engine.snapshot()), current,
    combineSelection(current, selection, initial.width, initial.height, 'add'), 'solid', [0, 0, 0], undefined, selection,
    { base: initial.base, width: initial.width, height: initial.height, exclude: null })

  engine.commit(command)
  assert.equal(engine.layers, cached.next, 'commit installs the already computed immutable preview result')
  assert.equal(engine.magicCache, null)
  assertLayers(engine.snapshot(), expected)
})

test('magic cache keys every edit parameter and state changes invalidate it', () => {
  const initial = fixture(9, 8)
  const options = { maskPercent: 70, maskColor: [255, 255, 255], showOther: true, otherPercent: 38, otherColor: [255, 110, 165] }
  const base = { requestId: 1, point: { x: 6, y: 5 }, tolerance: 4, expand: 0,
    operation: 'add', category: 'other', intersectOffset: 0 }
  const variants = [
    ['point', { point: { x: 5, y: 5 } }],
    ['tolerance', { tolerance: 5 }],
    ['expand', { expand: 1 }],
    ['operation', { operation: 'subtract' }],
    ['category', { category: 'solid' }],
    ['clipRect', { clipRect: { x: 1, y: 1, width: 7, height: 6 } }],
    ['intersectOffset', { intersectOffset: 1 }],
  ]
  for (const [name, change] of variants) {
    const engine = new RasterWorkerEngine()
    engine.init(initial)
    engine.render({ ...options, magicPreview: base })
    const first = engine.magicCache
    engine.render({ ...options, magicPreview: { ...base, ...change, requestId: 2 } })
    assert.notEqual(engine.magicCache, first, `${name} must select a new cache entry`)
  }

  const engine = new RasterWorkerEngine()
  engine.init(initial)
  engine.render({ ...options, magicPreview: base })
  const same = engine.magicCache
  engine.render({ ...options, magicPreview: { ...base, requestId: 99 } })
  assert.equal(engine.magicCache, same, 'transport request ids do not change edit output')
  engine.commit({ selection: { kind: 'rectangle', x1: 0, y1: 0, x2: 1, y2: 1 }, operation: 'add', category: 'other' })
  assert.equal(engine.magicCache, null)
  engine.render({ ...options, magicPreview: base }); assert.ok(engine.magicCache)
  engine.undo(); assert.equal(engine.magicCache, null)
  engine.render({ ...options, magicPreview: base }); assert.ok(engine.magicCache)
  engine.redo(); assert.equal(engine.magicCache, null)
  engine.render({ ...options, magicPreview: base }); assert.ok(engine.magicCache)
  const snapshot = engine.snapshot()
  engine.merge({ layers: layers(snapshot), rect: { x: 0, y: 0, width: 1, height: 1 } })
  assert.equal(engine.magicCache, null)
  engine.render({ ...options, magicPreview: base }); assert.ok(engine.magicCache)
  engine.init(initial)
  assert.equal(engine.magicCache, null)
})

test('worker request queue fences async snapshot serialization and preserves command order', { timeout: 5000 }, async () => {
  const responses = []
  const previous = { ImageData: globalThis.ImageData, OffscreenCanvas: globalThis.OffscreenCanvas, postMessage: globalThis.postMessage, onmessage: globalThis.onmessage }
  class FakeImageData {
    constructor(data, width, height) { this.data = data; this.width = width; this.height = height }
  }
  class FakeCanvas {
    constructor(width, height) { this.width = width; this.height = height; this.data = new Uint8ClampedArray(width * height * 4) }
    getContext() { return { putImageData: value => { this.data = value.data.slice() } } }
    async convertToBlob() {
      await new Promise(resolve => setTimeout(resolve, 12))
      return new Blob([this.data])
    }
    transferToImageBitmap() { return { data: this.data.slice(), width: this.width, height: this.height } }
  }
  globalThis.ImageData = FakeImageData
  globalThis.OffscreenCanvas = FakeCanvas
  globalThis.postMessage = response => { responses.push(response) }
  try {
    const workerSource = (await compile('raster-worker'))
      .replaceAll("'./raster-worker-engine'", JSON.stringify(engineUrl))
    .replaceAll("'./raster-worker-scheduler'", JSON.stringify(schedulerUrl))
      .replaceAll("'./raster-worker-protocol'", JSON.stringify(protocolUrl))
    await import(`${moduleUrl(workerSource)}#queue-test`)
    const input = fixture(3, 2)
    const send = data => globalThis.onmessage({ data })
    send({ id: 1, type: 'init', payload: input })
    send({ id: 2, type: 'commit', payload: { selection: { kind: 'rectangle', x1: 0, y1: 0, x2: 0, y2: 0 }, operation: 'add', category: 'other' } })
    send({ id: 3, type: 'snapshot' })
    send({ id: 4, type: 'undo' })
    send({ id: 5, type: 'snapshot' })

    const deadline = Date.now() + 2000
    while (responses.length < 5 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
    assert.deepEqual(responses.map(response => response.id), [1, 2, 3, 4, 5])
    assert.equal(responses[2].type, 'snapshot')
    assert.equal(responses[2].value.revision, 1)
    assert.equal(new Uint8Array(await responses[2].value.other.arrayBuffer())[0], 255)
    assert.equal(responses[4].type, 'snapshot')
    assert.equal(responses[4].value.revision, 2)
    assert.equal(new Uint8Array(await responses[4].value.other.arrayBuffer())[0], 0)
    assert.deepEqual(responses[4].value.assignment, input.assignment)
  } finally {
    globalThis.ImageData = previous.ImageData
    globalThis.OffscreenCanvas = previous.OffscreenCanvas
    globalThis.postMessage = previous.postMessage
    globalThis.onmessage = previous.onmessage
  }
})
