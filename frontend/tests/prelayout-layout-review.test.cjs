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
const { textStyle, cropRegions } = load(path.resolve(__dirname, '../src/prelayout/layout-review.ts'))

test('shared text style uses original image coordinates and live paint properties', () => {
  const style = textStyle({ x: .25, y: .75, rotation: 23, orientation: 'vertical', 'font-size': 36, color: '000', 'stroke-color': 'white', 'stroke-weight': 4 }, { width: 2000, height: 1000 })
  assert.equal(style.left, 500)
  assert.equal(style.top, 750)
  assert.equal(style.transform, 'translate(-50%, -50%) rotate(-23deg)')
  assert.equal(style.writingMode, 'vertical-rl')
  assert.equal(style.fontSize, 36)
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
