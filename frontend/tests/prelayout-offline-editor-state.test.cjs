const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function harness() {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const source = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const denied = () => assert.fail('Offline editing must not open IndexedDB, schedule autosave, or fetch')
    new Function('require', 'module', 'exports', 'indexedDB', 'fetch', 'setTimeout', source)(
      name => load(path.resolve(path.dirname(file), `${name}.ts`)), module, module.exports, { open: denied }, denied, denied,
    )
    return module.exports
  }
  const { EditorState } = load(path.resolve(__dirname, '../src/prelayout/editor-state.ts'))
  const page = { id: 'p1', name: '1.png', width: 300, height: 500, revision: 0, sha256: '', clean: null, measure: [],
    items: [{ _id: 'one', text: '原文', x: .5, y: .5, 'font-size': 20, orientation: 'vertical', rotation: 0, color: '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 0 }] }
  const controller = new EditorState('offline-test', [page])
  const state = controller.pages.get(page.id)
  const edit = text => controller.edit(page.id, state.data.items.map(item => ({ ...item, text })))
  return { controller, page, state, edit }
}

test('local editor loads, edits and undoes without a backend, IndexedDB or autosave', async () => {
  const { controller, page, state, edit } = harness()
  assert.equal(await controller.load('p1'), state)
  await assert.rejects(controller.load('missing'), /離線/)
  edit('譯文')
  assert.equal(state.data.items[0].text, '譯文')
  assert.equal(page.items[0].text, '原文', 'Editing cannot mutate the loaded document snapshot')
  assert.equal(controller.dirty, true)
  controller.undo('p1'); assert.equal(state.data.items[0].text, '原文')
  controller.undo('p1', true); assert.equal(state.data.items[0].text, '譯文')
  assert.equal(await controller.flush(), false)
  controller.dispose()
})

test('acknowledging a file snapshot preserves edits made while a save is pending', () => {
  const { controller, state, edit } = harness()
  edit('第一版')
  const saved = new Map([['p1', state.version]])
  edit('保存期間的新版本')
  controller.acknowledgeLocalSave(saved)
  assert.equal(controller.dirty, true)
  assert.equal(state.data.items[0].text, '保存期間的新版本')
  controller.acknowledgeLocalSave(new Map([['p1', state.version]]))
  assert.equal(controller.dirty, false)
  controller.undo('p1')
  assert.equal(controller.dirty, true, 'Saving retains undo history; undo requires another file save')
})

test('finishing inline text does not write a file unless the caller explicitly saves', async () => {
  const { controller, state, edit } = harness()
  let writes = 0
  controller.localSave = async () => { writes++; controller.acknowledgeLocalSave(new Map([['p1', state.version]])); return true }
  const draft = controller.beginTextDraft('p1', () => { edit('原位編輯'); draft.end() })
  draft.change(true)
  assert.equal(await controller.flush(), false)
  assert.equal(writes, 0)
  assert.equal(state.data.items[0].text, '原位編輯')
  assert.equal(await controller.flush({ localWrite: true }), true)
  assert.equal(writes, 1)
  assert.equal(controller.dirty, false)
})
