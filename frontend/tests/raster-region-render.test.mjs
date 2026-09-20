import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
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
const engineUrl = moduleUrl(engineSource)

const { RasterWorkerEngine } = await import(engineUrl)

const OPTIONS = {
  maskPercent: 70,
  maskColor: [255, 255, 255],
  showOther: true,
  otherPercent: 38,
  otherColor: [255, 110, 165],
}

function image(width, height, pixel) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let n = 0; n < width * height; n++) data.set(pixel(n % width, Math.floor(n / width)), n * 4)
  return data
}

function fixture(width = 12, height = 10) {
  return {
    width,
    height,
    base: image(width, height, (x, y) => [(x * 19 + y * 7) % 256, (x * 3 + y * 23) % 256, (x * 11 + y * 5) % 256, 255]),
    overlay: image(width, height, () => [0, 0, 0, 0]),
    other: image(width, height, () => [0, 0, 0, 255]),
    edited: image(width, height, () => [0, 0, 0, 0]),
  }
}

function fullFrame(frame) {
  assert.equal(frame.rect, undefined)
  return { left: frame.left.slice(), right: frame.right.slice() }
}

function applyPatch(base, patch) {
  assert.ok(patch.rect)
  const result = { left: base.left.slice(), right: base.right.slice() }
  const { x, y, width, height } = patch.rect
  assert.equal(patch.left.length, width * height * 4)
  assert.equal(patch.right.length, width * height * 4)
  for (let row = 0; row < height; row++) {
    const source = row * width * 4
    const target = ((y + row) * patch.width + x) * 4
    result.left.set(patch.left.subarray(source, source + width * 4), target)
    result.right.set(patch.right.subarray(source, source + width * 4), target)
  }
  return result
}

function assertReconstructs(engine, displayed, baseRevision, options = OPTIONS) {
  const patch = engine.render({ ...options, baseRevision })
  assert.equal(patch.baseRevision, baseRevision)
  const reconstructed = applyPatch(displayed, patch)
  const expected = engine.render(options)
  assert.deepEqual(reconstructed.left, expected.left)
  assert.deepEqual(reconstructed.right, expected.right)
  return patch
}

test('a regional edit returns its exact dirty bounds and reconstructs the full render byte-for-byte', () => {
  const engine = new RasterWorkerEngine()
  engine.init(fixture())
  const displayed = fullFrame(engine.render(OPTIONS))
  engine.commit({
    selection: { kind: 'rectangle', x1: 2, y1: 3, x2: 4, y2: 5 },
    operation: 'add',
    category: 'other',
  })
  const patch = assertReconstructs(engine, displayed, 0)
  assert.deepEqual(patch.rect, { x: 2, y: 3, width: 3, height: 3 })
})

test('a skipped displayed revision unions every intervening actual dirty bound', () => {
  const engine = new RasterWorkerEngine()
  engine.init(fixture())
  const frame0 = fullFrame(engine.render(OPTIONS))
  engine.commit({ selection: { kind: 'rectangle', x1: 1, y1: 1, x2: 2, y2: 2 }, operation: 'add', category: 'other' })
  const frame1 = fullFrame(engine.render(OPTIONS))
  engine.commit({ selection: { kind: 'rectangle', x1: 8, y1: 6, x2: 10, y2: 8 }, operation: 'add', category: 'solid' })

  assert.deepEqual(assertReconstructs(engine, frame1, 1).rect, { x: 8, y: 6, width: 3, height: 3 })
  assert.deepEqual(assertReconstructs(engine, frame0, 0).rect, { x: 1, y: 1, width: 10, height: 8 })
})

test('undo and redo record actual layer changes as new patchable revisions', () => {
  const engine = new RasterWorkerEngine()
  engine.init(fixture())
  engine.commit({ selection: { kind: 'rectangle', x1: 3, y1: 2, x2: 6, y2: 5 }, operation: 'add', category: 'other' })
  const frame1 = fullFrame(engine.render(OPTIONS))

  assert.equal(engine.undo().revision, 2)
  assert.deepEqual(assertReconstructs(engine, frame1, 1).rect, { x: 3, y: 2, width: 4, height: 4 })
  const frame2 = fullFrame(engine.render(OPTIONS))

  assert.equal(engine.redo().revision, 3)
  assert.deepEqual(assertReconstructs(engine, frame2, 2).rect, { x: 3, y: 2, width: 4, height: 4 })
})

test('dirty bounds come from resulting layers rather than the gesture geometry', () => {
  const initial = fixture(10, 5)
  for (let x = 1; x <= 8; x++) initial.other.set([255, 255, 255, 255], (2 * initial.width + x) * 4)
  const engine = new RasterWorkerEngine()
  engine.init(initial)
  const displayed = fullFrame(engine.render(OPTIONS))

  engine.commit({
    selection: { kind: 'rectangle', x1: 4, y1: 2, x2: 4, y2: 2 },
    operation: 'local_intersect',
    category: 'other',
  })
  const patch = assertReconstructs(engine, displayed, 0)
  assert.deepEqual(patch.rect, { x: 1, y: 2, width: 8, height: 1 }, 'the connected component changes outside the 1px gesture')
})

