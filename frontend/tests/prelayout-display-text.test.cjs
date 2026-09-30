const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')

function modules(document) {
  const cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('require', 'module', 'exports', 'document', code)(name => {
      assert(name.startsWith('./'))
      return load(path.resolve(path.dirname(file), `${name}.ts`))
    }, module, module.exports, document)
    return module.exports
  }
  return name => load(path.resolve(__dirname, `../src/prelayout/${name}.ts`))
}
const { displayText } = modules()('display-text')

test('corner and curly quotes use desktop display glyphs in both orientations', () => {
  for (const orientation of ['horizontal', 'vertical']) {
    assert.equal(displayText('「你好」“新篇”『保留』', orientation), '｢你好｣‶新篇〟『保留』')
  }
})

test('all 32 ASCII punctuation symbols become fullwidth, with letters and horizontal digits unchanged', () => {
  const punctuation = Array.from({ length: 95 }, (_, index) => index + 32)
    .filter(code => code >= 33 && code <= 47 || code >= 58 && code <= 64 || code >= 91 && code <= 96 || code >= 123 && code <= 126)
  assert.equal(punctuation.length, 32)
  assert.equal(displayText(String.fromCharCode(...punctuation), 'horizontal'), String.fromCharCode(...punctuation.map(code => code + 0xFEE0)))
  assert.equal(displayText('ABC xyz 0123456789', 'horizontal'), 'ABC xyz 0123456789')
  assert.equal(displayText('ABC xyz 0123456789', 'vertical'), 'ABC xyz ０１２３４５６７８９')
})

test('spacing, newlines, Unicode, and UTF-16 offsets survive display preparation', () => {
  const text = ' \t「甲😀」\r\n乙\r丙\n丁\\n  …—（全形）｢｣‶〟'
  for (const orientation of ['horizontal', 'vertical']) {
    const displayed = displayText(text, orientation)
    assert.equal(displayed, ' \t｢甲😀｣\r\n乙\r丙\n丁＼n  …—（全形）｢｣‶〟')
    assert.equal(displayed.length, text.length)
    assert.equal(displayed.indexOf('😀'), text.indexOf('😀'))
    assert.equal(displayText(displayed, orientation), displayed)
  }
  assert.equal(displayText('', 'vertical'), '')
})

test('measurement inserts prepared display text without mutating saved items', async () => {
  const created = []
  const document = {
    createElement() {
      const node = { style: {}, children: [], textContent: '', appendChild(child) { this.children.push(child) },
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 10, bottom: 20 }), remove() { this.removed = true } }
      created.push(node)
      return node
    },
    body: { appendChild() {} }, fonts: { ready: Promise.resolve() },
  }
  const item = { _id: 'quote', text: '「第12話!」', orientation: 'vertical', x: .5, y: .5, 'font-size': 24,
    rotation: 0, color: '#000', 'stroke-color': '#fff', 'stroke-weight': 0 }
  const page = { width: 800, height: 1000, items: [item, { ...item, _id: 'horizontal', orientation: 'horizontal' }, { ...item, _id: 'empty', text: '' }] }
  const snapshot = JSON.stringify(page)
  await modules(document)('layout-review').measurePage(page)
  assert.deepEqual(created.slice(1).map(node => node.textContent), ['｢第１２話！｣', '｢第12話！｣', '\u200b'])
  assert.equal(created[0].removed, true)
  assert.equal(JSON.stringify(page), snapshot)
})
