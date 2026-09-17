import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough, Readable } from 'node:stream';
import test, { TestContext } from 'node:test';
import { stripVTControlCharacters } from 'node:util';
import { LIMITS, Permission, PROTOCOL_VERSION } from '@monky/shared';
import { main, parseLanguageArgs, promptLanguageSelection, runCommand } from './cli';
import { CONFIG_KEYS, PERMISSION_OPTIONS } from './cli/constants';
import { GlobalArgs, withContext } from './cli/context';
import { askConfigKey, setConfig, showConfig } from './cli/commands/config';
import { createCommand } from './cli/commands/create';
import { listMembers, showMemberInfo } from './cli/commands/members';
import { listRoles } from './cli/commands/roles';
import { printServerTable, restartServerCommand, startServerCommand, statusServerCommand } from './cli/commands/serverLifecycle';
import * as update from './cli/commands/update';
import {
  configKeyLabel,
  describeSfuPortProblem,
  describeTurnPortProblem,
  describeTurnUnavailability,
  encodePermissions,
  formatProcessStatus,
  normalizeRoleColor,
  parseBoolean,
  parseMemberLimit,
  parseOption,
  parsePermissionNames,
  parsePositiveInt,
  parseVoiceMode,
  permissionLabel,
  printVoiceModeComparisonTable,
  sfuPreflightSummary,
} from './cli/formatters';
import * as health from './cli/health';
import {
  detectCliLanguage,
  getCliConfigPath,
  getCliLanguage,
  initCliI18n,
  loadPersistedLanguage,
  normalizeCliLanguage,
  persistLanguage,
  setCliLanguage,
  SupportedCliLanguage,
  t,
} from './cli/i18n';
import { en } from './cli/i18n/locales/en';
import { ptBR } from './cli/i18n/locales/pt-BR';
import * as onlineUsers from './cli/onlineUsers';
import * as pm2 from './cli/pm2';
import * as processes from './cli/process';
import * as prompts from './cli/prompts';
import { registerServer } from './cli/registry';
import * as target from './cli/target';
import * as ipScanner from './infrastructure/discovery/ServerIpScanner';
import { CoturnManager, TurnPortProblem, TURN_LISTENING_PORT, TURN_RELAY_MAX_PORT, TURN_RELAY_MIN_PORT } from './infrastructure/turn/CoturnManager';

const ENVIRONMENT_KEYS = [
  'MONKY_HOME', 'MONKY_LANG', 'HOME', 'USERPROFILE', 'PM2_HOME',
  'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE', 'CI',
];

function fixture(context: TestContext) {
  const root = fs.mkdtempSync(path.join(process.cwd(), '.monky-cli-locale-test-'));
  const profile = path.join(root, 'isolated-cli');
  const home = path.join(root, 'unrelated-home');
  const previousEnvironment = new Map(ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]));
  const previousLanguage = getCliLanguage();
  for (const key of ENVIRONMENT_KEYS) delete process.env[key];
  process.env.MONKY_HOME = profile;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PM2_HOME = path.join(root, 'unused-pm2');
  setCliLanguage('en');
  context.after(() => {
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setCliLanguage(previousLanguage);
    fs.rmSync(root, { recursive: true, force: true });
  });
  context.mock.method(processes, 'runSync', (command: string) => {
    assert.fail(`Locale tests must not execute external commands: ${command}`);
  });
  context.mock.method(processes, 'runAsync', (command: string) => {
    assert.fail(`Locale tests must not start external processes: ${command}`);
  });
  return { root, profile, home };
}

function captureConsole(context: TestContext): string[] {
  const lines: string[] = [];
  context.mock.method(console, 'log', (...values: unknown[]) => {
    lines.push(stripVTControlCharacters(values.map(String).join(' ')));
  });
  return lines;
}

function setTty(context: TestContext, input: boolean, output = input): void {
  for (const [stream, value] of [[process.stdin, input], [process.stdout, output]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(stream, 'isTTY');
    Object.defineProperty(stream, 'isTTY', { value, configurable: true });
    context.after(() => {
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else Reflect.deleteProperty(stream, 'isTTY');
    });
  }
}

function writeConfig(value: string): void {
  fs.mkdirSync(path.dirname(getCliConfigPath()), { recursive: true });
  fs.writeFileSync(getCliConfigPath(), value, 'utf8');
}

function commandArgs(args: string[], dataDir: string): GlobalArgs {
  return { args, dataDir, dataDirSpecified: true };
}

function lifecycleFixture(context: TestContext) {
  const base = fixture(context);
  const output = captureConsole(context);
  const dataDir = path.join(base.root, 'synthetic-server');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, 'monky.json'), '{"port":3200}');
  const server = { id: 'fixture-server', dataDir, name: 'Fixture Server', port: 3100, createdAt: 1 };
  const state: { entry: pm2.Pm2Process | null; exitCode: number } = { entry: null, exitCode: 0 };
  const commands: string[][] = [];
  const previewPorts: number[] = [];
  context.mock.method(target, 'resolveTargetServer', async () => server);
  context.mock.method(target, 'knownServers', () => [server]);
  context.mock.method(pm2, 'ensurePm2', () => {});
  context.mock.method(pm2, 'requirePm2', () => true);
  context.mock.method(pm2, 'isMonkyServerRegistered', () => true);
  context.mock.method(pm2, 'findPm2Process', () => state.entry);
  context.mock.method(pm2, 'findLegacyProcessFor', () => null);
  context.mock.method(pm2, 'writeEcosystem', () => path.join(dataDir, 'synthetic-ecosystem.cjs'));
  context.mock.method(health, 'diagnoseServerHealth', async () => []);
  context.mock.method(onlineUsers, 'confirmDisconnectingUsers', async () => true);
  context.mock.method(onlineUsers, 'readLocalServerPreview', async (port: number) => {
    previewPorts.push(port);
    return {
      userCount: 10,
      voiceUserCount: 0,
      botCompatibility: { protocolVersion: PROTOCOL_VERSION, incompatibleBots: 1, uncheckedBots: 2 },
    };
  });
  context.mock.method(processes, 'runSync', (command: string, args: string[] = []): ReturnType<typeof processes.runSync> => {
    assert.equal(command, 'pm2', 'all process execution is simulated');
    assert.ok(args[0] === 'startOrRestart' || args[0] === 'save');
    commands.push(args);
    return { pid: 0, status: state.exitCode, signal: null, stdout: '', stderr: '', output: [] };
  });
  return { ...base, dataDir, server, state, commands, previewPorts, output };
}

