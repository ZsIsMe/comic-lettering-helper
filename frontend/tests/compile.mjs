import { readFile } from 'node:fs/promises'
import ts from 'typescript'
export async function load(name) {
  const code = await readFile(new URL(`../src/edgewhite/${name}.ts`, import.meta.url), 'utf8')
  const output = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  return import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`)
}
