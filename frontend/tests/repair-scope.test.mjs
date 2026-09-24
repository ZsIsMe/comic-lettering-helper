import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
const code = await readFile(new URL('../src/repair-scope.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
const { moveScopeEdge, fullRepairRect, defaultRepairRect } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)
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
