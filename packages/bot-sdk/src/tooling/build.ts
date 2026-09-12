import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  botEntryPath, isBotVersion, isRecord, loadBotProject, releaseAssetName, type BotPackageDefinition,
} from './config';
import { bundleDependencies, copyRuntimePath, isPrivateRuntimePath, resolvePackage } from './bundle';
import { runNpm } from './process';

export interface BuildBotOptions {
  root?: string;
  out?: string;
  version?: string;
  skipBuild?: boolean;
}

export interface BuiltBotPackage {
  file: string;
  name: string;
  version: string;
  cliName: string;
  protocolVersion: number;
  packageCount: number;
}

export function parseBuildArguments(args: string[]): BuildBotOptions {
  const options: BuildBotOptions = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--skip-build') { options.skipBuild = true; continue; }
    if (argument === '--out' || argument === '--version' || argument === '--root') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--out') options.out = value;
      else if (argument === '--version') options.version = value;
      else options.root = value;
      continue;
    }
    throw new Error(`Unknown build option: ${argument}.`);
  }
  return options;
}

const GENERATED_CLI = 'monky-cli.cjs';

function publishedDefinition(definition: BotPackageDefinition): Record<string, unknown> {
  const releases = definition.releases;
  return {
    cliName: definition.cliName,
    displayName: definition.displayName,
    entry: definition.entry,
    buildScript: false,
    files: definition.files,
    modes: definition.modes,
    ...(releases ? { releases: { url: releases.url, assetName: releases.assetName, tokenEnv: releases.tokenEnv } } : {}),
  };
}

function validateRepository(value: unknown): void {
  const address = typeof value === 'string' ? value : isRecord(value) && typeof value.url === 'string' ? value.url : undefined;
  if (!address || !address.includes('://')) return;
  let url: URL;
  try { url = new URL(address); } catch { throw new Error('Invalid package repository URL.'); }
  if (url.username || url.password) throw new Error('Package repository metadata must not contain credentials.');
}

