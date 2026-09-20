import { build } from 'esbuild'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

const out = new URL('../../var-test/frame-clipboard-probe/', import.meta.url)
await mkdir(out, { recursive: true })
await build({ entryPoints: [new URL('./prelayout-frame-clipboard-browser.tsx', import.meta.url).pathname], outfile: new URL('regression.js', out).pathname, bundle: true, format: 'esm', jsx: 'automatic' })
await writeFile(new URL('regression.html', out), await readFile(new URL('./prelayout-frame-clipboard-browser.html', import.meta.url)))
console.log(`Browser fixture: ${new URL('regression.html', out).pathname}`)
