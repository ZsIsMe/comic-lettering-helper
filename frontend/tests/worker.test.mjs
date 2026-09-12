import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Worker } from 'node:worker_threads'
import ts from 'typescript'
const options = { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
const snap = ts.transpileModule(await readFile(new URL('../src/edgewhite/guide-snap.ts', import.meta.url), 'utf8'), options).outputText
const url = `data:text/javascript;base64,${Buffer.from(snap).toString('base64')}`
const code = ts.transpileModule(await readFile(new URL('../src/edgewhite/guide-snap.worker.ts', import.meta.url), 'utf8'), options).outputText.replace("'./guide-snap'", JSON.stringify(url))
function create() {
  const bootstrap = `import { parentPort } from 'node:worker_threads'; globalThis.self = { postMessage: value => parentPort.postMessage(value) }; ${code}; parentPort.on('message', data => self.onmessage({data}));`
  return new Worker(new URL(`data:text/javascript;base64,${Buffer.from(bootstrap).toString('base64')}`))
}
function send(worker, value, transfer = []) { return new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.postMessage(value, transfer) }) }
const request = { horizontal: true, position: 82, step: 1, parallel: [82], perpendicular: [80], whiteTolerance: 30 }
test('real worker transfers source pixels, finds expected match and replaces cache per source key', { timeout: 5000 }, async () => {
  const worker = create()
  try {
    const rgba = new Uint8ClampedArray(160 * 160 * 4).fill(255)
    for (let y = 80; y < 90; y++) for (let x = 100; x < 120; x++) { const i = (y * 160 + x) * 4; rgba[i] = rgba[i + 1] = rgba[i + 2] = 0 }
    const buffer = rgba.buffer
    assert.equal((await send(worker, { kind: 'load', key: 'collection:page:hash1', width: 160, height: 160, rgba: buffer }, [buffer])).kind, 'ready')
    assert.equal(buffer.byteLength, 0)
    let result = await send(worker, { kind: 'find', key: 'collection:page:hash1', id: 1, request })
    assert.deepEqual(result.match, { position: 90, passingCount: 2, total: 2 })
    const next = new Uint8ClampedArray(160 * 160 * 4).fill(255)
    await send(worker, { kind: 'load', key: 'collection:page:hash2', width: 160, height: 160, rgba: next.buffer }, [next.buffer])
    worker.postMessage({ kind: 'find', key: 'collection:page:hash1', id: 2, request })
    result = await send(worker, { kind: 'find', key: 'collection:page:hash2', id: 3, request })
    assert.equal(result.id, 3, 'stale source key must not return a result')
    assert.equal(result.match.position, 82, 'new page pixels replace the old cached image')
  } finally { await worker.terminate() }
})
