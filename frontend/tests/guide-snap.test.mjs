import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from './compile.mjs'
const { findSnap, grayscale } = await load('guide-snap')
function pixels(rects = [], background = 255) {
  const gray = new Uint8Array(160 * 160).fill(background)
  for (const [x, y, w, h] of rects) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) gray[yy * 160 + xx] = 0
  return gray
}
function request(horizontal = true, position = 82, step = 1, extra = {}) {
  return { horizontal, position, step, parallel: [], perpendicular: [], whiteTolerance: 30, ...extra }
}
function find(image, r = request()) { return findSnap(image, 160, 160, r) }
// Expected positions independently specified by the Swift bdfbe8b8 regression suite.
test('two complete segments beat the nearer partial solution, including at the start', () => {
  const r = request(true, 82, 1, { perpendicular: [80] })
  assert.deepEqual(find(pixels([[100, 80, 20, 10]]), r), { position: 90, passingCount: 2, total: 2 })
  assert.equal(find(pixels([[10, 80, 10, 4], [100, 80, 20, 10]]), r).position, 90)
})
test('partial best stays at start; neighbor and 64-pixel range prevent finding more segments', () => {
  const r = request(true, 82, 1, { perpendicular: [80] })
  for (const h of [160, 155]) assert.equal(find(pixels([[100, 0, 10, h]]), r).position, 82)
  assert.equal(find(pixels([[100, 0, 10, 100]]), { ...r, parallel: [100] }).position, 82)
})
test('three segments prefer two when all three cannot pass; left and up keep the direction', () => {
  assert.deepEqual(find(pixels([[60, 80, 10, 10], [130, 0, 10, 160]]), request(true, 82, 1, { perpendicular: [50, 110] })), { position: 90, passingCount: 2, total: 3 })
  assert.equal(find(pixels([[100, 70, 10, 30]]), request(true, 82, -1, { perpendicular: [80] })).position, 69)
  assert.equal(find(pixels([[70, 100, 30, 10]]), request(false, 82, -1, { perpendicular: [80] })).position, 69)
})
test('four directions use exact first white pixels', () => {
  assert.equal(find(pixels([[10, 80, 140, 4]])).position, 84)
  assert.equal(find(pixels([[10, 80, 140, 4]]), request(true, 82, -1)).position, 79)
  assert.equal(find(pixels([[80, 10, 4, 140]]), request(false)).position, 84)
  assert.equal(find(pixels([[80, 10, 4, 140]]), request(false, 82, -1)).position, 79)
})
test('single pixel gaps and tiny complete segments count without content support', () => {
  assert.equal(find(pixels([[20, 70, 1, 3], [20, 74, 1, 20]]), request(true, 71)).position, 73)
  assert.equal(find(pixels([[20, 70, 1, 3], [20, 74, 1, 20]]), request(true, 80, -1)).position, 73)
  assert.deepEqual(find(pixels([[1, 0, 159, 160]]), request(true, 82, 1, { perpendicular: [1] })), { position: 82, passingCount: 1, total: 2 })
})
test('complete middle segment may win even if both outside segments have ink', () => {
  assert.equal(find(pixels([[10, 80, 20, 4], [100, 50, 20, 100]])), null)
  assert.equal(find(pixels([[0, 0, 40, 160], [50, 80, 20, 4], [120, 0, 40, 160]]), request(true, 82, 1, { perpendicular: [40, 120] })).position, 84)
})
test('hard limits: 64 included, 65 excluded, parallel line excluded, no reverse', () => {
  const image = pixels([[0, 0, 160, 100]])
  assert.equal(find(image, request(true, 36)).position, 100)
  assert.equal(find(image, request(true, 35)), null)
  assert.equal(find(image, request(true, 80, -1)), null)
  assert.equal(find(image, request(true, 80, 1, { parallel: [100] })), null)
  assert.equal(find(image, request(true, 80, 1, { parallel: [101] })).position, 100)
})
test('every pixel must meet tolerance, equality passes, no noise exemptions', () => {
  assert.equal(find(pixels([], 210)), null)
  assert.equal(find(pixels([], 210), request(true, 82, 1, { whiteTolerance: 45 })).position, 82)
  assert.equal(find(pixels([], 210), request(true, 82, 1, { whiteTolerance: 44 })), null)
  assert.equal(find(pixels([]), request(true, 82, 1, { whiteTolerance: 0 })).position, 82)
  assert.equal(find(pixels([], 0), request(true, 82, 1, { whiteTolerance: 255 })).position, 82)
  assert.equal(find(pixels([[20, 82, 1, 1]])).position, 83)
})
test('bad dimensions, step and fractional coordinates fail; crossed bounds are deduplicated', () => {
  assert.equal(findSnap(new Uint8Array(), 0, 0, request()), null)
  assert.equal(find(pixels(), request(true, 82, 0)), null)
  assert.equal(find(pixels(), request(true, 82.5)), null)
  assert.equal(find(pixels(), request(true, 0)), null)
  assert.deepEqual(find(pixels(), request(true, 82, 1, { perpendicular: [80, 80, -1, 200] })), { position: 82, passingCount: 2, total: 2 })
})
test('RGB weighted grayscale and white alpha background use original pixels', () => {
  assert.deepEqual([...grayscale(new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0, 0, 0, 0, 128]))], [76, 149, 29, 255, 127])
})