test('CLI catalogs have the same keys and placeholders, including shared beta diagnostics', () => {
  const catalogs: Record<string, string>[] = [ptBR, en];
  assert.deepEqual(Object.keys(catalogs[0]).sort(), Object.keys(catalogs[1]).sort());
  const placeholders = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const [key, value] of Object.entries(catalogs[0])) {
    assert.ok(value.trim(), key);
    assert.ok(catalogs[1][key].trim(), key);
    assert.deepEqual(placeholders(value), placeholders(catalogs[1][key]), key);
  }
  for (const key of ['voiceUsers.warning', 'update.downloadProgress', 'botCompatibility.incompatible']) {
    assert.ok(catalogs[0][key], key);
  }
});

test('language tags normalize without accepting unsupported or malformed choices', () => {
  for (const value of ['en', 'en-US', 'EN_us.UTF-8', 'en-GB']) assert.equal(normalizeCliLanguage(value), 'en');
  for (const value of ['pt', 'pt-BR', 'pt_BR.UTF-8', 'PT-br', 'pt-PT']) assert.equal(normalizeCliLanguage(value), 'pt-BR');
  for (const value of ['', 'english', 'es', 'fr-FR', 'en-', '1', 'pt-BR invalid']) {
    assert.equal(normalizeCliLanguage(value), null, value);
  }
});

test('--lang parsing preserves canonical command arguments and rejects ambiguous flags', (context) => {
  fixture(context);
  const args = ['config', '--lang', 'en-US', 'set', 'voiceMode', 'sfu', '--data', 'fixture'];
  assert.deepEqual(parseLanguageArgs(args), {
    language: 'en',
    args: ['config', 'set', 'voiceMode', 'sfu', '--data', 'fixture'],
  });
  assert.equal(args[1], '--lang', 'the caller owns the original arguments');
  assert.deepEqual(parseLanguageArgs(['--lang=pt-BR', 'list']), { language: 'pt-BR', args: ['list'] });
  for (const invalid of [
    ['--lang'], ['--lang', '--help'], ['--lang='], ['--lang', 'fr'],
    ['--lang', 'en', '--lang', 'pt-BR'],
  ]) {
    assert.throws(() => parseLanguageArgs(invalid), /language|--lang/i);
  }
  assert.equal(fs.existsSync(getCliConfigPath()), false);
});

test('MONKY_HOME is resolved dynamically and never consults the unrelated profile', (context) => {
  const { root, profile, home } = fixture(context);
  const unrelatedConfig = path.join(home, '.monky', 'cli-config.json');
  fs.mkdirSync(path.dirname(unrelatedConfig), { recursive: true });
  fs.writeFileSync(unrelatedConfig, '{"language":"pt-BR","sentinel":"unchanged"}');
  assert.equal(getCliConfigPath(), path.join(profile, 'cli-config.json'));
  assert.equal(initCliI18n(), false);
  persistLanguage('en');

  process.env.MONKY_HOME = path.join(root, 'second-profile');
  assert.equal(loadPersistedLanguage(), null);
  persistLanguage('pt-BR');
  assert.equal(loadPersistedLanguage(), 'pt-BR');
  process.env.MONKY_HOME = profile;
  assert.equal(loadPersistedLanguage(), 'en');
  assert.equal(fs.readFileSync(unrelatedConfig, 'utf8'), '{"language":"pt-BR","sentinel":"unchanged"}');
});

test('default CLI location follows the OS home without reading Electron settings', (context) => {
  const { home } = fixture(context);
  delete process.env.MONKY_HOME;
  assert.equal(getCliConfigPath(), path.join(home, '.monky', 'cli-config.json'));
  persistLanguage('pt-BR');
  assert.equal(loadPersistedLanguage(), 'pt-BR');
});

test('persisting a normalized language preserves unrelated CLI preferences', (context) => {
  fixture(context);
  writeConfig('{"language":"en-US","futurePreference":{"enabled":true}}');
  assert.equal(loadPersistedLanguage(), 'en');
  persistLanguage('pt-BR');
  const saved: unknown = JSON.parse(fs.readFileSync(getCliConfigPath(), 'utf8'));
  assert.deepEqual(saved, { language: 'pt-BR', futurePreference: { enabled: true } });
});

