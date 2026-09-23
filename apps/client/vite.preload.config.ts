import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  publicDir: false,
  resolve: {
    alias: { '@monky/shared/dist/ipc': path.resolve(__dirname, '../../packages/shared/src/ipc.ts') },
  },
  build: {
    outDir: 'dist-electron/preload',
    emptyOutDir: false,
    minify: false,
    lib: {
      entry: path.resolve(__dirname, 'src/preload/localPreparationDialog.ts'),
      formats: ['cjs'],
      fileName: () => 'localPreparationDialog.cjs',
    },
    rollupOptions: { external: ['electron'] },
  },
});
