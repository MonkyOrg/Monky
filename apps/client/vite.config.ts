import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Lazy optimization would reload the renderer during a live call.
    exclude: ['@mediapipe/tasks-vision'],
  },
  build: {
    outDir: path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
    target: 'esnext',
    chunkSizeWarningLimit: 1000,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  resolve: {
    alias: {
      '@monky/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
