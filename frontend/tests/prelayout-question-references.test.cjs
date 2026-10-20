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

test('captures original metadata and page summaries without layout in click order', () => {
  const data = pages()
  Object.assign(data.get('first').items[1], {
    index: 8, groupId: 1, x: .5, y: .5, rotation: 0, orientation: 'vertical', 'font-size': 24, font_size: 24,
    color: '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 0, xyxy_pixel: [0, 0, 10, 10],
    match_status: 'matched', match_source_block_index: 0, match_custom: 'state', need_inpaint: true, max_break: 12, 'text-direction': 'horizontal',
    bbox: [0, 0, 10, 10], center_normalized: [.5, .5],
    ocr_text: '日本語\n原文', baseball_term: { term: 'GM', notes: ['球團總經理'] },
    term_explanation: null, future_annotation: { reviewed: false }, absent: undefined,
  })
  const withSummary = { ...project, template: { page_summary: { '001.jpg': { text: '第一頁概括', tags: ['棒球'] }, '002.jpg': null } } }
  const result = questionReferences(withSummary, data, { first: ['shared'], second: ['shared'] }, [
    { page: 'second', id: 'shared' }, { page: 'first', id: 'shared' },
  ])
  assert.deepEqual(result.map(r => r.pageNumber), [2, 1])
  assert.equal(result[0].pageSummary, null)
  assert.equal('source' in result[0], false)
  assert.deepEqual(result[1].source, { ocr_text: '日本語\n原文', baseball_term: { term: 'GM', notes: ['球團總經理'] }, term_explanation: null, future_annotation: { reviewed: false } })
  assert.deepEqual(result[1].pageSummary, { text: '第一頁概括', tags: ['棒球'] })
  data.get('first').items[1].baseball_term.notes.push('後續修改')
  withSummary.template.page_summary['001.jpg'].tags.push('後續修改')
  assert.deepEqual(result[1].source.baseball_term.notes, ['球團總經理'])
  assert.deepEqual(result[1].pageSummary.tags, ['棒球'])
})

test('does not invent optional snapshot fields without source metadata', () => {
  const basic = questionReferences(project, pages())[0]
  assert.deepEqual(Object.keys(basic), ['key', 'pageId', 'pageNumber', 'pageName', 'itemId', 'itemNumber', 'text'])
  const missing = questionReferences({ ...project, template: { page_summary: { '001.jpg': undefined } } }, pages())[0]
  assert.deepEqual(missing, basic)
  const emptySummary = questionReferences({ ...project, template: { page_summary: { '001.jpg': '' } } }, pages())[0]
  assert.equal(emptySummary.pageSummary, '')
})
