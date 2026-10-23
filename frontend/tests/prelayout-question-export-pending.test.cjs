const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

// Execute the real component event handlers and request code with tiny hook/JSX
// hosts. Effects run only on mount; no DOM or real project is opened or changed.
function harness(file, fetch) {
  const cache = new Map(), values = [], effects = [], cleanups = []
  let cursor = 0, mounted = false
  const react = {
    useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value }] },
    useRef(initial) { const index = cursor++; if (!(index in values)) values[index] = { current: initial }; return values[index] },
    useMemo(make) { cursor++; return make() },
    useEffect(effect) { if (!mounted) effects.push(effect) }, useLayoutEffect() {},
  }
  const jsx = (type, props) => ({ type, props })
  const components = { Button: 'Button', Input: { Search: 'Search', TextArea: 'TextArea' }, Modal: 'Modal', Alert: 'Alert', Checkbox: 'Checkbox', Empty: 'Empty', Popconfirm: 'Popconfirm', Select: 'Select', Spin: 'Spin' }
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports
    const module = { exports: {} }; cache.set(filename, module)
    if (filename.endsWith('.css')) return module.exports
    const code = ts.transpileModule(readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const requireSource = name => {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'antd') return components
      const full = path.resolve(path.dirname(filename), name)
      return load(name.endsWith('.css') ? full : `${full}.ts`)
    }
    new Function('require', 'module', 'exports', 'fetch', code)(requireSource, module, module.exports, fetch)
    return module.exports
  }
  const exported = load(path.resolve(__dirname, '../src/prelayout', file))
  function render(props) {
    cursor = 0
    let element = Object.values(exported)[0](props)
    if (typeof element.type === 'function') element = element.type(element.props)
    if (!mounted) { mounted = true; effects.forEach(effect => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) }) }
    return element
  }
  return { render, unmount: () => cleanups.forEach(cleanup => cleanup()) }
}
function nodes(element) {
  if (!element || typeof element !== 'object') return []
  if (Array.isArray(element)) return element.flatMap(nodes)
  return [element, ...nodes(element.props?.children), ...nodes(element.props?.action)]
}
const find = (element, predicate) => { const node = nodes(element).find(predicate); assert(node, 'Expected interactive element'); return node }
const settled = () => new Promise(resolve => setImmediate(resolve))
const page = { id: 'page', name: '1.jpg' }
const item = { _id: 'text', text: '譯文' }
const reference = { key: '["page","text"]', pageId: 'page', pageName: '1.jpg', pageNumber: 1, itemId: 'text', itemNumber: 1, text: '譯文' }
const project = { id: 'project', name: '測試', pages: [page], template: {} }
const controller = { pages: new Map([['page', { data: { ...page, items: [item] } }]]) }

for (const modal of [false, true]) test(`${modal ? 'modal' : 'inline'} question save synchronously blocks exports and retains the block after an uncertain response until retry succeeds`, async () => {
  const statuses = [], writes = []
  let saved = false, fail = true
  const record = { id: 'existing', note: '原問題', texts: [reference], createdAt: 'now', updatedAt: 'now' }
  const host = harness(modal ? 'QuestionRecordsModal.tsx' : 'InlineQuestionRecord.tsx', async (_, options) => {
    if (!options) return { ok: true, json: async () => ({ version: 0, records: modal ? [record] : [] }) }
    assert.equal(statuses.at(-1), true, 'Export must be blocked before the write request starts')
    writes.push(JSON.parse(options.body))
    if (fail) return { ok: false, status: 503, json: async () => ({ detail: 'unknown save result' }) }
    saved = true
    return { ok: true, json: async () => ({ version: 1, records: writes.at(-1).records }) }
  })
  const props = { open: true, project, controller, selection: { page: 'page', ids: ['text'] }, currentPageId: 'page', onSaved() {}, onClose() {}, onExportPendingChange: value => statuses.push(value) }
  let tree = host.render(props)
  if (modal) {
    await settled(); tree = host.render(props)
    find(tree, node => node.props?.['aria-label'] === '修改疑問 1').props.onClick()
  } else find(tree, node => node.props?.['aria-label'] === '記錄疑問').props.onChange({ target: { value: '問題' } })
  tree = host.render(props)
  find(tree, node => node.type === 'Button' && node.props.children === (modal ? '更新記錄' : '添加記錄')).props.onClick()
  assert.deepEqual(statuses, [true], 'No effect or rerender should be necessary to start blocking')
  await settled(); assert.equal(statuses.at(-1), true)
  tree = host.render(props)
  assert.equal(statuses.at(-1), true, 'Rerender must not run an effect cleanup that clears pending')
  fail = false
  find(tree, node => node.type === 'Button' && node.props.children === '重試保存').props.onClick()
  await settled()
  assert(saved); assert.equal(statuses.at(-1), false); assert.equal(writes.length, 2)
  host.unmount(); assert.equal(statuses.at(-1), false)
})
