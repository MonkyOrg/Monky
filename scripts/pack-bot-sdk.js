/**
 * Builds a self-contained tarball of @monky/bot-sdk so it can be installed
 * straight from a GitHub release, without cloning the monorepo.
 *
 * Includes the installed production dependency tree, including @monky/shared.
 * Bundling shared alone makes npm assume its missing dependencies are bundled.
 *
 * Usage: node scripts/pack-bot-sdk.js [version] [--out <dir>]
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';

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
  const version = args.version || process.env.MONKY_VERSION || sdkPkg.version;

  const sdkDist = path.join(SDK_DIR, 'dist');
  const sharedDist = path.join(SHARED_DIR, 'dist');
  for (const dir of [sdkDist, sharedDist]) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Missing build output: ${dir}. Run "npm run build" first.`);
    }
  }
  const require = createRequire(import.meta.url);
  const { bundleDependencies } = require(path.join(sdkDist, 'tooling', 'bundle.js'));
  const { runNpm } = require(path.join(sdkDist, 'tooling', 'process.js'));
  const { isBotVersion } = require(path.join(sdkDist, 'tooling', 'config.js'));
  if (!isBotVersion(version)) throw new Error('The SDK version must be valid SemVer.');

  const staging = path.join(ROOT, 'release', 'bot-sdk-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  // Copy bot-sdk dist.
  fs.cpSync(sdkDist, path.join(staging, 'dist'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(staging, 'LICENSE'));

  const { dependencies, packageCount } = bundleDependencies(SDK_DIR, staging,
    new Map([['@monky/shared', SHARED_DIR]]));

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
    bin: sdkPkg.bin,
    engines: { node: '>=18' },
    dependencies,
    bundleDependencies: Object.keys(dependencies),
  };

  fs.writeFileSync(
    path.join(staging, 'package.json'),
    JSON.stringify(publishPkg, null, 2) + '\n'
  );

  for (const [source, destination] of [
    ['bots-desenvolvimento.md', 'README.md'],
    [path.join('en', 'bots-desenvolvimento.md'), 'README.en.md'],
  ]) {
    const contents = fs.readFileSync(path.join(ROOT, 'docs-site', source), 'utf8')
      .replace(/\]\(\/(?!\/)/g, '](https://monkyorg.github.io/Monky/');
    fs.writeFileSync(path.join(staging, destination), contents);
  }

  fs.mkdirSync(args.out, { recursive: true });
  const packed = runNpm(['pack', '--ignore-scripts', '--silent'], { cwd: staging })
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
  console.log(`[pack-bot-sdk] ${packageCount} bundled production packages`);
  return finalPath;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('pack-bot-sdk.js');
if (isDirectRun) {
  main();
}
