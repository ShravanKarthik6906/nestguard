import { defineConfig } from 'vite'

// In dev, the browser calls relative paths (/zones, /check, ...) and Vite forwards
// them to Udaya's API. In production Caddy does the same job, so the code never changes.
// Override the target with:  API_TARGET=http://localhost:8000 npm run dev
const target = process.env.API_TARGET || 'http://129.161.92.50:8000'
const paths = ['/zones', '/check', '/device', '/speak', '/docs', '/openapi.json']

export default defineConfig({
  server: {
    proxy: Object.fromEntries(paths.map((p) => [p, { target, changeOrigin: true }])),
  },
})
