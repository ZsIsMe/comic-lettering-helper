const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const file = path.resolve(__dirname, '../src/prelayout/group-colors.ts')
const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const moduleValue = { exports: {} }
new Function('module', 'exports', code)(moduleValue, moduleValue.exports)
const { GROUP_COLORS, groupColor } = moduleValue.exports

test('group display uses twenty fixed unique colors and wraps by modulo 20', () => {
  assert.equal(GROUP_COLORS.length, 20)
  assert.equal(new Set(GROUP_COLORS).size, 20)
  for (let index = 0; index < 60; index++) assert.equal(groupColor(index), GROUP_COLORS[index % 20])
})
