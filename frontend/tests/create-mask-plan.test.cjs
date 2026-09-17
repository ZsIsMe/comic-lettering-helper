const test = require('node:test')
const assert = require('node:assert/strict')
const ts = require('typescript')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const code = ts.transpileModule(readFileSync(path.join(__dirname, '../src/create-mask-plan.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
}).outputText
const mod = { exports: {} }
new Function('exports', code)(mod.exports)
const { createMaskPlan } = mod.exports
const files = (...names) => names.map(name => ({ name }))
test('no, partial and complete masks select only missing pages', () => {
  const sources = files('01.jpg', '02.png')
  assert.deepEqual(createMaskPlan(sources, []), { supplied: 0, missing: 2, invalid: false })
  assert.deepEqual(createMaskPlan(sources, files('02.png')), { supplied: 1, missing: 1, invalid: false })
  assert.deepEqual(createMaskPlan(sources, files('02.png', '01.png')), { supplied: 2, missing: 0, invalid: false })
})
test('reject unmatched and duplicate stems and match API normalization', () => {
  assert.equal(createMaskPlan(files('01.jpg'), files('02.png')).invalid, true)
  assert.equal(createMaskPlan(files('01.jpg', '01.png'), []).invalid, true)
  assert.equal(createMaskPlan(files('01.jpg'), files('01.png', '01.png')).invalid, true)
  assert.deepEqual(createMaskPlan(files('page 01.JPG'), files('page_01.png')), { supplied: 1, missing: 0, invalid: false })
})
