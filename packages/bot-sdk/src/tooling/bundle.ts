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
  // A declared npm polyfill such as "buffer" must not resolve as a Node builtin.
  return createRequire(path.join(requester, 'package.json')).resolve.paths(`${name}/package.json`) ?? [];
}

function packageLocation(requester: string, name: string): { source: string; modules: string } | null {
  packageName(name);
  for (const directory of lookupPaths(requester, name)) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return { source: fs.realpathSync(candidate), modules: fs.realpathSync(directory) };
    }
  }
  return null;
}

export function resolvePackage(requester: string, name: string): string | null {
  return packageLocation(requester, name)?.source ?? null;
}

export function isPrivateRuntimePath(relative: string): boolean {
  return relative.split(/[\\/]/).some((part) =>
    ['.git', '.hg', '.svn', '.keys', '.pm2', '.ssh', '.aws', '.azure', '.npmrc', '.yarnrc', '.yarnrc.yml', '.netrc', 'registrations.json', 'update-credentials.json'].includes(part) ||
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
      // Rebuild root dependencies, but preserve packaged source-local module aliases.
      if (name.split(path.sep)[0] === 'node_modules') return false;
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
  for (const file of ['LICENSE', 'LICENSE-MIT', 'LICENSE.md', 'LICENSE.txt', 'README.md']) {
    if (fs.existsSync(path.join(source, file))) copyRuntimePath(source, file, destination);
  }
  if (knownWorkspace) {
    for (const name of ['LICENSE', 'LICENSE-MIT']) {
      if (fs.existsSync(path.join(destination, name))) continue;
      const repositoryLicense = path.resolve(source, '..', '..', name);
      if (fs.existsSync(repositoryLicense) && fs.statSync(repositoryLicense).isFile()) {
        fs.copyFileSync(repositoryLicense, path.join(destination, name));
      }
      if (pkg.license === 'GPL-3.0-or-later' && !fs.existsSync(path.join(destination, name))) {
        throw new Error(`Missing Monky ${name} notice at ${source}.`);
      }
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
  const copied = new Set<string>();
  const locations = new Map<string, string>([[fs.realpathSync(sourceRoot), path.resolve(destinationRoot)]]);
  const rootModules = path.join(path.resolve(destinationRoot), 'node_modules');
  const moduleDirectories = new Map<string, string>();
  const edges: Array<{ name: string; requester: string; destination: string }> = [];
  let packageCount = 0;

  function copyDependency(
    name: string, requesterSource: string, requesterDestination: string, optional: boolean,
    override?: string
  ): string | null {
    packageName(name);
    const resolved = packageLocation(requesterSource, name);
    const source = override ? fs.realpathSync(override) : resolved?.source;
    if (!source) {
      if (optional) return null;
      throw new Error(`Missing required dependency "${name}", requested by ${requesterSource}.`);
    }
    const pkg = packageJson(source);
    if (typeof pkg.name !== 'string' || !isBotVersion(pkg.version)) throw new Error(`Invalid dependency metadata at ${source}.`);
    packageName(pkg.name);
    const spec = name === pkg.name ? pkg.version : `npm:${pkg.name}@${pkg.version}`;
    const modules = resolved?.source === source ? resolved.modules : path.join(requesterSource, 'node_modules');
    let destinationModules = moduleDirectories.get(modules);
    if (!destinationModules) {
      const owner = locations.get(path.dirname(modules));
      destinationModules = owner ? path.join(owner, 'node_modules') : rootModules;
      moduleDirectories.set(modules, destinationModules);
    }
    // Cloning a shared module per consumer splits class identities and registries (e.g. ASN.1).
    let destination = locations.get(source) ?? path.join(destinationModules, name);
    if (!locations.has(source) && placed.has(destination) && placed.get(destination) !== source) {
      destination = path.join(requesterDestination, 'node_modules', name);
    }
    const existing = placed.get(destination);
    if (existing !== undefined && existing !== source) {
      throw new Error(`Conflicting dependency locations for "${name}" at ${destination}.`);
    }
    edges.push({ name, requester: requesterDestination, destination });
    if (copied.has(destination)) return spec;
    locations.set(source, destination);
    placed.set(destination, source);
    copied.add(destination);
    copyPackage(source, destination, pkg);
    packageCount++;
    const children: Array<[string, string]> = [];
    for (const [child, isOptional] of productionDependencies(pkg)) {
      const childSpec = copyDependency(child, source, destination, isOptional);
      if (childSpec !== null) children.push([child, childSpec]);
    }
    fs.writeFileSync(path.join(destination, 'package.json'),
      JSON.stringify(sanitizedPackage(pkg, Object.fromEntries(children)), null, 2) + '\n');
    if (pkg.name.startsWith('@types/') && !pkg.main && !pkg.exports) {
      const declarations = typeof pkg.types === 'string' ? pkg.types
        : typeof pkg.typings === 'string' ? pkg.typings : 'index.d.ts';
      const entry = path.resolve(destination, declarations);
      if (!inside(destination, entry) || !fs.existsSync(entry) ||
          !fs.statSync(entry).isFile() || fs.statSync(entry).size === 0) {
        throw new Error(`Missing declaration entry for "${name}".`);
      }
    } else if (!pkg.exports) {
      try { createRequire(path.join(destination, 'package.json')).resolve(destination); } catch {
        throw new Error(`Missing runtime entry for "${name}".`);
      }
    }
    return spec;
  }

  const requested = productionDependencies(packageJson(sourceRoot));
  for (const name of extraRootDependencies.keys()) requested.set(name, false);
  for (const name of requested.keys()) {
    const resolved = packageLocation(sourceRoot, name);
    const override = extraRootDependencies.get(name);
    const source = override ? fs.realpathSync(override) : resolved?.source;
    if (source) {
      const destination = path.join(rootModules, name);
      const existing = locations.get(source);
      if (existing !== undefined && existing !== destination) {
        throw new Error(`Cannot preserve the shared identity of "${name}" at ${source}.`);
      }
      locations.set(source, destination);
      placed.set(destination, source);
    }
    if (resolved && (!override || resolved.source === fs.realpathSync(override))) {
      moduleDirectories.set(resolved.modules, rootModules);
    }
  }
  const dependencies: Array<[string, string]> = [];
  for (const [name, optional] of requested) {
    const spec = copyDependency(name, fs.realpathSync(sourceRoot), path.resolve(destinationRoot), optional, extraRootDependencies.get(name));
    if (spec !== null) dependencies.push([name, spec]);
  }
  for (const { name, requester, destination } of edges) {
    if (resolvePackage(requester, name) !== fs.realpathSync(destination)) {
      throw new Error(`Bundled dependency "${name}" resolves to the wrong instance from ${requester}.`);
    }
  }
  return { dependencies: Object.fromEntries(dependencies), packageCount };
}

export function bundlePackage(
  sourceRoot: string, destinationRoot: string, extraRootDependencies: ReadonlyMap<string, string> = new Map()
): { dependencies: Record<string, string>; packageCount: number } {
  const source = fs.realpathSync(sourceRoot);
  const pkg = packageJson(source);
  if (typeof pkg.name !== 'string' || !isBotVersion(pkg.version)) throw new Error(`Invalid dependency metadata at ${source}.`);
  packageName(pkg.name);
  copyPackage(source, destinationRoot, pkg);
  const result = bundleDependencies(source, destinationRoot, extraRootDependencies);
  fs.writeFileSync(path.join(destinationRoot, 'package.json'),
    JSON.stringify(sanitizedPackage(pkg, result.dependencies), null, 2) + '\n');
  return result;
}
