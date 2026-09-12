import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/directory-files.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText
const { readDirectoryFiles, readDroppedDirectory } = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`)

test('reads direct images without opening child directories or excluded files', async () => {
  const reads = []
  const file = name => ({ kind: 'file', name, async getFile() { reads.push(name); return { name } } })
  const directory = { name: 'chapter', async *values() {
    yield file('10.JPG')
    yield { kind: 'directory', name: 'results.png', values() { assert.fail('Child directory enumerated') }, getFile() { assert.fail('Child directory opened') } }
    yield file('._2.png')
    yield file('notes.txt')
    yield file('2.png')
  } }
  assert.deepEqual((await readDirectoryFiles(directory)).map(f => f.name), ['2.png', '10.JPG'])
  assert.deepEqual(reads, ['10.JPG', '2.png'])
  reads.length = 0
  assert.deepEqual((await readDirectoryFiles(directory, true)).map(f => f.name), ['2.png'])
  assert.deepEqual(reads, ['2.png'])
})

test('a directory containing only child directories returns no images', async () => {
  const directory = { name: 'parent', async *values() {
    yield { kind: 'directory', name: 'nested', values() { assert.fail('Nested directory enumerated') } }
  } }
  assert.deepEqual(await readDirectoryFiles(directory), [])
})

test('dropped directory reads all root batches and never opens subdirectories', async () => {
  const reads = []
  const file = name => ({ isFile: true, name, file(resolve) { reads.push(name); resolve({name}) } })
  const batches = [
    [file('2.JPG'), { isFile: false, name: 'nested', createReader() { assert.fail('Nested reader opened') } }, file('._3.png')],
    [file('1.png'), file('notes.txt')],
    [],
  ]
  const directory = { createReader() { let index = 0; return { readEntries(resolve) { resolve(batches[index++]) } } } }
  assert.deepEqual((await readDroppedDirectory(directory)).map(f => f.name), ['1.png','2.JPG'])
  assert.deepEqual(reads, ['2.JPG','1.png'])
  reads.length = 0
  assert.deepEqual((await readDroppedDirectory(directory, true)).map(f => f.name), ['1.png'])
  assert.deepEqual(reads, ['1.png'])
})

test('dropped directory reports read failure instead of returning a partial selection', async () => {
  const directory = { createReader() { return { readEntries(_resolve, reject) { reject(new Error('Read denied')) } } } }
  await assert.rejects(readDroppedDirectory(directory), /Read denied/)
})
