const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const code = ts.transpileModule(readFileSync(path.resolve(__dirname, '../src/prelayout/local-preview.ts'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText
const moduleValue = { exports: {} }
new Function('module', 'exports', code)(moduleValue, moduleValue.exports)
const { localPreviewPlan, localPreviewBlob } = moduleValue.exports

test('large local images retain only longest-edge bounded base previews', () => {
  assert.deepEqual(localPreviewPlan({ width: 8000, height: 16000, edge: 1536 }), {
    x: 0, y: 0, width: 8000, height: 16000, outputWidth: 768, outputHeight: 1536,
  })
  assert.deepEqual(localPreviewPlan({ width: 100, height: 50, edge: 768 }), {
    x: 0, y: 0, width: 100, height: 50, outputWidth: 100, outputHeight: 50,
  })
})

test('local full-resolution detail uses the exact original-space crop without expanding it', () => {
  assert.deepEqual(localPreviewPlan({ width: 8000, height: 16000, edge: 768, region: { x: 7600, y: 15000, width: 400, height: 1000 } }), {
    x: 7600, y: 15000, width: 400, height: 1000, outputWidth: 307, outputHeight: 768,
  })
  assert.throws(() => localPreviewPlan({ width: 8000, height: 16000, region: { x: 7900, y: 0, width: 200, height: 100 } }), /裁切/)
  assert.throws(() => localPreviewPlan({ width: 8000, height: 16000, edge: 0 }), /尺寸/)
})

test('native small images do not require a bitmap conversion or re-encoding', async () => {
  const blob = new Blob(['source'])
  assert.equal(await localPreviewBlob(blob, { url: 'blob:test', width: 100, height: 100 }), blob)
})