test('locale precedence is explicit flag, process override, saved preference, then OS', (context) => {
  fixture(context);
  process.env.LANG = 'pt_BR.UTF-8';
  process.env.LC_MESSAGES = 'en_US.UTF-8';
  process.env.LC_ALL = 'pt_BR.UTF-8';
  assert.equal(detectCliLanguage(), 'pt-BR');
  delete process.env.LC_ALL;
  assert.equal(detectCliLanguage(), 'en');
  delete process.env.LC_MESSAGES;
  assert.equal(initCliI18n(), false, 'an OS guess still needs first-run confirmation');
  assert.equal(getCliLanguage(), 'pt-BR');
  persistLanguage('en');
  assert.equal(initCliI18n(), true);
  assert.equal(getCliLanguage(), 'en');
  process.env.MONKY_LANG = 'pt-BR';
  assert.equal(initCliI18n(), true);
  assert.equal(getCliLanguage(), 'pt-BR');
  assert.equal(initCliI18n('en'), true);
  assert.equal(getCliLanguage(), 'en');
  assert.equal(loadPersistedLanguage(), 'en', 'process overrides are not persisted');
});

test('LANGUAGE preferences and unsupported OS locales have a defined English fallback', (context) => {
  fixture(context);
  process.env.LANGUAGE = 'fr:pt_BR:en_US';
  assert.equal(detectCliLanguage(), 'pt-BR');
  process.env.LANG = 'C';
  assert.equal(detectCliLanguage(), 'en');
  process.env.LC_ALL = 'de_DE.UTF-8';
  process.env.LANG = 'pt_BR.UTF-8';
  assert.equal(detectCliLanguage(), 'en', 'LC_ALL overrides LANG even without a matching catalog');
});

test('explicit process locales do not read corrupt stored preferences or silently accept invalid overrides', (context) => {
  fixture(context);
  writeConfig('{invalid');
  process.env.MONKY_LANG = 'pt-BR';
  assert.equal(initCliI18n(), true);
  assert.equal(getCliLanguage(), 'pt-BR');
  process.env.MONKY_LANG = 'unsupported';
  assert.throws(() => initCliI18n(), /MONKY_LANG/);
  assert.equal(initCliI18n('en'), true, '--lang overrides an inherited environment value');
  assert.equal(fs.readFileSync(getCliConfigPath(), 'utf8'), '{invalid');
  assert.throws(() => persistLanguage('en'), /Invalid language configuration/);
});

test('malformed or invalid stored configuration cannot become a successful default or be overwritten', async (context) => {
  for (const value of ['{invalid', 'null', '[]', '42', '{"language":null}', '{"language":"fr"}', '{"language":false}']) {
    await context.test(value, (subtest) => {
      fixture(subtest);
      writeConfig(value);
      assert.throws(() => initCliI18n(), /Invalid language configuration/);
      assert.throws(() => persistLanguage('en'), /Invalid language configuration/);
      assert.equal(fs.readFileSync(getCliConfigPath(), 'utf8'), value);
    });
  }
});

test('unreadable config reports its path and cause instead of claiming no preference', (context) => {
  fixture(context);
  const configPath = getCliConfigPath();
  context.mock.method(fs, 'readFileSync', () => {
    throw Object.assign(new Error('fixture read denied'), { code: 'EACCES' });
  });
  assert.throws(() => loadPersistedLanguage(), (error: unknown) =>
    error instanceof Error && error.message.includes(configPath) && error.message.includes('fixture read denied')
  );
});

test('a failed atomic save preserves the old config and removes only its incomplete file', (context) => {
  const { profile } = fixture(context);
  persistLanguage('en');
  const original = fs.readFileSync(getCliConfigPath(), 'utf8');
  context.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('fixture write denied'), { code: 'EACCES' });
  });
  assert.throws(() => persistLanguage('pt-BR'), /Could not save language.*fixture write denied/);
  assert.equal(fs.readFileSync(getCliConfigPath(), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(profile), ['cli-config.json']);
});

test('MONKY_HOME pointing to a file is an error, not a successful language save', (context) => {
  const { profile } = fixture(context);
  fs.writeFileSync(profile, 'not a directory');
  assert.throws(() => persistLanguage('en'), /Could not (read language configuration|save language)/);
  assert.equal(fs.readFileSync(profile, 'utf8'), 'not a directory');
});

test('first-run selection retries invalid answers and sets exactly the language it persists', async (context) => {
  fixture(context);
  const input = Readable.from(['\ninvalid\n1trailing\n2\n']);
  const output = new PassThrough();
  await promptLanguageSelection(input, output);
  const text = String(output.read());
  assert.equal(text.split(t('language.selectPrompt')).length - 1, 1);
  assert.equal(text.split(en['language.invalidSelection']).length - 1, 3);
  assert.match(text, /Idioma do CLI salvo: pt-BR/);
  assert.equal(loadPersistedLanguage(), 'pt-BR');
  assert.equal(getCliLanguage(), 'pt-BR');
  assert.equal(input.listenerCount('data'), 0);
});

test('language codes work in the first-run prompt and EOF cancels without creating defaults', async (context) => {
  const { profile } = fixture(context);
  await assert.rejects(promptLanguageSelection(Readable.from(['invalid\n']), new PassThrough()), /cancelled/);
  assert.equal(fs.existsSync(profile), false);
  await promptLanguageSelection(Readable.from(['en-US\n']), new PassThrough());
  assert.equal(loadPersistedLanguage(), 'en');
  assert.equal(getCliLanguage(), 'en');
});

