const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const cache = new Map()
function load(file) {
  if (cache.has(file)) return cache.get(file).exports
  const module = { exports: {} }; cache.set(file, module)
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', code)(name => {
    assert(name.startsWith('./'))
    return load(path.resolve(path.dirname(file), `${name}.ts`))
  }, module, module.exports)
  return module.exports
}
const { textStyle, cropRegions, candidateRegion, candidateSheetScales } = load(path.resolve(__dirname, '../src/prelayout/layout-review.ts'))

test('shared text style uses original image coordinates and live paint properties', () => {
  const style = textStyle({ x: .25, y: .75, rotation: 23, orientation: 'vertical', 'font-size': 36, color: '000', 'stroke-color': 'white', 'stroke-weight': 4 }, { width: 2000, height: 1000 })
  assert.equal(style.left, 500)
  assert.equal(style.top, 750)
  assert.equal(style.transform, 'translate(-50%, -50%) rotate(-23deg)')
  assert.equal(style.writingMode, 'vertical-rl')
  assert.equal(style.fontSize, 36)
  assert.equal(style.fontVariantLigatures, 'discretionary-ligatures')
  assert.equal(style.fontFeatureSettings, '"onum" 1, "palt" 0, "vpal" 1')
  assert.equal(textStyle({ x: .25, y: .75, rotation: 23, orientation: 'horizontal', 'font-size': 36, color: '000', 'stroke-color': 'white', 'stroke-weight': 4 }, { width: 2000, height: 1000 }).fontFeatureSettings, '"onum" 1, "palt" 1, "vpal" 0')
  assert.equal(style.color, '#000')
  assert.equal(style.WebkitTextStroke, '4px #ffffff')
})

test('crop regions include old and new positions, clamp to page, and merge nearby changes', () => {
  const page = { width: 1000, height: 800 }
  const regions = cropRegions(page, page, {
    a: [10, 20, 30, 40], b: [110, 20, 140, 50], c: [200, 200, 230, 230],
  }, {
    a: [22, 20, 42, 40], b: [120, 20, 150, 50], c: [900, 700, 950, 760],
  }, ['a', 'b', 'c'], 40)
  assert.deepEqual(regions, [[0, 0, 190, 90], [160, 160, 270, 270], [860, 660, 990, 800]])
})

test('unmeasured IDs produce no crop and invalid geometry cannot enter a region', () => {
  const page = { width: 1000, height: 800 }
  assert.deepEqual(cropRegions(page, page, {}, {}, ['missing'], 80), [])
  assert.deepEqual(cropRegions(page, page, { a: [NaN, 1, 2, 3] }, {}, ['a'], 80), [])
})

test('candidate crop includes original context and every trial at one shared region', () => {
  const page = { width: 1000, height: 800, items: [{ _id: 'a', xyxy_pixel: [80, 100, 200, 200] }, { _id: 'b' }] }
  const measurements = [
    { rects: { a: [100, 120, 180, 190], b: [400, 100, 450, 150] } },
    { rects: { a: [110, 160, 220, 250], b: [390, 110, 430, 160] } },
    { rects: { a: [70, 130, 210, 240], b: [480, 120, 510, 170] } },
  ]
  assert.deepEqual(candidateRegion(page, ['a'], measurements, 20, [60, 80, 240, 220]), [40, 60, 260, 270])
  assert.deepEqual(candidateRegion(page, ['a', 'b'], measurements, 20), [50, 80, 530, 270])
  assert.deepEqual(candidateRegion(page, ['a'], measurements, 200), [0, 0, 420, 450])
  assert.throws(() => candidateRegion(page, ['missing'], measurements, 20), /沒有有效/)
})

test('all sheet rows fit viewport while each group uses one scale for all its candidates', () => {
  const groups = [
    { region: [0, 0, 400, 600], candidates: ['a', 'b', 'c'] },
    { region: [0, 0, 200, 200], candidates: ['a', 'b'] },
  ]
  const width = 992, height = 731
  const scales = candidateSheetScales(groups, width, height)
  assert.equal(scales.length, 2)
  assert(scales[1] > scales[0])
  let totalHeight = 0
  groups.forEach((group, index) => {
    const columns = group.candidates.length + 2
    assert((group.region[2] - group.region[0]) * scales[index] * columns + (columns - 1) * 12 + columns * 2 <= width + 1e-8)
    totalHeight += (group.region[3] - group.region[1]) * scales[index] + 70
  })
  assert(totalHeight <= height + 1e-8)
})
