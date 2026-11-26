const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function harness(fetch = () => assert.fail('unexpected request')) {
  const cache = new Map(), timers = []
  const environment = { fetch, indexedDB: { open: () => ({}) }, performance: { now: () => 0 },
    setTimeout: callback => { timers.push(callback); return timers.length }, clearTimeout: () => {} }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', ...Object.keys(environment), code)(name => load(path.resolve(path.dirname(file), `${name}.ts`)), module, module.exports, ...Object.values(environment))
    return module.exports
  }
  return { ...load(path.resolve(__dirname, '../src/prelayout/source-line-count.ts')), ...load(path.resolve(__dirname, '../src/prelayout/line-breaks.ts')), ...load(path.resolve(__dirname, '../src/prelayout/editor-state.ts')), timers }
}
const item = extra => ({ _id: 'text-a', text: '甲乙，丙 丁😀', x: .5, y: .4, orientation: 'vertical', 'font-size': 24, rotation: 12, 'stroke-weight': 2, 'stroke-color': '#fff', color: '#000', groupId: 3, font: 'FixtureFont', match_status: 'auto', custom: { source: '保留' }, ...extra })
const selection = { page: 'page-a', ids: ['text-a'] }
const original = '甲乙，丙 丁😀'
const candidate = '甲乙，\n丙 丁😀'
const suggestions = () => ({ original_text: original, source_line_count: 2, candidates: [{ line_count: 2, text: candidate }, { line_count: 1, text: original }] })
function editor(EditorState) {
  const controller = new EditorState('fixture')
  controller.pages.set('page-a', { data: { id: 'page-a', items: [item(), item({ _id: 'text-b', text: '另一框' })], line_break_suggestions: { 'text-a': suggestions() }, revision: 1 }, undo: [], redo: [], version: 0, dirty: false, saving: false, conflict: false, error: '' })
  return controller
}

test('exact non-newline preservation includes punctuation, spaces and Unicode while accepting CR, LF and CRLF', () => {
  const { sameCharacters } = harness()
  assert(sameCharacters('甲 乙，😀\r\n丙', '甲 \n乙，\n😀\r丙'))
  assert(sameCharacters('甲\r\n乙', '甲\n乙'))
  for (const changed of ['甲乙，😀丙', '甲 乙,😀丙', '甲 乙，丙😀', '甲 乙，😁丙']) assert(!sameCharacters('甲 乙，😀丙', changed))
})

test('inline options show exact imported text and actual candidates, deduplicated in order', () => {
  const { lineBreakOptions } = harness()
  const data = { line_break_suggestions: { 'text-a': suggestions() } }
  assert.deepEqual(lineBreakOptions(item(), data).options, [{ label: '匯入原文 · 1列版', text: original }, { label: '2列版', text: candidate }])
  assert.equal(lineBreakOptions(item({ orientation: 'horizontal' }), data).options[1].label, '2行版')
  assert.equal(lineBreakOptions(item(), {}).options.length, 0)
  data.line_break_suggestions['text-a'].candidates = []
  assert.deepEqual(lineBreakOptions(item(), data).options, [{ label: '匯入原文', text: original }])
})

test('changing only line breaks can restore imported text, but changing characters invalidates old suggestions', () => {
  const { lineBreakOptions } = harness()
  const data = { line_break_suggestions: { 'text-a': suggestions() } }
  assert.equal(lineBreakOptions(item({ text: '甲\n乙，丙 丁😀' }), data).options[0].text, original)
  const result = lineBreakOptions(item({ text: '甲乙，丙丁😀' }), data)
  assert.deepEqual(result.options, []); assert.match(result.notice, /文字已改動/)
})

