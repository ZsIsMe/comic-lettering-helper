const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const moduleValue = { exports: {} }
const code = ts.transpileModule(readFileSync(path.resolve(__dirname, '../src/prelayout/group-import.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
new Function('module', 'exports', code)(moduleValue, moduleValue.exports)
const { parseGroupImport, mergeGroupImport } = moduleValue.exports
const current = [{ name: '框內', font: 'Old-Regular', color: 'red' }, { name: 'FX', font: 'FX-Bold' }]

test('default overwrites selected same-name font without applying to manually edited text', () => {
  assert.deepEqual(mergeGroupImport(current, [{ name: '框內', font: 'New-Bold' }], [0]), {
    names: ['框內', 'FX'], fonts: { 0: 'New-Bold' }, applyFontGroups: [],
  })
  assert.equal(current[0].font, 'Old-Regular')
})
test('keep mode preserves conflicts while appending only selected new groups', () => {
  assert.deepEqual(mergeGroupImport(current, [{ name: 'fx', font: 'New' }, { name: '新組', font: 'New' }, { name: '不選' }], [0, 1], 'keep', true), {
    names: ['框內', 'FX', '新組'], fonts: { 2: 'New' }, applyFontGroups: [],
  })
})
test('missing font does not erase an existing default; empty and null explicitly clear only defaults', () => {
  const source = parseGroupImport({ groupList: [{ name: '框內' }, { name: 'FX', font: '' }] })
  assert.deepEqual(mergeGroupImport(current, source, [0, 1], 'overwrite', true), {
    names: ['框內', 'FX'], fonts: { 1: null }, applyFontGroups: [],
  })
  assert.deepEqual(parseGroupImport({ groupList: [{ name: '框內', font: null }] }), [{ name: '框內', font: null }])
})
test('case and whitespace conflicts retain current index, spelling and all unselected entries', () => {
  assert.deepEqual(mergeGroupImport(current, [{ name: ' fx ', font: 'Updated' }, { name: '新組' }], [0], 'overwrite', true), {
    names: ['框內', 'FX'], fonts: { 1: 'Updated' }, applyFontGroups: ['1'],
  })
})
test('source ordering determines only appended group order and never moves existing indices', () => {
  assert.deepEqual(mergeGroupImport(current, [{ name: '新乙' }, { name: '新甲', font: 'New' }, { name: '框內', font: 'Update' }], [2, 1, 0], 'overwrite', true), {
    names: ['框內', 'FX', '新乙', '新甲'], fonts: { 0: 'Update', 3: 'New' }, applyFontGroups: ['0'],
  })
})
test('accepts Meo and saved project JSON while excluding text and unknown group information', () => {
  assert.deepEqual(parseGroupImport({ template: { groupList: [{ name: '框內', font: ' Font-Regular ', arbitrary: 'ignored' }] }, text: 'ignored' }), [{ name: '框內', font: 'Font-Regular' }])
  assert.deepEqual(parseGroupImport({ groupList: [] }), [])
})
test('rejects invalid group collections and duplicate normalized names', () => {
  for (const value of [null, [], {}, { groupList: {} }, { groupList: [null] }, { groupList: [{ name: ' ' }] }, { groupList: [{ name: 'Fx' }, { name: ' fx ' }] }, { groupList: [{ name: 'x'.repeat(81) }] }, { groupList: [{ name: 'bad\nname' }] }, { groupList: [{ name: 3 }] }]) {
    assert.throws(() => parseGroupImport(value))
  }
})
test('rejects invalid font fields and excessive source/final group counts', () => {
  for (const font of [42, {}, [], 'x'.repeat(513), 'Font\u0000Name', 'Font\u0085Name']) assert.throws(() => parseGroupImport({ groupList: [{ name: '組', font }] }))
  const thousand = Array.from({ length: 1000 }, (_, i) => ({ name: `g${i}` }))
  assert.throws(() => parseGroupImport({ groupList: [...thousand, { name: 'extra' }] }))
  assert.throws(() => mergeGroupImport(thousand, [{ name: 'extra' }], [0]))
})
test('rejects stale invalid selections and invalid existing drafts', () => {
  for (const selected of [[-1], [1], [0.5], [NaN]]) assert.throws(() => mergeGroupImport(current, [{ name: '新' }], selected))
  assert.throws(() => mergeGroupImport([{ name: '' }], [], []))
  assert.throws(() => mergeGroupImport(current, [], [], 'invalid'))
})
