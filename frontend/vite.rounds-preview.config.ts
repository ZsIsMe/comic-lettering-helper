import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontend = path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  root: frontend,
  plugins: [react()],
  publicDir: false,
  define: { __ROUNDS_ASSET_ROOT__: JSON.stringify('/@fs/' + path.resolve(frontend, '../var/rounds-preview/assets')) },
  server: {
    host: '127.0.0.1', port: 5175, strictPort: true,
    fs: { allow: [frontend, path.resolve(frontend, '../var/rounds-preview/assets')] },
    // No API proxy: the preview cannot submit jobs to the local/remote backend.
  },
})
