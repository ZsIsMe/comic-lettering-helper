const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

// Run the actual TS reducers and undo store offline. No browser, image, server,
// or real IndexedDB is opened; autosave timers stay under the test's control.
function sources() {
  const cache = new Map(), timers = new Map()
  let clock = 0, timerId = 0
  const environment = {
    indexedDB: { open: () => ({}) }, performance: { now: () => clock },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId },
    clearTimeout: id => timers.delete(id),
    fetch: () => assert.fail('Shortcut tests must not contact a server'),
  }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText
    const requireSource = name => {
      assert(name.startsWith('./'), `Unexpected dependency: ${name}`)
      return load(path.resolve(path.dirname(file), `${name}.ts`))
    }
    new Function('require', 'module', 'exports', ...Object.keys(environment), code)(requireSource, module, module.exports, ...Object.values(environment))
    return module.exports
  }
  return { load: name => load(path.resolve(__dirname, '../src/prelayout', `${name}.ts`)), timers, advance: ms => { clock += ms } }
}

const key = (value, extra = {}) => ({ key: value, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, isComposing: false, defaultPrevented: false, keyCode: 0, ...extra })
const fixture = () => [
  { _id: 'a', text: '甲\n乙', x: .25, y: .5, 'font-size': 28, rotation: 17, xyxy_pixel: [400, 900, 600, 1100], orientation: 'vertical', color: '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 3, match_status: 'auto', extra: { keep: true } },
  { _id: 'b', text: 'ABC', x: .75, y: .25, 'font-size': 43, rotation: -29, xyxy_pixel: [1400, 400, 1600, 600], orientation: 'horizontal', color: '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 0, match_status: 'auto' },
  { _id: 'c', text: '未選', x: .5, y: .75, 'font-size': 50, rotation: 0, orientation: 'vertical', color: '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 0, match_status: 'auto' },
]
const { textShortcut, adjustedItems } = sources().load('shortcuts')
const { splitTextItem, splitTextParts } = sources().load('split-text')
const { applyPageSplit } = sources().load('webmcp')
const { characterLabel, characterAt, characterPath } = sources().load('character-overlay')

test('character hover labels use original width/height and the estimated font size', () => {
  const box = { bbox: [10, 20, 22, 32], width: 12, height: 12, estimated_font_size: 22, calculated_font_size: 24 }
  assert.equal(characterLabel(box), 'W12H12FS22.0')
  assert.equal(characterLabel({ ...box, estimated_font_size: 21.83 }), 'W12H12FS21.8')
  assert.equal(characterLabel({ ...box, estimated_font_size: undefined }), 'W12H12FS24.0')
  assert.equal(characterLabel({ ...box, estimated_font_size: undefined, calculated_font_size: undefined }), 'W12H12')
})

test('overlapping character hit tests choose the smallest original-coordinate box', () => {
  const boxes = [{ bbox: [0, 0, 100, 100] }, { bbox: [10, 20, 22, 32] }, { bbox: [0, 0, 0, 0] }]
  for (const scale of [.5, 1, 2]) {
    assert.equal(characterAt(boxes, 15 * scale / scale, 25 * scale / scale), 1)
  }
  assert.equal(characterAt(boxes, 22, 32), 1)
  assert.equal(characterAt(boxes, 23, 32), 0)
  assert.equal(characterAt(boxes, 101, 50), null)
  assert.equal(characterAt([], 0, 0), null)
  assert.equal(characterPath([boxes[1]]), 'M10,20h12v12h-12Z')
})

test('arrow modifiers move selected centers and boxes by original pixels', () => {
  for (const [direction, dx, dy] of [['ArrowLeft', -1, 0], ['ArrowRight', 1, 0], ['ArrowUp', 0, -1], ['ArrowDown', 0, 1]]) {
    for (const [modifiers, step] of [[{}, 1], [{ shiftKey: true }, 10], [{ ctrlKey: true, shiftKey: true }, 50], [{ metaKey: true, shiftKey: true }, 50]]) {
      const before = fixture(), saved = structuredClone(before)
      const after = adjustedItems(before, ['a', 'b'], textShortcut(key(direction, modifiers)), 2000, 2000)
      for (const index of [0, 1]) {
        assert(Math.abs((after[index].x - before[index].x) * 2000 - dx * step) < 1e-10)
        assert(Math.abs((after[index].y - before[index].y) * 2000 - dy * step) < 1e-10)
        assert.deepEqual(after[index].xyxy_pixel, before[index].xyxy_pixel.map((v, i) => v + (i % 2 ? dy : dx) * step))
        assert.equal(after[index]['font-size'], before[index]['font-size'])
        assert.equal(after[index].rotation, before[index].rotation)
      }
      assert.strictEqual(after[2], before[2]); assert.deepEqual(before, saved)
    }
  }
})

test('font shortcuts support Command, Control, numpad and Option-transformed symbols', () => {
  for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
    for (const [value, code, shift, alt, delta] of [
      ['=', 'Equal', false, false, 2], ['+', 'Equal', true, false, 2], ['-', 'Minus', false, false, -2],
      ['+', 'NumpadAdd', false, false, 2], ['-', 'NumpadSubtract', false, false, -2],
      ['≠', 'Equal', false, true, 10], ['±', 'Equal', true, true, 10], ['–', 'Minus', false, true, -10],
      ['+', '', false, true, 10], ['-', '', false, true, -10],
    ]) {
      const before = fixture(), action = textShortcut(key(value, { ...modifiers, code, shiftKey: shift, altKey: alt }))
      assert.deepEqual(action, { kind: 'font', delta })
      const after = adjustedItems(before, ['a', 'b'], action, 2000, 2000)
      assert.deepEqual(after.map(item => item['font-size']), [28 + delta, 43 + delta, 50])
      assert.equal(after[0].rotation, 17); assert.equal(after[1].rotation, -29)
      assert.deepEqual(after[0].xyxy_pixel, before[0].xyxy_pixel)
      assert.deepEqual(after[0].extra, { keep: true })
      assert.strictEqual(after[2], before[2])
    }
  }
})

test('rotation changes each selection independently with the desktop direction', () => {
  const { transform } = sources().load('geometry')
  for (const modifiers of [{ metaKey: true }, { ctrlKey: true }]) {
    for (const [value, code, altKey, delta] of [['[', 'BracketLeft', false, 1], [']', 'BracketRight', false, -1], ['“', 'BracketLeft', true, 5], ['‘', 'BracketRight', true, -5]]) {
      const action = textShortcut(key(value, { ...modifiers, code, altKey }))
      const after = adjustedItems(fixture(), ['a', 'b'], action, 2000, 2000)
      assert.deepEqual(after.map(item => item.rotation), [17 + delta, -29 + delta, 0])
      assert(transform(after[0]).includes(`rotate(${-17 - delta}deg)`))
      assert.deepEqual(after.map(item => item['font-size']), [28, 43, 50])
    }
  }
})

test('rotation wraps through 180 degrees without stopping at the boundary', () => {
  for (const [angle, delta, expected] of [[180, 1, -179], [-179, -1, 180], [179, 5, -176], [-179, -5, 176], [17.25, 1, 18.25]]) {
    const items = fixture(); items[0].rotation = angle
    assert.equal(adjustedItems(items, ['a'], { kind: 'rotate', delta }, 2000, 2000)[0].rotation, expected)
  }
})

test('font bounds and empty selection do not create artificial edits', () => {
  for (const [size, delta, expected] of [[2, -10, 1], [995, 10, 999], [28.5, 2, 30.5]]) {
    const items = fixture(); items[0]['font-size'] = size
    assert.equal(adjustedItems(items, ['a'], { kind: 'font', delta }, 2000, 2000)[0]['font-size'], expected)
  }
  for (const [size, delta] of [[1, -2], [999, 10]]) {
    const items = fixture(); items[0]['font-size'] = size
    assert.strictEqual(adjustedItems(items, ['a'], { kind: 'font', delta }, 2000, 2000), items)
    assert.equal(items[0].match_status, 'auto')
  }
  const items = fixture()
  assert.strictEqual(adjustedItems(items, [], { kind: 'rotate', delta: 1 }, 2000, 2000), items)
})

test('quick color, stroke and orientation toggles use each selected item own state', () => {
  const items = fixture()
  Object.assign(items[0], { color: '000', 'stroke-color': '#123456', 'stroke-weight': 3, orientation: 'vertical' })
  Object.assign(items[1], { color: '#c03030', 'stroke-color': '#ffffff', 'stroke-weight': 0, orientation: 'horizontal' })
  let after = adjustedItems(items, ['a', 'b'], { kind: 'color' }, 2000, 2000)
  assert.deepEqual(after.slice(0, 2).map(item => [item.color, item['stroke-color']]), [['#ffffff', '#000000'], ['#000000', '#ffffff']])
  after = adjustedItems(after, ['a', 'b'], { kind: 'stroke' }, 2000, 2000)
  assert.deepEqual(after.slice(0, 2).map(item => [item['stroke-weight'], item['stroke-color']]), [[0, '#000000'], [4, '#ffffff']])
  after = adjustedItems(after, ['a', 'b'], { kind: 'orientation' }, 2000, 2000)
  assert.deepEqual(after.map(item => item.orientation), ['horizontal', 'vertical', 'vertical'])
  assert(after.slice(0, 2).every(item => item.match_status === 'manual'))
  assert.strictEqual(after[2], items[2])
})

test('quick actions record one undo for a multiselection', () => {
  const { controller, state, original } = editorFixture()
  controller.edit('page', adjustedItems(state.data.items, ['a', 'b'], { kind: 'stroke' }, 2000, 2000))
  assert.equal(state.undo.length, 1)
  assert.deepEqual(state.data.items.slice(0, 2).map(item => item['stroke-weight']), [0, 4])
  controller.undo('page'); assert.deepEqual(state.data.items, original)
  controller.dispose()
})

test('split keeps the original center and style while making a fresh manual item to its right', () => {
  const items = fixture()
  Object.assign(items[0], { text: '前😀選\n取後', groupId: 7, index: 4, source_block_index: 12, match_source_block_index: 12, need_inpaint: true, text_has_stroke: true })
  items[1].index = 9
  const result = splitTextItem(items, 'a', items[0].text, 3, 5, 2000,
    { remainder: { width: 80, height: 120 }, selected: { width: 60, height: 100 } }, () => 't_fresh')
  assert(result)
  const original = result.items[0], fresh = result.items.at(-1)
  assert.equal(original.text, '前😀取後'); assert.equal(original.x, items[0].x); assert.equal(original.y, items[0].y)
  assert.equal(fresh.text, '選\n'); assert.equal(fresh._id, 't_fresh'); assert.equal(fresh.index, 10); assert.equal(fresh.groupId, 7)
  assert(fresh.x > original.x); assert.equal(fresh.y, original.y)
  for (const key of ['font-size', 'rotation', 'orientation', 'color', 'stroke-color', 'stroke-weight']) assert.equal(fresh[key], items[0][key])
  for (const key of ['xyxy_pixel', 'source_block_index', 'match_source_block_index', 'need_inpaint', 'text_has_stroke']) assert.equal(fresh[key], undefined)
})

test('split respects Unicode boundaries and rejects collapsed, blank and whole-text selections', () => {
  assert.deepEqual(splitTextParts('A😀B', 2, 3), { start: 1, end: 3, selectedText: '😀', remainder: 'AB' })
  assert.equal(splitTextParts('A😀B', 2, 2), null, 'collapsed caret inside surrogate stays collapsed')
  assert.equal(splitTextParts('ABC', 0, 3), null)
  assert.equal(splitTextParts('A  B', 1, 3), null)
})

test('split including an in-progress draft is one undo operation', () => {
  const { controller, state, original } = editorFixture()
  const draft = '草稿中的選字', result = splitTextItem(state.data.items, 'a', draft, 4, 6, 2000, undefined, () => 't_split')
  assert(result)
  const undoSnapshot = state.data.items.map(item => item._id === 'a' ? { ...item, text: draft, match_status: 'manual' } : item)
  controller.edit('page', result.items, true, undefined, false, undoSnapshot)
  assert.equal(state.undo.length, 1); assert.equal(state.data.items.length, 4)
  assert.equal(state.data.items[0].text, '草稿中的'); assert.equal(state.data.items[3].text, '選字')
  controller.undo('page'); assert.equal(state.data.items.length, original.length); assert.equal(state.data.items[0].text, draft); assert.equal(state.data.items[0].match_status, 'manual')
  controller.dispose()
})

test('WebMCP split uses the editor undo and autosave path', () => {
  const { controller, state, original, timers } = editorFixture()
  const result = applyPageSplit(state.data, 'a', 0, 1, () => 't_webmcp')
  controller.edit('page', result.page.items)
  assert.equal(state.undo.length, 1)
  assert.equal(state.data.items.at(-1).text, '甲')
  assert.equal([...timers.values()][0].delay, 700)
  controller.undo('page')
  assert.deepEqual(state.data.items, original)
  assert.equal(state.undo.length, 0)
  controller.dispose()
})

test('IME composition and handled events never become text adjustments', () => {
  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }]) {
    assert.equal(textShortcut(key('=', { code: 'Equal', metaKey: true, ...extra })), null)
    assert.equal(textShortcut(key('ArrowDown', extra)), null)
  }
  for (const event of [key('+'), key('['), key('ArrowLeft', { altKey: true }), key('ArrowRight', { metaKey: true }), key('m', { metaKey: true })]) assert.equal(textShortcut(event), null)
})

