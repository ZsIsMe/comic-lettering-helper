const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const mod = { exports: {} }
const code = ts.transpileModule(readFileSync(path.resolve(__dirname, '../src/prelayout/local-fonts.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
new Function('module', 'exports', code)(mod, mod.exports)
const { fontName, itemFontFamily, localFontAlias, loadLocalFont, normalizeFonts } = mod.exports

test('font names stay distinct and unsafe/missing values do not affect fallback', () => {
  for (const value of [null, {}, '', 'a\nb', 'a\x00', 'x'.repeat(513)]) assert.equal(itemFontFamily(value), undefined)
  assert.equal(fontName(' NotoSansCJKjp-Medium '), 'NotoSansCJKjp-Medium')
  assert.notEqual(localFontAlias('Face-Regular'), localFontAlias('Face-Bold'))
  assert.match(itemFontFamily('Face";color:red'), /^"PLLocal-[a-f0-9-]+",/)
})
test('exact PostScript face loads once, failed faces can be retried without changing stored name', async () => {
  const faces = []
  global.document = { fonts: { add: face => faces.push(face) } }
  let fail = true
  global.FontFace = class {
    constructor(family, source) { this.family = family; this.source = source }
    async load() { if (fail) throw new Error('missing'); return this }
  }
  await assert.rejects(loadLocalFont('Test-Bold'))
  assert.equal(faces.length, 0)
  fail = false
  await loadLocalFont('Test-Bold', true)
  await loadLocalFont('Test-Bold')
  assert.equal(faces.length, 1)
  assert.equal(faces[0].source, 'local("Test-Bold")')
  assert.equal(faces[0].family, localFontAlias('Test-Bold'))
  delete global.FontFace; delete global.document
})
test('font picker keeps different weights while deduplicating exact PostScript names', () => {
  const font = (postscriptName, fullName) => ({ postscriptName, family: 'Test', fullName, style: 'Regular' })
  assert.deepEqual(normalizeFonts([font('A', 'A'), font('B', 'B'), font('A', 'A'), font('', 'Invalid')]).map(f => f.postscriptName), ['A', 'B'])
})

const { fontFamilies, selectedFontFamily, familyFace, fontStyleLabel } = mod.exports
const face = (postscriptName, style, extra = {}) => ({ postscriptName, family: 'PingFang TC', fullName: `PingFang TC ${style}`, style, ...extra })
test('localized families group actual faces and remain searchable in Chinese, English and PostScript names', () => {
  const groups = fontFamilies([
    face('PingFangTC-Bold', 'Bold', { localizedFamily: '蘋方-繁', localizedStyle: '粗體' }),
    face('PingFangTC-Regular', 'Regular', { localizedFamily: '蘋方-繁', localizedStyle: '標準體' }),
    face('PingFangTC-Light', 'Light'),
  ])
  assert.equal(groups.length, 1)
  assert.equal(groups[0].name, 'PingFang TC')
  assert.equal(groups[0].label, '蘋方-繁')
  assert.match(groups[0].search, /蘋方-繁/)
  assert.match(groups[0].search, /PingFangTC-Bold/)
  assert.deepEqual(groups[0].faces.map(font => font.style), ['Light', 'Regular', 'Bold'])
  assert.equal(fontStyleLabel(groups[0].faces[2]), '粗體')
})
test('mixed weights retain their common family but different or missing families stay mixed', () => {
  const fonts = [face('TC-R', 'Regular'), face('TC-B', 'Bold'), face('HK-R', 'Regular', { family: 'PingFang HK' })]
  assert.equal(selectedFontFamily(fonts, ['TC-R', 'TC-B']), 'PingFang TC')
  for (const values of [[], ['TC-R', 'HK-R'], ['TC-R', undefined], ['TC-R', 'Missing']]) assert.equal(selectedFontFamily(fonts, values), undefined)
})
test('changing family keeps an existing style when possible, otherwise chooses a real regular face', () => {
  const family = fontFamilies([face('TC-B', 'Bold'), face('TC-R', 'Regular')])[0]
  assert.equal(familyFace(family, face('Other-B', 'Bold')).postscriptName, 'TC-B')
  assert.equal(familyFace(family, face('Other-Light', 'Light')).postscriptName, 'TC-R')
  assert.equal(familyFace(fontFamilies([face('Only-M', 'Medium')])[0]).postscriptName, 'Only-M')
  assert.equal(fontFamilies([face('TC-R', 'Regular')])[0].label, 'PingFang TC')
})
