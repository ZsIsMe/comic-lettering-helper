const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const ts = require('typescript')

function load(file) {
  const code = ts.transpileModule(readFileSync(path.resolve(__dirname, `../src/prelayout/${file}`), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => name === './api' ? load('api.ts') : require(name), module, module.exports)
  return module.exports
}
const project = {
  id: 'sample', name: '範例漫畫', updated_at: '2026-10-30T06:00:00Z',
  pages: [
    { id: '1', sha256: 'page-hash', revision: 2, reviewed_revision: 2 },
    { id: '2', revision: 3, reviewed_revision: 2 },
    { id: '3', revision: 0 },
  ],
}
function setup({ query = '', projects = [project], recentProjectIds = [] } = {}) {
  const events = []
  const { ProjectLibrary } = load('ProjectLibrary.tsx')
  const tree = ProjectLibrary({
    projects, recentProjectIds, query,
    onQueryChange: value => events.push(['query', value]),
    onOpen: value => events.push(['open', value]),
    onRename: value => events.push(['rename', value]),
    onDelete: value => events.push(['delete', value]),
  })
  return { tree, events, html: renderToStaticMarkup(tree) }
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!React.isValidElement(value)) return []
  return [value, ...nodes(value.props.children)]
}
function section(tree, label) {
  return nodes(tree).find(node => node.type === 'section' && node.props['aria-label'] === label)
}
function names(value) {
  return nodes(value).filter(node => ['pl-project-name', 'pl-recent-title'].includes(node.props.className)).map(node => node.props.children)
}

test('home renders only compact rows with current completion metadata', () => {
  const { html } = setup()
  assert(!html.includes('<img'))
  assert(!html.includes('pl-cover'))
  assert(!html.includes('卡片'))
  assert(!html.includes('項目顯示模式'))
  assert.match(html, /範例漫畫/)
  assert.match(html, /3 頁/)
  assert.match(html, /已完成 1 \/ 3 頁/)
  assert.match(html, /最近更新/)
  assert.match(html, /尚無最近開啟的項目/)
})

test('full list sorts names naturally regardless of latest edit time and leaves source order intact', () => {
  const items = [
    { ...project, id: 'ten', name: '漫畫10', updated_at: '2030-01-01T00:00:00Z' },
    { ...project, id: 'hundred', name: '漫畫164' },
    { ...project, id: 'two', name: '漫畫2', updated_at: '2020-01-01T00:00:00Z' },
  ]
  const { tree } = setup({ projects: items })
  assert.deepEqual(names(section(tree, '全部項目')), ['漫畫2', '漫畫10', '漫畫164'])
  assert.deepEqual(items.map(p => p.id), ['ten', 'hundred', 'two'])
})

test('recent section preserves opened order, deduplicates IDs, skips deleted projects and stops at three', () => {
  const items = [1, 2, 3, 4].map(n => ({ ...project, id: String(n), name: `漫畫${n}` }))
  const { tree } = setup({ projects: items, recentProjectIds: ['gone', '4', '4', '2', '3', '1'] })
  assert.deepEqual(names(section(tree, '最近開啟')), ['漫畫4', '漫畫2', '漫畫3'])
  const recentNodes = nodes(section(tree, '最近開啟'))
  assert.deepEqual(recentNodes.filter(n => n.type === 'img').map(n => n.props.src),
    ['4', '2', '3'].map(id => `/api/prelayout/projects/${id}/pages/1/layers/original?v=page-hash&edge=384`))
  assert.equal(recentNodes.filter(n => n.type === 'button').length, 3)
  assert(!recentNodes.some(n => /pl-project-(meta|progress|pages|updated|actions)/.test(n.props.className || '')))
  assert(!nodes(section(tree, '全部項目')).some(n => n.type === 'img'))
  assert.deepEqual(names(section(tree, '全部項目')), ['漫畫1', '漫畫2', '漫畫3', '漫畫4'])
})

test('search filters only full list, preserves recent access and allows clearing unmatched query', () => {
  const matching = { ...project, id: 'matching', name: 'Sample 漫畫' }
  const filtered = setup({ query: '  SAMPLE  ', projects: [project, matching], recentProjectIds: [project.id] })
  assert.deepEqual(names(section(filtered.tree, '全部項目')), [matching.name])
  assert.deepEqual(names(section(filtered.tree, '最近開啟')), [project.name])
  assert.match(filtered.html, /1 \/ 2.*個項目/)
  const empty = setup({ query: '不存在', projects: [project, matching] })
  assert.match(empty.html, /沒有符合的項目/)
  nodes(empty.tree).find(node => node.props.children === '清除篩選').props.onClick()
  assert.deepEqual(empty.events, [['query', '']])
})

test('name and open button each trigger one open while rename and delete keep existing callbacks', () => {
  const { tree, events } = setup({ recentProjectIds: [project.id] })
  const allRows = nodes(section(tree, '全部項目'))
  for (const [label, expected] of [['開啟', 'open'], ['改名', 'rename'], ['刪除', 'delete']]) {
    const before = events.length
    allRows.find(node => node.props.children === label).props.onClick()
    assert.equal(events.length, before + 1)
    assert.deepEqual(events.at(-1), [expected, project])
  }
  const before = events.length
  allRows.find(node => node.props.className === 'pl-project-name').props.onClick()
  assert.equal(events.length, before + 1)
  assert.deepEqual(events.at(-1), ['open', project])
  const recentRows = nodes(section(tree, '最近開啟'))
  recentRows.find(node => node.props.className === 'pl-recent-item').props.onClick()
  assert.deepEqual(events.at(-1), ['open', project])
  assert(!recentRows.some(node => node.props.children === '改名' || node.props.children === '刪除'))
})