function editorFixture() {
  const runtime = sources(), { EditorState } = runtime.load('editor-state'), controller = new EditorState('synthetic-shortcuts')
  const original = fixture(), data = { id: 'page', width: 2000, height: 2000, revision: 0, items: structuredClone(original), measure: [{ xyxy_pixel: [1, 2, 3, 4] }] }
  const state = { data, undo: [], redo: [], dirty: false, version: 0, error: '', saving: false, conflict: false }
  controller.pages.set('page', state)
  const press = (event, repeat = false, ids = ['a', 'b']) => {
    const adjustment = textShortcut(event)
    const items = adjustedItems(state.data.items, ids, adjustment, 2000, 2000)
    if (items !== state.data.items) controller.edit('page', items, true, `${JSON.stringify(adjustment)}:${ids.join(',')}`, repeat)
  }
  return { ...runtime, controller, state, original, press }
}

test('a held key is one undo operation even after the initial repeat delay', () => {
  for (const event of [key('ArrowRight'), key('=', { metaKey: true }), key('[', { metaKey: true, altKey: true })]) {
    const { controller, state, original, press, advance, timers } = editorFixture()
    press(event); advance(650)
    for (let i = 0; i < 20; i++) { press(event, true); advance(30) }
    assert.equal(state.undo.length, 1)
    assert.equal(timers.size, 1, 'Only the latest deferred autosave remains')
    assert.equal([...timers.values()][0].delay, 700)
    assert.deepEqual(state.data.measure, [{ xyxy_pixel: [1, 2, 3, 4] }])
    const after = structuredClone(state.data.items)
    controller.endGroup('page'); controller.undo('page')
    assert.deepEqual(state.data.items, original)
    controller.undo('page', true); assert.deepEqual(state.data.items, after)
    controller.dispose(); assert.equal(timers.size, 0)
  }
})

test('release, a different selection and a different adjustment each split undo', () => {
  const { controller, state, press } = editorFixture()
  const event = key('=', { metaKey: true })
  press(event); controller.endGroup('page'); press(event)
  press(event, true, ['b']); press(key('[', { metaKey: true }), true, ['b'])
  assert.equal(state.undo.length, 4)
  controller.undo('page'); assert.equal(state.redo.length, 1)
  press(key('-', { metaKey: true })); assert.equal(state.redo.length, 0)
  assert.equal(state.data.items[2]['font-size'], 50)
  controller.dispose()
})
