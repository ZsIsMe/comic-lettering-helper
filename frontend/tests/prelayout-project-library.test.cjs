const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')
const ts = require('typescript')

function load(file, overrides = {}) {
  const code = ts.transpileModule(readFileSync(path.resolve(__dirname, `../src/prelayout/${file}`), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => overrides[name] ?? require(name), module, module.exports)
  return module.exports
}
const project = {
  id: 'sample', name: '範例漫畫', updated_at: '2026-10-30T06:00:00Z',
  pages: [
    { id: '1', revision: 2, reviewed_revision: 2 },
    { id: '2', revision: 3, reviewed_revision: 2 },
    { id: '3', revision: 0 },
  ],
}
function setup(view, query = '', projects = [project]) {
  const previews = [], events = []
  const { ProjectLibrary } = load('ProjectLibrary.tsx', {
    './api': { previewUrl: (...args) => { previews.push(args); return '/fixture/preview' } },
  })
  const tree = ProjectLibrary({
    projects, view, query,
    onQueryChange: value => events.push(['query', value]),
    onViewChange: value => events.push(['view', value]),
    onOpen: value => events.push(['open', value]),
    onRename: value => events.push(['rename', value]),
    onDelete: value => events.push(['delete', value]),
  })
  return { tree, previews, events, html: renderToStaticMarkup(tree) }
}
function nodes(value) {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!React.isValidElement(value)) return []
  return [value, ...nodes(value.props.children)]
}

test('default list renders project metadata without an image or generating a preview URL', () => {
  const { loadProjectView } = load('project-view.ts')
  const { html, previews } = setup(loadProjectView({ getItem: () => null }))
  assert(!html.includes('<img'))
  assert(!html.includes('pl-cover'))
  assert(!html.includes('/preview'))
  assert.deepEqual(previews, [])
  assert.match(html, /範例漫畫/)
  assert.match(html, /3 頁/)
  assert.match(html, /已完成 1 \/ 3 頁/)
  assert.match(html, /最近更新/)
  assert.match(html, /aria-pressed="true"[^>]*><span>列/)
})

test('both views share name filtering and cards only request matching previews', () => {
  const matching = { ...project, id: 'matching', name: 'Sample 漫畫' }
  for (const view of ['list', 'cards']) {
    const { html, previews } = setup(view, '  SAMPLE  ', [project, matching])
    assert.match(html, /Sample 漫畫/)
    assert(!html.includes('範例漫畫'))
    assert.match(html, /1 \/ 2.*個項目/)
    assert.equal(previews.length, view === 'cards' ? 1 : 0)
    if (view === 'cards') assert.equal(previews[0][0], matching.id)
    const empty = setup(view, '不存在', [project, matching])
    assert.match(empty.html, /沒有符合的項目/)
    assert.deepEqual(empty.previews, [])
    nodes(empty.tree).find(node => node.props.children === '清除篩選').props.onClick()
    assert.deepEqual(empty.events.at(-1), ['query', ''])
  }
})

for (const view of ['list', 'cards']) test(`${view} preserves open, rename, delete and view controls`, () => {
  const { tree, html, previews, events } = setup(view)
  const all = nodes(tree)
  for (const [label, expected] of [[view === 'list' ? '開啟' : '繼續預排版', 'open'], ['改名', 'rename'], ['刪除', 'delete']]) {
    assert.match(html, new RegExp([...label].join('\\s*')))
    all.find(node => node.props.children === label).props.onClick()
    assert.deepEqual(events.at(-1), [expected, project])
  }
  all.find(node => node.props.className === 'pl-project-name').props.onClick()
  assert.deepEqual(events.at(-1), ['open', project])
  for (const [label, mode] of [['列表', 'list'], ['卡片', 'cards']]) {
    const button = all.find(node => node.props.children === label)
    assert.equal(button.props['aria-pressed'], view === mode)
    button.props.onClick()
    assert.deepEqual(events.at(-1), ['view', mode])
  }
  assert.equal(previews.length, view === 'cards' ? 1 : 0)
  assert.equal(html.includes('<img'), view === 'cards')
  if (view === 'cards') {
    assert.deepEqual(previews[0], [project.id, project.pages[0], 384])
    all.find(node => node.props.className === 'pl-cover').props.onClick()
    assert.deepEqual(events.at(-1), ['open', project])
  }
})

test('home view defaults to list and remembers each mode across reads without touching editor preferences', () => {
  const { loadProjectView, saveProjectView } = load('project-view.ts')
  const values = new Map([['pl-view-preferences', '{"version":1,"zoom":2}']])
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
  assert.equal(loadProjectView(storage), 'list')
  for (const mode of ['cards', 'list', 'cards']) {
    saveProjectView(mode, storage)
    assert.equal(loadProjectView(storage), mode)
    assert.equal(values.get('pl-project-view'), mode)
  }
  values.set('pl-project-view', 'unknown')
  assert.equal(loadProjectView(storage), 'list')
  assert.equal(values.get('pl-view-preferences'), '{"version":1,"zoom":2}')
})

test('blocked storage access and writes leave the home view usable', () => {
  const { loadProjectView, saveProjectView } = load('project-view.ts')
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('quota') } }
  assert.equal(loadProjectView(blocked), 'list')
  assert.doesNotThrow(() => saveProjectView('cards', blocked))
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked') } })
  try {
    assert.equal(loadProjectView(), 'list')
    assert.doesNotThrow(() => saveProjectView('list'))
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  }
})
