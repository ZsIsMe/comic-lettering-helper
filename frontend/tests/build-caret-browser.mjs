// npm's existing esbuild dependency builds an isolated fixture with the actual
// InlineTextEditor. Serve the output over localhost and click Run in a browser.
import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
const out = new URL('../../var-test/caret-probe/', import.meta.url)
await mkdir(out, { recursive: true })
await build({ entryPoints: [new URL('./prelayout-caret-browser.tsx', import.meta.url).pathname], outfile: new URL('regression.js', out).pathname, bundle: true, format: 'esm', jsx: 'automatic' })
await writeFile(new URL('regression.html', out), await readFile(new URL('./prelayout-caret-browser.html', import.meta.url)))
console.log(`Browser fixture: ${new URL('regression.html', out).pathname}`)
