const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function modules() {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const localRequire = name => load(path.resolve(path.dirname(file), `${name}.ts`))
    new Function('require', 'module', 'exports', code)(localRequire, module, module.exports)
    return module.exports
  }
  return load(path.resolve(__dirname, '../src/prelayout/text-control-labels.ts'))
}

const { quickControlLabel, textInfoLabel } = modules()
const item = extra => ({ _id: 't_fixture', text: '文字', x: .5, y: .5, 'font-size': 24, rotation: 0, orientation: 'vertical', color: '#000000', 'stroke-color': '#ffffff', 'stroke-weight': 0, groupId: 1, ...extra })

test('quick controls describe the state they will apply', () => {
  assert.equal(quickControlLabel(item(), 'color'), '切換白色文字')
  assert.equal(quickControlLabel(item({ color: '#ffffff' }), 'color'), '切換黑色文字')
  assert.equal(quickControlLabel(item(), 'stroke'), '添加描邊')
  assert.equal(quickControlLabel(item({ 'stroke-weight': 4 }), 'stroke'), '關閉描邊')
  assert.equal(quickControlLabel(item(), 'orientation'), '文字橫排')
  assert.equal(quickControlLabel(item({ orientation: 'horizontal' }), 'orientation'), '文字豎排')
})

test('text size badge includes the group name before the font size', () => {
  assert.equal(textInfoLabel(item(), ['框內', '框外']), '框外，24')
  assert.equal(textInfoLabel(item({ groupId: undefined, 'font-size': 24.5 }), ['框內']), '未分組，24.5')
})
