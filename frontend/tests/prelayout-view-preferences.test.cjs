const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const source = readFileSync(path.resolve(__dirname, '../src/prelayout/view-preferences.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const moduleValue = { exports: {} }
new Function('module', 'exports', code)(moduleValue, moduleValue.exports)
const { loadViewPreferences, saveViewPreferences, viewPreferencesKey } = moduleValue.exports
const defaults = {
  zoom: 1, compare: true, clean: true, showText: true, showMeasure: true,
  difference: false, differenceColor: '#ff288c', differenceOpacity: .4,
  focus: false, showService: false,
}
function storage(entries = {}) {
  const values = new Map(Object.entries(entries))
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }
}

test('latest preferences survive switching, a new project, and reloading including focus and service status', () => {
  const target = storage()
  assert.deepEqual(loadViewPreferences('A', target), defaults)
  const changed = {
    zoom: 1.5, compare: false, clean: false, showText: false, showMeasure: false,
    difference: true, differenceColor: '#c0ffee', differenceOpacity: 0,
    focus: true, showService: true,
  }
  saveViewPreferences(changed, target)
  for (const project of ['B', 'new-project', 'A']) assert.deepEqual(loadViewPreferences(project, target), changed)
  const latest = { ...changed, zoom: 2, focus: false }
  saveViewPreferences(latest, target)
  assert.deepEqual(loadViewPreferences('B', target), latest)
  assert.deepEqual(JSON.parse(target.values.get(viewPreferencesKey)), { version: 1, ...latest })
})

test('legacy preferences migrate once and never override a global record or alter project navigation', () => {
  const target = storage({
    'pl-view-A': JSON.stringify({ zoom: .75, compare: false, clean: false, showText: false, showMeasure: false, difference: true }),
    'pl-view-B': JSON.stringify({ zoom: 3, compare: true, difference: false }),
    'pl-difference-style': JSON.stringify({ color: '#ABCDEF', opacity: 0 }),
    'pl-review-range-A': '[2,4]',
    'pl-position-A': '{"page":"page-3"}',
  })
  const before = new Map(target.values)
  const migrated = loadViewPreferences('A', target)
  assert.deepEqual(migrated, {
    ...defaults, zoom: .75, compare: false, clean: false, showText: false, showMeasure: false,
    difference: true, differenceColor: '#abcdef', differenceOpacity: 0,
  })
  saveViewPreferences(migrated, target)
  assert.deepEqual(loadViewPreferences('B', target), migrated)
  for (const [key, value] of before) assert.equal(target.values.get(key), value)
  assert.deepEqual([...target.values.keys()], [...before.keys(), viewPreferencesKey])
})

test('invalid JSON and record shapes safely use defaults; an invalid version can migrate legacy settings', () => {
  for (const value of ['{', 'null', '[]', 'true', '42', '"text"', '{}', '{"version":2}']) {
    assert.deepEqual(loadViewPreferences('A', storage({ [viewPreferencesKey]: value })), defaults)
  }
  assert.equal(loadViewPreferences('A', storage({
    [viewPreferencesKey]: '{"version":2}',
    'pl-view-A': '{"zoom":2}',
  })).zoom, 2)
  assert.deepEqual(loadViewPreferences('A', storage({ 'pl-view-A': 'null', 'pl-difference-style': '[]' })), defaults)
})

test('saved fields require their real types and valid ranges without falling back to another project', () => {
  const target = storage({
    [viewPreferencesKey]: JSON.stringify({
      version: 1, zoom: '2', compare: 'false', clean: 0, showText: null,
      showMeasure: [], difference: {}, focus: 1, showService: 'true',
      differenceColor: 'red', differenceOpacity: '0',
    }),
    'pl-view-A': '{"zoom":3,"compare":false}',
    'pl-difference-style': '{"color":"#000000","opacity":0}',
  })
  assert.deepEqual(loadViewPreferences('A', target), defaults)
  for (const [zoom, expected] of [[0, .5], [100, 3], [1.25, 1.25]]) {
    target.setItem(viewPreferencesKey, JSON.stringify({ version: 1, zoom }))
    assert.equal(loadViewPreferences('A', target).zoom, expected)
  }
  for (const differenceOpacity of [-1, 2, null]) {
    target.setItem(viewPreferencesKey, JSON.stringify({ version: 1, differenceOpacity }))
    assert.equal(loadViewPreferences('A', target).differenceOpacity, .4)
  }
  target.setItem(viewPreferencesKey, '{"version":1,"zoom":1e400,"differenceOpacity":1e400}')
  assert.deepEqual(loadViewPreferences('A', target), defaults)
})

test('blocked storage reads, writes, or access to localStorage never crash the workspace preference path', () => {
  const blocked = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('quota') } }
  assert.deepEqual(loadViewPreferences('A', blocked), defaults)
  assert.doesNotThrow(() => saveViewPreferences(defaults, blocked))
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('blocked') } })
  try {
    assert.deepEqual(loadViewPreferences('A'), defaults)
    assert.doesNotThrow(() => saveViewPreferences(defaults))
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else delete globalThis.localStorage
  }
})
