import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';

const client = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shared = path.resolve(client, '..', '..', 'packages', 'shared', 'src');

export const PRELOADS = ['preload', 'overlayPreload', 'crashRecoveryPreload', 'localPreparationDialog'];

/**
 * Every window runs sandboxed, and a sandboxed preload can only require
 * `electron` (#826). Each preload is bundled alone into one CommonJS file with
 * its packages, shared contracts and the native audio worklet source, so no
 * chunk is shared between preloads.
 */
export async function buildPreloads({ outDir = path.join(client, 'dist-electron', 'preload'), names = PRELOADS } = {}) {
  for (const name of names) {
    await build({
      configFile: false,
      publicDir: false,
      logLevel: 'warn',
      resolve: {
        alias: [
          { find: /^@monky\/shared$/, replacement: path.join(shared, 'index.ts') },
          { find: /^@monky\/shared\/dist\/ipc$/, replacement: path.join(shared, 'ipc.ts') },
        ],
      },
      build: {
        outDir,
        emptyOutDir: false,
        minify: false,
        target: 'esnext',
        // The renderer half of the native runtime is CommonJS, required lazily by the preload.
        commonjsOptions: {
          include: [/node_modules/, /native[\\/]screen-share[\\/]/, /src[\\/]preload[\\/]/],
          extensions: ['.js', '.cjs', '.ts'],
          transformMixedEsModules: true,
        },
        lib: {
          entry: path.join(client, 'src', 'preload', `${name}.ts`),
          formats: ['cjs'],
          fileName: () => `${name}.cjs`,
        },
        rollupOptions: { external: ['electron'] },
      },
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await buildPreloads();
