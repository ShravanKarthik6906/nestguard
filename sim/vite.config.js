import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import cesium from 'vite-plugin-cesium'

// The flight simulator is its own page, served at knowflyzone.vip/fly/.
// In production Caddy sends /api/* to the simulator's Node backend and /check to the main FastAPI.
// In dev, /check goes to the live site (override with API_TARGET=http://localhost:8000).
const api = process.env.API_TARGET || 'https://knowflyzone.vip'

export default defineConfig({
  base: '/fly/',
  plugins: [
    react(),
    cesium()
  ],

  server: {
    port: 5173,
    strictPort: false,

    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true
      },
      '/check': {
        target: api,
        changeOrigin: true
      }
    }
  },

  optimizeDeps: {
    include: [
      'cesium',
      'maplibre-gl',
      'three'
    ]
  }
})
