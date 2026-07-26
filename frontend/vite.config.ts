import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: Number(process.env.PORT) || 3000,
    proxy: {
      // FastAPI backend (routing + geocoding). No rewrite — the backend
      // mounts its routers under /api/v1 already. ws:true forwards the
      // WebSocket upgrade for the in-drive voice loop
      // (/api/v1/trips/:id/voice).
      '/api/v1': {
        target: 'http://localhost:8000',
        changeOrigin: true,
        ws: true
      },
      // Martin tile server (self-hosted basemap vector tiles).
      '/api/tiles': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/tiles/, '')
      }
    }
  }
})
