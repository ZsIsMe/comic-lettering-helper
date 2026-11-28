import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// A classic script can load from a sibling file when index.html opens via file://.
export default defineConfig({
  plugins: [react()],
  publicDir: false,
  base: './',
  build: {
    outDir: 'dist/offline',
    lib: {
      entry: 'src/offline.tsx',
      name: 'PrelayoutOffline',
      formats: ['iife'],
      fileName: () => 'editor.js',
      cssFileName: 'editor',
    },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
})
