const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const source = readFileSync(path.join(__dirname, '../src/prelayout/recent-projects.ts'), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
const api = {}
new Function('exports', compiled.outputText)(api)

test('opening projects retains three distinct IDs in order across reloads', () => {
  const values = new Map([['pl-project-view', 'cards']])
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  let history = api.loadRecentProjectIds(storage)
  assert.deepEqual(history, [])
  for (const id of ['a', 'b', 'c', 'd', 'b']) history = api.rememberProjectOpen(id, history, storage)
  assert.deepEqual(api.loadRecentProjectIds(storage), ['b', 'd', 'c'])
})

test('malformed and unavailable storage do not prevent session history', () => {
  for (const raw of ['{', '{}', '42']) assert.deepEqual(api.loadRecentProjectIds({getItem: () => raw}), [])
  const blocked = { getItem() { throw Error() }, setItem() { throw Error() } }
  assert.deepEqual(api.loadRecentProjectIds(blocked), [])
  assert.deepEqual(api.rememberProjectOpen('b', ['a'], blocked), ['b', 'a'])
})
