import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startOwnedProcess } from './qa/process.js';

const require = createRequire(import.meta.url);
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const scenarios = ['connected', 'server-settings', 'voice', 'music', 'home', 'login', 'bot-install', 'tool-consent'];

export function parseQaArguments(args) {
  const result = { scenario: 'connected', smoke: false, bot: null, botRoot: null };
  let selected = false;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--smoke') result.smoke = true;
    else if (argument === '--bot=fixture') {
      if (result.bot) throw new Error('Choose one explicit bot source.');
      result.bot = 'sdk-fixture';
    } else if (argument === '--bot-root' || argument.startsWith('--bot-root=')) {
      if (result.bot) throw new Error('Choose one explicit bot source.');
      const root = argument === '--bot-root' ? args[++index] : argument.slice('--bot-root='.length);
      if (!root || !path.isAbsolute(root)) throw new Error('--bot-root requires an explicit absolute production MonkyBot checkout path.');
      result.botRoot = root;
      result.bot = 'production';
    } else if (scenarios.includes(argument) && !selected) {
      result.scenario = argument;
      selected = true;
    } else throw new Error(`Unknown QA argument/scenario: ${argument}. Use --help.`);
  }
  if (['home', 'login'].includes(result.scenario) && result.bot) throw new Error('Home/login QA must not install a bot before the tested login.');
  if (result.scenario === 'voice' && !result.bot) result.bot = 'sdk-fixture';
  if (['bot-install', 'tool-consent'].includes(result.scenario) && !result.bot) throw new Error('Choose --bot=fixture or an explicit --bot-root for this scenario.');
  if (result.scenario === 'music' && result.bot !== 'production') throw new Error('Music QA requires --bot-root. An SDK fixture is never production music.');
  return result;
}

