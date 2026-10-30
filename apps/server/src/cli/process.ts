/**
 * Child process helpers that never hand arguments to a shell.
 *
 * On Windows `pm2` and `npm` are usually `.cmd` scripts, which Node only runs
 * through `cmd.exe` (EINVAL otherwise). cmd.exe reparses the command line it
 * gets: `&` and `|` split it, and `%VAR%` expands even inside quotes, so a data
 * directory named after a variable, such as `D:\%USERNAME%`, reached PM2
 * rewritten. {@link resolveExecutable} finds what the shell would run and, for
 * the scripts npm, pnpm, Yarn and Volta write, the program behind them, which
 * then runs without a shell. Only a script this CLI cannot read still goes
 * through `cmd.exe`, with every argument escaped for it.
 *
 * POSIX runs the executable directly, with no shell involved either.
 */
import fs from 'fs';
import path from 'path';
import {
  ChildProcess,
  SpawnOptions,
  SpawnSyncOptions,
  SpawnSyncReturns,
  spawn,
  spawnSync,
} from 'child_process';
import { t } from './i18n/index';

/**
 * How to start a command: a program, run directly with `args` before the
 * caller's own, or a Windows script this CLI could not read, which only
 * `cmd.exe` can run.
 */
export type Executable =
  | { kind: 'program'; command: string; args: string[] }
  | { kind: 'script'; script: string };

/** Where a global npm prefix keeps the entry point of each tool this CLI runs. */
const NODE_ENTRIES: Readonly<Record<string, readonly string[]>> = {
  pm2: ['node_modules', 'pm2', 'bin', 'pm2'],
  npm: ['node_modules', 'npm', 'bin', 'npm-cli.js'],
};

/** What cmd.exe can run that this CLI knows how to start, in the default `PATHEXT` order. */
const RUNNABLE_EXTENSIONS = ['.com', '.exe', '.bat', '.cmd'];
const PROGRAM_EXTENSIONS = ['.com', '.exe'];

/** Yarn's global bin calls another shim, so scripts are followed a few hops. */
const MAX_SCRIPT_HOPS = 4;
const MAX_SCRIPT_BYTES = 64 * 1024;

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** A Windows environment variable, whose name ignores case (`Path`, `PATHEXT`, `ComSpec`). */
function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * Absolute `PATH` directories, in order. cmd.exe tries the current directory
 * first; that is left out, so a file dropped there never runs in place of the
 * real tool.
 */
function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  return (environmentValue(env, 'PATH') ?? '').split(path.delimiter)
    .map((entry) => entry.trim().replace(/^"(.*)"$/, '$1'))
    .filter((entry) => entry && path.isAbsolute(entry));
}

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const listed = (environmentValue(env, 'PATHEXT') ?? '').split(';')
    .map((extension) => extension.trim().toLowerCase())
    .filter((extension) => RUNNABLE_EXTENSIONS.includes(extension));
  return listed.length ? [...new Set(listed)] : RUNNABLE_EXTENSIONS;
}

