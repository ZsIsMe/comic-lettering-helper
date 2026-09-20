const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function modules() {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const localRequire = name => load(path.resolve(path.dirname(file), `${name}.ts`))
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports)
    return module.exports
  }
  return name => load(path.resolve(__dirname, '../src/prelayout', `${name}.ts`))
}

const load = modules()
const { createFrameClipboardHandler } = load('frame-clipboard-shortcut')
const item = (id = 'source') => ({ _id: id, index: 4, groupId: 6, text: '樣式', x: .2, y: .3, 'font-size': 32, rotation: 0, orientation: 'vertical', color: '#000', 'stroke-color': '#fff', 'stroke-weight': 2, match_status: 'auto' })
const event = (key, extra = {}) => {
  const value = { key, metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false, keyCode: 0, defaultPrevented: false, ...extra }
  value.preventDefault = () => { value.defaultPrevented = true }
  return value
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('copy rejects empty and multi selection, and paste needs a fresh left-page pointer', async () => {
  const messages = [], pasted = [], pointer = { current: null }
  const values = { selectionCount: 0, selected: [], selectedPage: { width: 1000, height: 1500 } }
  const handler = createFrameClipboardHandler(() => ({ blocked: () => false, ...values, pointer, notify: message => messages.push(message), paste: async capture => { pasted.push(capture) } }))
  const none = event('c'); handler.key(none)
  assert(none.defaultPrevented); assert.equal(messages.pop(), '請先選取一個文字框再複製')
  values.selectionCount = 2; values.selected = [item('a'), item('b')]; handler.key(event('c'))
  assert.equal(messages.pop(), '一次只能複製一個文字框')
  values.selectionCount = 1; values.selected = [item()]; handler.key(event('c'))
  assert.equal(messages.pop(), '已複製文字框樣式與內容')
  handler.key(event('v')); assert.equal(messages.pop(), '請將滑鼠移到左側可編輯頁面後再貼上')
  pointer.current = { page: 'left', x: .4, y: .7 }
  handler.key(event('v', { repeat: true })); assert.equal(pasted.length, 0)
  handler.key(event('v')); await tick()
  assert.equal(pasted.length, 1); assert.deepEqual(pasted[0].pointer, { page: 'left', x: .4, y: .7 })
  handler.dispose()
})

test('clipboard text reports empty, unavailable and denied reads without losing the frame', async () => {
  const messages = [], pasted = [], pointer = { current: { page: 'left', x: .5, y: .5 } }
  let readText = async () => ''
  const handler = createFrameClipboardHandler(() => ({ blocked: () => false, selectionCount: 1, selected: [item()], selectedPage: { width: 1000, height: 1500 }, pointer, notify: message => messages.push(message), readText, paste: async capture => { pasted.push(capture) } }))
  handler.key(event('c'))
  handler.key(event('p')); await tick(); assert.equal(messages.at(-1), '系統剪貼簿沒有文字')
  readText = async () => { throw new Error('瀏覽器無法讀取系統剪貼簿') }
  handler.key(event('p')); await tick(); assert.equal(messages.at(-1), '瀏覽器無法讀取系統剪貼簿')
  readText = async () => { throw new DOMException('denied', 'NotAllowedError') }
  handler.key(event('p')); await tick(); assert.equal(messages.at(-1), '無法讀取系統剪貼簿，請允許剪貼簿權限後重試')
  readText = async () => '甲\r\n乙'
  handler.key(event('p')); await tick(); assert.equal(pasted.at(-1).text, '甲\n乙')
  handler.key(event('v')); await tick(); assert.equal(pasted.length, 2, 'frame remains available after clipboard read errors')
  handler.dispose()
})

test('async read captures pointer and template, rejects overlap, and is cancelled by a newer paste', async () => {
  const messages = [], pasted = [], pointer = { current: { page: 'first', x: .2, y: .3 } }
  let resolveRead
  const options = { selectionCount: 1, selected: [item('old')], selectedPage: { width: 800, height: 900 } }
  const readText = () => new Promise(resolve => { resolveRead = resolve })
  const handler = createFrameClipboardHandler(() => ({ blocked: () => false, ...options, pointer, notify: message => messages.push(message), readText,
    paste: async (capture, valid) => { await tick(); if (valid()) pasted.push(capture) },
  }))
  handler.key(event('c')); handler.key(event('p')); await Promise.resolve()
  pointer.current = { page: 'second', x: .8, y: .9 }; options.selected = [item('new')]
  handler.key(event('p')); assert.equal(messages.at(-1), '正在讀取系統剪貼簿，請稍候')
  handler.key(event('v'))
  resolveRead('延遲文字'); await tick(); await tick()
  assert.equal(pasted.length, 1); assert.equal(pasted[0].pointer.page, 'second'); assert.equal(pasted[0].frame.item._id, 'old')
  handler.dispose()
})

test('disposing an async handler prevents a late clipboard result from editing', async () => {
  const pasted = [], pointer = { current: { page: 'left', x: .1, y: .1 } }
  let resolveRead
  const handler = createFrameClipboardHandler(() => ({ blocked: () => false, selectionCount: 1, selected: [item()], selectedPage: { width: 100, height: 100 }, pointer, notify: () => {}, readText: () => new Promise(resolve => { resolveRead = resolve }), paste: async capture => { pasted.push(capture) } }))
  handler.key(event('c')); handler.key(event('p')); await Promise.resolve(); handler.dispose(); resolveRead('late'); await tick()
  assert.equal(pasted.length, 0)
})
