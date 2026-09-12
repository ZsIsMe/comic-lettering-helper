import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/edit-preview.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { renderEditViews } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)
const options = { maskPercent: 100, maskColor: [255,255,255], showOther: true, otherPercent: 50, otherColor: [255,110,165] }
function layers() {
  return { base: new Uint8ClampedArray([40,60,80,255, 100,120,140,255, 200,180,160,255]),
    overlay: new Uint8ClampedArray([210,220,230,255, 210,220,230,255, 0,0,0,0]),
    other: new Uint8ClampedArray(12), edited: new Uint8ClampedArray(12),
    detectedText: new Uint8ClampedArray([255,255,255,255, 0,0,0,255, 0,0,0,255]) }
}

test('left original/Mask endpoints preserve the original and show text, not the full fill region', () => {
  const input = layers()
  const { left, right } = renderEditViews(input, options)
  assert.deepEqual([...left], [255,255,255,255, 0,0,0,255, 0,0,0,255])
  assert.deepEqual([...right], [210,220,230,255, 210,220,230,255, 200,180,160,255])
  const original = renderEditViews(input, {...options, maskPercent: 0})
  assert.deepEqual(original.left, input.base)
  assert.deepEqual(original.right, right)
  input.edited[4] = 255
  assert.deepEqual([...renderEditViews(input, options).left.slice(4,8)], [255,255,255,255])
})

test('right preview follows current fill, repair, erase and restored layers before any save', () => {
  const input = layers()
  const before = input.overlay.slice()
  input.overlay.set([20,30,40,255], 8)
  assert.deepEqual([...renderEditViews(input, options).right.slice(8)], [20,30,40,255])
  input.overlay.fill(0, 8); input.other[8] = 255
  assert.deepEqual([...renderEditViews(input, options).right.slice(8)], [228,145,163,255])
  assert.deepEqual(renderEditViews(input, {...options, showOther:false}).right.slice(8), input.base.slice(8))
  input.other[8] = 0
  assert.deepEqual(renderEditViews(input, options).right.slice(8), input.base.slice(8))
  input.overlay = before
  assert.deepEqual(renderEditViews(input, options).right, renderEditViews(layers(), options).right)
})

test('display changes do not mutate exported layers or the right-hand fill', () => {
  const input = layers()
  const before = Object.fromEntries(Object.entries(input).map(([key, pixels]) => [key, pixels.slice()]))
  const first = renderEditViews(input, options)
  const changed = renderEditViews(input, {...options, maskPercent: 35, maskColor: [10,200,80]})
  assert.deepEqual(input, before)
  assert.deepEqual(changed.right, first.right)
  assert.notDeepEqual(changed.left, first.left)
})
