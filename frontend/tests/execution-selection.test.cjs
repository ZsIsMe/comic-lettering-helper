const test = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const code = ts.transpileModule(readFileSync(path.join(__dirname, '../src/execution-selection.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText
const mod = { exports: {} }
new Function('exports', code)(mod.exports)
const { executionPageIds, selectionFromPages, addPageToNextRound, workflowRoundName } = mod.exports
const ids = ['01', '02', '03']
test('add from all replaces selection; subsequent additions dedupe and retain project order', () => {
  const first = addPageToNextRound({ mode: 'all' }, '02', ids)
  assert.deepEqual(executionPageIds(first, ids), ['02'])
  const next = addPageToNextRound(first, '01', ids)
  assert.deepEqual(executionPageIds(next, ids), ['01', '02'])
  assert.deepEqual(addPageToNextRound(next, '02', ids), next)
  assert.deepEqual(addPageToNextRound(next, 'missing', ids), next)
  assert.deepEqual(executionPageIds(first, ids), ['02'])
})
test('normalize full selection and ignore stale page IDs', () => {
  assert.deepEqual(selectionFromPages(['03', '02', '01', 'gone'], ids), { mode: 'all' })
  assert.deepEqual(executionPageIds({ mode: 'pages', pageIds: ['gone', '03'] }, ids), ['03'])
  assert.deepEqual(selectionFromPages([], ids), { mode: 'pages', pageIds: [] })
})
test('workflow round labels use local month day and time without separators', () => {
  const date = new Date(2026, 8, 30, 14, 30, 22)
  assert.equal(workflowRoundName('flux2klein_lanpaint', date), 'Flux_0930143022')
  assert.equal(workflowRoundName('firered', date), 'FireRed_0930143022')
})
