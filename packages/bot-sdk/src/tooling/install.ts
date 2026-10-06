import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type InstallLocale = 'pt-BR' | 'en-US';
interface InstallOptions {
  beta: boolean;
  addToPath: boolean;
  help: boolean;
  locale: InstallLocale;
  prefix?: string;
  version?: string;
  file?: string;
  sha256?: string;
}
interface ReleaseAsset { version: string; url: string; sha256: string; size: number }
interface SdkInfo { name: string; version: string; protocolVersion: number; authoringVersion: number }
const API = 'https://api.github.com/repos/MonkyOrg/Monky/releases';
const MAX_ARCHIVE = 64 * 1024 * 1024;
const OWNER_FILE = '.monky-bot-sdk-install.json';
const OWNER = { application: 'monky-bot-sdk', format: 1 };
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(locale: InstallLocale, pt: string, en: string): string { return locale === 'en-US' ? en : pt; }
function language(value: string): InstallLocale | undefined {
  if (/^en(?:[-_].*)?$/i.test(value)) return 'en-US';
  if (/^pt(?:[-_]br)?(?:\..*)?$/i.test(value)) return 'pt-BR';
  return undefined;
}
function reason(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function includesAll(value: unknown, required: string[]): boolean {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string') &&
    required.every(entry => value.includes(entry));
}

export function npmCommand(): { command: string; args: string[] } {
  const npmCli = process.env.npm_execpath;
  if (npmCli?.endsWith('.js') && fs.existsSync(npmCli)) return { command: process.execPath, args: [npmCli] };
  const locations = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)];
  for (const directory of locations) {
    if (!directory) continue;
    const adjacent = path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (fs.existsSync(adjacent)) return { command: process.execPath, args: [adjacent] };
    if (process.platform !== 'win32') {
      const executable = path.join(directory, 'npm');
      if (fs.existsSync(executable)) {
        const resolved = fs.realpathSync(executable);
        if (resolved.endsWith('.js')) return { command: process.execPath, args: [resolved] };
      }
    }
  }
  if (process.platform !== 'win32') return { command: 'npm', args: [] };
  throw new Error('Could not locate npm-cli.js. Install Node.js with npm before using bot build/update commands.');
}

export function parseInstallArguments(args: string[]): InstallOptions {
  const options: InstallOptions = {
    beta: false, addToPath: true, help: false,
    locale: language(process.env.MONKY_BOT_LOCALE ?? process.env.MONKY_LANG ??
      process.env.LC_ALL ?? process.env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale) ?? 'pt-BR',
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (seen.has(option)) throw new Error(text(options.locale, 'Opção repetida.', 'Duplicate option.'));
    seen.add(option);
    if (option === '--beta') { options.beta = true; continue; }
    if (option === '--no-path') { options.addToPath = false; continue; }
    if (option === '--help' || option === '-h') { options.help = true; continue; }
    if (!['--prefix', '--version', '--file', '--sha256', '--locale'].includes(option)) {
      throw new Error(text(options.locale, 'Opção desconhecida. Use --help.', 'Unknown option. Use --help.'));
    }
    const value = args[++index];
    if (!value || value.startsWith('--') || /[\u0000-\u001f\u007f]/.test(value)) {
      throw new Error(text(options.locale, 'A opção exige um valor válido.', 'The option requires a valid value.'));
    }
    if (option === '--prefix') options.prefix = path.resolve(value);
    else if (option === '--file') options.file = path.resolve(value);
    else if (option === '--sha256') options.sha256 = value.toLowerCase();
    else if (option === '--version') options.version = value.replace(/^v/, '');
    else {
      const selected = /^(pt[-_]br|en[-_]us|pt|en)$/i.test(value) ? language(value) : undefined;
      if (!selected) throw new Error('Use --locale pt-BR or --locale en-US.');
      options.locale = selected;
    }
  }
  if (options.version && !VERSION.test(options.version)) {
    throw new Error(text(options.locale, 'Versão inválida.', 'Invalid version.'));
  }
  if (options.file ? !options.sha256 || options.beta || options.version : options.sha256) {
    throw new Error(text(options.locale, 'Use --file PACOTE --sha256 SHA256, sem --beta ou --version.',
      'Use --file PACKAGE --sha256 SHA256, without --beta or --version.'));
  }
  if (options.sha256 && !/^[a-f0-9]{64}$/.test(options.sha256)) {
    throw new Error(text(options.locale, 'SHA-256 inválido; use 64 dígitos hexadecimais.', 'Invalid SHA-256; use 64 hexadecimal digits.'));
  }
  return options;
}

