const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function harness(fetch) {
  const cache = new Map(), values = [], effects = new Map()
  let cursor = 0, scheduled = []
  const react = {
    useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value }] },
    useRef(initial) { const index = cursor++; if (!(index in values)) values[index] = { current: initial }; return values[index] },
    useEffect(effect, deps) {
      const index = cursor++, before = effects.get(index)
      if (!before || deps.some((value, index) => !Object.is(value, before.deps[index]))) scheduled.push(() => {
        before?.cleanup?.(); effects.set(index, { deps, cleanup: effect() })
      })
    },
  }
  const jsx = (type, props) => ({ type, props })
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    if (file.endsWith('.css')) return module.exports
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    new Function('require', 'module', 'exports', 'fetch', code)(name => {
      if (name === 'react') return react
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      if (name === 'antd') return { Button: 'Button', Input: { TextArea: 'TextArea' }, Popconfirm: 'Popconfirm' }
      return load(path.resolve(path.dirname(file), name.endsWith('.css') ? name : `${name}.ts`))
    }, module, module.exports, fetch)
    return module.exports
  }
  const { InlineQuestionRecord } = load(path.resolve(__dirname, '../src/prelayout/InlineQuestionRecord.tsx'))
  return {
    render(props) { cursor = 0; scheduled = []; const tree = InlineQuestionRecord(props); scheduled.forEach(run => run()); return tree },
    unmount() { effects.forEach(effect => effect.cleanup?.()) },
  }
}
function nodes(element) {
  if (!element || typeof element !== 'object') return []
  if (Array.isArray(element)) return element.flatMap(nodes)
  return [element, ...nodes(element.props?.children)]
}
const find = (tree, predicate) => { const result = nodes(tree).find(predicate); assert(result, 'Expected node'); return result }
const labeled = (tree, label) => find(tree, node => node.props?.['aria-label'] === label)
const button = (tree, text) => find(tree, node => node.type === 'Button' && node.props.children === text)
const settled = () => new Promise(resolve => setImmediate(resolve))
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data })
const page = { id: 'page', name: '1.jpg' }, item = { _id: 'item', text: '文字' }
const reference = { key: 'ref', pageId: 'page', pageNumber: 1, pageName: '1.jpg', itemId: 'item', itemNumber: 1, text: '文字' }
const record = { id: 'record', note: '舊疑問', texts: [reference, { ...reference, key: 'ref-2', itemId: 'item-2', itemNumber: 2 }], createdAt: '2026-10-20T10:00:00Z', updatedAt: '2026-10-20T10:00:00Z' }
function props(extra = {}) {
  return { project: { id: 'fixture', pages: [page], template: {} }, controller: { pages: new Map([['page', { data: { ...page, items: [item] } }]]) }, selection: { page: 'page', ids: ['item'] }, onSaved() {}, ...extra }
}
async function mount(host, input) {
  host.render(input); await settled()
  return host.render(input)
}

test('sidebar is always open and reads on mount; refresh preserves draft and edit snapshot', async () => {
  let reads = 0; const navigated = []
  const host = harness(async () => { reads++; return response({ version: reads, records: [record] }) })
  let input = props({ onNavigate: ref => navigated.push(ref), refreshKey: false })
  let tree = host.render(input)
  assert.equal(tree.type, 'section'); assert.equal(reads, 1)
  assert(!nodes(tree).some(node => node.type === 'details' || node.type === 'summary'))
  assert(find(tree, node => node.type === 'h2' && node.props.children === '疑問記錄'))
  assert(labeled(tree, '記錄疑問'), 'Composer is always visible')
  await settled(); tree = host.render(input)
  assert.equal(reads, 1)
  labeled(tree, '修改疑問 1').props.onClick()
  tree = host.render(input)
  labeled(tree, '記錄疑問').props.onChange({ target: { value: '未儲存修改' } })
  tree = host.render(input)
  labeled(tree, '疑問 1 引用 2：第 1 頁第 2 框').props.onClick()
  await settled(); tree = host.render(input)
  assert.equal(labeled(tree, '記錄疑問').props.value, '未儲存修改')
  assert.equal(navigated[0], record.texts[1])
  tree = host.render(input)
  assert.equal(reads, 1); assert.equal(labeled(tree, '記錄疑問').props.value, '未儲存修改')
  input = { ...input, refreshKey: true }; host.render(input); await settled(); tree = host.render(input)
  assert.equal(reads, 2); assert.equal(labeled(tree, '記錄疑問').props.value, '未儲存修改')
  input = { ...input, refreshKey: false }; host.render(input); await settled(); tree = host.render(input)
  assert.equal(reads, 3); assert.equal(labeled(tree, '記錄疑問').props.value, '未儲存修改')
  button(tree, '取消修改').props.onClick(); tree = host.render(input)
  assert.equal(labeled(tree, '記錄疑問').props.value, '')
  host.unmount()
})