test('a prompt cannot announce a saved language when persistence fails', async (context) => {
  fixture(context);
  persistLanguage('en');
  context.mock.method(fs, 'renameSync', () => { throw new Error('fixture save failure'); });
  const output = new PassThrough();
  await assert.rejects(promptLanguageSelection(Readable.from(['pt-BR\n']), output), /Could not save language/);
  assert.equal(getCliLanguage(), 'en');
  assert.equal(loadPersistedLanguage(), 'en');
  assert.doesNotMatch(String(output.read()), /saved|salvo/);
});

test('TTY help, version and invalid commands never prompt or save language', async (context) => {
  const { profile } = fixture(context);
  const output = captureConsole(context);
  setTty(context, true);
  context.mock.method(readline, 'createInterface', () => assert.fail('informational commands must not prompt'));
  for (const args of [
    [], ['--help'], ['help'], ['members', 'info', '--help'], ['create', '-h'],
    ['--version'], ['version'], ['start', '--version'], ['--lang', 'pt-BR', '--help'],
  ]) {
    await main(args);
  }
  for (const args of [['unknown'], ['members', 'unknown'], ['admin'], ['roles', 'invalid'], ['config', 'invalid']]) {
    await assert.rejects(main(args), /Unknown command|Invalid subcommand/);
  }
  assert.equal(fs.existsSync(profile), false);
  assert.ok(output.some((line) => line.includes('USAGE')));
  assert.ok(output.some((line) => line.includes('USO')));
});

test('first real TTY command asks once; a later --lang changes the saved preference', async (context) => {
  fixture(context);
  captureConsole(context);
  setTty(context, true);
  context.mock.method(target, 'knownServers', () => []);
  const createInterface = readline.createInterface;
  const question = context.mock.method(readline, 'createInterface', () =>
    createInterface({ input: Readable.from(['pt-BR\n']), output: new PassThrough(), terminal: false })
  );
  await main(['list']);
  assert.equal(question.mock.callCount(), 1);
  assert.equal(loadPersistedLanguage(), 'pt-BR');
  const modifiedAt = fs.statSync(getCliConfigPath()).mtimeMs;
  await main(['list']);
  assert.equal(question.mock.callCount(), 1);
  assert.equal(fs.statSync(getCliConfigPath()).mtimeMs, modifiedAt);
  await main(['--lang', 'en-US', 'list']);
  assert.equal(question.mock.callCount(), 1);
  assert.equal(loadPersistedLanguage(), 'en');
  assert.equal(getCliLanguage(), 'en');
});

test('noninteractive and redirected commands use --lang without saving or prompting', async (context) => {
  for (const [input, output] of [[false, false], [true, false], [false, true]] as const) {
    await context.test(`stdin TTY=${input}; stdout TTY=${output}`, async (subtest) => {
      const { profile } = fixture(subtest);
      captureConsole(subtest);
      setTty(subtest, input, output);
      subtest.mock.method(target, 'knownServers', () => []);
      subtest.mock.method(readline, 'createInterface', () => assert.fail('scripts must not gain language prompts'));
      await main(['list']);
      assert.equal(getCliLanguage(), 'en');
      await main(['list', '--lang', 'pt-BR']);
      assert.equal(getCliLanguage(), 'pt-BR');
      assert.equal(fs.existsSync(profile), false);
    });
  }
});

test('CI with a pseudo-terminal never prompts or implicitly persists a language', async (context) => {
  const { profile } = fixture(context);
  captureConsole(context);
  setTty(context, true);
  process.env.CI = 'true';
  context.mock.method(target, 'knownServers', () => []);
  context.mock.method(readline, 'createInterface', () => assert.fail('CI must not prompt, even with a TTY'));
  await main(['list']);
  await main(['--lang', 'pt-BR', 'list']);
  assert.equal(getCliLanguage(), 'pt-BR');
  assert.equal(fs.existsSync(profile), false);
  await main(['--lang', 'en']);
  assert.equal(loadPersistedLanguage(), 'en');
});

test('standalone --lang is an explicit preference edit even without a TTY', async (context) => {
  fixture(context);
  const output = captureConsole(context);
  setTty(context, false);
  await main(['--lang', 'en-US']);
  assert.equal(loadPersistedLanguage(), 'en');
  assert.match(output.join('\n'), /CLI language saved: en/);
  await main(['--lang=pt-BR']);
  assert.equal(loadPersistedLanguage(), 'pt-BR');
  assert.match(output.join('\n'), /Idioma do CLI salvo: pt-BR/);
});

test('invalid language flags are diagnosed in the saved locale without changing it', async (context) => {
  fixture(context);
  persistLanguage('pt-BR');
  const saved = fs.readFileSync(getCliConfigPath(), 'utf8');
  await assert.rejects(main(['--lang', 'fr']), /Idioma não suportado/);
  await assert.rejects(main(['--lang']), /Informe um idioma após --lang/);
  assert.equal(getCliLanguage(), 'pt-BR');
  assert.equal(fs.readFileSync(getCliConfigPath(), 'utf8'), saved);
});