function assetFromRelease(value: unknown, allowBeta: boolean, locale: InstallLocale): ReleaseAsset | undefined {
  if (!record(value) || value.draft !== false || typeof value.tag_name !== 'string' ||
      (!allowBeta && value.prerelease !== false)) return undefined;
  const version = value.tag_name.replace(/^v/, '');
  if (!VERSION.test(version) || (!allowBeta && version.includes('-')) || !Array.isArray(value.assets)) return undefined;
  const filename = `monky-bot-sdk-${version}.tgz`;
  const asset = value.assets.find((entry: unknown) => record(entry) && entry.name === filename);
  if (!record(asset)) return undefined;
  if (typeof asset.digest !== 'string' || !/^sha256:[a-f0-9]{64}$/i.test(asset.digest) ||
      typeof asset.size !== 'number' || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ARCHIVE) {
    throw new Error(text(locale, 'A release não fornece tamanho e SHA-256 válidos; a instalação foi bloqueada.',
      'The release does not provide a valid size and SHA-256; installation was blocked.'));
  }
  return {
    version, size: asset.size, sha256: asset.digest.slice('sha256:'.length).toLowerCase(),
    url: `https://github.com/MonkyOrg/Monky/releases/download/${encodeURIComponent(value.tag_name)}/${filename}`,
  };
}

export function selectReleaseAsset(value: unknown, beta: boolean, locale: InstallLocale): ReleaseAsset {
  if (Array.isArray(value)) {
    const releases = value.filter((entry: unknown): entry is Record<string, unknown> =>
      record(entry) && typeof entry.published_at === 'string' && Number.isFinite(Date.parse(entry.published_at)));
    releases.sort((a, b) => Date.parse(String(b.published_at)) - Date.parse(String(a.published_at)));
    for (const release of releases) {
      const asset = assetFromRelease(release, beta, locale);
      if (asset) return asset;
    }
  } else {
    const asset = assetFromRelease(value, beta, locale);
    if (asset) return asset;
  }
  throw new Error(text(locale, 'Não há pacote de SDK publicado para a versão/canal solicitado.',
    'No published SDK package was found for the requested version/channel.'));
}

