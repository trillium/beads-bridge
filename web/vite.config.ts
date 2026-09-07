import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import { defineConfig } from 'vite'

// Dev: the Express API runs on :3737; the SPA proxies API paths to it.
// API literals are frozen (agents fetch them verbatim) — never prefix them.
const API = ['/paste', '/fetch', '/resume', '/guide', '/help', '/next', '/print', '/beads', '/openapi.json']

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    proxy: Object.fromEntries(API.map((p) => [p, 'http://localhost:3737'])),
  },
})