test('an app-selected locale bypasses the first-run prompt without writing a preference', async (context) => {
  const { profile } = fixture(context);
  captureConsole(context);
  setTty(context, true);
  context.mock.method(target, 'knownServers', () => []);
  context.mock.method(readline, 'createInterface', () => assert.fail('the app already selected a language'));
  process.env.MONKY_LANG = 'pt-BR';
  await main(['list']);
  assert.equal(getCliLanguage(), 'pt-BR');
  assert.equal(fs.existsSync(profile), false);
});

test('one-off locales reach child command environments and are restored on both success and failure', async (context) => {
  const { profile } = fixture(context);
  captureConsole(context);
  setTty(context, false);
  process.env.MONKY_LANG = 'en-US';
  context.mock.method(target, 'knownServers', () => {
    assert.equal(process.env.MONKY_LANG, 'pt-BR');
    return [];
  });
  await main(['--lang', 'pt-BR', 'list']);
  assert.equal(process.env.MONKY_LANG, 'en-US');
  delete process.env.MONKY_LANG;
  await assert.rejects(main(['--lang', 'pt-BR', 'start', '--port', '0']), /Valor inválido/);
  assert.equal(process.env.MONKY_LANG, undefined);
  assert.equal(fs.existsSync(profile), false);
});

test('valid command/config/permission identifiers remain stable in both languages', (context) => {
  fixture(context);
  for (const language of ['en', 'pt-BR'] as const) {
    setCliLanguage(language);
    assert.equal(parseBoolean('true'), true);
    assert.equal(parseBoolean('não'), false);
    assert.equal(parsePositiveInt('port', '3000'), 3000);
    assert.equal(parseMemberLimit('maxUsers', '0'), 0);
    assert.equal(parseVoiceMode('sfu'), 'sfu');
    assert.equal(normalizeRoleColor('AABBCC'), '#AABBCC');
    assert.equal(encodePermissions(parsePermissionNames('MANAGE_ROLES,Speak')), Permission.MANAGE_ROLES | Permission.SPEAK);
    for (const permission of PERMISSION_OPTIONS) {
      assert.equal(encodePermissions(parsePermissionNames(permission.name)), permission.value);
      assert.equal(encodePermissions([permissionLabel(permission.name)]), permission.value);
    }
    for (const key of CONFIG_KEYS) assert.ok(configKeyLabel(key).endsWith(`(${key})`));
    assert.throws(() => parseOption(['--port'], '--port'), { message: t('validation.optionValue', { option: '--port' }) });
    assert.throws(() => parseOption(['--port', '--name'], '--port'), {
      message: t('validation.optionValueReceived', { option: '--port', value: '--name' }),
    });
    assert.throws(() => parseBoolean('invalid'), { message: t('validation.boolean', { value: 'invalid' }) });
    assert.throws(() => parsePositiveInt('port', '0'), { message: t('validation.positiveInt', { key: 'port', value: '0' }) });
    assert.throws(() => parseMemberLimit('maxUsers', '-1'), {
      message: t('validation.memberLimit', { key: 'maxUsers', value: '-1' }),
    });
    assert.throws(() => parsePermissionNames('invalid'), { message: t('validation.permission', { value: 'invalid' }) });
    assert.throws(() => encodePermissions(['invalid']), { message: t('validation.permission', { value: 'invalid' }) });
    assert.throws(() => normalizeRoleColor('invalid'), { message: t('validation.roleColor') });
    assert.throws(() => parseVoiceMode('invalid'), { message: t('validation.voiceMode', { value: 'invalid' }) });
  }
});

test('comparison tables, status, health and availability diagnostics use the active language', (context) => {
  fixture(context);
  const output = captureConsole(context);
  for (const language of ['en', 'pt-BR'] as const) {
    setCliLanguage(language);
    output.length = 0;
    printVoiceModeComparisonTable();
    const comparison = output.join('\n');
    assert.ok(comparison.includes(t('voice.audio')));
    assert.ok(comparison.includes(t('voice.screen')));
    assert.ok(comparison.includes(t('voice.direct')));
    assert.ok(comparison.includes('P2P Mesh'));
    assert.equal(formatProcessStatus('stopped'), t('status.stopped'));
    assert.equal(formatProcessStatus('not started'), t('status.notStarted'));
    assert.equal(formatProcessStatus('future-pm2-status'), 'future-pm2-status');
    assert.equal(describeTurnUnavailability({ supported: false, reason: 'unsupported-platform' }), t('config.turnLinuxOnly'));
    assert.equal(describeTurnUnavailability({ supported: false, reason: 'not-installed', autoInstallable: true }), t('config.coturnMissing'));
    assert.equal(describeTurnUnavailability({ supported: true }), null);
    assert.equal(describeSfuPortProblem({ code: 'bind-failed', port: 10000, minPort: 10000, maxPort: 11000 }),
      t('sfu.portBindFailed', { port: 10000, minPort: 10000, maxPort: 11000 }));
    const summary = sfuPreflightSummary({ ok: false, issues: [{ code: 'mediasoup-unresolved', message: 'fixture diagnostic' }] });
    assert.equal(summary, t('sfu.preflightMediasoupUnresolved'));
    assert.deepEqual(health.evaluateServerHealth({
      entry: { pid: 0, pm2_env: { status: 'online' } },
      portState: 'closed',
      cliNodeVersion: '24.0.0',
    }), [{ message: t('health.noPid'), hint: t('health.noPidHint') }]);
  }
});

