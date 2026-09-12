import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/selection-core.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { combineSelection, magicSelection, polygonSelection, rectangleSelection } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const mask = (...rows) => Uint8Array.from(rows.join(''), Number)
const rgba = (...rows) => Uint8ClampedArray.from(rows.flatMap(row => row.flatMap(v => [v, v, v, 255])))

test('local intersection trims only touched 8-connected components and never adds a new region', () => {
  const current = mask('110001', '110001', '001000', '000000')
  const selection = mask('100000', '000000', '000000', '000011')
  assert.deepEqual(combineSelection(current, selection, 6, 4, 'local_intersect'), mask('100001', '000001', '000000', '000000'))
  assert.deepEqual(combineSelection(current, mask('000000', '000000', '000000', '000011'), 6, 4, 'local_intersect'), current)
})

test('local intersection offset expands or contracts the retained part without clearing untouched components', () => {
  const current = mask('0000000', '0111000', '0111000', '0111000', '0000001')
  const selection = rectangleSelection(1, 1, 3, 3, 7, 5)
  assert.deepEqual(combineSelection(current, selection, 7, 5, 'local_intersect', -1), mask('0000000', '0000000', '0010000', '0000000', '0000001'))
  assert.deepEqual(combineSelection(current, rectangleSelection(2, 2, 2, 2, 7, 5), 7, 5, 'local_intersect', 1), mask('0000000', '0010000', '0111000', '0010000', '0000001'))
})

test('inner selection adds enclosed holes; selection plus inner also adds the shell', () => {
  const ring = mask('0000000', '0111110', '0100010', '0100010', '0111110', '0000000')
  const current = mask('1000000', '0000000', '0000000', '0000000', '0000000', '0000000')
  assert.deepEqual(combineSelection(current, ring, 7, 6, 'selection_inner'), mask('1000000', '0000000', '0011100', '0011100', '0000000', '0000000'))
  assert.deepEqual(combineSelection(current, ring, 7, 6, 'add_selection_inner'), mask('1000000', '0111110', '0111110', '0111110', '0111110', '0000000'))
  const openDiagonal = mask('00000', '00110', '01010', '01110', '00000')
  assert.deepEqual(combineSelection(new Uint8Array(25), openDiagonal, 5, 5, 'selection_inner'), new Uint8Array(25))
})

test('magic wand uses seed colour, per-channel tolerance and eight-connected regions', () => {
  assert.deepEqual(magicSelection(rgba([0, 9, 18, 27]), 4, 1, 0, 0, 10, 0), mask('1100'))
  assert.deepEqual(magicSelection(rgba([0, 255, 255], [255, 0, 255], [255, 255, 0]), 3, 3, 0, 0, 0, 0), mask('100', '010', '001'))
  const colors = Uint8ClampedArray.from([10, 20, 30, 255, 20, 30, 40, 0, 21, 20, 30, 255])
  assert.deepEqual(magicSelection(colors, 3, 1, 0, 0, 10, 0), mask('110'))
})

test('magic expansion follows ellipse dilation and stays within image dimensions', () => {
  const image = rgba([255, 255, 255], [255, 0, 255], [255, 255, 255])
  assert.deepEqual(magicSelection(image, 3, 3, 1, 1, 0, 1), mask('010', '111', '010'))
  assert.deepEqual(magicSelection(image, 3, 3, -1, 1, 0, 1), new Uint8Array(9))
})

test('preview calculation is immutable and its accepted result is identical', () => {
  const image = rgba([255, 0, 255], [255, 0, 255])
  const originalImage = image.slice(), current = mask('100', '000'), originalMask = current.slice()
  const selection = magicSelection(image, 3, 2, 1, 0, 0, 1), originalSelection = selection.slice()
  const preview = combineSelection(current, selection, 3, 2, 'add')
  const accepted = combineSelection(current, magicSelection(image, 3, 2, 1, 0, 0, 1), 3, 2, 'add')
  assert.deepEqual(preview, accepted)
  assert.deepEqual(image, originalImage)
  assert.deepEqual(current, originalMask)
  assert.deepEqual(selection, originalSelection)
  assert.deepEqual(combineSelection(preview, mask('010', '010'), 3, 2, 'subtract'), mask('101', '101'))
})

test('rectangles include endpoint pixels, work in either drag direction and clip off-image selections', () => {
  assert.deepEqual(rectangleSelection(2, 2, 1, 1, 4, 4), mask('0000', '0110', '0110', '0000'))
  assert.deepEqual(rectangleSelection(0, 0, 0, 0, 3, 2), mask('100', '000'))
  assert.deepEqual(rectangleSelection(-9, 0, -2, 2, 3, 2), mask('000', '000'))
  assert.deepEqual(rectangleSelection(-9, -9, 20, 20, 3, 2), mask('111', '111'))
})

test('lasso fills a closed polygon including edges and ignores unfinished polygons', () => {
  const points = [{ x: 1, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 3 }, { x: 1, y: 3 }]
  assert.deepEqual(polygonSelection(points, 5, 5), mask('00000', '01110', '01110', '01110', '00000'))
  assert.deepEqual(polygonSelection(points.slice(0, 2), 5, 5), new Uint8Array(25))
  const concave = [{x:0,y:0},{x:3,y:0},{x:3,y:1},{x:1,y:1},{x:1,y:3},{x:0,y:3}]
  assert.deepEqual(polygonSelection(concave, 4, 4), mask('1111', '1111', '1100', '1100'))
})

test('dimensions are validated instead of silently applying a misaligned mask', () => {
  assert.throws(() => combineSelection(new Uint8Array(4), new Uint8Array(3), 2, 2, 'add'), RangeError)
  assert.throws(() => magicSelection(new Uint8ClampedArray(4), 2, 2, 0, 0, 0, 0), RangeError)
})