export function isolatedEnvironment(root, extra = {}) {
  const env = {};
  for (const name of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC',
    'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  return {
    ...env, HOME: root, USERPROFILE: root, APPDATA: path.join(root, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(root, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(root, 'data'),
    TMP: path.join(root, 'scratch'), TEMP: path.join(root, 'scratch'), TMPDIR: path.join(root, 'scratch'),
    MONKY_HOME: path.join(root, 'cli'), ...extra,
  };
}

export const scenarioPreparation = {
  connected: 'Fresh identity, authenticated owner, seeded chat; no voice or local consent.',
  'server-settings': 'Connected owner and real General settings; no setting is edited for the test.',
  voice: 'Connected owner, muted synthetic input and real P2P SDK peer. The SDK fixture is not production music.',
  music: 'Explicit production MonkyBot and real voice; waits for actual local consent and verified tools before ready. Playback itself is not invoked.',
  home: 'Fresh identity and completed introductory wizard only; no saved server or authentication.',
  login: 'Home with loopback address, nickname and test password filled; login is deliberately not submitted.',
  'bot-install': 'Connected owner and owned manifest URL filled in the real bot installation form; bot is deliberately not installed.',
  'tool-consent': 'Connected owner, installed bot and local command visible; permission and tool setup are deliberately untouched.',
};

export async function runQa(options, hooks = {}) {
  if (!scenarios.includes(options.scenario)) throw new Error('Unsupported QA scenario.');
  if (options.bot === 'production' ? !options.botRoot : options.botRoot) throw new Error('Production QA requires its explicit bot checkout; no fixture will be substituted.');
  const { developmentQaConfigSchema, developmentQaReportSchema, botManifestSchema, PROTOCOL_VERSION } = require('../packages/shared/dist/index.js');
  for (const filename of ['apps/client/dist/index.html', 'apps/client/dist-electron/main/main.js', 'apps/server/dist/server.js']) {
    await fs.access(path.join(repoRoot, ...filename.split('/'))).catch(() => { throw new Error(`Missing QA build: ${filename}. Run npm run qa (which builds first).`); });
  }
  if (options.botRoot) {
    options.botRoot = await fs.realpath(options.botRoot);
    const manifest = JSON.parse(await fs.readFile(path.join(options.botRoot, 'package.json'), 'utf8'));
    if (manifest.name !== '@monky/bot' || manifest.monky?.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error('The explicit checkout must be production @monky/bot with the same protocol as this Monky build.');
    }
    await fs.access(path.join(options.botRoot, 'dist', 'commands', 'index.js'))
      .catch(() => { throw new Error('Build the explicit production MonkyBot checkout first; no fixture will be substituted.'); });
  }
  const runId = randomUUID();
  const runs = path.join(repoRoot, '.qa', 'runs');
  await fs.mkdir(runs, { recursive: true });
  if (await fs.realpath(runs) !== path.join(await fs.realpath(repoRoot), '.qa', 'runs')) throw new Error('QA run directories must not redirect outside this checkout.');
  const root = path.join(runs, `${options.scenario}-${runId}`);
  await fs.mkdir(root, { mode: 0o700 });
  const children = [];
  let failureReject;
  const failure = new Promise((_, reject) => { failureReject = reject; });
  failure.catch(() => {});
  const interruption = new Error('QA startup/session interrupted.');
  const interrupt = () => { failureReject(interruption); };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  const password = randomBytes(24).toString('hex');
  const startup = promise => Promise.race([promise, failure]);
  const spawn = (label, command, args, cwd, env, onMessage, windowsHide = true) => {
    const child = startOwnedProcess(command, args, {
      cwd, env, runId, label, onMessage, windowsHide, onFailure: failureReject, timeoutMs: options.smoke ? 60_000 : 180_000,
    });
    children.push(child);
    return child;
  };
  const serviceFile = path.join(repoRoot, 'scripts', 'qa', 'service.cjs');
  let result, error;
  try {
    for (const role of ['server', 'client', 'bot']) {
      const directory = path.join(root, role);
      await fs.mkdir(directory);
      for (const child of [path.join('AppData', 'Roaming'), path.join('AppData', 'Local'), 'config', 'cache', 'data', 'scratch', 'cli']) {
        await fs.mkdir(path.join(directory, child), { recursive: true });
      }
    }
    const serviceEnv = role => isolatedEnvironment(path.join(root, role), {
      MONKY_QA_SERVICE: JSON.stringify({ root, role, runId, scenario: options.scenario, password, botRoot: options.botRoot ?? undefined }),
    });
    const server = spawn('QA server', process.execPath, [serviceFile], path.join(root, 'server'), serviceEnv('server'));
    const serverReady = await startup(server.ready);
    if (serverReady.protocol !== PROTOCOL_VERSION) throw new Error('QA server/client build protocol mismatch.');
    const healthUrl = `http://127.0.0.1:${serverReady.port}/health`;
    if (!(await fetch(healthUrl, { signal: AbortSignal.timeout(5000), redirect: 'error' })).ok) throw new Error('The QA server health endpoint is not responsive.');
    let bot, botReady, joining = Promise.resolve();
    if (options.bot) {
      bot = spawn('QA bot', process.execPath, [serviceFile], path.join(root, 'bot'), serviceEnv('bot'));
      botReady = await startup(bot.ready);
      const address = new URL(botReady.manifestUrl);
      if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.pathname !== '/manifest' ||
          address.username || address.password || address.search || address.hash) throw new Error('The QA bot must expose an owned loopback manifest.');
      const manifest = await fetch(address, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!manifest.ok) throw new Error('The owned bot manifest is unavailable.');
      const parsed = botManifestSchema.parse(await manifest.json());
      if (!parsed.commands?.length || parsed.registrationUrl !== `${address.origin}/register`) {
        throw new Error('The bot must register real commands and keep token registration inside its owned loopback endpoint.');
      }
    }
    const config = developmentQaConfigSchema.parse({
      runId, scenario: options.scenario, smoke: options.smoke, nickname: 'QA Tester',
      server: { host: '127.0.0.1', port: serverReady.port, name: serverReady.name, password },
      ...(botReady ? { bot: botReady } : {}),
    });
    const configFile = path.join(root, 'launch.json');
    await fs.writeFile(configFile, JSON.stringify({ ownerPid: process.pid, config }), { flag: 'wx', mode: 0o600 });
    const reports = [];
    const client = spawn('QA client', require('electron'), [
      path.join(repoRoot, 'apps', 'client'), `--user-data-dir=${path.join(root, 'client')}`,
    ], path.join(repoRoot, 'apps', 'client'), isolatedEnvironment(path.join(root, 'client'), { MONKY_QA_CONFIG: configFile }), message => {
      if (message.type !== 'qa-report') return;
      const report = developmentQaReportSchema.parse(message.report);
      if (report.runId !== runId || report.scenario !== options.scenario) { failureReject(new Error('Mismatched QA readiness report.')); return; }
      reports.push(report);
      if (report.phase === 'voice-joined' && bot) {
        // BOT_INSTALL registers the SDK connection under the installed bot ID.
        joining = bot.call('qa-join-voice', { serverId: report.botId, channelId: report.voiceChannelId });
        joining.catch(failureReject);
      }
      if (report.phase === 'waiting-consent') hooks.log?.('QA_PREPARING: real local consent and verified tools are required; not ready yet.');
    }, options.smoke === true);
    const ready = await startup(client.ready);
    await startup(joining);
    let windowVisible;
    for (const child of children) {
      const state = await startup(child.call('qa-ping'));
      if (!state.alive) throw new Error('A QA child failed its readiness ping.');
      if (child === client) {
        windowVisible = state.visible;
        if (windowVisible !== !options.smoke) throw new Error('The QA client window visibility does not match the interactive/smoke scenario.');
      }
    }
    const stats = await startup(server.call('qa-snapshot'));
    const expectsLogin = !['home', 'login'].includes(options.scenario);
    if (ready.connected !== expectsLogin || (expectsLogin && (stats.onlineUsers !== 1 || stats.messages < 1)) ||
        (!expectsLogin && (stats.members !== 0 || stats.messages !== 0))) throw new Error('QA readiness disagrees with the real authenticated server state.');
    if (bot) {
      const state = await startup(bot.call('qa-snapshot'));
      if (options.scenario === 'bot-install' ? state.connected.length !== 0 : !state.connected.includes(ready.botId)) {
        throw new Error('QA bot readiness disagrees with its authenticated SDK connection.');
      }
      if (options.scenario !== 'bot-install' && (!ready.botPermissions ||
          state.permissions?.reviewedBy !== ready.userId ||
          JSON.stringify(state.permissions) !== JSON.stringify(ready.botPermissions))) {
        throw new Error('The SDK and administrator disagree about the real reviewed bot permissions.');
      }
      if (['voice', 'music'].includes(options.scenario) && (!state.voice || state.humanPeers < 1 || !ready.peers)) {
        throw new Error('The required real voice connection is no longer ready.');
      }
    }
    result = { scenario: options.scenario, root, runId, serverUrl: `ws://127.0.0.1:${serverReady.port}`,
      botManifestUrl: botReady?.manifestUrl, botKind: botReady?.kind, pids: children.map(child => child.child.pid),
      prepared: scenarioPreparation[options.scenario], windowVisible, ready, stats, reports };
    await hooks.onReady?.(result);
    hooks.log?.(`QA_READY ${JSON.stringify(result)}`);
    if (!options.smoke) await Promise.race([client.closed, failure]);
  } catch (caught) { if (caught !== interruption) error = caught; }
  finally {
    const failures = [];
    for (const child of [...children].reverse()) {
      try { await child.stop(); } catch (cleanupError) { failures.push(cleanupError); }
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    if (children.every(child => child.isClosed())) await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    else failures.push(new Error(`Could not confirm owned child termination; preserving QA data at ${root}.`));
    if (failures.length) {
      const causes = [...(error ? [error] : []), ...failures];
      const primary = causes[0];
      error = new AggregateError(causes,
        `Prepared QA startup/shutdown failed: ${primary instanceof Error ? primary.message : String(primary)}`);
    }
  }
  if (error) throw error;
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run qa -- [scenario] [--bot=fixture | --bot-root <absolute MonkyBot checkout>] [--smoke]\n');
    for (const scenario of scenarios) console.log(`${scenario}: ${scenarioPreparation[scenario]}`);
    console.log('\nFresh isolated data is removed on shutdown. Ctrl+C closes owned processes. Normal npm start is unchanged.');
  } else {
    runQa(parseQaArguments(process.argv.slice(2)), { log: console.log })
      .catch(error => { console.error(error); process.exitCode = 1; });
  }
}
