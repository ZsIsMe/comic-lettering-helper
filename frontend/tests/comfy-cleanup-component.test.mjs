import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/ComfyCleanup.tsx', import.meta.url), 'utf8')

test('cleanup confirmations use a controlled modal instead of the unsupported static renderer', () => {
  assert.doesNotMatch(source, /Modal\.confirm/)
  assert.match(source, /open=\{!!pendingDelete\}/)
  assert.match(source, /onOk=\{\(\) => \{ if \(pendingDelete\) void remove\(pendingDelete\) \}\}/)
})

test('both cleanup buttons snapshot their visible file list before confirmation', () => {
  assert.match(source, /scope: 'safe', items: \[\.\.\.safe\]/)
  assert.match(source, /const items = unknown\.filter/)
  assert.match(source, /scope: 'selected', items, files: items\.length/)
})
