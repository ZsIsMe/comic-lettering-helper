const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const file = path.resolve(__dirname, '../src/prelayout/difference-mask.ts')
const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const moduleValue = { exports: {} }
new Function('module', 'exports', code)(moduleValue, moduleValue.exports)
const { DIFFERENCE_THRESHOLD, paintDifferencePixels } = moduleValue.exports

test('difference mask keeps small changes transparent and paints larger changes into a neutral mask', () => {
  const source = new Uint8ClampedArray([10, 20, 30, 255, 10, 20, 30, 255])
  const clean = new Uint8ClampedArray([20, 30, 40, 255, 80, 20, 30, 255])
  const output = new Uint8ClampedArray(source.length)
  paintDifferencePixels(source, clean, output, 0, 2)
  assert.equal(DIFFERENCE_THRESHOLD, 24)
  assert.deepEqual([...output.slice(0, 4)], [255, 255, 255, 0])
  assert.equal(output[4], 255)
  assert.equal(output[5], 255)
  assert.equal(output[6], 255)
  assert.ok(output[7] > 0)
})

test('difference mask can paint a bounded pixel range for frame-by-frame work', () => {
  const source = new Uint8ClampedArray(12)
  const clean = new Uint8ClampedArray(12); clean.fill(255)
  const output = new Uint8ClampedArray(12)
  paintDifferencePixels(source, clean, output, 1, 2)
  assert.equal(output[3], 0)
  assert.equal(output[7], 210)
  assert.equal(output[11], 0)
})
