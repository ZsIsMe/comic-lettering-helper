const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { File } = require('node:buffer')
const { webcrypto } = require('node:crypto')
const ts = require('typescript')

function harness() {
  const urls = [], revoked = [], cache = new Map()
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports
    const module = { exports: {} }; cache.set(file, module)
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    new Function('module', 'exports', 'require', 'URL', 'crypto', code)(module, module.exports,
      name => load(path.resolve(path.dirname(file), `${name}.ts`)), {
        createObjectURL: file => { const url = `blob:test-${urls.length}`; urls.push({ file, url }); return url },
        revokeObjectURL: url => revoked.push(url),
      }, webcrypto)
    return module.exports
  }
  return { ...load(path.join(__dirname, '../src/prelayout/offline-data.ts')), urls, revoked }
}
const id = number => `t_${number.toString(16).padStart(32, '0')}`
function file(relative, content) {
  const value = new File([typeof content === 'string' ? content : JSON.stringify(content)], relative.split('/').at(-1))
  Object.defineProperty(value, 'webkitRelativePath', { value: relative })
  return value
}
const manifest = { version: 1, name: '測試', pages: [{ id: 'p1', name: '001.png', width: 800, height: 1200,
  original: 'images/nested/001.png', overlay: 'overlays/001.png', clean: 'clean/001.png', itemIds: [id(1), id(2)] }] }
const original = { version: 2, groupList: [{ name: '對白', font: 'MyFont', unknown: 3 }],
  questionRecords: { version: 7, records: [{ id: 'q1', texts: [{ itemId: id(2) }], unknown: ['snapshot'] }] },
  unknown: { nested: [false, null, 'preserved'] }, transMap: { '001.png': [
    { index: 1, text: '第一框', x: .3, y: .2, 'font-size': 30, upstream: { ocr: '原文' } },
    { index: 2, text: '第二框' },
  ], 'unknown-page.png': [{ untouched: true }] } }
function files(meo = original, project = manifest) {
  return [file('bundle/project.json', project), file('bundle/Meo.json', meo),
    file('bundle/images/nested/001.png', 'original-pixels'), file('bundle/overlays/001.png', 'overlay-pixels'), file('bundle/clean/001.png', 'clean-pixels')]
}

test('folder paths resolve nested images, skip AppleDouble, and release only cached object URLs', async () => {
  const api = harness(), inputs = [...files(), file('bundle/._project.json', 'garbage'), file('bundle/__MACOSX/project.json', 'garbage')]
  const project = await api.loadOfflineProject(inputs)
  assert.equal(project.manifest.name, '測試')
  assert.equal(project.pages[0].items[0]._id, id(1))
  assert.equal(project.pages[0].reviewed_revision, undefined)
  assert.equal(project.pages[0].clean, 'overlays/001.png')
  assert.equal(api.urls.length, 0)
  assert.equal(project.imageUrl('p1'), 'blob:test-0')
  assert.equal(project.imageUrl('p1'), 'blob:test-0')
  assert.equal(project.imageUrl('p1', 'overlay'), 'blob:test-1')
  assert.equal(await api.urls[0].file.text(), 'original-pixels')
  assert.equal(await api.urls[1].file.text(), 'overlay-pixels')
  project.dispose(); project.dispose()
  assert.deepEqual(api.revoked, ['blob:test-0', 'blob:test-1'])
  assert.throws(() => project.imageUrl('p1'), /已關閉/)
})

test('editing, deleting and adding survives JSON download and reopening with the original manifest', async () => {
  const api = harness(), project = await api.loadOfflineProject(files())
  const second = { ...project.pages[0].items[1], text: '改過的第二框' }
  const added = { ...second, _id: id(9), index: 9, text: '新框', custom: 'retained' }
  project.setPageItems('p1', [second, added])
  project.meo.questionRecords.records.push({ id: 'q-new', note: '新問題' })
  const saved = JSON.parse(await project.meoBlob().text())
  assert.equal('_id' in saved.transMap['001.png'][0], false)
  assert.deepEqual(saved._offlinePrelayout.itemIds['001.png'], [id(2), id(9)])
  assert.deepEqual(saved.groupList, original.groupList)
  assert.deepEqual(saved.unknown, original.unknown)
  assert.deepEqual(saved.transMap['unknown-page.png'], original.transMap['unknown-page.png'])
  assert.equal(saved.questionRecords.records[0].texts[0].itemId, id(2))
  const reopened = await api.loadOfflineProject(files(saved))
  assert.deepEqual(reopened.pages[0].items.map(item => item._id), [id(2), id(9)])
  assert.deepEqual(reopened.pages[0].items.map(item => item.text), ['改過的第二框', '新框'])
  assert.equal(reopened.meo.questionRecords.records[1].id, 'q-new')
  assert.equal(reopened.pages[0].items[1].custom, 'retained')
})

test('unknown item metadata is preserved while standard editor defaults are added', async () => {
  const { loadOfflineProject } = harness(), project = await loadOfflineProject(files())
  const saved = project.exportMeo()
  assert.deepEqual(saved.transMap['001.png'][0].upstream, { ocr: '原文' })
  assert.equal(project.pages[0].items[1].orientation, 'vertical')
  assert.equal(project.pages[0].items[1].color, '#000000')
  saved.transMap['001.png'][0].upstream.ocr = 'mutated exported copy'
  assert.equal(project.pages[0].items[0].upstream.ocr, '原文')
})

