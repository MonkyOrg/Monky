import { defineConfig } from 'vite';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    // Prebundle lazy TensorFlow dependencies (including CommonJS kernels)
    // before a call, not when the camera worker first imports them.
    include: ['@tensorflow/tfjs-core', '@tensorflow/tfjs-converter', '@tensorflow/tfjs-backend-webgl', '@tensorflow/tfjs-backend-cpu'],
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
    watch: { ignored: ['**/dist-test/**', '**/.qa/**'] },
  },
  resolve: {
    alias: {
      '@monky/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
    },
  },
});