async function download(url: string, maximum: number, locale: InstallLocale, redirects = 0): Promise<Buffer> {
  const address = new URL(url);
  if (address.protocol !== 'https:' || address.username || address.password || address.port ||
      !['api.github.com', 'github.com'].includes(address.hostname) && !address.hostname.endsWith('.githubusercontent.com')) {
    throw new Error(text(locale, 'Download fora dos hosts HTTPS oficiais recusado.', 'Download outside official HTTPS hosts refused.'));
  }
  const response = await fetch(address, {
    redirect: 'manual', signal: AbortSignal.timeout(30_000),
    headers: { 'User-Agent': 'Monky-Bot-SDK-Installer', Accept: address.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' },
  });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel();
    const location = response.headers.get('location');
    if (!location || redirects >= 5) throw new Error(text(locale, 'Redirecionamento de download inválido.', 'Invalid download redirect.'));
    return download(new URL(location, address).toString(), maximum, locale, redirects + 1);
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(text(locale, `Não foi possível baixar o SDK (HTTP ${response.status}). Confira conexão, canal e disponibilidade da release.`,
      `Could not download the SDK (HTTP ${response.status}). Check connectivity, channel and release availability.`));
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) throw new Error(text(locale, 'Download excede o limite de tamanho.', 'Download exceeds the size limit.'));
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function verifyArchive(data: Buffer, sha256: string, expectedSize?: number): void {
  if (!data.length || data.length > MAX_ARCHIVE || (expectedSize !== undefined && data.length !== expectedSize) ||
      createHash('sha256').update(data).digest('hex') !== sha256.toLowerCase()) {
    throw new Error('SDK SHA-256/size mismatch. / SHA-256 ou tamanho do SDK incorreto.');
  }
}

function regularFile(file: string): void {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
}

export function inspectInstallPrefix(prefix: string): void {
  if (prefix === path.parse(prefix).root || path.relative(prefix, os.homedir()) === '' || path.relative(prefix, process.cwd()) === '' ||
      /[\u0000-\u001f\u007f]/.test(prefix) || (process.platform !== 'win32' && prefix.includes(':'))) {
    throw new Error('Choose a dedicated SDK directory, not a root/home/project directory. / Escolha uma pasta exclusiva do SDK.');
  }
  if (!fs.existsSync(prefix)) return;
  const stat = fs.lstatSync(prefix);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('SDK prefix must be a real directory. / O destino deve ser uma pasta real.');
  if (!fs.readdirSync(prefix).length) return;
  const marker = path.join(prefix, OWNER_FILE);
  regularFile(marker);
  const owner: unknown = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (!record(owner) || owner.application !== OWNER.application || owner.format !== OWNER.format) {
    throw new Error('Destination is not owned by this installer. / O destino não pertence a este instalador.');
  }
  const current = path.join(prefix, 'current');
  if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || !fs.statSync(current).isDirectory())) {
    throw new Error('SDK current directory cannot be a link or file. / A instalação atual não pode ser um link ou arquivo.');
  }
}

export function shellPathBlock(bin: string): string {
  const quoted = `'${bin.replace(/'/g, "'\\''")}'`;
  return `\n# Monky Bot SDK\ncase ":$PATH:" in\n  *:${quoted}:*) ;;\n  *) export PATH=${quoted}:"$PATH" ;;\nesac\n`;
}

export function configureUnixPath(bin: string, home: string, shell: string, zshHome = home): string[] {
  const shellName = path.basename(shell);
  if (!['bash', 'zsh', 'sh', 'dash'].includes(shellName)) {
    throw new Error('Shell not supported for automatic PATH setup. Use --no-path. / Use --no-path para configurar seu shell manualmente.');
  }
  const loginFile = ['.bash_profile', '.bash_login', '.profile'].find(file => fs.existsSync(path.join(home, file))) ?? '.profile';
  const targets = shellName === 'zsh' ? [path.join(zshHome, '.zshrc')]
    : shellName === 'bash' ? [path.join(home, '.bashrc'), path.join(home, loginFile)] : [path.join(home, '.profile')];
  const block = shellPathBlock(bin);
  const changed: { file: string; before: Buffer | null }[] = [];
  try {
    for (const file of targets) {
      const exists = fs.existsSync(file);
      if (exists && (!fs.statSync(file).isFile() || fs.statSync(file).size > 4 * 1024 * 1024)) {
        throw new Error(`Shell profile is not a file or exceeds 4 MiB: ${file}`);
      }
      const before = exists ? fs.readFileSync(file) : null;
      if (before?.toString('utf8').includes(block)) continue;
      changed.push({ file, before });
      fs.appendFileSync(file, block, { mode: 0o600 });
    }
  } catch (error) {
    const failures = [reason(error)];
    for (const entry of changed.reverse()) {
      try {
        if (entry.before) fs.writeFileSync(entry.file, entry.before);
        else fs.unlinkSync(entry.file);
      } catch (rollbackError) { failures.push(reason(rollbackError)); }
    }
    throw new Error(failures.join('; '));
  }
  return changed.map(entry => entry.file);
}