test('invalid candidates and texts beyond 50000 Unicode codepoints are never selectable', () => {
  const { lineBreakOptions } = harness()
  const data = { line_break_suggestions: { 'text-a': suggestions() } }
  data.line_break_suggestions['text-a'].candidates.push({ line_count: 2, text: '甲乙，\n丙丁😀' }, { line_count: 0, text: original })
  assert.equal(lineBreakOptions(item(), data).options.length, 2)
  const atLimit = '😀'.repeat(50000)
  data.line_break_suggestions['text-a'] = { original_text: atLimit, source_line_count: 1, candidates: [{ line_count: 2, text: atLimit + '\n' }] }
  assert.equal(lineBreakOptions(item({ text: atLimit }), data).options.length, 1)
  data.line_break_suggestions['text-a'].original_text += '甲'
  assert.equal(lineBreakOptions(item({ text: atLimit + '甲' }), data).options.length, 0)
})

test('preview does not mutate text, metadata, undo or save state; adopt changes only text in one undo step', () => {
  const { EditorState, createLineBreakPreview, applyLineBreaks, timers } = harness()
  const controller = editor(EditorState), state = controller.pages.get('page-a'), before = structuredClone(state)
  const preview = createLineBreakPreview(controller, selection, candidate)
  assert.deepEqual(state, before); assert.equal(timers.length, 0)
  assert.equal(applyLineBreaks(controller, selection, preview), true)
  assert.deepEqual(state.data.items, [{ ...before.data.items[0], text: candidate }, before.data.items[1]])
  assert.deepEqual(state.data.line_break_suggestions, before.data.line_break_suggestions)
  assert.equal(state.undo.length, 1); assert.equal(state.dirty, true); assert.equal(timers.length, 1)
  controller.undo('page-a'); assert.deepEqual(state.data.items, before.data.items)
  controller.undo('page-a', true); assert.equal(state.data.items[0].text, candidate)
})

test('same-page and cross-page multiple selection, including unloaded pages, cannot preview or adopt', () => {
  const { EditorState, createLineBreakPreview, applyLineBreaks, singleLineBreakItem } = harness()
  const controller = editor(EditorState), preview = createLineBreakPreview(controller, selection, candidate)
  for (const selected of [{ ...selection, ids: ['text-a', 'text-b'] }, { ...selection, byPage: { 'page-b': ['unloaded'] } }]) {
    assert.equal(singleLineBreakItem(controller, selected), null)
    assert.throws(() => createLineBreakPreview(controller, selected, candidate), /一個文字框/)
    assert.throws(() => applyLineBreaks(controller, selected, preview), /已變更/)
  }
  assert.equal(controller.pages.get('page-a').undo.length, 0)
})

test('stale previews are rejected after text, position or style edits, including later undo', () => {
  const { EditorState, createLineBreakPreview, applyLineBreaks, lineBreakPreviewMatches } = harness()
  for (const changes of [{ text: '改字' }, { x: .8 }, { font: 'AnotherFont' }]) {
    const controller = editor(EditorState), state = controller.pages.get('page-a'), preview = createLineBreakPreview(controller, selection, candidate)
    controller.edit('page-a', state.data.items.map(value => value._id === 'text-a' ? { ...value, ...changes } : value))
    assert.equal(lineBreakPreviewMatches(controller, selection, preview), false)
    assert.throws(() => applyLineBreaks(controller, selection, preview), /已變更/)
    controller.undo('page-a')
    assert.equal(lineBreakPreviewMatches(controller, selection, preview), false)
  }
})

test('adopt can restore import line breaks and no-op does not create history', () => {
  const { EditorState, createLineBreakPreview, applyLineBreaks } = harness()
  const controller = editor(EditorState), state = controller.pages.get('page-a')
  assert.equal(applyLineBreaks(controller, selection, createLineBreakPreview(controller, selection, original)), false)
  assert.equal(state.undo.length, 0)
  state.data.items[0].text = candidate
  assert.equal(applyLineBreaks(controller, selection, createLineBreakPreview(controller, selection, original)), true)
  assert.equal(state.data.items[0].text, original)
})


