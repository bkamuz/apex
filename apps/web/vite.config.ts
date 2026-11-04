import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [react()],
  // Prevent Vite from clearing the terminal so `tauri dev` Rust errors stay visible.
  clearScreen: false,
  server: {
    port: 5173,
    // Tauri expects a fixed port; fail rather than silently switching.
    strictPort: true,
    host: host || undefined,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
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