function powershell(script: string, environment: NodeJS.ProcessEnv): string {
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: environment, encoding: 'utf8', windowsHide: true, shell: false, timeout: 20_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `PowerShell failed (${result.status}).`);
  return result.stdout;
}

function configureWindowsPath(bin: string): void {
  powershell(`$ErrorActionPreference = 'Stop'
$old = [Environment]::GetEnvironmentVariable('Path', 'User')
$bin = $env:MONKY_SDK_INSTALL_BIN
$found = @($old -split ';') | Where-Object { $_.TrimEnd('\\') -ieq $bin.TrimEnd('\\') }
if (-not $found) { [Environment]::SetEnvironmentVariable('Path', ($bin + ';' + $old), 'User') }`,
  { ...process.env, MONKY_SDK_INSTALL_BIN: bin });
}

function sdkLocation(prefix: string): { tools: string; launcher: string; bin: string } {
  const bin = process.platform === 'win32' ? prefix : path.join(prefix, 'bin');
  const modules = process.platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  return {
    tools: path.join(modules, '@monky', 'bot-sdk', 'dist', 'tools.js'),
    launcher: path.join(bin, process.platform === 'win32' ? 'monky-bot-sdk.cmd' : 'monky-bot-sdk'), bin,
  };
}

function prepareWindowsLauncher(prefix: string): void {
  if (process.platform !== 'win32') return;
  const { launcher } = sdkLocation(prefix);
  regularFile(launcher);
  // npm's unquoted SET dp0 breaks valid '&' paths. A .ps1 shim can also shadow
  // the .cmd command on machines that disallow unsigned PowerShell scripts.
  fs.writeFileSync(launcher, `@ECHO OFF\r\nSETLOCAL DisableDelayedExpansion\r\n"${process.execPath.replace(/%/g, '%%')}" "%~dp0node_modules\\@monky\\bot-sdk\\dist\\tools.js" %*\r\nEXIT /B %ERRORLEVEL%\r\n`);
  fs.rmSync(path.join(prefix, 'monky-bot-sdk.ps1'), { force: true });
}

