const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
function exporter(fetch) {
  const downloads = [], urls = [], revoked = []
  const document = { body: { appendChild() {} }, createElement: () => ({ click() { downloads.push({ name: this.download, url: this.href }) }, remove() {} }) }
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', 'fetch', 'document', 'URL', 'setTimeout', code)(name => load(path.resolve(path.dirname(file), `${name}.ts`)), module, module.exports, fetch, document,
      { createObjectURL: blob => { urls.push(blob); return 'blob:test' }, revokeObjectURL: url => revoked.push(url) }, fn => fn())
    return module.exports
  }
  const module = { exports: { ...load(path.resolve(__dirname, '../src/prelayout/download-discussion.ts')), ...load(path.resolve(__dirname, '../src/prelayout/export-guard.ts')) } }
  return { ...module.exports, downloads, urls, revoked }
}
test('flush failure prevents a stale export request and download', async () => {
  const api = exporter(() => assert.fail('failed save must not fetch'))
  await assert.rejects(api.downloadDiscussion({ id: 'p1', name: '項目' }, async () => false), /尚未保存/)
  assert.deepEqual(api.downloads, [])
})
test('export requests fresh Markdown and downloads the actual response with a clear filename', async () => {
  let saved = false
  const blob = new Blob(['# 項目｜疑問記錄\n\n請回答問題。'])
  const api = exporter(async (url, options) => {
    assert(saved); assert.equal(url, '/api/prelayout/projects/p1/export/discussion'); assert.equal(options.cache, 'no-store')
    return { ok: true, headers: new Headers({ 'Content-Type': 'text/markdown; charset=utf-8' }), blob: async () => blob }
  })
  await api.downloadDiscussion({ id: 'p1', name: '選秀王' }, async () => { saved = true; return true })
  assert.deepEqual(api.downloads, [{ name: '選秀王_疑問記錄.md', url: 'blob:test' }]); assert.equal(api.urls[0], blob); assert.deepEqual(api.revoked, ['blob:test'])
})
test('server errors and incompatible responses cannot be downloaded as a fake Markdown file', async () => {
  for (const response of [
    { ok: false, status: 409, json: async () => ({ detail: '保存衝突' }) },
    { ok: true, headers: new Headers({ 'Content-Type': 'text/html' }) },
  ]) {
    const api = exporter(async () => response)
    await assert.rejects(api.downloadDiscussion({ id: 'p1', name: '項目' }, async () => true)); assert.deepEqual(api.downloads, [])
  }
})
test('project filename cannot introduce directories or invalid filename characters', () => {
  const api = exporter(() => {})
  assert.equal(api.discussionFilename('../A/B\\C:題'), '.._A_B_C_題_疑問記錄.md')
  assert.equal(api.discussionFilename(''), '項目_疑問記錄.md')
})

const project = { id: 'p1', name: '選秀王' }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const downloadResponse = (markdown, content) => ({ ok: true, headers: new Headers({ 'Content-Type': markdown ? 'text/markdown' : 'application/json' }), blob: async () => content })
for (const markdown of [true, false]) {
  const format = markdown ? 'Markdown' : 'Meo JSON'
  const download = (api, flush, guard) => (markdown ? api.downloadDiscussion : api.downloadMeo)(project, flush, guard)
  test(`${format}: pending and uncertain question writes block before text flush or fetching`, async () => {
    const api = exporter(() => assert.fail('pending save must not fetch')), guard = new api.ProjectExportGuard()
    for (const source of ['questions', 'inline']) {
      guard.setPending(source, true)
      await assert.rejects(download(api, () => assert.fail('pending save must not flush'), guard), /尚未確認/)
      // An unconfirmed write remains blocked across multiple attempts.
      await assert.rejects(download(api, async () => true, guard), /尚未確認/)
      guard.setPending(source, false)
    }
    assert.deepEqual(api.downloads, [])
  })
  test(`${format}: failed text flush prevents fetching even without a pending question`, async () => {
    const api = exporter(() => assert.fail('failed flush must not fetch')), guard = new api.ProjectExportGuard()
    await assert.rejects(download(api, async () => false, guard), /尚未保存/)
    assert.deepEqual(api.downloads, [])
  })
  test(`${format}: a save that starts and completes during flush still invalidates the old export attempt`, async () => {
    const api = exporter(() => assert.fail('changed save state must not fetch')), guard = new api.ProjectExportGuard(), flush = deferred()
    const result = download(api, () => flush.promise, guard)
    guard.setPending('inline', true); guard.setPending('inline', false)
    flush.resolve(true)
    await assert.rejects(result, /已有變更/)
    assert.deepEqual(api.downloads, [])
  })
  test(`${format}: question changes while a response is downloading never publish the stale snapshot`, async () => {
    const bytes = deferred(), entered = deferred()
    const api = exporter(async () => { entered.resolve(); return { ...downloadResponse(markdown), blob: () => bytes.promise } }), guard = new api.ProjectExportGuard()
    const result = download(api, async () => true, guard)
    await entered.promise
    guard.setPending('questions', true); guard.setPending('questions', false)
    bytes.resolve(new Blob(['old snapshot']))
    await assert.rejects(result, /已有變更/)
    assert.deepEqual(api.downloads, []); assert.deepEqual(api.urls, [])
  })
  test(`${format}: an overlapping project operation aborts the download, and retry receives exact fresh bytes`, async () => {
    const response = deferred(), entered = deferred(), bytes = new Blob(['{"font":"OriginalFont","ocr_text":"原文","note":"註釋"}'])
    let requests = 0
    const api = exporter(async (url, options) => {
      assert.equal(url, `/api/prelayout/projects/p1/export/${markdown ? 'discussion' : 'bt'}`)
      assert.equal(options.cache, 'no-store')
      if (++requests === 1) { entered.resolve(); return response.promise }
      return downloadResponse(markdown, bytes)
    }), guard = new api.ProjectExportGuard()
    const result = download(api, async () => true, guard)
    await entered.promise; guard.invalidate(); response.resolve(downloadResponse(markdown, new Blob(['stale'])))
    await assert.rejects(result, /已有變更/)
    assert.deepEqual(api.downloads, [])
    await download(api, async () => true, guard)
    assert.equal(api.urls[0], bytes)
    assert.equal(api.downloads[0].name, markdown ? '選秀王_疑問記錄.md' : 'Meo.json')
  })
}
