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
  const legacy = fixture(); legacy.items[0].text = '甲乙\r\n丙丁'
  assert.equal(applyPagePatches(legacy, [{ item_id: 'stable-a', set: { text: '甲\n乙丙丁' } }]).items[0].text, '甲\n乙丙丁')
})

test('line-break reads reuse verified candidates, preserve raw text and return LF texts ready for the patch path', () => {
  const { pageLineBreakOptions, applyPagePatches } = moduleUnderTest()
  const page = fixture(), original = '甲 乙，\r\n丙丁😀'
  page.items[0].text = original
  page.line_break_suggestions = { 'stable-a': { original_text: original, source_line_count: 2, candidates: [
    { line_count: 2, text: '甲 乙，\n丙丁😀' }, { line_count: 3, text: '甲 \n乙，\n丙丁😀' },
    { line_count: 1, text: '甲乙，丙丁😀' }, { line_count: 1, text: '甲 乙,丙丁😀' },
  ] } }
  const before = structuredClone(page)
  const [first, missing] = pageLineBreakOptions(page, ['stable-a', 'stable-b'])
  assert.deepEqual(first, { item_id: 'stable-a', current_text: original, original_text: original, source_line_count: 2, options: [
    { label: '匯入原文 · 2列版', text: '甲 乙，\n丙丁😀', is_current: true },
    { label: '3列版', text: '甲 \n乙，\n丙丁😀', is_current: false },
  ], notice: '已列出目前提供的版本；相同斷句會合併顯示。' })
  for (const option of first.options) assert.equal(applyPagePatches(page, [{ item_id: first.item_id, set: { text: option.text } }]).items[0].text, option.text)
  assert.equal(missing.current_text, '另一項'); assert.deepEqual(missing.options, [])
  assert.equal(missing.source_line_count, null); assert.equal('original_text' in missing, false)
  assert.match(missing.notice, /缺少.*精確 CTD/)
  assert.deepEqual(page, before)
  page.items[0].text = '文字改動'
  const [stale] = pageLineBreakOptions(page, ['stable-a'])
  assert.deepEqual(stale.options, []); assert.equal('original_text' in stale, false)
  assert.match(stale.notice, /文字已改動/)
})

test('line-break reads reject invalid batches and ambiguous identities without mutation', () => {
  const { pageLineBreakOptions } = moduleUnderTest()
  const page = fixture(), before = structuredClone(page)
  for (const ids of [undefined, [], Array(21).fill('stable-a'), ['stable-a', 'stable-a'], ['missing'], [''], [4]]) assert.throws(() => pageLineBreakOptions(page, ids))
  const duplicate = { ...page, items: [...page.items, { ...page.items[0] }] }
  assert.throws(() => pageLineBreakOptions(duplicate, ['stable-a']), /不存在或 ID 重複/)
  assert.deepEqual(page, before)
})

test('candidate groups branch from one draft and preserve its contents and revision', () => {
  const { preparePreviewCandidates } = moduleUnderTest()
  const page = fixture(), before = structuredClone(page)
  const groups = preparePreviewCandidates(page, [
    { label: '字級', region: [100, 200, 1000, 800], candidates: [
      { label: 'A', patches: [{ item_id: 'stable-a', set: { 'font-size': 32 } }] },
      { label: 'B', patches: [{ item_id: 'stable-a', set: { rotation: 12 } }] },
    ] },
    { label: '整組移動', candidates: [{ label: 'C', patches: [
      { item_id: 'stable-a', center: [600, 550] }, { item_id: 'stable-b', set: { x: .7 } },
    ] }] },
  ])
  assert.equal(groups[0].candidates[0].page.items[0]['font-size'], 32)
  assert.equal(groups[0].candidates[1].page.items[0]['font-size'], 36)
  assert.equal(groups[0].candidates[1].page.items[0].rotation, 12)
  assert.equal(groups[1].candidates[0].page.items[0].x, .3)
  assert.equal(groups[1].candidates[0].page.items[1].x, .7)
  assert.equal(groups[1].candidates[0].page.revision, 7)
  assert.deepEqual(groups[1].itemIds, ['stable-a', 'stable-b'])
  assert.deepEqual(page, before)
})

