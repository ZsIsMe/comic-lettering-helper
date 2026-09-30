const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

const source = readFileSync(path.resolve(__dirname, '../src/prelayout/display-font.ts'), 'utf8')
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
const moduleValue = { exports: {} }
new Function('require', 'module', 'exports', code)(name => {
  assert.equal(name, './api')
  return { base: '/api/prelayout' }
}, moduleValue, moduleValue.exports)
const { displayFontUrl } = moduleValue.exports
const bundled = '/assets/toolbox-demibold-v2.7-example.ttf'

test('bundled font works when server has no display or OCR font, including older servers', () => {
  for (const availability of [
    { display_font_custom: false, display_font_available: false, assets: { font: false }, font_version: '' },
    { assets: { font: false } },
    { assets: { font: true }, font_version: 'old-noto-version' },
  ]) assert.equal(displayFontUrl(bundled, availability), bundled)
})

test('changes to server OCR font do not change the bundled display asset', () => {
  assert.equal(displayFontUrl(bundled, { display_font_custom: false, font_version: 'changed' }), bundled)
})

test('explicit custom font uses its versioned API URL', () => {
  assert.equal(displayFontUrl(bundled, { display_font_custom: true, font_version: 'version + ?' }), '/api/prelayout/font?v=version%20%2B%20%3F')
})

test('missing explicit custom font remains an error instead of silently switching fonts', () => {
  assert.equal(displayFontUrl(bundled, { display_font_custom: true, display_font_available: false, font_version: '' }), '/api/prelayout/font?v=')
})