test('external replacement without ID extension matches stable indices after deletion and does not resurrect absent metadata', async () => {
  const api = harness(), project = await api.loadOfflineProject(files())
  await project.replaceMeo(file('Meo.json', { transMap: { '001.png': [{ index: 2, text: '只留第二框' }, { index: 3, text: '新增' }] } }))
  assert.equal(project.pages[0].items[0]._id, id(2))
  assert.match(project.pages[0].items[1]._id, /^t_[a-f0-9]{32}$/)
  assert.notEqual(project.pages[0].items[1]._id, id(1))
  assert.equal(project.meo.questionRecords, undefined)
  assert.equal(project.meo.groupList, undefined)
})

test('failed replacement or item edit leaves existing edits and metadata intact', async () => {
  const api = harness(), project = await api.loadOfflineProject(files())
  project.setPageItems('p1', [{ ...project.pages[0].items[0], text: '尚未下載的修改' }])
  const before = project.exportMeo()
  await assert.rejects(project.replaceMeo(file('Meo.json', { transMap: { '001.png': [{ text: 'bad', x: 500 }] } })), /超出可用範圍/)
  assert.deepEqual(project.exportMeo(), before)
  assert.throws(() => project.setPageItems('p1', [{ ...project.pages[0].items[0], _id: 'bad' }]), /ID/)
  assert.deepEqual(project.exportMeo(), before)
})

test('optional replacement at open uses baseline indices, and optional image absence is explicit', async () => {
  const api = harness(), minimal = structuredClone(manifest)
  delete minimal.pages[0].overlay; delete minimal.pages[0].clean
  const project = await api.loadOfflineProject(files(original, minimal), file('Meo.json', { transMap: { '001.png': [{ index: 2, text: '重載' }] } }))
  assert.equal(project.pages[0].items[0]._id, id(2))
  assert.equal(project.imageUrl('p1', 'overlay'), undefined)
  assert.equal(project.imageUrl('p1', 'clean'), undefined)
})

test('manifest line-break suggestions retain stable IDs and are available after local edits/reopen', async () => {
  const api = harness(), withSuggestions = structuredClone(manifest)
  const suggestions = { [id(1)]: { original_text: '第一\n框', source_line_count: 2,
    candidates: [{ line_count: 1, text: '第一框' }, { line_count: 2, text: '第一\n框' }] } }
  withSuggestions.pages[0].line_break_suggestions = suggestions
  const project = await api.loadOfflineProject(files(original, withSuggestions))
  assert.deepEqual(project.pages[0].line_break_suggestions, suggestions)
  project.setPageItems('p1', [{ ...project.pages[0].items[0], text: '第一\n框' }])
  const reopened = await api.loadOfflineProject(files(project.exportMeo(), withSuggestions))
  assert.deepEqual(reopened.pages[0].line_break_suggestions, suggestions)
  assert.equal(reopened.pages[0].items[0]._id, id(1))
  for (const invalid of [null, { bad: {} }, { [id(1)]: { ...suggestions[id(1)], candidates: [{ line_count: 2, text: null }] } }]) {
    const badManifest = structuredClone(withSuggestions)
    badManifest.pages[0].line_break_suggestions = invalid
    await assert.rejects(api.loadOfflineProject(files(original, badManifest)), /斷句候選/)
  }
})

test('missing files, ambiguous folders and invalid paths are rejected before images are opened', async () => {
  const api = harness()
  await assert.rejects(api.loadOfflineProject(files().filter(value => !value.webkitRelativePath.includes('/clean/'))), /缺少圖片.*clean\/001.png/)
  await assert.rejects(api.loadOfflineProject(files().filter(value => value.name !== 'Meo.json')), /缺少 Meo.json/)
  await assert.rejects(api.loadOfflineProject([...files(), file('second/project.json', manifest)]), /唯一 project.json/)
  const escaping = structuredClone(manifest); escaping.pages[0].original = '../001.png'
  await assert.rejects(api.loadOfflineProject(files(original, escaping)), /相對路徑無效/)
  await assert.rejects(api.loadOfflineProject([...files(), files()[0]]), /路徑重複/)
  assert.equal(api.urls.length, 0)
})

test('invalid JSON, nonfinite values, item identities and layout are rejected without normalizing away data', async () => {
  const api = harness()
  const invalid = [
    { ...original, transMap: {} },
    { ...original, _offlinePrelayout: { version: 1, itemIds: { '001.png': [id(1)] } } },
    { ...original, _offlinePrelayout: { version: 1, itemIds: { '001.png': [id(1), id(1)] } } },
    { ...original, transMap: { '001.png': [{ text: null }] } },
    { ...original, transMap: { '001.png': [{ orientation: 'diagonal' }] } },
    { ...original, transMap: { '001.png': [{ xyxy_pixel: [20, 0, 1, 1] }] } },
  ]
  for (const value of invalid) await assert.rejects(api.loadOfflineProject(files(value)))
  await assert.rejects(api.loadOfflineProject(files('{"transMap":{},"unknown":1e999}')), /非有限數字/)
  await assert.rejects(api.loadOfflineProject(files('{bad')), /有效的 JSON/)
})
