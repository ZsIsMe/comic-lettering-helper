const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const moduleSource = { exports: {} }
new Function('module', 'exports', ts.transpileModule(readFileSync(path.join(__dirname, '../src/prelayout/question-navigation.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText)(moduleSource, moduleSource.exports)
const { questionReferencePage, questionReferenceItem } = moduleSource.exports
const reference = { pageId: 'page', pageName: '001.jpg', itemId: 'target', itemNumber: 1 }

test('reference navigation keeps the stable target after preceding frames are inserted or removed', () => {
  const target = { _id: 'target', text: 'edited since snapshot', y: .7 }
  for (const items of [[target], [{ _id: 'new' }, target]]) assert.equal(questionReferenceItem(items, reference), target)
  const pages = [{ id: 'page', name: 'renamed.jpg' }, { id: 'other', name: '001.jpg' }]
  assert.equal(questionReferencePage(pages, reference), pages[0])
})
test('a missing historical page resolves only an exact filename or unique stem', () => {
  const pages = [{ id: 'new', name: '001.png' }]
  assert.equal(questionReferencePage(pages, reference), pages[0])
  const exact = { id: 'exact', name: '001.jpg' }
  assert.equal(questionReferencePage([...pages, exact], reference), exact)
  assert.throws(() => questionReferencePage([...pages, { id: 'duplicate', name: '001.webp' }], reference), /無法找到/)
  assert.throws(() => questionReferencePage([], reference), /無法找到/)
})
test('deleted references never select a replacement frame merely sharing the ordinal or text', () => {
  assert.throws(() => questionReferenceItem([{ _id: 'replacement', text: 'same snapshot' }], reference), /已不存在/)
  assert.throws(() => questionReferenceItem([{ _id: 'target' }, { _id: 'target' }], reference), /已不存在/)
})
