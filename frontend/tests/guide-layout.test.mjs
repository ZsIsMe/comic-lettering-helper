import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from './compile.mjs'
const { addGuide, moveGuide, removeGuide, rectangles, toggleCell } = await load('guide-layout')
const edit = { verticalGuides: [100, 300], horizontalGuides: [200], selectedCells: [{ column: 1, row: 1 }] }
test('adding duplicate slot finds nearest free pixel, lower first, and clears selections', () => {
  const next = addGuide(edit, 'vertical', 300, 1000)
  assert.deepEqual(next.edit.verticalGuides, [100, 299, 300]); assert.deepEqual(next.edit.selectedCells, [])
  assert.deepEqual(next.active, { axis: 'vertical', index: 1 })
  assert.equal(addGuide(edit, 'vertical', 1, 2), null)
})
test('guide movement is integer, clamped to its neighbors, preserves selected grid', () => {
  const next = moveGuide(edit, { axis: 'vertical', index: 0 }, 500, 1000, 1000)
  assert.deepEqual(next.verticalGuides, [299, 300]); assert.deepEqual(next.selectedCells, edit.selectedCells)
  assert.equal(moveGuide(edit, { axis: 'vertical', index: 0 }, -2, 1000, 1000).verticalGuides[0], 1)
  assert.equal(moveGuide(edit, { axis: 'vertical', index: 0 }, 100.6, 1000, 1000).verticalGuides[0], 101)
})
test('delete clears cells; toggling a cell is reversible; exported bounds are half-open', () => {
  assert.deepEqual(removeGuide(edit, { axis: 'horizontal', index: 0 }).selectedCells, [])
  assert.deepEqual(rectangles(edit, 1000, 1000), [{ x: 100, y: 200, width: 200, height: 800 }])
  assert.deepEqual(toggleCell(toggleCell(edit, 50, 50), 50, 50), edit)
  assert.equal(toggleCell(edit, 100, 200).selectedCells.length, 0)
})
