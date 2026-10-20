const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
function harness(fetch) {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('module', 'exports', 'require', 'fetch', code)(module, module.exports, name => load(path.resolve(path.dirname(file), `${name}.ts`)), fetch)
    return module.exports
  }
  return load(path.join(__dirname, '../src/prelayout/question-record-store.ts')).appendQuestionRecord
}
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const record = { id: 'new', note: '疑問', texts: [], createdAt: 'now', updatedAt: 'now' }
test('inline append preserves existing records and uses the latest version', async () => {
  const calls = []
  const append = harness(async (_, options) => {
    if (!options) return response({ version: 8, records: [{ id: 'other' }] })
    calls.push(JSON.parse(options.body)); return response({})
  })
  await append('p', record)
  assert.equal(calls[0].expected_version, 8)
  assert.deepEqual(calls[0].records.map(r => r.id), ['new', 'other'])
})
test('concurrent additions are merged after a version conflict', async () => {
  let reads = 0, writes = 0; const calls = []
  const append = harness(async (_, options) => {
    if (!options) return response({ version: ++reads, records: reads === 1 ? [] : [{ id: 'concurrent' }] })
    calls.push(JSON.parse(options.body)); return ++writes === 1 ? response({ detail: 'conflict' }, 409) : response({})
  })
  await append('p', record)
  assert.deepEqual(calls[1].records.map(r => r.id), ['new', 'concurrent'])
  assert.equal(calls[1].expected_version, 2)
})
test('retry after a lost response does not create a duplicate record', async () => {
  let saved = false, writes = 0
  const append = harness(async (_, options) => {
    if (!options) return response({ version: saved ? 1 : 0, records: saved ? [record] : [] })
    saved = true; writes++; throw new Error('lost response')
  })
  await assert.rejects(append('p', record), /lost response/)
  await append('p', record)
  assert.equal(writes, 1)
})
test('validation failure stops without retrying the write', async () => {
  let writes = 0
  const append = harness(async (_, options) => {
    if (!options) return response({ version: 0, records: [] })
    writes++; return response({ detail: 'invalid' }, 422)
  })
  await assert.rejects(append('p', record), /invalid/)
  assert.equal(writes, 1)
})
