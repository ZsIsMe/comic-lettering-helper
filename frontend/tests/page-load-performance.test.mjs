import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'
const compiled = ts.transpileModule(await readFile(new URL('../src/page-load-performance.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const { startPageLoad, measurePageStage, getPageLoadRecords, clearPageLoadRecords, subscribePageLoads } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('failed stages retain durations and late callbacks cannot overwrite completed navigation records', async () => {
  clearPageLoadRecords()
  const trace = startPageLoad('page-a', 'navigate')
  const late = trace.stage('firstFrame')
  await assert.rejects(measurePageStage(trace, 'assets.total', async () => { throw new Error('decode failed') }), /decode failed/)
  trace.finish('failed')
  const saved = getPageLoadRecords()
  assert.equal(saved[0].status, 'failed')
  assert.ok(saved[0].stages['assets.total'] >= 0)
  assert.ok(saved[0].totalMs >= saved[0].stages['assets.total'])
  late(); trace.finish('ready')
  assert.deepEqual(getPageLoadRecords(), saved)
  saved[0].stages['assets.total'] = -1
  assert.ok(getPageLoadRecords()[0].stages['assets.total'] >= 0)
})

test('diagnostics bound history and notify only navigation start/end, without changing task outcomes', async () => {
  clearPageLoadRecords()
  let notifications = 0
  const unsubscribe = subscribePageLoads(() => { notifications++ })
  const badListener = subscribePageLoads(() => { throw new Error('diagnostics failure') })
  for (let index = 0; index < 25; index++) {
    const trace = startPageLoad(`page-${index}`, 'navigate')
    assert.equal(await measurePageStage(trace, 'save.wait', async () => true), true)
    await measurePageStage(trace, 'worker.init', async () => {})
    trace.finish()
  }
  unsubscribe(); badListener()
  assert.equal(notifications, 50)
  assert.equal(getPageLoadRecords().length, 20)
  assert.equal(getPageLoadRecords()[0].pageId, 'page-5')
  assert.equal(await measurePageStage(undefined, 'untraced', async () => 17), 17)
})
