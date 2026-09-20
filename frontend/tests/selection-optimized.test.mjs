import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/selection-core.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const optimized = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

// Frozen copy of the pre-optimization core. Keep this independent from production helpers.
function checkSize(width, height, ...lengths) {
  const size = width * height
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 0 || height < 0 || lengths.some(length => length !== size)) {
    throw new RangeError('Selection dimensions do not match the image')
  }
  return size
}
function visitNeighbors(index, width, height, visit) {
  const x = index % width, y = Math.floor(index / width)
  for (let yy = Math.max(0, y - 1); yy <= Math.min(height - 1, y + 1); yy++) {
    for (let xx = Math.max(0, x - 1); xx <= Math.min(width - 1, x + 1); xx++) {
      const next = yy * width + xx
      if (next !== index) visit(next)
    }
  }
}
function legacyOffsetMask(mask, width, height, offset, preciseDisk = false) {
  const radius = Math.min(Math.max(width, height), Math.abs(Math.trunc(offset)))
  if (!radius || !mask.some(Boolean)) return mask.slice()
  const dilate = offset > 0
  const result = new Uint8Array(mask.length)
  if (!dilate) result.fill(1)
  const sums = new Uint32Array((width + 1) * height)
  for (let y = 0; y < height; y++) {
    const row = y * (width + 1)
    for (let x = 0; x < width; x++) sums[row + x + 1] = sums[row + x] + Number(mask[y * width + x] > 0)
  }
  for (let dy = -radius; dy <= radius; dy++) {
    const span = Math.sqrt(radius * radius - dy * dy)
    const half = preciseDisk ? Math.floor(span) : Math.round(span)
    for (let y = Math.max(0, -dy); y < Math.min(height, height - dy); y++) {
      const row = (y + dy) * (width + 1)
      for (let x = 0; x < width; x++) {
        const i = y * width + x
        if (dilate ? result[i] : !result[i]) continue
        const left = Math.max(0, x - half), right = Math.min(width, x + half + 1)
        const count = sums[row + right] - sums[row + left]
        if (dilate ? count > 0 : count < right - left) result[i] = dilate ? 1 : 0
      }
    }
  }
  return result
}
function legacySelectionHoles(selection, width, height) {
  const exterior = new Uint8Array(selection.length)
  const queue = new Int32Array(selection.length)
  let head = 0, tail = 0
  const enqueue = i => {
    if (!selection[i] && !exterior[i]) { exterior[i] = 1; queue[tail++] = i }
  }
  if (!width || !height) return exterior
  for (let x = 0; x < width; x++) { enqueue(x); enqueue((height - 1) * width + x) }
  for (let y = 1; y < height - 1; y++) { enqueue(y * width); enqueue(y * width + width - 1) }
  while (head < tail) visitNeighbors(queue[head++], width, height, enqueue)
  return selection.map((value, i) => Number(!value && !exterior[i]))
}
function legacyCombineSelection(current, selection, width, height, op, offset = 0) {
  const size = checkSize(width, height, current.length, selection.length)
  const result = current.map(value => Number(value > 0))
  if (op === 'local_intersect') {
    const touched = new Uint8Array(size), queue = new Int32Array(size)
    let head = 0, tail = 0
    const enqueue = i => {
      if (current[i] && !touched[i]) { touched[i] = 1; queue[tail++] = i }
    }
    for (let i = 0; i < size; i++) if (current[i] && selection[i]) enqueue(i)
    while (head < tail) visitNeighbors(queue[head++], width, height, enqueue)
    const intersection = touched.map((value, i) => Number(value > 0 && selection[i] > 0))
    const local = legacyOffsetMask(intersection, width, height, offset)
    for (let i = 0; i < size; i++) result[i] = Number((result[i] && !touched[i]) || local[i])
  } else if (op === 'selection_inner' || op === 'add_selection_inner') {
    const holes = legacySelectionHoles(selection, width, height)
    for (let i = 0; i < size; i++) if (holes[i] || (op === 'add_selection_inner' && selection[i])) result[i] = 1
  } else {
    for (let i = 0; i < size; i++) if (selection[i]) result[i] = op === 'subtract' ? 0 : 1
  }
  return result
}
function legacyMagicSelection(rgba, width, height, x, y, tolerance, expand) {
  const size = checkSize(width, height, rgba.length / 4)
  const result = new Uint8Array(size)
  x = Math.floor(x); y = Math.floor(y)
  if (x < 0 || x >= width || y < 0 || y >= height || !Number.isFinite(x + y)) return result
  const seed = (y * width + x) * 4
  const limit = Math.max(0, Math.min(255, tolerance))
  const seen = new Uint8Array(size), queue = new Int32Array(size)
  let head = 0, tail = 0
  const enqueue = i => {
    if (seen[i]) return
    seen[i] = 1
    const p = i * 4
    if (Math.abs(rgba[p] - rgba[seed]) <= limit && Math.abs(rgba[p + 1] - rgba[seed + 1]) <= limit && Math.abs(rgba[p + 2] - rgba[seed + 2]) <= limit) {
      result[i] = 1; queue[tail++] = i
    }
  }
  enqueue(y * width + x)
  while (head < tail) visitNeighbors(queue[head++], width, height, enqueue)
  return expand > 0 ? legacyOffsetMask(result, width, height, expand, expand > 16) : result
}