test('CRLF, CR and LF versions deduplicate while preserving the exact imported string and merged labels', () => {
  const { lineBreakOptions } = harness()
  const data = { line_break_suggestions: { 'text-a': { original_text: '甲\r\n乙', source_line_count: 2, candidates: [
    { line_count: 2, text: '甲\n乙' }, { line_count: 2, text: '甲\r乙' }, { line_count: 1, text: '甲乙' },
  ] } } }
  assert.deepEqual(lineBreakOptions(item({ text: '甲\n乙' }), data).options, [
    { label: '匯入原文 · 2列版', text: '甲\r\n乙' }, { label: '1列版', text: '甲乙' },
  ])
})

test('preview and adopt never finish or save a currently active canvas text draft', () => {
  const { EditorState, createLineBreakPreview, applyLineBreaks } = harness()
  const controller = editor(EditorState), state = controller.pages.get('page-a')
  const preview = createLineBreakPreview(controller, selection, candidate)
  controller.beginTextDraft('page-a', () => assert.fail('must not finish the draft'))
  assert.throws(() => createLineBreakPreview(controller, selection, candidate), /完成畫布/)
  assert.throws(() => applyLineBreaks(controller, selection, preview), /完成畫布/)
  assert.equal(state.undo.length, 0); assert.equal(state.dirty, false)
})


test('inspect prefers precise OCR line counts, treats explicit zero as unknown and labels legacy estimates', () => {
  const { sourceLineCount } = harness()
  const matched = item({ match_source_block_index: 4 })
  const data = { measure: [{ source_block_index: 4, source_line_count: 3 }], character_boxes: [
    { source_block_index: 4, line_index: 0 }, { source_block_index: 4, line_index: 1 },
  ] }
  assert.deepEqual(sourceLineCount(matched, data), { source_line_count: 3, source_line_count_source: 'ctd_lines' })
  data.measure[0].source_line_count = 0
  assert.deepEqual(sourceLineCount(matched, data), { source_line_count: 0, source_line_count_source: 'unknown' })
  delete data.measure[0].source_line_count
  assert.deepEqual(sourceLineCount(matched, data), { source_line_count: 2, source_line_count_source: 'character_boxes_estimate' })
  assert.deepEqual(sourceLineCount(item(), data), { source_line_count: null, source_line_count_source: 'unknown' })
})

test('availability messages distinguish known missing prerequisites without suggesting reimport', () => {
  const { lineBreakOptions, lineBreakSelectionNotice, EditorState } = harness()
  const controller = editor(EditorState)
  assert.match(lineBreakSelectionNotice(controller, { page: 'page-a', ids: [] }), /選取一個/)
  assert.match(lineBreakSelectionNotice(controller, { page: 'page-a', ids: ['text-a'], byPage: { other: ['x'] } }), /2 框/)
  assert.match(lineBreakSelectionNotice(controller, { page: 'unloaded', ids: ['x'] }), /尚未載入/)
  assert.match(lineBreakOptions(item(), { measure: [] }).notice, /沒有偵測量測/)
  assert.match(lineBreakOptions(item({ match_source_block_index: 4 }), { measure: [{ source_block_index: 4 }] }).notice, /缺少.*精確 CTD/)
  assert.match(lineBreakOptions(item({ match_source_block_index: 4 }), { measure: [{ source_block_index: 4, source_line_count: 0 }] }).notice, /未知（0）/)
  assert.match(lineBreakOptions(item({ match_status: 'unmatched' }), { measure: [{ source_block_index: 4, source_line_count: 3 }] }).notice, /可靠的原文匹配/)
  assert.match(lineBreakOptions(item({ match_source_block_index: 4 }), { measure: [{ source_block_index: 4, source_line_count: 3 }] }).notice, /未提供.*候選/)
  for (const data of [{}, { measure: [] }, { measure: [{ source_block_index: 4 }] }]) assert.doesNotMatch(lineBreakOptions(item(), data).notice, /重新匯入|重導/)
})

