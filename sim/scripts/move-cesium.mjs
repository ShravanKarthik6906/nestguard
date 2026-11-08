// vite-plugin-cesium puts the 3D library in dist/fly/cesium because the page lives at /fly/.
// Caddy serves dist/ at /fly/, so move it to dist/cesium (served as /fly/cesium/...).
import { existsSync, renameSync, rmSync } from 'node:fs'

const from = 'dist/fly/cesium'
const to = 'dist/cesium'
if (existsSync(from)) {
  rmSync(to, { recursive: true, force: true })
  renameSync(from, to)
  rmSync('dist/fly', { recursive: true, force: true })
  console.log('Moved the Cesium files to dist/cesium')
}
