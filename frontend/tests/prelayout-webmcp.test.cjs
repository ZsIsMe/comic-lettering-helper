const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function moduleUnderTest(environment = {}) {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', 'document', 'navigator', code)(name => {
      assert(name.startsWith('./'))
      return load(path.resolve(path.dirname(file), `${name}.ts`))
    }, module, module.exports, environment.document, environment.navigator)
    return module.exports
  }
  return load(path.resolve(__dirname, '../src/prelayout/webmcp.ts'))
}

const fixture = () => ({ id: 'p1', name: '04', width: 2000, height: 1000, revision: 7, sha256: 'source', clean: null,
  measure: [{ source_block_index: 4 }], extra: { keep: true }, items: [
    { _id: 'stable-a', index: 3, groupId: 8, text: '甲乙\n丙丁', x: .25, y: .5, 'font-size': 36, rotation: 0,
      orientation: 'vertical', color: '#000', 'stroke-color': '#fff', 'stroke-weight': 2,
      xyxy_pixel: [400, 400, 600, 600], match_status: 'auto', source_block_index: 4, extra: { keep: true } },
    { _id: 'stable-b', text: '另一項', x: .8, y: .6, 'font-size': 30, rotation: 0,
      orientation: 'horizontal', color: '#000', 'stroke-color': '#fff', 'stroke-weight': 0 },
  ] })

test('pure patch preserves identity and metadata, and shifts source box with center', () => {
  const { applyPagePatches } = moduleUnderTest()
  const page = fixture(), snapshot = structuredClone(page)
  const result = applyPagePatches(page, [{ item_id: 'stable-a', center: [600, 550], set: { text: '甲\n乙丙丁', 'font-size': 37, color: '#ffffff' } }])
  assert.notStrictEqual(result, page)
  assert.equal(result.items.length, page.items.length)
  assert.equal(result.items[0]._id, 'stable-a')
  assert.equal(result.items[0].index, 3)
  assert.equal(result.items[0].source_block_index, 4)
  assert.deepEqual(result.items[0].extra, { keep: true })
  assert.deepEqual(result.items[0].xyxy_pixel, [500, 450, 700, 650])
  assert.equal(result.items[0].x, .3)
  assert.equal(result.items[0].y, .55)
  assert.equal(result.items[0].match_status, 'manual')
  assert.strictEqual(result.items[1], page.items[1])
  assert.deepEqual(page, snapshot)
  assert.strictEqual(result.measure, page.measure)
})

test('normalized x/y movement also shifts xyxy_pixel', () => {
  const { applyPagePatches } = moduleUnderTest()
  const item = applyPagePatches(fixture(), [{ item_id: 'stable-a', set: { x: .4, y: .3 } }]).items[0]
  assert.deepEqual(item.xyxy_pixel, [700, 200, 900, 400])
})

test('text edits change line breaks only', () => {
  const { applyPagePatches } = moduleUnderTest()
  const page = fixture()
  assert.equal(applyPagePatches(page, [{ item_id: 'stable-a', set: { text: '甲乙丙丁' } }]).items[0].text, '甲乙丙丁')
  for (const text of ['甲乙丙戊', '甲 乙丙丁', '甲乙\r\n丙丁']) {
    assert.throws(() => applyPagePatches(page, [{ item_id: 'stable-a', set: { text } }]), /只能修改換行/)
  }
})

test('stale or duplicate item identity and invalid second patch reject the entire batch', () => {
  const { applyPagePatches } = moduleUnderTest()
  const page = fixture(), before = structuredClone(page)
  assert.throws(() => applyPagePatches(page, [{ item_id: 'missing', set: { text: '甲' } }]), /不存在或 ID 重複/)
  assert.throws(() => applyPagePatches({ ...page, items: [...page.items, { ...page.items[0] }] }, [{ item_id: 'stable-a', set: { x: .3 } }]), /不存在或 ID 重複/)
  assert.throws(() => applyPagePatches(page, [{ item_id: 'stable-a', set: { x: .3 } }, { item_id: 'stable-b', set: { text: '改字' } }]), /只能修改換行/)
  assert.deepEqual(page, before)
  assert.throws(() => applyPagePatches(page, [{ item_id: 'stable-a', set: { x: .3 } }, { item_id: 'stable-a', set: { y: .3 } }]), /重複/)
})

test('rejects conflicting coordinates, bad bounds, unknown fields, and invalid geometry', () => {
  const { applyPagePatches } = moduleUnderTest()
  const page = fixture()
  for (const patch of [
    { item_id: 'stable-a', center: [100, 100], set: { x: .2 } },
    { item_id: 'stable-a', center: [2001, 100] },
    { item_id: 'stable-a', set: { x: Number.NaN } },
    { item_id: 'stable-a', set: { 'font-size': Infinity } },
    { item_id: 'stable-a', set: { 'stroke-weight': -1 } },
    { item_id: 'stable-a', set: { surprise: 1 } },
    { item_id: 'stable-a', set: { color: 'red' } },
  ]) assert.throws(() => applyPagePatches(page, [patch]))
  const malformed = fixture(); malformed.items[0].xyxy_pixel = [1, 2, 3]
  assert.throws(() => applyPagePatches(malformed, [{ item_id: 'stable-a', set: { x: .3 } }]), /來源框無效/)
})