function inspectSdk(prefix: string, expectedVersion?: string): SdkInfo {
  const { tools, launcher } = sdkLocation(prefix);
  regularFile(tools);
  if (!fs.existsSync(launcher)) throw new Error('npm did not create the SDK command. / npm não criou o comando do SDK.');
  const env = { ...process.env, CI: '1', MONKY_BOT_SDK_HOME: path.join(prefix, '.verification-profile') };
  const output = process.platform === 'win32'
    ? powershell(`$ErrorActionPreference = 'Stop'; & $env:MONKY_SDK_INSTALL_LAUNCHER info --json; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
      { ...env, MONKY_SDK_INSTALL_LAUNCHER: launcher })
    : (() => {
      const result = spawnSync(launcher, ['info', '--json'], {
        env, encoding: 'utf8', shell: false, timeout: 15_000, windowsHide: true,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw new Error(result.stderr || `SDK command failed (${result.status}).`);
      return result.stdout;
    })();
  const info: unknown = JSON.parse(output.trim());
  if (!record(info) || info.name !== '@monky/bot-sdk' || typeof info.version !== 'string' || !VERSION.test(info.version) ||
      (expectedVersion !== undefined && info.version !== expectedVersion) || info.authoringVersion !== 1 ||
      typeof info.protocolVersion !== 'number' || !Number.isSafeInteger(info.protocolVersion) || info.protocolVersion < 1 ||
      !includesAll(info.generators, ['command', 'form', 'selector', 'settings', 'screen']) ||
      !includesAll(info.locales, ['pt-BR', 'en-US'])) {
    throw new Error('SDK authoring CLI verification failed. / A verificação do assistente do SDK falhou.');
  }
  return { name: info.name, version: info.version, protocolVersion: info.protocolVersion, authoringVersion: info.authoringVersion };
}

export async function runSdkInstaller(args = process.argv.slice(2)): Promise<void> {
  const options = parseInstallArguments(args);
  const say = (pt: string, en: string): string => text(options.locale, pt, en);
  if (options.help) {
    console.log(say(`Instalador Monky Bot SDK (por usuário, sem administrador)
  --beta                  Incluir releases beta (stable por padrão)
  --version VERSAO        Instalar uma versão explícita
  --prefix PASTA          Pasta exclusiva da ferramenta
  --no-path               Não alterar PATH nem perfis do shell
  --locale pt-BR|en-US     Idioma do instalador
  --file PACOTE --sha256 HASH   Instalar artefato local verificado
Reexecute o instalador para atualizar o CLI; os projetos permanecem fixados no seu SDK.`,
    `Monky Bot SDK installer (per user, no administrator)
  --beta                  Include beta releases (stable by default)
  --version VERSION       Install an explicit version
  --prefix DIR            Dedicated tool directory
  --no-path               Do not change PATH or shell profiles
  --locale pt-BR|en-US     Installer language
  --file PACKAGE --sha256 HASH  Install a verified local artifact
Rerun the installer to update the CLI; projects remain pinned to their SDK.`));
    return;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) {
    throw new Error(say('Instale Node.js 22 ou superior com npm: https://nodejs.org/',
      'Install Node.js 22 or newer with npm: https://nodejs.org/'));
  }
  const npm = npmCommand();
  const npmVersion = spawnSync(npm.command, [...npm.args, '--version'], { encoding: 'utf8', windowsHide: true, shell: false, timeout: 15_000 });
  if (npmVersion.error || npmVersion.status !== 0 || !/^\d+\.\d+\.\d+\s*$/.test(npmVersion.stdout)) {
    throw new Error(say('npm não está disponível. Instale Node.js com npm antes de continuar.',
      'npm is unavailable. Install Node.js with npm before continuing.'));
  }
  const prefix = path.resolve(options.prefix ?? (process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Monky', 'BotSdk')
    : path.join(os.homedir(), '.local', 'share', 'monky-bot-sdk')));
  inspectInstallPrefix(prefix);
  console.log(say('[1/4] Localizando e verificando o pacote...', '[1/4] Locating and verifying the package...'));
  let data: Buffer, expectedVersion: string | undefined;
  if (options.file) {
    if (!options.sha256) throw new Error(say('O pacote local exige SHA-256.', 'A local package requires SHA-256.'));
    regularFile(options.file);
    if (fs.statSync(options.file).size > MAX_ARCHIVE) throw new Error(say('Pacote local excede 64 MiB.', 'Local package exceeds 64 MiB.'));
    data = fs.readFileSync(options.file);
    verifyArchive(data, options.sha256);
  } else {
    const endpoint = options.version ? `${API}/tags/v${encodeURIComponent(options.version)}` : options.beta ? `${API}?per_page=100` : `${API}/latest`;
    const release: unknown = JSON.parse((await download(endpoint, 8 * 1024 * 1024, options.locale)).toString('utf8'));
    const asset = selectReleaseAsset(release, options.beta || !!options.version, options.locale);
    expectedVersion = asset.version;
    data = await download(asset.url, MAX_ARCHIVE, options.locale);
    verifyArchive(data, asset.sha256, asset.size);
  }
  fs.mkdirSync(prefix, { recursive: true });
  const marker = path.join(prefix, OWNER_FILE);
  if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify(OWNER) + '\n', { flag: 'wx', mode: 0o600 });
  const lockFile = path.join(prefix, '.install.lock');
  const lock = fs.openSync(lockFile, 'wx', 0o600);
  const staging = path.join(prefix, `.install-${randomUUID()}`);
  const previous = path.join(prefix, `.previous-${randomUUID()}`);
  const current = path.join(prefix, 'current');
  let movedPrevious = false, activated = false, committed = false;
  try {
    fs.writeFileSync(lock, `${process.pid}\n`);
    fs.mkdirSync(staging);
    const archive = path.join(staging, 'sdk.tgz');
    fs.writeFileSync(archive, data, { flag: 'wx' });
    console.log(say('[2/4] Instalando dependências em uma pasta isolada...', '[2/4] Installing dependencies in an isolated directory...'));
    const installed = spawnSync(npm.command, [...npm.args, 'install', '--global', '--offline', '--prefix', staging, archive,
      '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit', windowsHide: true, shell: false, timeout: 300_000 });
    if (installed.error) throw installed.error;
    if (installed.status !== 0) throw new Error(say(`npm encerrou com erro (${installed.status ?? installed.signal}).`,
      `npm failed (${installed.status ?? installed.signal}).`));
    prepareWindowsLauncher(staging);
    console.log(say('[3/4] Conferindo o comando e os geradores instalados...', '[3/4] Checking the installed command and generators...'));
    let info: SdkInfo;
    try { info = inspectSdk(staging, expectedVersion); } catch (error) {
      throw new Error(say(`A release não oferece o assistente esperado. Nenhuma instalação anterior foi substituída. Use --beta explicitamente ou aguarde uma release compatível. ${reason(error)}`,
        `The release does not provide the expected assistant. No previous installation was replaced. Explicitly use --beta or wait for a compatible release. ${reason(error)}`));
    }
    fs.unlinkSync(archive);
    if (fs.existsSync(current)) {
      fs.renameSync(current, previous);
      movedPrevious = true;
    }
    fs.renameSync(staging, current);
    activated = true;
    inspectSdk(current, info.version);
    const location = sdkLocation(current);
    console.log(say('[4/4] Finalizando a instalação por usuário...', '[4/4] Finishing the per-user installation...'));
    if (options.addToPath) {
      if (process.platform === 'win32') configureWindowsPath(location.bin);
      else configureUnixPath(location.bin, os.homedir(), process.env.SHELL ?? '/bin/sh', process.env.ZDOTDIR);
    }
    committed = true;
    if (movedPrevious) {
      try { fs.rmSync(previous, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch (error) {
        console.warn(say(`O SDK novo está ativo, mas não foi possível remover o backup ${previous}: ${reason(error)}`,
          `The new SDK is active, but its backup could not be removed at ${previous}: ${reason(error)}`));
      }
    }
    console.log(say(`SDK ${info.version} instalado. Os SDKs dos projetos não foram alterados.`,
      `SDK ${info.version} installed. Project SDKs were not changed.`));
    console.log(options.addToPath
      ? say('Abra um novo terminal e execute: monky-bot-sdk', 'Open a new terminal and run: monky-bot-sdk')
      : say('PATH preservado. Execute o comando abaixo:', 'PATH left unchanged. Run the command below:'));
    console.log(process.platform === 'win32' ? `& "${location.launcher}"` : `'${location.launcher.replace(/'/g, "'\\''")}'`);
  } catch (error) {
    const failures = [reason(error)];
    try {
      if (!committed && activated) fs.renameSync(current, staging);
      if (!committed && movedPrevious) fs.renameSync(previous, current);
    } catch (rollbackError) {
      failures.push(say(`Falha ao restaurar a instalação anterior em ${previous}: ${reason(rollbackError)}`,
        `Could not restore the previous installation at ${previous}: ${reason(rollbackError)}`));
    }
    throw new Error(failures.join('\n'));
  } finally {
    try { fs.rmSync(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } finally {
      fs.closeSync(lock);
      fs.unlinkSync(lockFile);
    }
  }
}

if (require.main === module) {
  void runSdkInstaller().catch((error: unknown) => {
    console.error(reason(error));
    process.exitCode = 1;
  });
}