test('TURN port failures expose structured diagnostics without changing legacy callers or using real ports', async (context) => {
  for (const code of ['not-listening', 'external-unreachable', 'relay-bind-failed'] as const) {
    await context.test(code, async (subtest) => {
      fixture(subtest);
      let connections = 0;
      subtest.mock.method(net.Socket.prototype, 'connect', function (this: net.Socket) {
        connections++;
        const connected = code !== 'not-listening' && (connections === 1 || code === 'relay-bind-failed');
        queueMicrotask(() => {
          if (connected) this.emit('connect');
          else this.emit('error', new Error('fixture TCP failure'));
        });
        return this;
      });
      subtest.mock.method(dgram.Socket.prototype, 'bind', function (this: dgram.Socket) {
        queueMicrotask(() => this.emit('error', new Error('fixture UDP failure')));
        return this;
      });
      subtest.mock.method(ipScanner, 'getPublicIp', async () => '203.0.113.10');
      const problems: TurnPortProblem[] = [];
      const result = await CoturnManager.checkPortReachability((problem) => {
        problems.push(problem);
        return describeTurnPortProblem(problem);
      });
      assert.equal(problems.length, 1);
      assert.equal(problems[0].code, code);
      assert.equal(result, describeTurnPortProblem(problems[0]));
      if (code === 'not-listening') {
        assert.equal(result, t('turn.portNotListening', { port: TURN_LISTENING_PORT }));
      } else if (code === 'external-unreachable') {
        assert.equal(result, t('turn.portExternalUnreachable', {
          port: TURN_LISTENING_PORT, publicIp: '203.0.113.10',
          minPort: TURN_RELAY_MIN_PORT, maxPort: TURN_RELAY_MAX_PORT,
        }));
      } else {
        assert.equal(result, t('turn.relayPortBindFailed', {
          port: TURN_RELAY_MIN_PORT, minPort: TURN_RELAY_MIN_PORT, maxPort: TURN_RELAY_MAX_PORT,
        }));
      }
      connections = 0;
      const legacy = await CoturnManager.checkPortReachability();
      assert.match(legacy ?? '', /^(A porta|O range)/, 'callers without a CLI formatter keep the original messages');
      setCliLanguage('pt-BR');
      assert.equal(describeTurnPortProblem(problems[0]), legacy);
    });
  }
});

test('confirmation hints use Y/N or S/N while accepting the same boolean answers', async (context) => {
  fixture(context);
  const createInterface = readline.createInterface;
  for (const language of ['en', 'pt-BR'] as const) {
    setCliLanguage(language);
    for (const defaultYes of [true, false]) {
      const output = new PassThrough();
      const mocked = context.mock.method(readline, 'createInterface', () =>
        createInterface({ input: Readable.from(['y\n']), output, terminal: false })
      );
      assert.equal(await prompts.confirm(t('create.confirm'), defaultYes), true);
      assert.ok(String(output.read()).includes(t(defaultYes ? 'prompt.confirmDefaultYes' : 'prompt.confirmDefaultNo')));
      mocked.mock.restore();
    }
  }
});

test('create prompts, default server name, summary and existing-server errors are localized without writes on cancel', async (context) => {
  const { root } = fixture(context);
  const output = captureConsole(context);
  context.mock.method(prompts, 'ask', async (question: string, defaultValue?: string) => {
    assert.equal(question, t('create.serverName'));
    assert.equal(defaultValue, t('create.defaultServerName'));
    return defaultValue;
  });
  context.mock.method(prompts, 'promptPassword', async (question: string) => {
    assert.equal(question, t('create.identityPassword'));
    return 'synthetic fixture password';
  });
  context.mock.method(prompts, 'confirm', async (question: string) => {
    assert.equal(question, t('create.confirm'));
    return false;
  });
  for (const language of ['en', 'pt-BR'] as const) {
    setCliLanguage(language);
    output.length = 0;
    const dataDir = path.join(root, language);
    const globalArgs = commandArgs(['create'], dataDir);
    await createCommand(globalArgs, [
      '--identity', 'MONKY-ID:synthetic-fixture', '--port', '3000',
      '--password', '', '--max-users', '0', '--voice-mode', 'p2p',
    ]);
    const text = output.join('\n');
    for (const label of ['create.summary', 'label.dataDir', 'label.name', 'label.voiceMode', 'label.password', 'create.cancelled'] as const) {
      assert.ok(text.includes(t(label)), label);
    }
    assert.equal(fs.existsSync(dataDir), false, 'cancelled creation does not write server data');
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, 'server.db'), '');
    await assert.rejects(createCommand(globalArgs, []), {
      message: `${t('create.alreadyExists', { path: dataDir })}\n${t('create.adjustExisting')}`,
    });
  }
});

