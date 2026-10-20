const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const source = { exports: {} }
new Function('module', 'exports', ts.transpileModule(readFileSync(path.join(__dirname, '../src/prelayout/question-references.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(source, source.exports)
const { questionReferences } = source.exports
const project = { pages: [{ id: 'first', name: '001.jpg' }, { id: 'second', name: '002.jpg' }, { id: 'unloaded', name: '003.jpg' }] }
const pages = () => new Map([
  ['second', { items: [{ _id: 'shared', text: '目前草稿\n保留換行' }, { _id: 'other', text: '不選取' }] }],
  ['first', { items: [{ _id: 'one', text: '第一條' }, { _id: 'shared', text: '跨頁同 ID' }] }],
])
test('captures cross-page selection in reading order with page and frame references', () => {
  const result = questionReferences(project, pages(), { second: ['shared'], first: ['shared'] })
  assert.deepEqual(result.map(r => [r.pageNumber, r.pageName, r.itemNumber, r.text]), [[1, '001.jpg', 2, '跨頁同 ID'], [2, '002.jpg', 1, '目前草稿\n保留換行']])
  assert.notEqual(result[0].key, result[1].key)
})
test('missing pages, removed frames and an empty selection cannot add unrelated text', () => {
  assert.deepEqual(questionReferences(project, pages(), {}), [])
  assert.deepEqual(questionReferences(project, pages(), { first: ['removed'], unloaded: ['missing'] }), [])
  assert.equal(questionReferences(project, pages(), { first: ['shared'] }).length, 1)
})
test('full question list and selected entry use exactly the same reference format', () => {
  const all = questionReferences(project, pages())
  const selected = questionReferences(project, pages(), { second: ['shared'] })
  assert.equal(all.length, 4)
  assert.deepEqual(selected[0], all[2])
})
test('record text is a snapshot and does not follow later draft edits', () => {
  const data = pages(), selected = questionReferences(project, data, { second: ['shared'] })
  data.get('second').items[0].text = '後來更改'
  assert.equal(selected[0].text, '目前草稿\n保留換行')
})

test('selected snapshots preserve interleaved click order instead of regrouping pages', () => {
  const result = questionReferences(project, pages(), { first: ['one', 'shared'], second: ['shared'] }, [
    { page: 'first', id: 'shared' }, { page: 'second', id: 'shared' }, { page: 'first', id: 'one' },
  ])
  assert.deepEqual(result.map(r => [r.pageNumber, r.itemNumber]), [[1, 2], [2, 1], [1, 1]])
})