test('invalid candidate batches reject labels, geometry, limits, identities, and text edits without mutation', () => {
  const { preparePreviewCandidates } = moduleUnderTest()
  const page = fixture(), before = structuredClone(page)
  const group = { label: 'group', candidates: [{ label: 'A', patches: [{ item_id: 'stable-a', set: { 'font-size': 32 } }] }] }
  for (const groups of [
    [], Array(5).fill(group), [group, group], [{ ...group, label: ' ' }],
    [{ ...group, candidates: [] }], [{ ...group, candidates: Array(5).fill(group.candidates[0]) }],
    [{ ...group, candidates: [group.candidates[0], group.candidates[0]] }],
    [{ ...group, region: [-1, 0, 100, 100] }], [{ ...group, region: [1, 0, 2001, 100] }],
    [{ ...group, region: [100, 100, 0, 0] }], [{ ...group, region: [0, 0, Infinity, 100] }],
    [{ ...group, candidates: [{ label: 'A', patches: [{ item_id: 'missing', set: { rotation: 3 } }] }] }],
    [{ ...group, candidates: [{ label: 'A', patches: [{ item_id: 'stable-a', set: { text: '任意改字' } }] }] }],
    [{ ...group, candidates: [{ label: 'A', patches: Array(21).fill(group.candidates[0].patches[0]) }] }],
  ]) assert.throws(() => preparePreviewCandidates(page, groups))
  assert.throws(() => preparePreviewCandidates(page, [group], 15))
  assert.throws(() => preparePreviewCandidates(page, [group], NaN))
  assert.deepEqual(page, before)
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
  const host = Object.fromEntries(['inspect', 'getLineBreakOptions', 'patch', 'split', 'compare', 'previewCandidates', 'undo', 'save', 'navigate', 'setView'].map(method => [method, async args => { calls.push([method, args]); return { method } }]))
  const absent = moduleUnderTest()
  assert.doesNotThrow(() => absent.registerPrelayoutTools(host)())
  const registered = new Map(), removed = []
  const modelContext = { registerTool(tool) { registered.set(tool.name, tool) }, unregisterTool(name) { removed.push(name) } }
  const { registerPrelayoutTools } = moduleUnderTest({ document: { modelContext } })
  const dispose = registerPrelayoutTools(host)
  assert.equal(registered.size, 10)
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
  const lineBreaks = registered.get('prelayout_get_line_break_options')
  assert.equal(lineBreaks.annotations.readOnlyHint, true)
  assert.deepEqual(lineBreaks.inputSchema.required, ['token', 'item_ids'])
  assert.equal(lineBreaks.inputSchema.properties.item_ids.minItems, 1)
  assert.equal(lineBreaks.inputSchema.properties.item_ids.maxItems, 20)
  assert.equal(lineBreaks.inputSchema.properties.item_ids.uniqueItems, true)
  assert.equal(lineBreaks.inputSchema.properties.item_ids.items.minLength, 1)
  const lineBreakRequest = { token: 'current-token', item_ids: ['stable-a'] }
  assert.deepEqual(await lineBreaks.execute(lineBreakRequest), { content: [{ type: 'text', text: '{"method":"getLineBreakOptions"}' }] })
  assert.deepEqual(calls.at(-1), ['getLineBreakOptions', lineBreakRequest])
  const preview = registered.get('prelayout_preview_candidates')
  assert.equal(preview.annotations.readOnlyHint, true)
  assert.deepEqual(preview.inputSchema.required, ['token', 'groups'])
  assert.equal(preview.inputSchema.properties.groups.maxItems, 4)
  assert.equal(preview.inputSchema.properties.groups.items.additionalProperties, false)
  assert.equal(preview.inputSchema.properties.groups.items.properties.candidates.items.properties.patches.maxItems, 20)
  const previewRequest = { token: 'current-token', groups: [{ label: 'group', candidates: [{ label: 'A', patches: request.patches }] }] }
  await preview.execute(previewRequest)
  assert.deepEqual(calls.at(-1), ['previewCandidates', previewRequest])
  const split = registered.get('prelayout_split_item')
  assert.deepEqual(split.inputSchema.required, ['token', 'item_id', 'selection_start', 'selection_end'])
  assert.equal(split.inputSchema.properties.selection_start.type, 'integer')
  assert.equal(split.inputSchema.properties.selection_end.type, 'integer')
  const selection = { token: 'current-token', item_id: 'stable-a', selection_start: 1, selection_end: 3 }
  assert.deepEqual(await split.execute(selection), { content: [{ type: 'text', text: '{"method":"split"}' }] })
  assert.deepEqual(calls.at(-1), ['split', selection])
  const save = registered.get('prelayout_save_page')
  assert.deepEqual(save.inputSchema.required, ['token'])
  assert.equal(save.inputSchema.properties.wait.default, true)
  assert.equal(save.inputSchema.properties.next_page_id.type, 'string')
  const saving = { token: 'current-token', reviewed: true, wait: false, next_page_id: 'next-page' }
  await save.execute(saving)
  assert.deepEqual(calls.at(-1), ['save', saving])
  const view = registered.get('prelayout_set_view')
  assert.deepEqual(view.inputSchema.properties.mode.enum, ['overlay', 'original', 'final'])
  assert.equal(view.inputSchema.properties.show_text.type, 'boolean')
  assert.equal(view.inputSchema.properties.clean.type, 'boolean')
  assert.equal(view.inputSchema.properties.difference_color.pattern, '^#[0-9a-fA-F]{6}$')
  assert.equal(view.inputSchema.properties.difference_opacity.minimum, 0)
  assert.equal(view.inputSchema.properties.difference_opacity.maximum, 1)
  const viewRequest = { token: 'current-token', mode: 'overlay', difference_color: '#3250ff', difference_opacity: .65 }
  assert.deepEqual(await view.execute(viewRequest), { content: [{ type: 'text', text: '{"method":"setView"}' }] })
  assert.deepEqual(calls.at(-1), ['setView', viewRequest])
  await Promise.resolve()
  dispose()
  assert.equal(new Set(removed).size, 10)
})
