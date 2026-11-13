const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const ts = require('typescript')
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

function load(file, overrides = {}) {
  const code = ts.transpileModule(readFileSync(path.resolve(__dirname, `../src/prelayout/${file}`), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(name => overrides[name] ?? require(name), module, module.exports)
  return module.exports
}
const api = load('api.ts')
const page = { id: 'p1', name: '1.jpg', sha256: 'source-v1', clean: 'detections/d1/output/inpainted/1.npz', width: 780, height: 1080 }
const planning = load('layered-preview.ts', { './api': api, './preview-cache': {} })

test('layer URLs preserve source/overlay identities and bounded native-space regions', () => {
  assert.equal(api.layerUrl('pid', page, 'original'), '/api/prelayout/projects/pid/pages/p1/layers/original?v=source-v1')
  const url = new URL(api.layerUrl('pid', page, 'overlay', { edge: 768, region: { x: 123, y: 234, width: 345, height: 456 } }), 'http://local')
  assert.equal(url.pathname, '/api/prelayout/projects/pid/pages/p1/layers/overlay')
  assert.equal(url.searchParams.get('v'), page.clean)
  assert.deepEqual(['edge', 'x', 'y', 'w', 'h'].map(k => url.searchParams.get(k)), ['768', '123', '234', '345', '456'])
  assert(!url.pathname.endsWith('/preview'))
})

test('normal pages reuse native layers while huge pages keep bounded base and visible tiles', () => {
  assert.deepEqual(planning.baseLayerOptions(page, 1536), {})
  assert.deepEqual(planning.baseLayerOptions(page, 768, false), { edge: 768 })
  assert.deepEqual(planning.baseLayerOptions({ width: 2000, height: 4000 }, 1536), {})
  assert.deepEqual(planning.baseLayerOptions({ width: 2001, height: 4000 }, 1536), { edge: 1536 })
  assert.deepEqual(planning.layerTiles(page, 4, { x: 0, y: 0, width: 500, height: 700 }, true, 2), [])
  const large = { width: 6000, height: 9000 }
  assert.deepEqual(planning.baseLayerOptions(large, 1536), { edge: 1536 })
  assert.deepEqual(planning.layerTiles(large, .1, { x: 0, y: 0, width: 1000, height: 1000 }, true, 1), [])
  assert.deepEqual(planning.layerTiles(large, 2, null, true, 1), [])
  const visible = { x: 5900, y: 8800, width: 100, height: 200 }
  const tiles = planning.layerTiles(large, 2, visible, true, 1)
  assert(tiles.length > 0 && tiles.length < 10)
  for (const tile of tiles) {
    assert.equal(tile.options.edge, 768)
    assert(tile.x >= 0 && tile.y >= 0)
    assert(tile.x + tile.width <= large.width && tile.y + tile.height <= large.height)
    assert.deepEqual(tile.options.region, { x: tile.x, y: tile.y, width: tile.width, height: tile.height })
  }
})

function hookLayers(clean, response) {
  const calls = []
  const hooks = load('layered-preview.ts', { './api': api, './preview-cache': { usePreview(key) {
    calls.push(key)
    return response(key, calls.length)
  } } })
  return { value: hooks.useLayeredPreview('pid', page, clean, {}), calls }
}
const image = { naturalWidth: 780, naturalHeight: 1080 }
const ready = key => ({ key, image, url: `blob:${key}`, error: '' })

test('a clean scene becomes ready only after both current-generation layers decode', () => {
  assert.equal(hookLayers(true, ready).value.ready, true)
  const old = hookLayers(true, (key, index) => index === 2 ? { ...ready(key), key: 'old-overlay' } : ready(key))
  assert.equal(old.value.ready, false)
  const mismatched = hookLayers(true, (key, index) => index === 2 ? { ...ready(key), image: { naturalWidth: 10, naturalHeight: 10 } } : ready(key))
  assert.equal(mismatched.value.ready, false)
  assert.match(mismatched.value.error, /尺寸/)
  const failed = hookLayers(true, (key, index) => index === 2 ? { url: '', error: 'overlay failed' } : ready(key))
  assert.equal(failed.value.ready, false)
  assert.equal(failed.value.error, 'overlay failed')
  const original = hookLayers(false, ready)
  assert.equal(original.value.ready, true)
  assert.equal(original.value.hasOverlay, false)
  assert.equal(original.calls[0], original.calls[1], 'original-only view shares one cache entry and never requests overlay')
})

function markup(layers) {
  const { LayeredImage } = load('LayeredImage.tsx', { './layered-preview': { useLayeredPreview: () => layers } })
  return renderToStaticMarkup(React.createElement(LayeredImage, { project: 'pid', page, clean: true }))
}
test('layer rendering blocks incomplete scenes, exposes retry failures, and marks both ready images', () => {
  const layers = { ready: true, hasOverlay: true, source: { url: 'blob:source' }, overlay: { url: 'blob:overlay' } }
  const html = markup(layers)
  assert.equal((html.match(/<img /g) || []).length, 2)
  assert.equal((html.match(/data-preview-ready="true"/g) || []).length, 2)
  assert.match(html, /data-layer="original"/)
  assert.match(html, /data-layer="overlay"/)
  assert.match(html, /data-background-kind="clean"/)
  const pending = markup({ ...layers, ready: false })
  assert.match(pending, /data-layer-pending/)
  assert(!pending.includes('<img'), 'no original-only scene can masquerade as a clean view')
  const error = markup({ ...layers, ready: false, error: 'overlay failed' })
  assert.match(error, /overlay failed/)
  assert.match(error, /重試圖片/)
  assert(!error.includes('data-background-kind="clean"'))
})

class Canvas {
  constructor() { this.width = 0; this.height = 0; this.data = new Uint8ClampedArray(); this.context = new Context(this) }
  getContext() { return this.context }
  allocate() { if (this.data.length !== this.width * this.height * 4) this.data = new Uint8ClampedArray(this.width * this.height * 4) }
}
class Context {
  constructor(canvas) { this.canvas = canvas; this.globalCompositeOperation = 'source-over' }
  drawImage(source) {
    this.canvas.allocate()
    const pixels = source.data
    for (let p = 0; p < pixels.length; p += 4) {
      const a = pixels[p + 3] / 255, b = this.canvas.data[p + 3] / 255, out = a + b * (1 - a)
      for (let c = 0; c < 3; c++) this.canvas.data[p + c] = out ? Math.round((pixels[p + c] * a + this.canvas.data[p + c] * b * (1 - a)) / out) : 0
      this.canvas.data[p + 3] = Math.round(out * 255)
    }
  }
  getImageData() { return { data: this.canvas.data.slice() } }
  putImageData(image) { this.canvas.data = image.data.slice() }
  fillRect() {
    const color = this.fillStyle.replace('#', '')
    for (let p = 0; p < this.canvas.data.length; p += 4) for (let c = 0; c < 3; c++) this.canvas.data[p + c] = parseInt(color.slice(c * 2, c * 2 + 2), 16)
  }
}

test('difference highlights actual alpha-composited changes, not overlay coverage', () => {
  const before = { naturalWidth: 4, naturalHeight: 1, data: new Uint8ClampedArray([100,100,100,255, 100,100,100,255, 100,100,100,255, 100,100,100,255]) }
  const patch = { naturalWidth: 4, naturalHeight: 1, data: new Uint8ClampedArray([0,0,0,0, 100,100,100,255, 0,0,0,128, 101,100,100,255]) }
  const effects = [], target = new Canvas(); let refs = 0
  const fakeReact = { ...React, memo: value => value, useRef(value) { return { current: refs++ === 0 ? target : value } }, useState(value) { return [value, () => {}] }, useEffect(effect) { effects.push(effect) } }
  const difference = load('difference-mask.ts')
  const { DifferenceOverlay } = load('DifferenceOverlay.tsx', {
    react: fakeReact,
    './difference-mask': difference,
    './layered-preview': { baseLayerOptions: () => ({}), useLayeredPreview: () => ({ ready: true, key: 'same-generation', source: { image: before }, overlay: { image: patch } }) },
  })
  const previousDocument = global.document, previousImageData = global.ImageData
  global.document = { createElement: () => new Canvas() }
  global.ImageData = class { constructor(w, h) { this.data = new Uint8ClampedArray(w * h * 4) } }
  try {
    DifferenceOverlay({ project: 'pid', page, edge: 768, interacting: false, color: '#12ab34', opacity: .5 })
    for (const effect of effects) effect()
    assert.deepEqual([target.data[3], target.data[7], target.data[15]], [0, 0, 0])
    assert(target.data[11] > 0, 'a half-transparent black repair changes the source and must highlight')
    assert.deepEqual([...target.data.slice(8, 11)], [0x12, 0xab, 0x34])
  } finally { global.document = previousDocument; global.ImageData = previousImageData }
})

test('local review reuses native layers and requests bounded native-coordinate crops for huge pages', () => {
  const cases = []
  const { LayoutReview } = load('LayoutReview.tsx', {
    antd: { Modal: ({ children }) => React.createElement('div', null, children) },
    './LayeredImage': { LayeredImage: props => { cases.push(props); return React.createElement('span') } },
    './layered-preview': planning,
    './layout-review': { textStyle: () => ({}) },
    './layout-review.css': {},
    './DisplayText': { DisplayText: ({ text }) => text },
  })
  for (const dimensions of [{ width: 780, height: 1080 }, { width: 6000, height: 9000 }]) {
    cases.length = 0
    const record = { ...page, ...dimensions, items: [{ _id: 'text', text: 'test', x: .5, y: .5 }] }
    renderToStaticMarkup(React.createElement(LayoutReview, { project: 'pid', before: record, after: record,
      regions: [[100, 200, 400, 500]], view: 'detail', includeOriginal: true, clean: true, onClose() {} }))
    assert.equal(cases.length, 3)
    assert.deepEqual(cases.map(value => value.clean), [false, true, true])
    for (const value of cases) {
      if (dimensions.width === 780) {
        assert.deepEqual(value.options, {})
        assert.equal(value.style.left, -100)
        assert.equal(value.style.top, -200)
        assert.equal(value.style.width, 780)
      } else {
        assert.deepEqual(value.options, { edge: 3072, region: { x: 100, y: 200, width: 300, height: 300 } })
        assert.equal(value.style.left, 0)
        assert.equal(value.style.top, 0)
        assert.equal(value.style.width, 300)
      }
    }
  }
})
