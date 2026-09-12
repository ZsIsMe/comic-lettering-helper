import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/local-edit-roi.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { clampLocalRect, offsetLocalRect } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('expanded ROI is clipped to the actual page without shifting the opposite edge', () => {
  assert.deepEqual(offsetLocalRect({ x: 10, y: 20, width: 40, height: 60 }, 32, 100, 100),
    { x: 0, y: 0, width: 82, height: 100 })
})
test('shrinking a small ROI keeps both axes aligned and never crosses the boundaries', () => {
  assert.deepEqual(offsetLocalRect({ x: 10, y: 20, width: 20, height: 9 }, -32, 100, 100),
    { x: 14, y: 24, width: 12, height: 1 })
  const single = { x: 4, y: 7, width: 1, height: 1 }
  assert.deepEqual(offsetLocalRect(single, -32, 100, 100), single)
})
test('coordinates beyond the page always leave a valid nonempty ROI', () => {
  assert.deepEqual(clampLocalRect({ x: 999, y: 999, width: -20, height: 0 }, 100, 80),
    { x: 99, y: 79, width: 1, height: 1 })
  assert.deepEqual(clampLocalRect({ x: 95, y: 78, width: 20, height: 30 }, 100, 80),
    { x: 95, y: 78, width: 5, height: 2 })
})
