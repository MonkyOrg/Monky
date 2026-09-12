import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { isBotVersion, isRecord, relativeBotPath } from './config';

function packageJson(root: string): Record<string, unknown> {
  const value: unknown = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!isRecord(value)) throw new Error(`Invalid package metadata at ${root}.`);
  return value;
}

function dependencyMap(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${label} must be a dependency object.`);
  return value;
}

function packageName(name: string): void {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) ||
      name.split('/').some((part) => part === '.' || part === '..')) {
    throw new Error('Invalid dependency package name.');
  }
}

function productionDependencies(pkg: Record<string, unknown>): Map<string, boolean> {
  const dependencies = new Map<string, boolean>();
  const peerMetadata = dependencyMap(pkg.peerDependenciesMeta, 'peerDependenciesMeta');
  for (const name of Object.keys(dependencyMap(pkg.peerDependencies, 'peerDependencies'))) {
    const metadata = peerMetadata[name];
    dependencies.set(name, isRecord(metadata) && metadata.optional === true);
  }
  for (const name of Object.keys(dependencyMap(pkg.dependencies, 'dependencies'))) dependencies.set(name, false);
  for (const name of Object.keys(dependencyMap(pkg.optionalDependencies, 'optionalDependencies'))) dependencies.set(name, true);
  for (const name of dependencies.keys()) packageName(name);
  return dependencies;
}

function lookupPaths(requester: string, name: string): string[] {
  return createRequire(path.join(requester, 'package.json')).resolve.paths(name) ?? [];
}

export function resolvePackage(requester: string, name: string): string | null {
  packageName(name);
  for (const directory of lookupPaths(requester, name)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return fs.realpathSync(candidate);
  }
  return null;
}

export function isPrivateRuntimePath(relative: string): boolean {
  return relative.split(/[\\/]/).some((part) =>
    ['.git', '.hg', '.svn', '.keys', '.pm2', '.ssh', '.aws', '.azure', '.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', 'registrations.json'].includes(part) ||
    (part === '.env' || part.startsWith('.env.')) && !['.env.example', '.env.sample'].includes(part));
}

function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export function copyRuntimePath(sourceRoot: string, relative: string, destinationRoot: string, projectFile = false): void {
  const source = path.join(sourceRoot, relative);
  const destination = path.join(destinationRoot, relative);
  if (!fs.existsSync(source)) throw new Error(`Missing runtime file: ${relative}.`);
  if (!inside(sourceRoot, fs.realpathSync(source))) throw new Error(`Runtime path escapes its package: ${relative}.`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: true,
    filter: (file) => {
      const name = path.relative(sourceRoot, file);
      if (name.split(path.sep).includes('node_modules')) return false;
      if (isPrivateRuntimePath(name)) {
        if (projectFile) throw new Error(`Refusing to package private runtime data: ${name}.`);
        return false;
      }
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (!inside(sourceRoot, target) || fs.statSync(target).isDirectory()) {
          throw new Error(`Unsupported or escaping runtime symlink: ${name}.`);
        }
      }
      return true;
    },
  });
}

function copyPackage(source: string, destination: string, pkg: Record<string, unknown>): void {
  fs.mkdirSync(destination, { recursive: true });
  const knownWorkspace = pkg.name === '@monky/bot-sdk' || pkg.name === '@monky/shared';
  const installed = source.split(path.sep).includes('node_modules');
  if (knownWorkspace) {
    const entry = path.join(source, 'dist', 'index.js');
    if (!fs.existsSync(entry) || !fs.statSync(entry).isFile() || fs.statSync(entry).size === 0) {
      throw new Error(`Missing @monky build output at ${source}.`);
    }
    copyRuntimePath(source, 'dist', destination);
  } else if (!installed) {
    if (!Array.isArray(pkg.files) || !pkg.files.length) {
      throw new Error(`Local dependency ${String(pkg.name)} must declare package.files to avoid bundling its private workspace data.`);
    }
    for (const file of pkg.files) copyRuntimePath(source, relativeBotPath(file, 'dependency files'), destination);
  } else {
    copyRuntimePath(source, '.', destination);
  }
  for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'README.md']) {
    if (fs.existsSync(path.join(source, file))) copyRuntimePath(source, file, destination);
  }
  if (knownWorkspace && !fs.existsSync(path.join(destination, 'LICENSE'))) {
    const repositoryLicense = path.resolve(source, '..', '..', 'LICENSE');
    if (fs.existsSync(repositoryLicense) && fs.statSync(repositoryLicense).isFile()) {
      fs.copyFileSync(repositoryLicense, path.join(destination, 'LICENSE'));
    }
  }
}

function sanitizedPackage(pkg: Record<string, unknown>, dependencies: Record<string, string>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...pkg, dependencies, bundleDependencies: Object.keys(dependencies) };
  for (const field of [
    'bundledDependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta', 'optionalDependencies',
    'scripts', '_from', '_resolved', '_where', '_requested', '_integrity', '_id', '_npmVersion', '_nodeVersion',
  ]) delete result[field];
  return result;
}

/** Preserve the tree each requester resolves, including distinct nested versions and workspace junctions. */
export function bundleDependencies(
  sourceRoot: string, destinationRoot: string, extraRootDependencies: ReadonlyMap<string, string> = new Map()
): { dependencies: Record<string, string>; packageCount: number } {
  const placed = new Map<string, string>();
  let packageCount = 0;

  function copyDependency(
    name: string, requesterSource: string, requesterDestination: string, optional: boolean,
    ancestors: string[], override?: string
  ): string | null {
    packageName(name);
    const source = override ? fs.realpathSync(override) : resolvePackage(requesterSource, name);
    if (!source) {
      if (optional) return null;
      throw new Error(`Missing required dependency "${name}", requested by ${requesterSource}.`);
    }
    const pkg = packageJson(source);
    if (typeof pkg.name !== 'string' || !isBotVersion(pkg.version)) throw new Error(`Invalid dependency metadata at ${source}.`);
    packageName(pkg.name);
    const spec = name === pkg.name ? pkg.version : `npm:${pkg.name}@${pkg.version}`;
    for (const directory of lookupPaths(requesterDestination, name)) {
      const existing = placed.get(path.join(directory, name));
      if (existing !== undefined) {
        if (existing === source) return spec;
        break;
      }
    }
    if (ancestors.includes(source)) throw new Error(`Cannot preserve a shadowed dependency cycle involving "${name}".`);
    const destination = path.join(requesterDestination, 'node_modules', name);
    copyPackage(source, destination, pkg);
    placed.set(destination, source);
    packageCount++;
    const children: Array<[string, string]> = [];
    for (const [child, isOptional] of productionDependencies(pkg)) {
      const childSpec = copyDependency(child, source, destination, isOptional, [...ancestors, source]);
      if (childSpec !== null) children.push([child, childSpec]);
    }
    fs.writeFileSync(path.join(destination, 'package.json'),
      JSON.stringify(sanitizedPackage(pkg, Object.fromEntries(children)), null, 2) + '\n');
    if (!pkg.exports) {
      try { createRequire(path.join(destination, 'package.json')).resolve(destination); } catch {
        throw new Error(`Missing runtime entry for "${name}".`);
      }
    }
    return spec;
  }

  const requested = productionDependencies(packageJson(sourceRoot));
  for (const name of extraRootDependencies.keys()) requested.set(name, false);
  const dependencies: Array<[string, string]> = [];
  for (const [name, optional] of requested) {
    const spec = copyDependency(name, fs.realpathSync(sourceRoot), destinationRoot, optional, [], extraRootDependencies.get(name));
    if (spec !== null) dependencies.push([name, spec]);
  }
  return { dependencies: Object.fromEntries(dependencies), packageCount };
}
