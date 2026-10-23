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
  const api = load(path.join(__dirname, '../src/prelayout/question-record-store.ts'))
  return Object.assign(api.appendQuestionRecord, api)
}
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const record = { id: 'new', note: '疑問', texts: [], createdAt: 'now', updatedAt: 'now' }
test('inline append preserves existing records and uses the latest version', async () => {
  const calls = []
  const append = harness(async (_, options) => {
    if (!options) return response({ version: 8, records: [{ id: 'other' }] })
    calls.push(JSON.parse(options.body)); return response({ version: 9, records: calls.at(-1).records })
  })
  await append('p', record)
  assert.equal(calls[0].expected_version, 8)
  assert.deepEqual(calls[0].records.map(r => r.id), ['other', 'new'])
})
test('concurrent additions are merged after a version conflict', async () => {
  let reads = 0, writes = 0; const calls = []
  const append = harness(async (_, options) => {
    if (!options) return response({ version: ++reads, records: reads === 1 ? [] : [{ id: 'concurrent' }] })
    calls.push(JSON.parse(options.body)); return ++writes === 1 ? response({ detail: 'conflict' }, 409) : response({ version: 3, records: calls.at(-1).records })
  })
  await append('p', record)
  assert.deepEqual(calls[1].records.map(r => r.id), ['concurrent', 'new'])
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

const oldRecord = { id: 'target', note: '原問題', texts: [{ key: 'second', text: '第二條', source: { ocr_text: '原文' } }, { key: 'first', text: '第一條' }], createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z' }
test('note update retries CAS against a fresh list and preserves texts/createdAt and unrelated changes', async () => {
  let reads = 0, writes = 0; const calls = []
  const { updateQuestionRecord } = harness(async (_, options) => {
    if (!options) return response({ version: ++reads, records: [oldRecord, { id: 'other', note: reads === 1 ? 'before' : 'concurrent change' }] })
    calls.push(JSON.parse(options.body))
    return ++writes === 1 ? response({ detail: 'conflict' }, 409) : response({ version: 3, records: calls.at(-1).records })
  })
  const result = await updateQuestionRecord('p', oldRecord, '新問題', '2026-10-23T10:00:00Z')
  assert.equal(calls[1].expected_version, 2)
  assert.equal(result.records[1].note, 'concurrent change')
  assert.deepEqual(result.records[0], { ...oldRecord, note: '新問題', updatedAt: '2026-10-23T10:00:00Z' })
})
test('same-target concurrent edits are rejected without overwriting note or snapshots', async () => {
  for (const change of [{ note: '別人問題' }, { texts: [] }, { updatedAt: 'changed' }]) {
    let writes = 0
    const { updateQuestionRecord, deleteQuestionRecord } = harness(async (_, options) => {
      if (!options) return response({ version: 9, records: [{ ...oldRecord, ...change }] })
      writes++; return response({})
    })
    await assert.rejects(updateQuestionRecord('p', oldRecord, '新問題', 'now'), /其他視窗修改/)
    await assert.rejects(deleteQuestionRecord('p', oldRecord), /其他視窗修改/)
    assert.equal(writes, 0)
  }
})
test('lost update or delete response can be confirmed idempotently with a fresh read', async () => {
  for (const deleting of [false, true]) {
    let records = [oldRecord], writes = 0
    const api = harness(async (_, options) => {
      if (!options) return response({ version: writes, records })
      records = JSON.parse(options.body).records; writes++; throw new Error('unknown result')
    })
    const run = () => deleting ? api.deleteQuestionRecord('p', oldRecord) : api.updateQuestionRecord('p', oldRecord, '新問題', 'later')
    await assert.rejects(run(), /unknown result/)
    const result = await run()
    assert.equal(writes, 1)
    assert.deepEqual(result.records, deleting ? [] : [{ ...oldRecord, note: '新問題', updatedAt: 'later' }])
  }
})
test('delete retries only its ID against unrelated concurrent records, with at most three CAS attempts', async () => {
  let reads = 0, writes = 0; const calls = []
  const api = harness(async (_, options) => {
    if (!options) return response({ version: ++reads, records: [oldRecord, { id: `concurrent-${reads}` }] })
    calls.push(JSON.parse(options.body)); return ++writes === 1 ? response({ detail: 'conflict' }, 409) : response({ version: 3, records: calls.at(-1).records })
  })
  await api.deleteQuestionRecord('p', oldRecord)
  assert.deepEqual(calls[1].records, [{ id: 'concurrent-2' }])
  let attempts = 0
  const conflict = harness(async (_, options) => options ? (attempts++, response({ detail: 'conflict' }, 409)) : response({ version: 1, records: [oldRecord] }))
  await assert.rejects(conflict.deleteQuestionRecord('p', oldRecord), /conflict/)
  assert.equal(attempts, 3)
})
test('a removed update target reports a conflict while a missing delete target is already complete', async () => {
  const api = harness(async () => response({ version: 4, records: [] }))
  await assert.rejects(api.updateQuestionRecord('p', oldRecord, '新問題', 'later'), /刪除/)
  assert.deepEqual(await api.deleteQuestionRecord('p', oldRecord), { version: 4, records: [] })
})

test('same desired note does not confirm an update if its immutable text references changed', async () => {
  for (const change of [{ texts: [] }, { createdAt: 'different creation' }]) {
    let writes = 0
    const api = harness(async (_, options) => {
      if (!options) return response({ version: 3, records: [{ ...oldRecord, note: 'desired', ...change }] })
      writes++; return response({})
    })
    await assert.rejects(api.updateQuestionRecord('p', oldRecord, 'desired', 'later'), /其他視窗修改/)
    assert.equal(writes, 0)
  }
})
test('invalid successful response is uncertain rather than a fabricated records document', async () => {
  for (const invalid of [{}, { version: -1, records: [] }, { version: 1, records: null }]) {
    const api = harness(async (_, options) => options ? response(invalid) : response({ version: 0, records: [] }))
    await assert.rejects(api('p', record), error => /尚未確認/.test(error.message) && error.status === undefined)
  }
})