test('merge uses actual changed pixels and a no-op revision emits a harmless 1px patch', () => {
  const initial = fixture(9, 7)
  const engine = new RasterWorkerEngine()
  engine.init(initial)
  const frame0 = fullFrame(engine.render(OPTIONS))
  const draft = engine.snapshot()
  draft.other.set([255, 255, 255, 255], (4 * initial.width + 5) * 4)
  engine.merge({ layers: draft, rect: { x: 1, y: 1, width: 7, height: 5 } })
  assert.deepEqual(assertReconstructs(engine, frame0, 0).rect, { x: 5, y: 4, width: 1, height: 1 })

  const frame1 = fullFrame(engine.render(OPTIONS))
  const unchanged = engine.snapshot()
  engine.merge({ layers: unchanged, rect: { x: 0, y: 0, width: initial.width, height: initial.height } })
  const patch = assertReconstructs(engine, frame1, 1)
  assert.deepEqual(patch.rect, { x: 0, y: 0, width: 1, height: 1 })
})

test('unknown and evicted bases fall back to full frames while 64 retained transitions remain patchable', () => {
  const initial = fixture(2, 2)
  const engine = new RasterWorkerEngine()
  engine.init(initial)
  const unchanged = engine.snapshot()
  for (let revision = 1; revision <= 65; revision++) {
    engine.merge({ layers: unchanged, rect: { x: 0, y: 0, width: 2, height: 2 } })
  }

  const old = engine.render({ ...OPTIONS, baseRevision: 0 })
  assert.equal(old.rect, undefined)
  assert.equal(old.baseRevision, undefined)
  assert.equal(old.left.length, initial.width * initial.height * 4)
  const retained = engine.render({ ...OPTIONS, baseRevision: 1 })
  assert.deepEqual(retained.rect, { x: 0, y: 0, width: 1, height: 1 })
  assert.equal(retained.baseRevision, 1)
  const future = engine.render({ ...OPTIONS, baseRevision: 999 })
  assert.equal(future.rect, undefined)
  assert.equal(future.baseRevision, undefined)
})

test('display-option changes request full frames and magic preview stays full-size beside clean patches', () => {
  const initial = fixture(11, 8)
  const engine = new RasterWorkerEngine()
  engine.init(initial)
  const displayed = fullFrame(engine.render(OPTIONS))
  engine.commit({ selection: { kind: 'rectangle', x1: 2, y1: 2, x2: 3, y2: 3 }, operation: 'add', category: 'other' })

  const previewOptions = {
    ...OPTIONS,
    baseRevision: 0,
    magicPreview: {
      requestId: 7,
      point: { x: 9, y: 6 },
      tolerance: 12,
      expand: 1,
      operation: 'add',
      category: 'solid',
    },
  }
  const patch = engine.render(previewOptions)
  assert.ok(patch.rect)
  assert.equal(patch.left.length, patch.rect.width * patch.rect.height * 4)
  assert.equal(patch.magicLeft.length, initial.width * initial.height * 4)
  const fullPreview = engine.render({ ...previewOptions, baseRevision: undefined })
  assert.deepEqual(patch.magicLeft, fullPreview.magicLeft)
  assert.deepEqual(applyPatch(displayed, patch).left, fullPreview.left)

  const changedDisplay = engine.render({ ...OPTIONS, maskPercent: 25, showOther: false })
  assert.equal(changedDisplay.rect, undefined)
  assert.equal(changedDisplay.left.length, initial.width * initial.height * 4)
})

test('regional rendering materially reduces measured work for a small edit', t => {
  const initial = fixture(1121, 1600)
  const engine = new RasterWorkerEngine()
  engine.init(initial)
  engine.commit({ selection: { kind: 'rectangle', x1: 300, y1: 450, x2: 331, y2: 481 }, operation: 'add', category: 'other' })
  const patch = engine.render({ ...OPTIONS, baseRevision: 0 })
  assert.deepEqual(patch.rect, { x: 300, y: 450, width: 32, height: 32 })
  const fullBytes = initial.width * initial.height * 4 * 2
  const patchBytes = patch.left.byteLength + patch.right.byteLength
  const byteRatio = fullBytes / patchBytes
  assert.ok(byteRatio > 1700)

  // Warm both paths, then measure enough repetitions for a stable order-of-magnitude check.
  engine.render(OPTIONS)
  engine.render({ ...OPTIONS, baseRevision: 0 })
  const rounds = 4
  let start = performance.now()
  for (let index = 0; index < rounds; index++) engine.render(OPTIONS)
  const fullMs = performance.now() - start
  start = performance.now()
  for (let index = 0; index < rounds; index++) engine.render({ ...OPTIONS, baseRevision: 0 })
  const patchMs = performance.now() - start
  assert.ok(patchMs < fullMs, `expected ${patchMs.toFixed(2)}ms regional < ${fullMs.toFixed(2)}ms full`)

  const snapshot = engine.snapshot()
  const snapshotLayers = { overlay: snapshot.overlay, other: snapshot.other, edited: snapshot.edited }
  engine.layerDiffBounds(snapshotLayers, snapshotLayers)
  start = performance.now()
  for (let index = 0; index < rounds; index++) engine.layerDiffBounds(snapshotLayers, snapshotLayers)
  const diffMs = performance.now() - start
  t.diagnostic(`1121x1600 rendered bytes ${byteRatio.toFixed(1)}x smaller; ${rounds} full renders ${fullMs.toFixed(2)}ms, regional ${patchMs.toFixed(2)}ms; ${rounds} worst-case full diff scans ${diffMs.toFixed(2)}ms`)
})
