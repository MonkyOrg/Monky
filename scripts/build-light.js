import { existsSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = 'Usage: npm run build:light -- [--arch x64|arm64] [--target <cmake-target>]';

function parseArguments(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!['--arch', '--target'].includes(flag) || !value || value.startsWith('--') || options.has(flag)) {
      throw new Error(USAGE);
    }
    options.set(flag, value);
  }
  return options;
}

export function nativeBuildPlan({
  root = ROOT,
  platform = process.platform,
  architecture = process.arch,
  nodeExecutable = process.execPath,
  jobs = Math.min(4, availableParallelism()),
  args = [],
} = {}) {
  if (!['win32', 'darwin'].includes(platform)) {
    throw new Error('The initial Monky Light targets are Windows x64 and macOS x64/arm64.');
  }
  const options = parseArguments(args);
  const arch = options.get('--arch') ?? architecture;
  if (!['x64', 'arm64'].includes(arch) || (platform === 'win32' && arch !== 'x64')) {
    throw new Error(`Unsupported Monky Light target: ${platform}/${arch}`);
  }
  const target = options.get('--target');
  if (target && !/^[A-Za-z0-9_-]+$/.test(target)) throw new Error('Invalid CMake target name.');
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error('Build parallelism must be a positive integer.');

  const sourceDirectory = path.join(root, 'apps', 'light');
  const buildDirectory = path.join(sourceDirectory, 'build', `${platform === 'win32' ? 'windows' : 'macos'}-${arch}`);
  const configure = [
    '-S', sourceDirectory, '-B', buildDirectory,
    `-DMONKY_LIGHT_TARGET_ARCH:STRING=${arch}`,
    `-DMONKY_NODE_EXECUTABLE:FILEPATH=${nodeExecutable}`,
  ];
  if (platform === 'win32') {
    configure.push('-G', 'Visual Studio 17 2022', '-A', 'x64');
  } else {
    configure.push('-DCMAKE_BUILD_TYPE=Release');
    configure.push(`-DCMAKE_OSX_ARCHITECTURES=${arch === 'x64' ? 'x86_64' : 'arm64'}`);
  }
  const build = ['--build', buildDirectory, '--config', 'Release', '--parallel', String(jobs)];
  if (target) build.push('--target', target);
  return { sourceDirectory, buildDirectory, configure, build };
}

function isFile(candidate) {
  return existsSync(candidate) && statSync(candidate).isFile();
}

export function findCmake() {
  if (process.env.MONKY_LIGHT_CMAKE) {
    const explicit = path.resolve(process.env.MONKY_LIGHT_CMAKE);
    if (!isFile(explicit)) throw new Error(`MONKY_LIGHT_CMAKE is not a file: ${explicit}`);
    return explicit;
  }
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'cmake.exe' : 'cmake');
    if (isFile(candidate)) return candidate;
  }
  if (process.platform === 'win32') {
    const installer = path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer');
    const vswhere = path.join(installer, 'vswhere.exe');
    if (isFile(vswhere)) {
      const found = spawnSync(vswhere, [
        '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath',
      ], { encoding: 'utf8' });
      if (found.error) throw found.error;
      if (found.status !== 0) throw new Error(`vswhere failed: ${found.stderr.trim()}`);
      const installation = found.stdout.trim();
      if (installation) {
        const bundled = path.join(installation, 'Common7', 'IDE', 'CommonExtensions', 'Microsoft', 'CMake', 'CMake', 'bin', 'cmake.exe');
        if (isFile(bundled)) return bundled;
      }
    }
  }
  throw new Error('CMake was not found. Install CMake or set MONKY_LIGHT_CMAKE to its executable.');
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`CMake failed (${result.signal ?? result.status}).`);
}

function main(args) {
  if (args.length === 1 && args[0] === '--help') {
    console.log(USAGE);
    return;
  }
  const plan = nativeBuildPlan({ args });
  const cmake = findCmake();
  console.log(`Monky Light build: ${plan.buildDirectory}`);
  run(cmake, plan.configure);
  run(cmake, plan.build);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2));
}
