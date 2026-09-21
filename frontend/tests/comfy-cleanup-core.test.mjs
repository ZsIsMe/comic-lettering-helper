import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/comfy-cleanup-core.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { cleanupPreviewUrl, cleanupQuery, formatStorage } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('preview URL encodes each relative path segment without accepting it as one opaque URL', () => {
  assert.equal(cleanupPreviewUrl({ root: 'input', path: 'manual pages/第 1 頁.png' }), '/api/comfy-cleanup/preview/input/manual%20pages/%E7%AC%AC%201%20%E9%A0%81.png')
})

test('date query omits empty bounds and storage labels stay readable', () => {
  assert.equal(cleanupQuery('', ''), '/api/comfy-cleanup')
  assert.equal(cleanupQuery('2026-09-01', '2026-09-21'), '/api/comfy-cleanup?unknown_after=2026-09-01&unknown_before=2026-09-21')
  assert.equal(formatStorage(1536), '1.5 KiB')
  assert.equal(formatStorage(3 * 1024 ** 2), '3.0 MiB')
})
