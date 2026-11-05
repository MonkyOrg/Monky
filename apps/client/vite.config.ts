import { defineConfig } from 'vite';
import path from 'path';
import { readFileSync } from 'fs';
import { thirdPartyNotices } from './scripts/thirdPartyNotices.cjs';
import { embeddedReleasesPlugin } from './scripts/embeddedReleases.mjs';
import { MINIAPPS_DEV_URL, WEB_DEV_PORT } from './scripts/buildMiniapps.mjs';
import { MONKY_MINIAPPS_URL, miniappsFrameSource } from '@monky/shared';

// The release writes its version here before building (release.yml).
const packageJson: { version: string } = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'));
const { version } = packageJson;

const notices = thirdPartyNotices();

export default defineConfig(({ mode, command }) => {
  // `--mode web` builds the same renderer as a static site (#858): only the
  // app page, with its own bridge instead of the Electron preload.
  const web = mode === 'web';
  // Bot miniapps open from another site; the dev server pairs with `npm run dev:miniapps`.
  const miniappsUrl = process.env.VITE_MONKY_MINIAPPS_URL || (command === 'serve' ? MINIAPPS_DEV_URL : MONKY_MINIAPPS_URL);
  return {
    root: path.resolve(__dirname, 'src/renderer'),
    base: './',
    plugins: [notices.plugin, embeddedReleasesPlugin({ embed: web }), ...(web ? [{
      name: 'monky-web-miniapps-csp',
      // The page's CSP admits the desktop's miniapp scheme; the site frames the miniapps site instead.
      transformIndexHtml: (html: string) => html.replace('monky-miniapp:', miniappsFrameSource(miniappsUrl)),
    }] : [])],
    define: { __MONKY_VERSION__: JSON.stringify(version), __MONKY_MINIAPPS_URL__: JSON.stringify(miniappsUrl) },
    worker: {
      format: 'es' as const,
      plugins: notices.workerPlugins,
    },
    optimizeDeps: {
      // Prebundle lazy TensorFlow dependencies (including CommonJS kernels)
      // before a call, not when the camera worker first imports them.
      include: ['@tensorflow/tfjs-core', '@tensorflow/tfjs-converter', '@tensorflow/tfjs-backend-webgl', '@tensorflow/tfjs-backend-cpu'],
    },
    build: {
      outDir: path.resolve(__dirname, web ? 'dist-web' : 'dist'),
      emptyOutDir: true,
      target: 'esnext',
      chunkSizeWarningLimit: 1000,
      rollupOptions: {
        // The overlay window has its own page and loads none of the app (R-MEDIA-3).
        input: web
          ? { index: path.resolve(__dirname, 'src/renderer/index.html') }
          : {
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
      port: web ? WEB_DEV_PORT : 5173,
      strictPort: true,
      watch: { ignored: ['**/dist-test/**', '**/.qa/**'] },
    },
    resolve: {
      alias: {
        '@monky/shared': path.resolve(__dirname, '../../packages/shared/src/index.ts'),
        '@monky/dm': path.resolve(__dirname, '../../packages/dm/src/index.ts'),
      },
    },
  };
});