test('split preserves every character and reports the exact reading order', () => {
  const { applyPageSplit } = moduleUnderTest()
  const page = fixture(), snapshot = structuredClone(page)
  page.items[0].text = '甲 乙，\n丙丁'
  const result = applyPageSplit(page, 'stable-a', 2, 5, () => 'new-id')
  assert.deepEqual(result.readingOrder, [
    { item_id: 'stable-a', text: '甲 ' },
    { item_id: 'new-id', text: '乙，\n' },
    { item_id: 'stable-a', text: '丙丁' },
  ])
  assert.equal(result.readingOrder.map(segment => segment.text).join(''), page.items[0].text)
  assert.equal(result.page.items[0].text, '甲 丙丁')
  assert.equal(result.page.items.at(-1).text, '乙，\n')
  assert.deepEqual(result.itemOrder, ['stable-a', 'stable-b', 'new-id'])
  assert.equal(result.page.items[0]._id, 'stable-a')
  assert.equal(result.page.items.at(-1)._id, 'new-id')
  assert.deepEqual(page, { ...snapshot, items: [{ ...snapshot.items[0], text: '甲 乙，\n丙丁' }, snapshot.items[1]] })
})

test('split rejects invalid ranges, stale identities, blank selection, and duplicate generated ID without mutation', () => {
  const { applyPageSplit } = moduleUnderTest()
  const page = fixture(), before = structuredClone(page)
  for (const [id, start, end, makeId] of [
    ['missing', 0, 1], ['stable-a', 0, 0], ['stable-a', -1, 1], ['stable-a', 0, 99],
    ['stable-a', 0.5, 2], ['stable-a', 0, page.items[0].text.length],
    ['stable-a', 1, 2, () => 'stable-b'],
  ]) assert.throws(() => applyPageSplit(page, id, start, end, makeId))
  const duplicate = { ...page, items: [page.items[0], { ...page.items[0] }] }
  assert.throws(() => applyPageSplit(duplicate, 'stable-a', 0, 1))
  const blank = fixture(); blank.items[0].text = '甲  乙'
  assert.throws(() => applyPageSplit(blank, 'stable-a', 1, 3), /選取必須包含文字/)
  assert.deepEqual(page, before)
})

test('split expands a UTF-16 selection to complete surrogate pairs', () => {
  const { applyPageSplit } = moduleUnderTest()
  const page = fixture(); page.items[0].text = '前😀後'
  const result = applyPageSplit(page, 'stable-a', 2, 3, () => 'new-id')
  assert.equal(result.selectionStart, 1)
  assert.equal(result.selectionEnd, 3)
  assert.equal(result.page.items.at(-1).text, '😀')
  assert.equal(result.readingOrder.map(segment => segment.text).join(''), '前😀後')
})

test('tool schemas are strict, unsupported context is harmless, and writes proxy only to host', async () => {
  const calls = []
  const host = Object.fromEntries(['inspect', 'patch', 'split', 'compare', 'undo', 'save', 'navigate', 'setView'].map(method => [method, async args => { calls.push([method, args]); return { method } }]))
  const absent = moduleUnderTest()
  assert.doesNotThrow(() => absent.registerPrelayoutTools(host)())
  const registered = new Map(), removed = []
  const modelContext = { registerTool(tool) { registered.set(tool.name, tool) }, unregisterTool(name) { removed.push(name) } }
  const { registerPrelayoutTools } = moduleUnderTest({ document: { modelContext } })
  const dispose = registerPrelayoutTools(host)
  assert.equal(registered.size, 8)
  for (const tool of registered.values()) {
    assert.equal(tool.inputSchema.additionalProperties, false)
    assert.equal(tool.inputSchema.type, 'object')
    assert.equal(typeof tool.execute, 'function')
  }
  const patch = registered.get('prelayout_patch_page')
  assert.equal(patch.inputSchema.properties.patches.items.additionalProperties, false)
  assert.equal(patch.inputSchema.properties.patches.items.properties.set.additionalProperties, false)
  assert.deepEqual(patch.inputSchema.properties.patches.items.required, ['item_id'])
  const request = { token: 'current-token', patches: [{ item_id: 'stable-a', set: { text: '甲乙丙丁' } }] }
  assert.deepEqual(await patch.execute(request), { content: [{ type: 'text', text: '{"method":"patch"}' }] })
  assert.deepEqual(calls, [['patch', request]])
  const split = registered.get('prelayout_split_item')
  assert.deepEqual(split.inputSchema.required, ['token', 'item_id', 'selection_start', 'selection_end'])
  assert.equal(split.inputSchema.properties.selection_start.type, 'integer')
  assert.equal(split.inputSchema.properties.selection_end.type, 'integer')
  const selection = { token: 'current-token', item_id: 'stable-a', selection_start: 1, selection_end: 3 }
  assert.deepEqual(await split.execute(selection), { content: [{ type: 'text', text: '{"method":"split"}' }] })
  assert.deepEqual(calls.at(-1), ['split', selection])
  await Promise.resolve()
  dispose()
  assert.equal(new Set(removed).size, 8)
})
