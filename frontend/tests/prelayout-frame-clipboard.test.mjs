import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/prelayout/frame-clipboard.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const clipboard = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

const item = () => ({
  _id: 'source', index: 17, groupId: 8, text: '原文\r\n第二行', x: .25, y: .4,
  'font-size': 37, rotation: -23, orientation: 'vertical', color: '#123456',
  'stroke-color': '#ffffff', 'stroke-weight': 4, match_status: 'auto',
  match_source_block_index: 9, source_block_index: 11, xyxy_pixel: [100, 120, 300, 520],
  nested: { values: [1, 2, 3] }, need_inpaint: true,
})

test('copied frames are independent deep snapshots', () => {
  const original = item(), frame = clipboard.copyFrame(original, { width: 1000, height: 2000 })
  original.text = 'changed'; original.nested.values[0] = 99
  assert.equal(frame.item.text, '原文\r\n第二行')
  assert.deepEqual(frame.item.nested, { values: [1, 2, 3] })
  clipboard.storeFrame(frame)
  const first = clipboard.readFrame(), second = clipboard.readFrame()
  first.item.nested.values[1] = 88
  assert.deepEqual(second.item.nested, { values: [1, 2, 3] })
})

test('paste centers a rebased reference box on target pages at every display scale', () => {
  const frame = clipboard.copyFrame(item(), { width: 1000, height: 2000 })
  for (const scale of [.5, 1, 2, 3]) {
    const pointer = { page: 'target', x: .6, y: .25 }
    const pasted = clipboard.pasteFrame(frame, pointer, { width: 2000, height: 1000 }, () => `fresh-${scale}`)
    assert.equal(pasted.x, .6); assert.equal(pasted.y, .25)
    assert.deepEqual(pasted.xyxy_pixel, [1100, 50, 1300, 450])
    assert.equal(pasted._id, `fresh-${scale}`); assert.equal(pasted.index, undefined)
    assert.equal(pasted.groupId, 8); assert.equal(pasted['font-size'], 37); assert.equal(pasted.rotation, -23)
    assert.equal(pasted.match_status, 'manual'); assert.equal(pasted.match_source_block_index, undefined); assert.equal(pasted.source_block_index, undefined)
  }
})

test('each paste gets a fresh independent item and clipboard text normalizes line endings', () => {
  let id = 0
  const frame = clipboard.copyFrame(item(), { width: 1000, height: 2000 })
  const first = clipboard.pasteFrame(frame, { page: 'a', x: .1, y: .2 }, { width: 500, height: 500 }, () => `id-${++id}`, '甲\r\n乙\r丙')
  const second = clipboard.pasteFrame(frame, { page: 'b', x: .8, y: .9 }, { width: 800, height: 1200 }, () => `id-${++id}`)
  first.nested.values[0] = 77
  assert.equal(first.text, '甲\n乙\n丙'); assert.equal(second.text, '原文\r\n第二行')
  assert.notEqual(first._id, second._id); assert.deepEqual(second.nested, { values: [1, 2, 3] })
  assert.equal(frame.item.match_status, 'auto'); assert.equal(frame.item._id, 'source')
})

test('a copied item without a valid reference box pastes without stale geometry', () => {
  const source = item(); source.xyxy_pixel = [1, 2, 3]
  const pasted = clipboard.pasteFrame(clipboard.copyFrame(source, { width: 1000, height: 2000 }), { page: 'p', x: .5, y: .5 }, { width: 700, height: 900 }, () => 'fresh')
  assert.equal(pasted.xyxy_pixel, undefined)
})
