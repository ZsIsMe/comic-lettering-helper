import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
const code = await readFile(new URL('../src/repair-scope.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { moveScopeEdge, fullRepairRect, defaultRepairRect, fitRepairGrid, repairRectangles, toggleRepairCell } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
test('unconfigured pages start ten pixels inside each edge, with nonempty bounds on tiny images', () => {
  assert.deepEqual(defaultRepairRect(1120, 1600), { x: 10, y: 10, width: 1100, height: 1580 })
  assert.deepEqual(defaultRepairRect(1, 4), { x: 0, y: 1, width: 1, height: 2 })
})
test('manual four-line movement uses pixel coordinates without crossing or leaving the page', () => {
  let rect = fullRepairRect(100, 80)
  for (const [edge, position] of [['left', 10.4], ['right', 90], ['top', 20], ['bottom', 70]]) rect = moveScopeEdge(rect, edge, position, 100, 80)
  assert.deepEqual(rect, { x: 10, y: 20, width: 80, height: 50 })
  assert.deepEqual(moveScopeEdge(rect, 'left', 500, 100, 80), { x: 89, y: 20, width: 1, height: 50 })
  assert.equal(moveScopeEdge(rect, 'top', -10, 100, 80).y, 0)
  assert.equal(moveScopeEdge(rect, 'bottom', -10, 100, 80).height, 1)
  assert.equal(moveScopeEdge(rect, 'right', 150, 100, 80).width, 90)
  assert.deepEqual(fullRepairRect(100, 80), { x: 0, y: 0, width: 100, height: 80 })
})
test('legacy rectangles become one selected grid cell without changing bounds', () => {
  for (const rect of [defaultRepairRect(100, 80), fullRepairRect(100, 80), {x:0,y:10,width:40,height:70}, {x:30,y:0,width:70,height:30}]) {
    assert.deepEqual(repairRectangles(fitRepairGrid(rect, 100, 80), 100, 80), [rect])
  }
})
test('multiple lit cells remain independent half-open rectangles; empty selection means no repair', () => {
  let grid = { verticalGuides: [40, 70], horizontalGuides: [30], selectedCells: [] }
  grid = toggleRepairCell(toggleRepairCell(grid, 10, 20), 80, 60)
  assert.deepEqual(repairRectangles(grid, 100, 80), [{x:0,y:0,width:40,height:30}, {x:70,y:30,width:30,height:50}])
  grid = toggleRepairCell(toggleRepairCell(grid, 10, 20), 80, 60)
  assert.deepEqual(repairRectangles(grid, 100, 80), [])
  assert.deepEqual(toggleRepairCell({verticalGuides:[],horizontalGuides:[],selectedCells:[]}, 0, 0).selectedCells, [{column:0,row:0}])
})
test('apply-all fitting collapses out-of-bounds guides and remaps selected cells like backend', () => {
  const grid = {verticalGuides:[10,50,90],horizontalGuides:[20,60],selectedCells:[{column:1,row:0},{column:3,row:2}]}
  assert.deepEqual(fitRepairGrid(grid, 40, 50), {verticalGuides:[10,39],horizontalGuides:[20,49],selectedCells:[{column:1,row:0},{column:2,row:2}]})
  assert.deepEqual(fitRepairGrid(grid, 1, 1), {verticalGuides:[],horizontalGuides:[],selectedCells:[{column:0,row:0}]})
  assert.deepEqual(grid.verticalGuides, [10,50,90])
})