test('members, roles and config display translated labels while retaining canonical keys and data', async (context) => {
  const { root } = fixture(context);
  const output = captureConsole(context);
  context.mock.method(update, 'isAutoUpdateEnabled', () => false);
  context.mock.method(CoturnManager, 'describeAvailability', () => ({ supported: true }));
  await withContext(path.join(root, 'server-data'), async (ctx) => {
    await ctx.userRepo.create({
      id: 'fixture-user', clientId: 'fixture-client', publicKey: 'synthetic-public-key',
      nickname: 'Fixture Nickname', avatarPath: null, createdAt: 1, lastSeenAt: 2,
    });
    const admin = await ctx.roleRepo.findByName('Admin');
    assert.ok(admin);
    await ctx.roleRepo.assignRole('fixture-user', admin.id);
    for (const language of ['en', 'pt-BR'] as const) {
      setCliLanguage(language);
      output.length = 0;
      await listMembers(ctx);
      await showMemberInfo(ctx, 'fixture-client');
      await listRoles(ctx);
      await showConfig(ctx);
      const text = output.join('\n');
      for (const label of ['label.nickname', 'label.clientId', 'label.roles', 'label.publicKey', 'label.permissions', 'label.createdAt'] as const) {
        assert.ok(text.includes(t(label)), label);
      }
      assert.ok(text.includes(configKeyLabel('voiceMode')));
      assert.ok(text.includes(configKeyLabel('allowSoundboard')));
      assert.ok(text.includes('Fixture Nickname'));
      assert.ok(text.includes('Admin'), 'stored role names are not translated');
      await assert.rejects(setConfig(ctx, 'nome', 'different'), { message: t('config.unsupportedKey', { key: 'nome' }) });
      await assert.rejects(setConfig(ctx, 'voiceMode', 'typo'), { message: t('validation.voiceMode', { value: 'typo' }) });
      await setConfig(ctx, 'allowSoundboard', 'false');
      assert.equal((await ctx.serverRepo.getServer())?.allowSoundboard, false);
    }
  });
});

test('translated config choices resolve back to the canonical key', async (context) => {
  fixture(context);
  setCliLanguage('pt-BR');
  context.mock.method(prompts, 'askChoice', async (_question: string, choices: string[]) => {
    const choice = choices.find((entry) => entry.endsWith('(maxUsers)'));
    assert.ok(choice);
    assert.equal(choice, 'Limite de membros (maxUsers)');
    return choice;
  });
  assert.equal(await askConfigKey(), 'maxUsers');
});

test('server selection and listings translate human copy without altering process identifiers', async (context) => {
  const { root } = fixture(context);
  const output = captureConsole(context);
  setTty(context, true);
  for (const directory of ['first', 'second']) {
    fs.mkdirSync(path.join(root, directory));
    fs.writeFileSync(path.join(root, directory, 'server.db'), '');
  }
  const first = registerServer(path.join(root, 'first'), { name: 'Friends', port: 3000 });
  const second = registerServer(path.join(root, 'second'), { name: 'Work', port: 3100 });
  context.mock.method(pm2, 'findPm2Process', () => ({ pid: 0, pm2_env: { status: 'stopped' } }));
  context.mock.method(pm2, 'findLegacyProcessFor', () => null);
  context.mock.method(prompts, 'askChoice', async (question: string, choices: string[]) => {
    assert.equal(question, t('target.whichServer', { action: t('action.restart') }));
    assert.ok(choices[0].includes(t('target.portSuffix', { port: 3000 })));
    return choices[1];
  });
  for (const language of ['en', 'pt-BR'] as const) {
    setCliLanguage(language);
    const selected = await target.resolveTargetServer({ args: [], dataDir: root, dataDirSpecified: false }, t('action.restart'));
    assert.equal(selected.id, second.id);
    output.length = 0;
    await printServerTable([first, second]);
    assert.ok(output.join('\n').includes(t('status.stopped')));
    assert.ok(output.join('\n').includes(t('lifecycle.tableDataDir')));
  }
});

test('member/role/config command routing passes a translated action before touching data', async (context) => {
  const { root } = fixture(context);
  context.mock.method(target, 'resolveTargetServer', async (_args: GlobalArgs, action: string) => {
    assert.equal(action, t('action.manage'));
    throw new Error('fixture target selected');
  });
  for (const language of ['en', 'pt-BR'] as const) {
    setCliLanguage(language);
    for (const command of ['members', 'roles', 'config']) {
      await assert.rejects(runCommand(commandArgs([command], root)), /fixture target selected/);
    }
  }
});

test('successful start and restart print persistent bot warnings from the effective server port', async (context) => {
  for (const command of ['start', 'restart'] as const) {
    await context.test(command, async (subtest) => {
      const f = lifecycleFixture(subtest);
      setCliLanguage(command === 'start' ? 'en' : 'pt-BR');
      if (command === 'start') await startServerCommand(commandArgs(['start'], f.dataDir), ['--port', '4100']);
      else await restartServerCommand(commandArgs(['restart'], f.dataDir));
      assert.deepEqual(f.previewPorts, [command === 'start' ? 4100 : 3200]);
      assert.deepEqual(f.commands.map((args) => args[0]), ['startOrRestart', 'save']);
      const output = f.output.join('\n');
      assert.ok(output.includes(t('botCompatibility.incompatible', { count: 1, protocol: PROTOCOL_VERSION })));
      assert.ok(output.includes(t('botCompatibility.unchecked', { count: 2, protocol: PROTOCOL_VERSION })));
    });
  }
});

test('failed start or restart never claims that a running server was checked for bot compatibility', async (context) => {
  const f = lifecycleFixture(context);
  f.state.exitCode = 1;
  await assert.rejects(startServerCommand(commandArgs(['start'], f.dataDir), []), /Failed to start/);
  await assert.rejects(restartServerCommand(commandArgs(['restart'], f.dataDir)), /Failed to restart/);
  assert.deepEqual(f.previewPorts, []);
  assert.ok(f.commands.every((args) => args[0] === 'startOrRestart'));
});