export function buildBotPackage(options: BuildBotOptions = {}): BuiltBotPackage {
  let project = loadBotProject(options.root ?? process.cwd());
  if (project.manifest.name === '@monky/bot-sdk') throw new Error('Run the bot builder from a bot project, not the SDK itself.');
  const requestedVersion = options.version?.replace(/^v/, '');
  if (requestedVersion !== undefined && !isBotVersion(requestedVersion)) throw new Error('The build version must be valid SemVer.');
  const out = path.resolve(project.root, options.out ?? 'release');
  const buildScript = project.definition.buildScript;
  if (!options.skipBuild && buildScript) {
    if (process.env.MONKY_BOT_BUILD_ROOT === project.root) {
      throw new Error('Recursive bot build detected. The compiler script must not invoke the SDK builder again.');
    }
    const scripts = isRecord(project.manifest.scripts) ? project.manifest.scripts : {};
    const command = scripts[buildScript];
    if (typeof command !== 'string' || !command.trim()) throw new Error(`Missing npm script "${buildScript}".`);
    if (/\bmonky-bot-sdk(?:\.cmd)?\s+build\b/.test(command)) {
      throw new Error('The compiler script cannot call monky-bot-sdk build recursively. Use a separate package script.');
    }
    runNpm(['run', buildScript], {
      cwd: project.root, stdio: 'inherit', env: { ...process.env, MONKY_BOT_BUILD_ROOT: project.root },
    });
    project = loadBotProject(project.root);
  }
  const version = requestedVersion ?? project.manifest.version;
  botEntryPath(project);
  validateRepository(project.manifest.repository);
  for (const file of project.definition.files) {
    if (isPrivateRuntimePath(file) || file.split('/').includes('node_modules') || file === GENERATED_CLI) {
      throw new Error(`Refusing to package a private or reserved path: ${file}.`);
    }
    const source = path.resolve(project.root, file);
    if (source === out || out.startsWith(`${source}${path.sep}`)) throw new Error('The artifact output directory cannot be inside an included runtime path.');
  }

  const declared = [project.manifest.dependencies, project.manifest.devDependencies, project.manifest.peerDependencies]
    .some((dependencies) => isRecord(dependencies) && Object.prototype.hasOwnProperty.call(dependencies, '@monky/bot-sdk'));
  const installedSdk = resolvePackage(project.root, '@monky/bot-sdk');
  if (!installedSdk && declared) throw new Error('Install the bot project dependencies before building its package.');
  const sdkRoot = installedSdk ?? fs.realpathSync(path.resolve(__dirname, '..', '..'));
  const sdk: unknown = createRequire(path.join(sdkRoot, 'package.json'))(sdkRoot);
  if (!isRecord(sdk) || typeof sdk.runBotCli !== 'function' ||
      typeof sdk.PROTOCOL_VERSION !== 'number' || !Number.isSafeInteger(sdk.PROTOCOL_VERSION)) {
    throw new Error('The bot project requires an SDK with the reusable CLI. Update/build its installed SDK first.');
  }
  const monky = isRecord(project.manifest.monky) ? project.manifest.monky : {};
  if (monky.protocolVersion !== undefined && monky.protocolVersion !== sdk.PROTOCOL_VERSION) {
    throw new Error('The bot protocol metadata does not match its installed SDK.');
  }
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-bot-package-'));
  try {
    for (const file of project.definition.files) copyRuntimePath(project.root, file, staging, true);
    if (!fs.existsSync(path.join(staging, project.definition.entry))) {
      throw new Error('monkyBot.files must include the built bot entry and its runtime resources.');
    }
    for (const file of ['README.md', 'README.en.md', 'LICENSE', 'LICENSE.md', 'LICENSE.txt', '.env.example']) {
      if (fs.existsSync(path.join(project.root, file))) copyRuntimePath(project.root, file, staging, true);
    }
    if (fs.existsSync(path.join(staging, GENERATED_CLI))) throw new Error('The generated CLI path is reserved by the SDK.');
    fs.writeFileSync(path.join(staging, GENERATED_CLI), `#!/usr/bin/env node
'use strict';
const { runBotCli } = require('@monky/bot-sdk');
Promise.resolve().then(() => runBotCli(__dirname, process.argv.slice(2))).catch((error) => {
  console.error(error instanceof Error ? error.message : 'Bot CLI failed.');
  process.exitCode = 1;
});
`, { mode: 0o755 });

    const { dependencies, packageCount } = bundleDependencies(project.root, staging,
      new Map([['@monky/bot-sdk', sdkRoot]]));
    const pkg: Record<string, unknown> = {
      name: project.manifest.name, version,
      main: project.definition.entry,
      bin: { [project.definition.cliName]: `./${GENERATED_CLI}` },
      monky: { ...monky, protocolVersion: sdk.PROTOCOL_VERSION },
      monkyBot: publishedDefinition(project.definition),
      dependencies, bundleDependencies: Object.keys(dependencies),
    };
    for (const field of ['description', 'license', 'repository', 'homepage', 'keywords', 'author', 'funding', 'type', 'engines', 'private', 'os', 'cpu']) {
      if (project.manifest[field] !== undefined) pkg[field] = project.manifest[field];
    }
    fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    const result: unknown = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts'], { cwd: staging }));
    const packed = Array.isArray(result) && isRecord(result[0]) ? result[0].filename : undefined;
    if (typeof packed !== 'string' || path.basename(packed) !== packed || !packed.endsWith('.tgz')) {
      throw new Error('npm pack did not return a valid artifact filename.');
    }
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, releaseAssetName(project.definition, version));
    fs.copyFileSync(path.join(staging, packed), file);
    return { file, name: project.manifest.name, version, cliName: project.definition.cliName, protocolVersion: sdk.PROTOCOL_VERSION, packageCount };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
