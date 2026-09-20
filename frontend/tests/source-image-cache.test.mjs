import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/source-image-cache.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
const { SourceImageCache } = await import(moduleUrl)

const tick = () => new Promise(resolve => setImmediate(resolve))
const imageData = (width, height, value = 0) => ({ width, height, data: new Uint8ClampedArray(width * height * 4).fill(value) })
const resource = (url, width, height, closed = []) => ({
  source: { url }, width, height, close: () => closed.push(url),
})

test('preload is deduplicated, serial, and defers pixel extraction until foreground load', async () => {
  const pending = new Map()
  const calls = []
  let active = 0
  let maxActive = 0
  let extracts = 0
  const cache = new SourceImageCache({
    decode: url => new Promise(resolve => {
      calls.push(url); active++; maxActive = Math.max(maxActive, active)
      pending.set(url, () => { active--; resolve(resource(url, 2, 2)) })
    }),
    extract: (_resource, width, height) => { extracts++; return imageData(width, height) },
    defer: queueMicrotask,
  })

  cache.schedule([
    { url: 'a', width: 2, height: 2 },
    { url: 'b', width: 2, height: 2 },
    { url: 'a', width: 2, height: 2 },
  ])
  await tick()
  assert.deepEqual(calls, ['a'])
  assert.equal(extracts, 0)

  pending.get('a')()
  await tick()
  assert.deepEqual(calls, ['a', 'b'])
  assert.equal(maxActive, 1)
  pending.get('b')()
  await tick()

  await cache.load('a', 2, 2)
  assert.equal(extracts, 1)
  assert.deepEqual(cache.stats(), {
    hits: 1, misses: 2, loads: 2, failures: 0, evictions: 0,
    entries: 2, decodedBytes: 32, queued: 0, preloading: false,
  })
})

test('LRU eviction enforces the decoded byte budget and reloads evicted sources', async () => {
  const calls = []
  const cache = new SourceImageCache({
    budgetBytes: 32,
    decode: async url => { calls.push(url); return resource(url, 2, 2) },
    extract: (_resource, width, height) => imageData(width, height),
  })

  await cache.load('a', 2, 2)
  await cache.load('b', 2, 2)
  await cache.load('a', 2, 2)
  await cache.load('c', 2, 2)
  await cache.load('b', 2, 2)

  assert.deepEqual(calls, ['a', 'b', 'c', 'b'])
  assert.equal(cache.stats().entries, 2)
  assert.equal(cache.stats().decodedBytes, 32)
  assert.equal(cache.stats().evictions, 2)
})

test('dimension mismatches close the decoded source and a later load retries', async () => {
  const closed = []
  let attempt = 0
  const cache = new SourceImageCache({
    decode: async url => ++attempt === 1 ? resource(url, 3, 2, closed) : resource(url, 2, 2, closed),
    extract: (_resource, width, height) => imageData(width, height),
  })

  await assert.rejects(cache.load('page', 2, 2), /dimensions 3x2 do not match expected 2x2/)
  assert.deepEqual(closed, ['page'])
  assert.equal((await cache.load('page', 2, 2)).width, 2)
  assert.equal(attempt, 2)
  assert.equal(cache.stats().failures, 1)
})

test('clear detaches a stalled old preload and discards it without blocking a new project', async () => {
  const pending = new Map()
  const calls = []
  const closed = []
  const cache = new SourceImageCache({
    decode: url => new Promise(resolve => {
      calls.push(url)
      pending.set(url, () => resolve(resource(url, 2, 2, closed)))
    }),
    extract: (_resource, width, height) => imageData(width, height),
    defer: queueMicrotask,
  })

  cache.schedule([{ url: 'old-project', width: 2, height: 2 }])
  await tick()
  cache.clear()
  cache.schedule([{ url: 'new-project', width: 2, height: 2 }])
  await tick()
  assert.deepEqual(calls, ['old-project', 'new-project'])

  pending.get('new-project')()
  await tick()
  assert.equal(cache.stats().entries, 1)
  assert.equal(cache.stats().decodedBytes, 16)
  pending.get('old-project')()
  await tick()
  assert.deepEqual(closed, ['old-project'])
  assert.equal(cache.stats().entries, 1)
  assert.equal(cache.stats().decodedBytes, 16)
})

test('clear invalidates an old deferred pump without consuming the new project queue', async () => {
  const deferred = []
  const calls = []
  const cache = new SourceImageCache({
    decode: async url => { calls.push(url); return resource(url, 2, 2) },
    extract: (_resource, width, height) => imageData(width, height),
    defer: task => deferred.push(task),
  })

  cache.schedule([{ url: 'old-project', width: 2, height: 2 }])
  cache.clear()
  cache.schedule([{ url: 'new-project', width: 2, height: 2 }])
  assert.equal(deferred.length, 2)
  deferred.shift()()
  await tick()
  assert.deepEqual(calls, [])
  deferred.shift()()
  await tick()
  assert.deepEqual(calls, ['new-project'])
})

test('clear does not cancel a foreground load or let its old accounting alter the new generation', async () => {
  let resolveOld
  let attempt = 0
  const cache = new SourceImageCache({
    decode: url => {
      attempt++
      if (attempt === 1) return new Promise(resolve => { resolveOld = () => resolve(resource('old', 2, 2)) })
      return Promise.resolve(resource(url, 2, 2))
    },
    extract: (decoded, width, height) => {
      if (decoded.source.url === 'old') throw new Error('old extraction failed')
      return imageData(width, height)
    },
  })

  const oldLoad = cache.load('same-url', 2, 2)
  cache.clear()
  await cache.load('same-url', 2, 2)
  assert.equal(cache.stats().decodedBytes, 16)
  resolveOld()
  await assert.rejects(oldLoad, /old extraction failed/)
  assert.equal(cache.stats().entries, 1)
  assert.equal(cache.stats().decodedBytes, 16)
})

test('background preload skips sources larger than the cache budget', async () => {
  const calls = []
  const cache = new SourceImageCache({
    budgetBytes: 16,
    decode: async url => { calls.push(url); return resource(url, 2, 2) },
    extract: (_resource, width, height) => imageData(width, height),
    defer: queueMicrotask,
  })

  cache.schedule([
    { url: 'too-large', width: 3, height: 2 },
    { url: 'fits', width: 2, height: 2 },
  ])
  await tick()
  assert.deepEqual(calls, ['fits'])
  assert.equal(cache.stats().decodedBytes, 16)
})