for (const exitCode of [0, 1]) {
  test(`update restart publishes a PID-bound intent before PM2 and cleans it (exit=${exitCode})`, async (context) => {
    const f = lifecycleFixture(context);
    f.state.entry = { pid: 24680, pm2_env: { status: 'online' } };
    f.state.exitCode = exitCode;
    const filename = path.join(f.dataDir, 'update-restart-intent.json');
    const run = processes.runSync;
    let observed = false;
    context.mock.method(processes, 'runSync', (...parameters: Parameters<typeof processes.runSync>) => {
      if (parameters[1]?.[0] === 'startOrRestart') {
        const intent: unknown = JSON.parse(fs.readFileSync(filename, 'utf8'));
        assert.ok(intent && typeof intent === 'object' && 'pid' in intent && 'expiresAt' in intent);
        assert.equal(intent.pid, 24680);
        assert.ok(typeof intent.expiresAt === 'number' && intent.expiresAt > Date.now());
        observed = true;
      }
      return run(...parameters);
    });
    const restart = restartServerCommand(commandArgs(['restart'], f.dataDir), ['--after-update']);
    if (exitCode === 0) await restart;
    else await assert.rejects(restart, /Failed to restart/);
    assert.equal(observed, true);
    assert.equal(fs.existsSync(filename), false);
  });
}

test('PM2 shutdown uses a portable IPC message and allows the WebSocket grace period', (context) => {
  const f = fixture(context);
  context.mock.method(health, 'resolveInterpreter', () => process.execPath);
  const ecosystem = pm2.generateEcosystem({ dataDir: f.root, port: 3200, serverName: 'Notice fixture' });
  assert.match(ecosystem, /shutdown_with_message:\s*true/);
  const timeout = ecosystem.match(/kill_timeout:\s*(\d+)/);
  assert.ok(timeout);
  assert.ok(Number(timeout[1]) > LIMITS.SHUTDOWN_GRACE_MS);
});

test('already-running start reports bot compatibility at the running port, not an unapplied override', async (context) => {
  const f = lifecycleFixture(context);
  f.state.entry = { pid: 123, pm2_env: { status: 'online' } };
  await startServerCommand(commandArgs(['start'], f.dataDir), ['--port', '4100']);
  assert.deepEqual(f.previewPorts, [3100]);
  assert.deepEqual(f.commands, []);
  assert.ok(f.output.join('\n').includes(t('botCompatibility.incompatible', { count: 1, protocol: PROTOCOL_VERSION })));
});

test('detailed status checks bot compatibility only for a process that is running with a PID', async (context) => {
  const f = lifecycleFixture(context);
  const states: Array<pm2.Pm2Process | null> = [
    null,
    { pid: 123, pm2_env: { status: 'stopped' } },
    { pid: 123, pm2_env: { status: 'errored' } },
    { pid: 0, pm2_env: { status: 'online' } },
  ];
  for (const entry of states) {
    f.state.entry = entry;
    await statusServerCommand(commandArgs(['status'], f.dataDir));
  }
  assert.deepEqual(f.previewPorts, []);
  f.state.entry = { pid: 123, pm2_env: { status: 'online' } };
  await statusServerCommand(commandArgs(['status'], f.dataDir));
  await statusServerCommand({ args: ['status'], dataDir: f.root, dataDirSpecified: false });
  assert.deepEqual(f.previewPorts, [3100, 3100]);
  assert.ok(f.output.join('\n').includes(t('botCompatibility.unchecked', { count: 2, protocol: PROTOCOL_VERSION })));
  assert.deepEqual(f.commands, []);
});

test('startup reports unavailable preview diagnostics explicitly instead of claiming bots are compatible', async (context) => {
  const f = lifecycleFixture(context);
  context.mock.method(onlineUsers, 'readLocalServerPreview', async () => null);
  await startServerCommand(commandArgs(['start'], f.dataDir), []);
  assert.ok(f.output.includes(t('botCompatibility.unavailable')));
  assert.ok(f.output.includes(t('lifecycle.started')));
});

test('the built CLI exits promptly with localized help, validation and stderr in isolated child processes', (context) => {
  const { root, profile } = fixture(context);
  const cli = path.join(__dirname, 'cli.js');
  const cases: { args: string[]; status: number; expected: RegExp; language: SupportedCliLanguage }[] = [
    { args: ['--help'], status: 0, expected: /USAGE/, language: 'en' },
    { args: ['members', '--help'], status: 0, expected: /USO/, language: 'pt-BR' },
    { args: ['--version'], status: 0, expected: /monky \d+\.\d+\.\d+/, language: 'en' },
    { args: ['unknown'], status: 1, expected: /Erro: Comando desconhecido: unknown/, language: 'pt-BR' },
    { args: ['start', '--port', '0'], status: 1, expected: /Error: Invalid value for port: 0/, language: 'en' },
  ];
  for (const entry of cases) {
    const result = spawnSync(process.execPath, [cli, '--lang', entry.language === 'en' ? 'en-US' : entry.language, ...entry.args], {
      cwd: root, env: { ...process.env }, encoding: 'utf8', timeout: 15_000, input: '',
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, entry.status, result.stderr);
    assert.match(stripVTControlCharacters(result.stdout + result.stderr), entry.expected);
    assert.doesNotMatch(result.stdout, /Select your language/);
    if (entry.status !== 0) assert.match(result.stderr, /monky --help/);
  }
  assert.equal(fs.existsSync(profile), false);
});