test('all supplied N+1, N and N-1 candidates are exposed without a fixed option count', () => {
  const { lineBreakOptions } = harness()
  const text = '甲乙丙丁戊己', data = { line_break_suggestions: { 'text-a': { original_text: text, source_line_count: 3, candidates: [
    { line_count: 4, text: '甲乙\n丙丁\n戊\n己' }, { line_count: 3, text: '甲乙\n丙丁\n戊己' }, { line_count: 2, text: '甲乙丙\n丁戊己' },
  ] } } }
  assert.deepEqual(lineBreakOptions(item({ text }), data).options.map(option => option.label), ['匯入原文', '4列版', '3列版', '2列版'])
  data.line_break_suggestions['text-a'].candidates = []
  assert.match(lineBreakOptions(item({ text }), data).notice, /只有匯入原文/)
})

function controlsHarness(controller, selection) {
  const states = [], calls = [], cache = new Map()
  let hook = 0
  const props = { controller, selection, preview: null, disabled: false, onPreview: value => { calls.push(value); props.preview = value }, onApplied: () => assert.fail('must not adopt') }
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText
    const localRequire = name => {
      if (name === 'react/jsx-runtime') return require('react/jsx-runtime')
      if (name === 'react') return { useId: () => 'fixture-panel', useMemo: fn => fn(), useState: initial => { const id = hook++; if (!(id in states)) states[id] = initial; return [states[id], value => { states[id] = typeof value === 'function' ? value(states[id]) : value }] } }
      if (name === 'antd') return { Button: 'Button', Space: 'Space' }
      return load(path.resolve(path.dirname(file), `${name}.ts`))
    }
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports)
    return module.exports
  }
  const { LineBreakControls } = load(path.resolve(__dirname, '../src/prelayout/LineBreakControls.tsx'))
  function descendants(node) {
    if (Array.isArray(node)) return node.flatMap(descendants)
    if (!node || typeof node !== 'object') return []
    return [node, ...descendants(node.props?.children)]
  }
  return { props, calls, render() { hook = 0; return descendants(LineBreakControls(props)) } }
}

test('real adjustment entry remains visible without selection and closing it clears preview', () => {
  const { EditorState } = harness(), controller = editor(EditorState)
  const ui = controlsHarness(controller, { page: 'page-a', ids: [] })
  let nodes = ui.render()
  const trigger = nodes.find(node => node.type === 'Button' && node.props.children === '調整斷句')
  assert(trigger); assert.equal(trigger.props.disabled, undefined); assert.equal(trigger.props['aria-expanded'], true)
  assert(nodes.some(node => node.props?.role === 'status' && /選取一個/.test(node.props.children)))
  ui.props.preview = { page: 'page-a', id: 'text-a', text: candidate }
  trigger.props.onClick()
  nodes = ui.render()
  assert.equal(ui.calls.at(-1), null)
  assert(!nodes.some(node => node.props?.id === 'fixture-panel'))
  const collapsed = nodes.find(node => node.type === 'Button' && node.props.children === '調整斷句')
  assert.equal(collapsed.props['aria-expanded'], false)
  collapsed.props.onClick(); assert(ui.render().some(node => node.props?.id === 'fixture-panel'))
  assert.equal(controller.pages.get('page-a').undo.length, 0)
})

test('selected frame candidates are immediately clickable and cancel never writes', () => {
  const { EditorState } = harness(), controller = editor(EditorState)
  const ui = controlsHarness(controller, selection)
  const option = ui.render().find(node => node.type === 'button' && node.props.children.some(child => child?.type === 'pre' && child.props.children === candidate))
  assert(option); option.props.onClick()
  assert.equal(ui.props.preview.text, candidate)
  assert.equal(controller.pages.get('page-a').undo.length, 0)
  ui.render().find(node => node.type === 'Button' && node.props.children === '取消預覽').props.onClick()
  assert.equal(ui.props.preview, null)
  const workbench = readFileSync(path.resolve(__dirname, '../src/prelayout/PrelayoutWorkbench.tsx'), 'utf8')
  assert(workbench.indexOf('<LineBreakControls') < workbench.indexOf('{first ?'))
})
