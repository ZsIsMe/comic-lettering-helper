const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const fixture = [{ postscriptName: 'Test-Regular', family: 'Test', fullName: 'Test Regular', style: 'Regular', localizedFamily: '測試字體' }]
function catalogue(initial, fetcher) {
  const storage = new Map(initial ? [['pl-local-font-catalogue-v1', initial]] : [])
  const window = { addEventListener() {}, removeEventListener() {} }
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file)
    const module = { exports: {} }
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', 'localStorage', 'window', code)(name => name === './api' ? { base: '/api/prelayout', request: fetcher } : load(path.resolve(path.dirname(file), `${name}.ts`)), module, module.exports,
      { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) }, window)
    cache.set(file, module.exports); return module.exports
  }
  return { api: load(path.resolve(__dirname, '../src/prelayout/font-catalogue.ts')), storage }
}
test('cached catalogue is available across reloads without enumerating fonts again', async () => {
  let calls = 0
  const first = catalogue(null, async () => { calls++; return { available: true, fonts: fixture } })
  assert.equal(first.api.getCachedFonts().length, 0)
  await first.api.refreshFontCatalogue()
  assert.equal(calls, 1)
  const second = catalogue(first.storage.get('pl-local-font-catalogue-v1'), () => assert.fail('cache must not fetch'))
  assert.equal(second.api.getCachedFonts()[0].localizedFamily, '測試字體')
  assert.equal(second.api.getFontCatalogue(), second.api.getFontCatalogue())
})
test('explicit refresh is shared by simultaneous pickers and notifies subscribers', async () => {
  let finish, calls = 0, notifications = 0
  const item = catalogue(null, () => { calls++; return new Promise(resolve => { finish = resolve }) })
  const stop = item.api.subscribeFontCatalogue(() => notifications++)
  const a = item.api.refreshFontCatalogue(), b = item.api.refreshFontCatalogue()
  assert.equal(a, b); assert.equal(calls, 1)
  finish({ available: true, fonts: fixture }); await a
  assert.equal(notifications, 1); stop()
})
test('bad cache is ignored and failed updates preserve the last usable catalogue', async () => {
  for (const raw of ['invalid', JSON.stringify({ version: 2, fonts: fixture, updatedAt: 1 }), JSON.stringify({ version: 1, fonts: [{}], updatedAt: 1 })]) {
    assert.equal(catalogue(raw, () => {}).api.getCachedFonts().length, 0)
  }
  const valid = JSON.stringify({ version: 1, fonts: fixture, updatedAt: 1 })
  const item = catalogue(valid, async () => ({ available: true, fonts: [{ postscriptName: 'Invalid', family: 45, fullName: 'a', style: 'b' }] }))
  const before = item.api.getFontCatalogue()
  await assert.rejects(item.api.refreshFontCatalogue())
  assert.equal(item.api.getFontCatalogue(), before)
})
