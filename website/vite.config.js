import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/comic-lettering-helper/',
  plugins: [react(), tailwindcss()],
})
