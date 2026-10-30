import { defineConfig } from 'vite';
import path from 'path';
import { thirdPartyNotices } from './scripts/thirdPartyNotices.cjs';

const notices = thirdPartyNotices();

export default defineConfig({
  root: path.resolve(__dirname, 'src/renderer'),
  base: './',
  plugins: [notices.plugin],
  worker: {
    format: 'es',
    plugins: notices.workerPlugins,
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
    rollupOptions: {
      // The overlay window has its own page and loads none of the app (R-MEDIA-3).
      input: {
        index: path.resolve(__dirname, 'src/renderer/index.html'),
        overlay: path.resolve(__dirname, 'src/renderer/overlay.html'),
      },
      output: {
        // Extensionless licenses must not acquire a trailing dot on Windows.
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
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
