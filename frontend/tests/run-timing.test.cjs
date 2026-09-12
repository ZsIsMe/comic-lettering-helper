const test = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const code = ts.transpileModule(readFileSync(path.join(__dirname, '../src/run-timing.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText
const mod = { exports: {} }
new Function('exports', code)(mod.exports)
const { runTiming } = mod.exports
const start = Date.parse('2026-09-13T00:00:00Z')
const run = { state: 'running', created_at: new Date(start).toISOString(), updated_at: new Date(start + 70000).toISOString() }

test('running elapsed time advances, includes packaging, and survives refresh from persisted start', () => {
  assert.equal(runTiming(run, start + 61000).text, '已運行 1 分 1 秒')
  assert.equal(runTiming({ ...run, state: 'packaging' }, start + 71000).text, '已運行 1 分 11 秒')
  assert.equal(runTiming(JSON.parse(JSON.stringify(run)), start + 72000).text, '已運行 1 分 12 秒')
})
test('completed failed and abandoned stay fixed even if clock and metadata advance', () => {
  for (const state of ['completed', 'failed', 'abandoned']) {
    const ended = { ...run, state, finished_at: new Date(start + 65000).toISOString() }
    assert.equal(runTiming(ended, start + 90000).text, '總耗時 1 分 5 秒')
    assert.equal(runTiming({ ...ended, updated_at: new Date(start + 800000).toISOString() }, start + 1000000).text, '總耗時 1 分 5 秒')
  }
})
test('old records fall back to saved end time; missing dates never show NaN', () => {
  assert.equal(runTiming({ ...run, state: 'completed' }, start + 999000).text, '總耗時 1 分 10 秒')
  assert.equal(runTiming({ state: 'completed' }, start).text, '耗時資料不可用')
  assert.equal(runTiming(run, start - 5000).text, '已運行 0 秒')
})
