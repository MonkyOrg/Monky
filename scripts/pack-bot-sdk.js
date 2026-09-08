/**
 * Builds a self-contained tarball of @monky/bot-sdk so it can be installed
 * straight from a GitHub release, without cloning the monorepo.
 *
 * Like the CLI pack script, this bundles @monky/shared inside
 * node_modules/ so npm uses the bundled copy instead of looking for it in
 * the registry.
 *
 * Usage: node scripts/pack-bot-sdk.js [version] [--out <dir>]
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SDK_DIR = path.join(ROOT, 'packages', 'bot-sdk');
const SHARED_DIR = path.join(ROOT, 'packages', 'shared');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function parseArgs(argv) {
  const args = { version: null, out: path.join(ROOT, 'release') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') {
      args.out = path.resolve(argv[++i]);
    } else if (!args.version) {
      args.version = argv[i].replace(/^v/, '');
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sdkPkg = readJson(path.join(SDK_DIR, 'package.json'));
  const sharedPkg = readJson(path.join(SHARED_DIR, 'package.json'));
  const version = args.version || process.env.MONKY_VERSION || sdkPkg.version;

  const sdkDist = path.join(SDK_DIR, 'dist');
  const sharedDist = path.join(SHARED_DIR, 'dist');
  for (const dir of [sdkDist, sharedDist]) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Missing build output: ${dir}. Run "npm run build" first.`);
    }
  }

  const staging = path.join(ROOT, 'release', 'bot-sdk-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  // Copy bot-sdk dist.
  fs.cpSync(sdkDist, path.join(staging, 'dist'), { recursive: true });

  // Bundle @monky/shared.
  const bundledShared = path.join(staging, 'node_modules', '@monky', 'shared');
  fs.mkdirSync(bundledShared, { recursive: true });
  fs.cpSync(sharedDist, path.join(bundledShared, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(bundledShared, 'package.json'),
    JSON.stringify({
      name: sharedPkg.name,
      version: sharedPkg.version,
      main: sharedPkg.main,
      types: sharedPkg.types,
      dependencies: sharedPkg.dependencies,
    }, null, 2) + '\n'
  );

  // Build the publishable package.json.
  const publishPkg = {
    name: sdkPkg.name,
    version,
    description: sdkPkg.description,
    license: 'MIT',
    repository: { type: 'git', url: 'https://github.com/MonkyOrg/Monky.git' },
    homepage: 'https://github.com/MonkyOrg/Monky/tree/main/packages/bot-sdk',
    main: sdkPkg.main,
    types: sdkPkg.types,
    engines: { node: '>=18' },
    dependencies: {
      ...sharedPkg.dependencies,
      ...sdkPkg.dependencies,
      '@monky/shared': sharedPkg.version,
    },
    bundleDependencies: ['@monky/shared'],
  };

  fs.writeFileSync(
    path.join(staging, 'package.json'),
    JSON.stringify(publishPkg, null, 2) + '\n'
  );

  // README from the bots docs page.
  const readme = path.join(ROOT, 'docs-site', 'bots.md');
  if (fs.existsSync(readme)) {
    fs.copyFileSync(readme, path.join(staging, 'README.md'));
  }

  fs.mkdirSync(args.out, { recursive: true });
  const packed = execSync('npm pack', { cwd: staging, encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop()
    .trim();

  const finalName = `monky-bot-sdk-${version}.tgz`;
  const finalPath = path.join(args.out, finalName);
  fs.rmSync(finalPath, { force: true });
  fs.copyFileSync(path.join(staging, packed), finalPath);
  fs.rmSync(path.join(staging, packed), { force: true });

  console.log(`[pack-bot-sdk] ${finalPath}`);
  return finalPath;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('pack-bot-sdk.js');
if (isDirectRun) {
  main();
}