/** The file cmd.exe would run for `command`: each `PATH` directory in turn, trying each `PATHEXT`. */
function searchPath(command: string, env: NodeJS.ProcessEnv, allowed: readonly string[] = RUNNABLE_EXTENSIONS): string | null {
  const extensions = pathExtensions(env).filter((extension) => allowed.includes(extension));
  for (const directory of pathDirectories(env)) {
    for (const extension of extensions) {
      const candidate = path.join(directory, command + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function nodeEntryIn(directory: string, command: string): string | null {
  const entry = NODE_ENTRIES[command];
  if (!entry) return null;
  const candidate = path.join(directory, ...entry);
  return isFile(candidate) ? candidate : null;
}

function nodeProgram(script: string): Executable {
  return { kind: 'program', command: process.execPath, args: [script] };
}

/** Splits a line of a script into words, keeping "quoted" parts whole. */
function scriptWords(line: string): string[] {
  return line.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
}

function unquote(word: string): string {
  return word.replace(/"/g, '');
}

/**
 * A file a script names, relative to the script's own folder (`%~dp0`, or
 * `%dp0%` as npm writes it) or absolute. Null when it depends on any other
 * variable.
 */
function scriptPath(word: string, script: string): string | null {
  const value = unquote(word);
  const relative = /^(?:%~dp0|%dp0%)(.*)$/i.exec(value);
  const rest = relative ? relative[1] : value;
  if (rest.includes('%')) return null;
  if (relative) return path.join(path.dirname(script), ...rest.split(/[\\/]/));
  return path.isAbsolute(value) ? path.normalize(value) : null;
}

function isNodeName(value: string): boolean {
  return /^node(?:\.exe)?$/i.test(value) || /[\\/]node\.exe$/i.test(value);
}

/** Node as a script's program: `node`, a `node.exe` path, or npm's `%_prog%` when every value it gets is one. */
function isNodeProgram(word: string, text: string): boolean {
  const value = unquote(word);
  if (!/^%_prog%$/i.test(value)) return isNodeName(value);
  const programs = [...text.matchAll(/^\s*SET\s+"?_prog=([^"\r\n]*)"?\s*$/gim)].map((match) => match[1]);
  return programs.length > 0 && programs.every(isNodeName);
}

/**
 * What one line that hands the arguments on (`... %*`) runs:
 * - Node with a JavaScript file, as npm's and pnpm's shims do. npm writes
 *   `endLocal & ... & "%_prog%" "%dp0%\node_modules\pm2\bin\pm2" %*`; the
 *   older form and pnpm's, `"%~dp0\node.exe" "%~dp0\...\bin\pm2" %*` and
 *   `node "%~dp0\...\bin\pm2" %*`, or a fixed `node.exe` path;
 * - another script or an executable, as Yarn's global bin
 *   (`@"%~dp0\..\Data\global\node_modules\.bin\pm2.cmd" %*`) or `cmd /C`;
 * - `volta run %~n0 %*`, Volta's shim.
 */
function readLaunch(line: string, script: string, text: string, env: NodeJS.ProcessEnv, hops: number): Executable | null {
  const words = scriptWords(line);
  if (words.pop() !== '%*') return null;
  const start = words.reduce((last, word, index) => (/^(?:&|&&|\|\||\|)$/.test(word) ? index + 1 : last), 0);
  const command = words.slice(start);
  if (command[0]?.startsWith('@')) command[0] = command[0].slice(1);

  if (command.length === 3 && /^volta(?:\.exe)?$/i.test(unquote(command[0])) &&
      /^run$/i.test(command[1]) && /^%~n0$/i.test(unquote(command[2]))) {
    const volta = searchPath('volta', env, PROGRAM_EXTENSIONS);
    return volta ? { kind: 'program', command: volta, args: ['run', path.basename(script, path.extname(script))] } : null;
  }
  if (command.length === 2 && isNodeProgram(command[0], text)) {
    const target = scriptPath(command[1], script);
    return target && isFile(target) && !/\.(?:bat|cmd|com|exe)$/i.test(target) ? nodeProgram(target) : null;
  }
  const isCmd = command.length === 3 && /^cmd(?:\.exe)?$/i.test(path.win32.basename(unquote(command[0]))) &&
    /^\/c$/i.test(command[1]);
  const named = isCmd ? command[2] : command.length === 1 ? command[0] : null;
  const target = named === null ? null : scriptPath(named, script);
  if (!target || !isFile(target)) return null;
  if (/\.(?:com|exe)$/i.test(target)) return { kind: 'program', command: target, args: [] };
  if (/\.(?:bat|cmd)$/i.test(target) && hops < MAX_SCRIPT_HOPS) return readScript(target, env, hops + 1);
  return null;
}

/**
 * The program behind a script npm, pnpm, Yarn or Volta wrote, or null for any
 * other script. Every line that hands the arguments on must agree: npm's older
 * shims have two, with and without a `node.exe` beside them.
 */
function readScript(script: string, env: NodeJS.ProcessEnv, hops = 0): Executable | null {
  let text: string;
  try {
    if (fs.statSync(script).size > MAX_SCRIPT_BYTES) return null;
    text = fs.readFileSync(script, 'utf8');
  } catch {
    return null;
  }
  const launches = text.split(/\r?\n/).filter((line) => /%\*\s*$/.test(line))
    .map((line) => readLaunch(line, script, text, env, hops));
  const [first] = launches;
  if (!first) return null;
  const same = JSON.stringify(first);
  return launches.every((launch) => launch && JSON.stringify(launch) === same) ? first : null;
}

/**
 * How to start `command` on this platform, or null when it is not installed.
 *
 * Windows looks where cmd.exe would: the first `PATH` directory holding the
 * command with a `PATHEXT` extension. An executable runs as is. A script runs
 * the program behind it: npm keeps the Node entry point beside its shim, and
 * the shims of npm, pnpm, Yarn and Volta are read to find it. A script it
 * cannot read is still found, so an installed tool is never taken for a
 * missing one. npm is also the one that started this CLI (`npm_execpath`) and,
 * when none is on `PATH`, the one shipped with this Node.
 */
export function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  nodeDirectory: string = path.dirname(process.execPath)
): Executable | null {
  if (platform !== 'win32') return { kind: 'program', command, args: [] };
  if (command === 'npm') {
    // npm and npx hand their own entry point to what they run. Yarn 1 sets the
    // same variable to itself, and it must not stand in for npm.
    const npmCli = env.npm_execpath;
    if (npmCli && path.win32.basename(npmCli).toLowerCase() === 'npm-cli.js' && isFile(npmCli)) {
      return nodeProgram(npmCli);
    }
  }
  const found = searchPath(command, env);
  if (!found) {
    const bundled = nodeEntryIn(nodeDirectory, command);
    return bundled ? nodeProgram(bundled) : null;
  }
  if (/\.(?:com|exe)$/i.test(found)) return { kind: 'program', command: found, args: [] };
  const beside = nodeEntryIn(path.dirname(found), command);
  return beside ? nodeProgram(beside) : readScript(found, env) ?? { kind: 'script', script: found };
}

/** Whether `command` is installed, found without running it. */
export function commandInstalled(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  if (platform === 'win32') return resolveExecutable(command, env, platform) !== null;
  return pathDirectories(env).some((directory) => isExecutableFile(path.join(directory, command)));
}

/**
 * The `cmd.exe /c` command line that runs a script this CLI could not read.
 *
 * Every argument is quoted, so `&`, `|`, `^`, `<`, `>` and parentheses stay
 * literal both when cmd.exe reads the line and when the script hands it on
 * with `%*`. `%` becomes `%%cd:~,%`, which cmd.exe expands to a single `%`
 * (Rust escapes arguments to batch files the same way), so `%VAR%` reaches the
 * program as written. A quote or a control character cannot pass through a
 * script safely, so it is refused instead of run.
 */
export function scriptCommandLine(script: string, args: readonly string[]): string {
  const unsafe = [script, ...args].find((value) => /["\u0000-\u001f]/.test(value));
  if (unsafe !== undefined) {
    throw new Error(t('process.unsafeScriptArgument', { script, argument: JSON.stringify(unsafe) }));
  }
  const quote = (value: string) => `"${value.replace(/%/g, '%%cd:~,%')}${/\\*$/.exec(value)?.[0] ?? ''}"`;
  return `"${[script, ...args].map(quote).join(' ')}"`;
}

interface Launch {
  file: string;
  args: string[];
  options: { shell: false; windowsVerbatimArguments?: boolean; argv0?: string };
}

function launchFor(executable: Executable, args: string[], env: NodeJS.ProcessEnv): Launch {
  if (executable.kind === 'program') {
    return { file: executable.command, args: [...executable.args, ...args], options: { shell: false } };
  }
  const systemRoot = environmentValue(env, 'SYSTEMROOT');
  const commandProcessor = environmentValue(env, 'COMSPEC') ||
    (systemRoot ? path.join(systemRoot, 'System32', 'cmd.exe') : 'cmd.exe');
  // The command line is written in full here, so Node must not quote it again.
  return {
    file: commandProcessor,
    args: ['/d', '/e:on', '/v:off', '/s', '/c', scriptCommandLine(executable.script, args)],
    options: { shell: false, windowsVerbatimArguments: true, argv0: 'cmd.exe' },
  };
}

/** The error Node reports when a command does not exist. */
function notInstalledError(command: string, syscall: string, args: string[]): NodeJS.ErrnoException {
  return Object.assign(new Error(`${syscall} ${command} ENOENT`), {
    errno: -4058, code: 'ENOENT', syscall: `${syscall} ${command}`, path: command, spawnargs: args,
  });
}

/** Runs a command to completion, with every argument passed as given. */
export function runSync(
  command: string,
  args: string[] = [],
  options: SpawnSyncOptions = {}
): SpawnSyncReturns<string> {
  const env = options.env ?? process.env;
  const executable = resolveExecutable(command, env);
  if (!executable) {
    return {
      pid: 0, output: [], stdout: '', stderr: '', status: null, signal: null,
      error: notInstalledError(command, 'spawnSync', args),
    };
  }
  const launch = launchFor(executable, args, env);
  return spawnSync(launch.file, launch.args, { ...options, ...launch.options }) as SpawnSyncReturns<string>;
}

/** Long-running variant of {@link runSync}, for streamed output. */
export function runAsync(command: string, args: string[] = [], options: SpawnOptions = {}): ChildProcess {
  const env = options.env ?? process.env;
  const executable = resolveExecutable(command, env);
  if (!executable) throw notInstalledError(command, 'spawn', args);
  const launch = launchFor(executable, args, env);
  return spawn(launch.file, launch.args, { ...options, ...launch.options });
}

/** Whether a command exists and exits cleanly — never throws. */
export function commandSucceeds(command: string, args: string[] = []): boolean {
  try {
    const result = runSync(command, args, { stdio: 'ignore' });
    return !result.error && result.status === 0;
  } catch {
    return false;
  }
}