test('list read errors retry independently, retain note, and navigation failure is visible', async () => {
  let fail = true
  const host = harness(async () => fail ? response({ detail: '列表暫不可用' }, 503) : response({ version: 1, records: [record] }))
  const input = props({ onNavigate: async () => { throw new Error('來源框已移除') } })
  let tree = await mount(host, input)
  assert(nodes(tree).some(node => node.props?.role === 'alert'))
  labeled(tree, '記錄疑問').props.onChange({ target: { value: '保留新增草稿' } })
  fail = false; button(tree, '重試讀取記錄').props.onClick()
  host.render(input); await settled(); tree = host.render(input)
  assert.equal(labeled(tree, '記錄疑問').props.value, '保留新增草稿')
  labeled(tree, '疑問 1 引用 1：第 1 頁第 1 框').props.onClick(); await settled(); tree = host.render(input)
  assert(nodes(tree).some(node => node.props?.role === 'alert' && JSON.stringify(node.props.children).includes('來源框已移除')))
  assert.equal(labeled(tree, '記錄疑問').props.value, '保留新增草稿')
  host.unmount()
})

for (const deleting of [false, true]) test(`${deleting ? 'delete' : 'update'} blocks export synchronously and survives unknown success, refresh, and retry`, async () => {
  const statuses = []; let records = structuredClone([record]), writes = 0, added = 0
  const host = harness(async (_, options) => {
    if (!options) return response({ version: writes, records })
    assert.equal(statuses.at(-1), true)
    records = JSON.parse(options.body).records; writes++
    throw new Error('回應中斷')
  })
  let input = props({ onExportPendingChange: value => statuses.push(value), onSaved: () => added++ })
  let tree = await mount(host, input)
  if (deleting) labeled(tree, '刪除疑問 1').props.onClick()
  else {
    labeled(tree, '修改疑問 1').props.onClick(); tree = host.render(input)
    labeled(tree, '記錄疑問').props.onChange({ target: { value: '新問題' } }); tree = host.render(input)
    button(tree, '更新記錄').props.onClick()
  }
  assert.deepEqual(statuses, [true])
  await settled(); tree = host.render(input)
  assert.equal(statuses.at(-1), true); assert.equal(labeled(tree, '記錄疑問').props.disabled, true)
  input = { ...input, refreshKey: 1 }; host.render(input); await settled(); tree = host.render(input)
  assert.equal(statuses.at(-1), true)
  assert.equal(labeled(tree, '記錄疑問').props.disabled, true)
  button(tree, '重試保存').props.onClick(); await settled(); tree = host.render(input)
  assert.equal(writes, 1); assert.equal(statuses.at(-1), false); assert.equal(added, 0)
  assert.equal(labeled(tree, '記錄疑問').props.disabled, false)
  if (!deleting) {
    assert.deepEqual(records[0].texts, record.texts)
    assert.equal(records[0].createdAt, record.createdAt)
    assert.equal(records[0].note, '新問題')
  } else assert.deepEqual(records, [])
  host.unmount()
})

test('only the latest navigation failure is shown and a successful click clears an older error', async () => {
  let rejectFirst, rejectSecond, clicks = 0
  const host = harness(async () => response({ version: 1, records: [record] }))
  const input = props({ onNavigate: () => {
    clicks++
    if (clicks === 1) return new Promise((_, reject) => { rejectFirst = reject })
    if (clicks === 2) return new Promise((_, reject) => { rejectSecond = reject })
  } })
  let tree = await mount(host, input)
  labeled(tree, '疑問 1 引用 1：第 1 頁第 1 框').props.onClick(); await settled()
  labeled(tree, '疑問 1 引用 2：第 1 頁第 2 框').props.onClick(); await settled()
  rejectFirst(new Error('舊定位失敗')); await settled(); tree = host.render(input)
  assert(!nodes(tree).some(node => node.props?.role === 'alert'))
  rejectSecond(new Error('新定位失敗')); await settled(); tree = host.render(input)
  assert(nodes(tree).some(node => node.props?.role === 'alert'))
  labeled(tree, '疑問 1 引用 1：第 1 頁第 1 框').props.onClick(); await settled(); tree = host.render(input)
  assert(!nodes(tree).some(node => node.props?.role === 'alert'))
  host.unmount()
})
