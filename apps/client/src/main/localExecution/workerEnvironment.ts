import path from 'node:path';
import type { LocalToolPaths } from './LocalTools';
import { LocalExecutionError } from './errors';

/**
 * The worker's private profile inside its task cache. Main creates these folders and points the child's
 * environment at them; the worker refuses to start unless its environment points at the same ones.
 */
export function workerDirectories(directory: string): Record<'temp' | 'home' | 'config' | 'cache' | 'data' | 'state' | 'runtime', string> {
  return {
    temp: path.join(directory, 'temp'), home: path.join(directory, 'home'), config: path.join(directory, 'config'),
    cache: path.join(directory, 'cache'), data: path.join(directory, 'data'), state: path.join(directory, 'state'),
    runtime: path.join(directory, 'runtime'),
  };
}

/** Construct a child-only environment; never clone ambient interpreter/loader settings or PATH. */
export function localWorkerEnvironment(
  paths: LocalToolPaths, directory: string, id: string, inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const retained = new Set([
    'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PATHEXT',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE',
    'NODE_EXTRA_CA_CERTS', 'NODE_USE_SYSTEM_CA', 'NODE_USE_ENV_PROXY',
  ]);
  for (const [key, value] of Object.entries(inherited)) {
    if (retained.has(key.toUpperCase()) && value !== undefined) {
      if (/[\0\r\n]/.test(value)) throw new LocalExecutionError('invalid_request');
      environment[process.platform === 'win32' ? key.toUpperCase() : key] = value;
    }
  }
  const directories = workerDirectories(directory);
  const search = [paths.node, paths.ytDlp, paths.ffmpeg].map(executable => path.dirname(executable));
  if (process.platform === 'win32') {
    const systemRoot = inherited.SystemRoot ?? inherited.SYSTEMROOT ?? inherited.windir ?? 'C:\\Windows';
    if (!path.isAbsolute(systemRoot) || /[\0\r\n]/.test(systemRoot)) throw new LocalExecutionError('invalid_request');
    environment.SYSTEMROOT = systemRoot;
    search.push(path.join(systemRoot, 'System32'), systemRoot);
    environment.HOMEDRIVE = path.parse(directories.home).root.replace(/[\\/]+$/, '');
    environment.HOMEPATH = directories.home.slice(environment.HOMEDRIVE.length);
  } else {
    search.push('/usr/bin', '/bin');
  }
  return {
    ...environment,
    PATH: [...new Set(search)].join(path.delimiter),
    TEMP: directories.temp, TMP: directories.temp, TMPDIR: directories.temp,
    HOME: directories.home, USERPROFILE: directories.home,
    APPDATA: directories.config, LOCALAPPDATA: directories.cache,
    XDG_CONFIG_HOME: directories.config, XDG_CACHE_HOME: directories.cache,
    XDG_DATA_HOME: directories.data, XDG_STATE_HOME: directories.state, XDG_RUNTIME_DIR: directories.runtime,
    NODE_DISABLE_COMPILE_CACHE: '1', NODE_TLS_REJECT_UNAUTHORIZED: '1',
    PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1',
    MONKY_LOCAL_WORKER_ID: id,
  };
}