let randomState = 0x92c0ffee
function random() {
  randomState ^= randomState << 13; randomState ^= randomState >>> 17; randomState ^= randomState << 5
  return (randomState >>> 0) / 0x100000000
}
const integer = limit => Math.floor(random() * limit)

test('optimized fixed-seed flood fill and ellipse expansion match the frozen oracle on random small images', () => {
  const expands = [0, 1, 2, 5, 16, 17, 32]
  const tolerances = [0, 1, 7, 28, 64, 255, Number.NaN]
  for (let iteration = 0; iteration < 700; iteration++) {
    const width = 1 + integer(18), height = 1 + integer(18)
    const palette = Array.from({ length: 6 }, () => [integer(256), integer(256), integer(256), integer(256)])
    const rgba = new Uint8ClampedArray(width * height * 4)
    for (let n = 0; n < width * height; n++) rgba.set(palette[integer(palette.length)], n * 4)
    const x = integer(width), y = integer(height)
    const tolerance = tolerances[integer(tolerances.length)], expand = expands[integer(expands.length)]
    assert.deepEqual(optimized.magicSelection(rgba, width, height, x, y, tolerance, expand),
      legacyMagicSelection(rgba, width, height, x, y, tolerance, expand),
      `magic iteration=${iteration} ${width}x${height} seed=${x},${y} tolerance=${tolerance} expand=${expand}`)
  }
})

test('optimized local intersection keeps legacy neutral borders, ellipse rounding, and erosion on random masks', () => {
  const operations = ['add', 'subtract', 'local_intersect', 'selection_inner', 'add_selection_inner']
  const offsets = [-32, -17, -16, -5, -1, 0, 1, 5, 16, 17, 32]
  for (let iteration = 0; iteration < 700; iteration++) {
    const width = 1 + integer(20), height = 1 + integer(20), size = width * height
    const current = Uint8Array.from({ length: size }, () => Number(random() < .45))
    const selection = Uint8Array.from({ length: size }, () => Number(random() < .38))
    const operation = operations[integer(operations.length)], offset = offsets[integer(offsets.length)]
    assert.deepEqual(optimized.combineSelection(current, selection, width, height, operation, offset),
      legacyCombineSelection(current, selection, width, height, operation, offset),
      `combine iteration=${iteration} ${width}x${height} operation=${operation} offset=${offset}`)
  }
})

function syntheticRgba(kind, width, height) {
  const rgba = new Uint8ClampedArray(width * height * 4)
  let state = 0x7f4a7c15
  const noise = () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5
    return state >>> 0
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let value = 255
    if (kind === 'checkerboard') value = (x + y) % 2 ? 255 : 0
    else if (kind === 'threshold-noise') value = noise() % 10 < 7 ? 96 + noise() % 17 : 220
    const i = (y * width + x) * 4
    rgba.set([value, value, value, 255], i)
  }
  if (kind === 'threshold-noise') rgba.set([104, 104, 104, 255], (Math.floor(height / 2) * width + Math.floor(width / 2)) * 4)
  return rgba
}

