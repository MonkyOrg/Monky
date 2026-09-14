/**
 * Builds a self-contained tarball of the Monky CLI so it can be installed
 * straight from a GitHub release, without cloning and building the repo (#285).
 *
 * Two things make the workspace package non-installable as-is:
 *
 * 1. `@monky/server` depends on `@monky/shared`, a workspace package that is
 *    never published. The staged package ships a real copy of it inside
 *    `node_modules/` and marks it as a bundled dependency, so npm uses the
 *    bundled copy instead of looking for it in the registry.
 * 2. `tsc` does not emit the `.sql` migration files, and DatabaseConnection
 *    resolves them relative to the compiled output, so they are copied next to
 *    the compiled code.
 *
 * Usage: node scripts/pack-cli.js [version] [--out <dir>]
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_DIR = path.join(ROOT, 'apps', 'server');
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

export function buildSharedPackageJson(sharedPkg) {
  // Declaring dependencies here makes npm treat them as part of the bundled
  // tree and create empty placeholder folders instead of installing them.
  // They are hoisted to the CLI package instead (see buildCliPackageJson).
  return {
    name: sharedPkg.name,
    version: sharedPkg.version,
    main: sharedPkg.main,
    types: sharedPkg.types,
  };
}

export function buildCliPackageJson(serverPkg, sharedPkg, version) {
  const dependencies = {
    // npm installs a bundled package as-is but does NOT resolve its own
    // dependencies, so @monky/shared's deps are hoisted here. Node then finds
    // them by walking up from the bundled copy to the install root.
    ...sharedPkg.dependencies,
    ...serverPkg.dependencies,
    '@monky/shared': sharedPkg.version,
  };
  return {
    name: serverPkg.name,
    version,
    description: 'Monky CLI — self-hosted voice, video and chat server',
    license: 'MIT',
    repository: { type: 'git', url: 'https://github.com/MonkyOrg/Monky.git' },
    homepage: 'https://github.com/MonkyOrg/Monky#readme',
    main: serverPkg.main,
    types: serverPkg.types,
    bin: serverPkg.bin,
    // mediasoup and two of its transitive dependencies (h264-profile-level-id,
    // supports-color) declare `>=22`, so the CLI cannot honestly claim Node 20.
    engines: { node: '>=22' },
    dependencies,
    bundleDependencies: ['@monky/shared'],
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const serverPkg = readJson(path.join(SERVER_DIR, 'package.json'));
  const sharedPkg = readJson(path.join(SHARED_DIR, 'package.json'));
  const version = args.version || process.env.MONKY_VERSION || serverPkg.version;

  const serverDist = path.join(SERVER_DIR, 'dist');
  const sharedDist = path.join(SHARED_DIR, 'dist');
  for (const dir of [serverDist, sharedDist]) {
    if (!fs.existsSync(dir)) {
      throw new Error(`Missing build output: ${dir}. Run "npm run build" first.`);
    }
  }
  const require = createRequire(import.meta.url);
  const { PROTOCOL_VERSION } = require(path.join(sharedDist, 'constants.js'));

  const staging = path.join(ROOT, 'release', 'cli-pack');
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  fs.cpSync(serverDist, path.join(staging, 'dist'), { recursive: true });

  // tsc leaves the .sql files behind, and DatabaseConnection looks for them
  // next to the compiled output first.
  const migrationsSrc = path.join(SERVER_DIR, 'src', 'infrastructure', 'database', 'migrations');
  const migrationsDest = path.join(staging, 'dist', 'infrastructure', 'database', 'migrations');
  fs.mkdirSync(migrationsDest, { recursive: true });
  const migrations = fs.readdirSync(migrationsSrc).filter((f) => f.endsWith('.sql'));
  for (const file of migrations) {
    fs.copyFileSync(path.join(migrationsSrc, file), path.join(migrationsDest, file));
  }

  const bundledShared = path.join(staging, 'node_modules', '@monky', 'shared');
  fs.mkdirSync(bundledShared, { recursive: true });
  fs.cpSync(sharedDist, path.join(bundledShared, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(bundledShared, 'package.json'),
    JSON.stringify(buildSharedPackageJson(sharedPkg), null, 2) + '\n'
  );

  fs.writeFileSync(
    path.join(staging, 'package.json'),
    JSON.stringify(buildCliPackageJson(serverPkg, sharedPkg, version), null, 2) + '\n'
  );

  // The CLI reference lives in the documentation site, which is also what the
  // published package shows on npm.
  const readme = path.join(ROOT, 'docs-site', 'cli.md');
  if (fs.existsSync(readme)) {
    fs.copyFileSync(readme, path.join(staging, 'README.md'));
  } else {
    console.warn(`[pack-cli] README not found at ${readme}`);
  }

  fs.mkdirSync(args.out, { recursive: true });
  // npm pack writes into the cwd. --pack-destination is avoided on purpose:
  // resolving npm.cmd on Windows requires shell mode, which splits arguments
  // on spaces and would corrupt any path containing one. A fixed command with
  // no interpolated arguments sidesteps that entirely — and, having no args
  // array, it does not trip Node's DEP0190 either.
  const packed = execSync('npm pack', { cwd: staging, encoding: 'utf8' })
    .trim()
    .split('\n')
    .pop()
    .trim();

  const finalName = `monky-cli-${version}.tgz`;
  const finalPath = path.join(args.out, finalName);
  fs.rmSync(finalPath, { force: true });
  fs.copyFileSync(path.join(staging, packed), finalPath);
  fs.rmSync(path.join(staging, packed), { force: true });
  const compatibilityPath = path.join(args.out, `monky-compatibility-${version}.json`);
  fs.writeFileSync(compatibilityPath, JSON.stringify({
    schemaVersion: 1,
    version,
    protocolVersion: PROTOCOL_VERSION,
    botSdkVersion: version,
  }, null, 2) + '\n');

  console.log(`[pack-cli] ${migrations.length} migration(s) bundled`);
  console.log(`[pack-cli] ${finalPath}`);
  console.log(`[pack-cli] ${compatibilityPath}`);
  return finalPath;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('pack-cli.js');
if (isDirectRun) {
  main();
}
