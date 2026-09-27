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
const { executionPageIds, selectionFromPages, executionPlan, executionJobRequest, addPageToNextRound, workflowRoundName } = mod.exports
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
test('formal workbench request includes selected pages in current project order and current revision', () => {
  const pages = [
    { id: '01', filename: '01.jpg', mask_ready: false },
    { id: '02', filename: '02.jpg', mask_ready: true },
    { id: '03', filename: '03.jpg', mask_ready: true },
  ]
  const selection = { mode: 'pages', pageIds: ['03', 'gone', '02'] }
  assert.deepEqual(executionPlan(pages, selection), { pageIds: ['02', '03'], missingMasks: [] })
  assert.deepEqual(executionJobRequest(pages, selection, ['firered'], 7), {
    workflows: ['firered'], expected_revision: 7, page_ids: ['02', '03'],
  })
  assert.throws(() => executionJobRequest(pages, { mode: 'all' }, ['firered'], 7), /01.jpg/)
  assert.throws(() => executionJobRequest(pages, { mode: 'pages', pageIds: ['gone'] }, ['firered'], 7), /至少選擇一張/)
})
test('workflow round labels use local month day and time without separators', () => {
  const date = new Date(2026, 8, 30, 14, 30, 22)
  assert.equal(workflowRoundName('flux2klein_lanpaint', date), 'Flux_0930143022')
  assert.equal(workflowRoundName('firered', date), 'FireRed_0930143022')
})
