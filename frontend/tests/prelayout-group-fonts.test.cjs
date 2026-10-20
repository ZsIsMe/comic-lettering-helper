const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
function load(file) {
  const module = { exports: {} }
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', code)(name => load(path.resolve(path.dirname(file), `${name}.ts`)), module, module.exports)
  return module.exports
}
const { groupFontChanges } = load(path.resolve(__dirname, '../src/prelayout/group-fonts.ts'))
const groups = [{ name: '框內', font: 'PingFangTC-Regular' }, { name: '框外', font: 'PingFangTC-Semibold' }, { name: '無預設' }]
test('explicit assignment includes that group exact font face in the same batch', () => {
  assert.deepEqual(groupFontChanges({ groupId: 0 }, groups), { groupId: 0, font: 'PingFangTC-Regular' })
  assert.deepEqual(groupFontChanges({ groupId: 1 }, groups), { groupId: 1, font: 'PingFangTC-Semibold' })
})
test('direct font overrides and unrelated edits never reapply group preset', () => {
  assert.deepEqual(groupFontChanges({ font: 'Helvetica' }, groups), { font: 'Helvetica' })
  assert.deepEqual(groupFontChanges({ text: '文字' }, groups), { text: '文字' })
  assert.deepEqual(groupFontChanges({ groupId: 0, font: 'Override' }, groups), { groupId: 0, font: 'Override' })
})
test('unconfigured or invalid groups do not erase the current item font', () => {
  for (const groupId of [2, -1, 20, undefined, NaN, 1.5]) assert.deepEqual(groupFontChanges({ groupId }, groups), { groupId })
  assert.deepEqual(groupFontChanges({ groupId: 0 }, [{ name: '框內', font: '' }]), { groupId: 0 })
})
