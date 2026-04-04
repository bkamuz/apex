import type { RollupLog } from 'rollup'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

function isManifoldNodeModuleWarning(warning: RollupLog): boolean {
  const msg = String(warning.message ?? '')
  return (
    msg.includes('manifold-3d') &&
    msg.includes('"module"') &&
    msg.includes('externalized for browser compatibility')
  )
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Основной бандл (ThatOpen / viewer) заведомо > 500 kB — порог только для отчёта Rollup
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      onwarn(warning, defaultHandler) {
        if (isManifoldNodeModuleWarning(warning)) return
        defaultHandler(warning)
      },
    },
  },
})
