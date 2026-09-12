import test from 'node:test'
import assert from 'node:assert/strict'
import { load } from './compile.mjs'
const { inputFiles } = await load('file-selection')
const file = (name, path = '') => ({ name, webkitRelativePath: path })
test('folder selection is strictly first-level: deal, nested images, and unsupported nested files never enter the collection', () => {
  const top = file('1.png', 'book/1.png')
  const chosen = inputFiles([top, file('2.jpg', 'book/2.jpg'), file('1.png', 'book/deal/1.png'), file('3.png', 'book/chapters/3.png'), file('4.webp', 'book/chapters/more/4.webp'), file('edgewhite_guides.json', 'book/edgewhite_guides.json'), file('._1.png', 'book/._1.png'), file('.DS_Store', 'book/.DS_Store')])
  assert.deepEqual(chosen.map(f => f.name), ['1.png', '2.jpg'])
  assert.equal(chosen[0], top)
})
test('multi-select accepts explicit image files and rejects duplicate stems or unsupported top-level images', () => {
  assert.deepEqual(inputFiles([file('1.png'), file('2.jpg')]).map(f => f.name), ['1.png', '2.jpg'])
  assert.throws(() => inputFiles([file('1.png'), file('1.jpg')]), /重複/)
  assert.throws(() => inputFiles([file('1.webp', 'book/1.webp')]), /不支援/)
  assert.deepEqual(inputFiles(null), [])
})

const { readRootDirectory, readDroppedRoots } = await load('file-selection')
test('native directory picker never iterates a child directory or obtains child file handles', async () => {
  let rootReads = 0, fileReads = 0
  const child = { kind: 'directory', name: 'deal', values() { throw new Error('SUBDIRECTORY MUST NOT BE READ') } }
  const root = { name: 'book', kind: 'directory', async *values() {
    rootReads++; yield { kind: 'file', name: '1.png', async getFile() { fileReads++; return file('1.png') } }
    yield child; yield { ...child, name: 'chapters' }
  } }
  const result = await readRootDirectory(root)
  assert.equal(rootReads, 1); assert.equal(fileReads, 1)
  assert.equal(result.ignoredDirectories, 2)
  assert.deepEqual(result.files.map(f => f.name), ['1.png'])
})
test('folder drop reads every batch of the root but never calls child createReader or file methods', async () => {
  let batches = 0
  const leaf = name => ({ isFile: true, isDirectory: false, name, file(resolve) { resolve(file(name)) } })
  const child = { isDirectory: true, isFile: false, name: 'deal', createReader() { throw new Error('SUBDIRECTORY MUST NOT BE OPENED') }, file() { throw new Error('SUBDIRECTORY MUST NOT BE READ') } }
  const root = {
    isDirectory: true, isFile: false, name: 'book',
    createReader() {
      return {
        readEntries(resolve) {
          resolve([[leaf('1.png'), child], [leaf('2.jpg'), { ...child, name: 'nested' }], []][batches++])
        },
      }
    },
  }
  const result = await readDroppedRoots([root])
  assert.equal(batches, 3); assert.equal(result.ignoredDirectories, 2)
  assert.deepEqual(result.files.map(f => f.name), ['1.png', '2.jpg'])
  await assert.rejects(() => readDroppedRoots([root, root]), /一次請拖入一個/)
  await assert.rejects(() => readDroppedRoots([]), /未提供資料夾結構/)
})
