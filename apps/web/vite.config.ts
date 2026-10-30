import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  server: {
    port: 5173,
    fs: {
      allow: ['../..'],
    },
  },
  build: {
    target: 'esnext',
  },
  // IFC-Lite (and transitive pointcloud streaming) spawn workers; es avoids
  // Rollup's "iife invalid for code-splitting builds" error on worker bundles.
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['./src/wasm/pkg/apex_wasm.js'],
    // jsZip is CJS; IFC-Lite parser imports default — prebundle so Vite interops.
    include: ['jszip', '@ifc-lite/parser', '@ifc-lite/geometry'],
  },
  assetsInclude: ['**/*.wasm'],
});
