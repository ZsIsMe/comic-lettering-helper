const test = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const path = require('node:path')

function compile(name, dependencies = {}) {
  const source = readFileSync(path.join(__dirname, '../src', name), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const mod = { exports: {} }
  new Function('exports', 'require', code)(mod.exports, dependency => dependencies[dependency] || require(dependency))
  return mod.exports
}
const selection = compile('execution-selection.ts')
const { canConfirmRoundPage, roundRows, pageRoundView, roundSelectionChanges } = compile('round-comparison.ts', { './execution-selection': selection })

test('pages without a usable candidate remain pending unless the mask is passthrough', () => {
  assert.equal(canConfirmRoundPage(undefined), false)
  assert.equal(canConfirmRoundPage({ passthrough: false, candidates: [{ available: false }] }), false)
  assert.equal(canConfirmRoundPage({ passthrough: false, candidates: [{ available: true }] }), true)
  assert.equal(canConfirmRoundPage({ passthrough: true, candidates: [] }), true)
})

test('round comparison can change several selections and clear all in one action', () => {
  const candidates = [
    { code: 2, selected: true }, { code: 3, selected: true }, { code: 4, selected: false },
  ]
  assert.deepEqual(roundSelectionChanges(candidates, [4]), [
    { code: 2, selected: false }, { code: 3, selected: false }, { code: 4, selected: true },
  ])
  assert.deepEqual(roundSelectionChanges(candidates, []), [
    { code: 2, selected: false }, { code: 3, selected: false },
  ])
})

test('formal round comparison keeps distinct runs of the same workflow and decodes hidden adopted sources', () => {
  const runs = [
    { id: 'old', created_at: '2026-09-26T03:01:02', workflows: ['firered'] },
    { id: 'new', created_at: '2026-09-26T04:05:06', workflows: ['firered'] },
  ]
  const composition = {
    revision: 14,
    candidates: [
      { run_id: 'old', workflow: 'firered', code: 2, selected: false },
      { run_id: 'new', workflow: 'firered', code: 3, selected: true },
    ],
    pages: [
      { page_id: 'p1', candidates: [{ code: 2, workflow: 'firered', available: true }, { code: 3, workflow: 'firered', available: false }] },
      { page_id: 'p2', candidates: [{ code: 2, workflow: 'firered', available: true }, { code: 3, workflow: 'firered', available: true }] },
    ],
  }
  const rows = roundRows(composition, runs)
  assert.deepEqual(rows.map(row => [row.code, row.label, row.generatedCount]), [
    [2, 'FireRed_0926030102', 2], [3, 'FireRed_0926040506', 1],
  ])
  const first = pageRoundView('/api/projects/id/round-composition', 'p1', composition.revision, rows, composition.pages[0].candidates)
  assert.deepEqual(first.selectedCodes, [3])
  assert.deepEqual(first.missing.map(item => item.code), [3])
  assert.deepEqual(first.options.map(item => item.code), [2], 'hidden but adopted code still loads')
  assert.match(first.options[0].url, /source=candidate:2$/)
  assert.match(first.options[0].diffUrl, /source=diff:2&revision=14$/)
})