test('full-page fragmented and solid selections remain bit exact and expose run-density performance', { timeout: 60000 }, t => {
  const width = 1121, height = 1600
  const rows = []
  for (const kind of ['checkerboard', 'threshold-noise', 'all-white']) {
    const rgba = syntheticRgba(kind, width, height)
    const x = kind === 'threshold-noise' ? Math.floor(width / 2) : 0
    const y = kind === 'threshold-noise' ? Math.floor(height / 2) : 0
    const tolerance = kind === 'threshold-noise' ? 28 : 0
    for (const expand of [16, 32]) {
      const measure = fn => {
        const started = performance.now()
        const value = fn(rgba, width, height, x, y, tolerance, expand)
        return { value, ms: performance.now() - started }
      }
      const legacyCold = measure(legacyMagicSelection), optimizedCold = measure(optimized.magicSelection)
      assert.deepEqual(optimizedCold.value, legacyCold.value, `${kind} cold expand=${expand}`)
      const selected = optimizedCold.value.reduce((sum, value) => sum + value, 0)
      legacyCold.value = null; optimizedCold.value = null
      const legacyHotTimes = [], optimizedHotTimes = []
      for (let repeat = 0; repeat < 3; repeat++) {
        // Alternate order so neither implementation is consistently charged for GC/JIT work.
        const first = repeat % 2 ? measure(optimized.magicSelection) : measure(legacyMagicSelection)
        const second = repeat % 2 ? measure(legacyMagicSelection) : measure(optimized.magicSelection)
        const legacyHot = repeat % 2 ? second : first, optimizedHot = repeat % 2 ? first : second
        assert.deepEqual(optimizedHot.value, legacyHot.value, `${kind} hot expand=${expand} repeat=${repeat}`)
        legacyHotTimes.push(legacyHot.ms); optimizedHotTimes.push(optimizedHot.ms)
        legacyHot.value = null; optimizedHot.value = null
      }
      legacyHotTimes.sort((a, b) => a - b); optimizedHotTimes.sort((a, b) => a - b)
      rows.push({ kind, expand, selected,
        legacyColdMs: +legacyCold.ms.toFixed(2), optimizedColdMs: +optimizedCold.ms.toFixed(2),
        legacyHotMedianMs: +legacyHotTimes[1].toFixed(2), optimizedHotMedianMs: +optimizedHotTimes[1].toFixed(2) })
    }
  }
  t.diagnostic(`run-density benchmark ${JSON.stringify(rows)}`)
})

const imageRoot = '/Users/zhongsheng/Documents/comic_data/comic_translator_playwright/images/昭和のグラゼニ-raw-【第92話】'
const pillowPython = '/Users/zhongsheng/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3'
const realCases = [
  { page: 3, x: 840, y: 1200, tolerance: 28 },
  { page: 7, x: 280, y: 400, tolerance: 28 },
  { page: 16, x: 560, y: 800, tolerance: 28 },
]
const hasRealFixture = existsSync(pillowPython) && realCases.every(item => existsSync(`${imageRoot}/${item.page}.jpg`))

test('optimized magic selection is bit exact on real manga pages at expansion 0, 16, and 32', { skip: !hasRealFixture, timeout: 30000 }, t => {
  const timings = []
  for (const item of realCases) {
    const decoded = spawnSync(pillowPython, ['-c',
      'from PIL import Image; import sys; sys.stdout.buffer.write(Image.open(sys.argv[1]).convert("RGBA").tobytes())',
      `${imageRoot}/${item.page}.jpg`], { maxBuffer: 16 * 1024 * 1024 })
    assert.equal(decoded.status, 0, decoded.stderr?.toString())
    const rgba = new Uint8ClampedArray(decoded.stdout.buffer, decoded.stdout.byteOffset, decoded.stdout.byteLength)
    assert.equal(rgba.length, 1121 * 1600 * 4)
    for (const expand of [0, 16, 32]) {
      let started = performance.now()
      const expected = legacyMagicSelection(rgba, 1121, 1600, item.x, item.y, item.tolerance, expand)
      const legacyMs = performance.now() - started
      started = performance.now()
      const actual = optimized.magicSelection(rgba, 1121, 1600, item.x, item.y, item.tolerance, expand)
      const optimizedMs = performance.now() - started
      assert.deepEqual(actual, expected, `page=${item.page} seed=${item.x},${item.y} tolerance=${item.tolerance} expand=${expand}`)
      timings.push({ ...item, expand, selected: actual.reduce((sum, value) => sum + value, 0),
        legacyMs: +legacyMs.toFixed(2), optimizedMs: +optimizedMs.toFixed(2) })
    }
  }
  t.diagnostic(`real manga benchmark ${JSON.stringify(timings)}`)
})
