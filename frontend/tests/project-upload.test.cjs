const test = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const { webcrypto } = require('node:crypto')

const code = ts.transpileModule(readFileSync(path.join(__dirname, '../src/project-upload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText

function harness(fetchResult) {
  let xhr
  const requests = [], timers = new Map()
  let timerId = 0
  class XHR {
    constructor() { this.upload = {}; xhr = this }
    open(method, url) { this.method = method; this.url = url }
    send(body) { this.body = body }
  }
  const mod = { exports: {} }
  new Function('exports', 'XMLHttpRequest', 'crypto', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController', code)(
    mod.exports, XHR, webcrypto,
    (url, options) => { requests.push({ url, options }); return fetchResult() },
    (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id },
    id => timers.delete(id), AbortController,
  )
  const progress = [], body = {}
  const promise = mod.exports.uploadProject(body, value => progress.push(value))
  const finish = (status, payload) => { xhr.status = status; xhr.responseText = JSON.stringify(payload); xhr.onload() }
  return { xhr, progress, requests, timers, body, promise, finish }
}
const flush = () => new Promise(resolve => setImmediate(resolve))

test('upload bytes and server page counts remain separate until the POST completes', async () => {
  const h = harness(async () => ({ ok: true, json: async () => ({ stage: 'creating', completed: 2, total: 8, filename: '03.png' }) }))
  assert.equal(h.xhr.method, 'POST')
  assert.match(h.xhr.url, /^\/api\/projects\?progress_id=[a-f0-9]{32}$/)
  assert.equal(h.xhr.body, h.body)
  h.xhr.upload.onprogress({ loaded: 100, total: 100, lengthComputable: true })
  assert.equal(h.progress.at(-1).stage, 'uploading')
  let resolved = false
  h.promise.then(() => { resolved = true })
  h.xhr.upload.onload()
  assert.equal(h.progress.at(-1).stage, 'waiting')
  await flush()
  assert.deepEqual(h.progress.at(-1), { stage: 'creating', completed: 2, total: 8, filename: '03.png' })
  assert.equal(resolved, false)
  assert.equal(h.requests[0].options.cache, 'no-store')
  assert.equal(h.requests[0].url.split('/').at(-1), h.xhr.url.split('=').at(-1))
  h.finish(201, { id: 'project', pages: [] })
  assert.deepEqual(await h.promise, { id: 'project', pages: [] })
  assert.equal(h.timers.size, 0)
})

test('a pending status request cannot update UI after completion', async () => {
  let release
  const h = harness(() => new Promise(resolve => { release = resolve }))
  h.xhr.upload.onload()
  const before = h.progress.length
  h.finish(201, { id: 'done' })
  await h.promise
  assert.equal(h.requests[0].options.signal.aborted, true)
  release({ ok: true, json: async () => ({ stage: 'creating', completed: 1, total: 2 }) })
  await flush()
  assert.equal(h.progress.length, before)
  assert.equal(h.timers.size, 0)
})

test('missing progress before multipart parsing and status network errors retry without restarting upload', async () => {
  let count = 0
  const h = harness(async () => {
    if (++count === 1) return { ok: false, status: 404 }
    throw new Error('offline')
  })
  h.xhr.upload.onload()
  await flush()
  const next = [...h.timers.values()].find(timer => timer.delay === 1000)
  assert.ok(next)
  next.callback()
  await flush()
  assert.equal(h.requests.length, 2)
  h.finish(400, { detail: 'Mask 尺寸不一致' })
  await assert.rejects(h.promise, /Mask 尺寸不一致/)
})

test('unknown transfer total stays unknown and connection errors clean up polling', async () => {
  const h = harness(async () => ({ ok: false }))
  h.xhr.upload.onprogress({ loaded: 250, total: 0, lengthComputable: false })
  assert.equal(h.progress.at(-1).bytesTotal, undefined)
  h.xhr.upload.onload()
  await flush()
  h.xhr.onerror()
  await assert.rejects(h.promise, /連線中斷/)
  assert.equal(h.timers.size, 0)
})

test('non-JSON server errors explain that project creation may have finished', async () => {
  const h = harness(async () => ({ ok: false }))
  h.xhr.status = 502
  h.xhr.responseText = '<html>proxy error</html>'
  h.xhr.onload()
  await assert.rejects(h.promise, /HTTP 502.*確認是否已建立/)
})
