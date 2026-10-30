const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { stripVTControlCharacters } = require('node:util');
const { LIMITS, Permission } = require('@monky/shared');
const { runCommand } = require('../dist/cli');
const { readLocalConfig, withContext } = require('../dist/cli/context');
const { PERMISSION_OPTIONS } = require('../dist/cli/constants');
const { parsePermissionNames, parsePort } = require('../dist/cli/formatters');
const pm2 = require('../dist/cli/pm2');
const processHelpers = require('../dist/cli/process');
const prompts = require('../dist/cli/prompts');
const targets = require('../dist/cli/target');
const { getCliLanguage, setCliLanguage, t: translate } = require('../dist/cli/i18n');
const { Logger } = require('../dist/infrastructure/logger/Logger');
const { customRoleRecord, parseNewRole, roleNameProblem } = require('../dist/domain/roles');
const { normalizeServerName, planServerSettingsUpdate } = require('../dist/domain/serverSettings');

/**
 * A stopped server with `members` registered members, reached by the CLI the
 * way an operator reaches it: no PM2, no external process.
 */
async function stoppedServer(t, { members = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-rules-'));
  const dataDir = path.join(root, 'server data');
  const previousHome = process.env.MONKY_HOME;
  const previousLanguage = getCliLanguage();
  process.env.MONKY_HOME = path.join(root, 'cli profile');
  setCliLanguage('en');
  t.after(() => {
    if (previousHome === undefined) delete process.env.MONKY_HOME;
    else process.env.MONKY_HOME = previousHome;
    setCliLanguage(previousLanguage);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  const output = [];
  t.mock.method(console, 'log', (...values) => output.push(stripVTControlCharacters(values.map(String).join(' '))));
  t.mock.method(Logger, 'info', () => {});
  t.mock.method(processHelpers, 'runSync', (command) => assert.fail(`Unexpected external process: ${command}`));
  t.mock.method(pm2, 'listPm2Processes', () => []);
  t.mock.method(pm2, 'findPm2Process', () => null);
  t.mock.method(pm2, 'findLegacyProcessFor', () => null);
  await withContext(dataDir, async (ctx) => {
    for (let index = 0; index < members; index++) {
      await ctx.userRepo.create({
        id: `member-${index}`, clientId: String(index).padStart(32, '0'), publicKey: null,
        nickname: `Member ${index}`, avatarPath: null, createdAt: 1, lastSeenAt: 1,
      });
    }
  });
  const server = { id: 'fixture', dataDir, name: 'Fixture', port: 3000, createdAt: 1 };
  t.mock.method(targets, 'resolveTargetServer', async () => server);
  const run = (...args) => runCommand({ args, dataDir, dataDirSpecified: true });
  const read = (fn) => withContext(dataDir, fn, false, { readOnly: true });
  return { dataDir, output, run, read };
}

test('server settings follow one rule set, whichever way they arrive', () => {
  const current = { maxAttachmentFileBytes: null, maxAttachmentStorageBytes: 1000, voiceMode: 'p2p', turnEnabled: false };
  assert.deepEqual(planServerSettingsUpdate(current, { maxAttachmentFileBytes: 2000 }, 0),
    { ok: false, problem: { code: 'attachment-file-over-total', fileBytes: 2000, totalBytes: 1000 } });
  assert.deepEqual(planServerSettingsUpdate(current, { maxAttachmentFileBytes: 999.9 }, 0),
    { ok: true, updates: { maxAttachmentFileBytes: 999 } });
  assert.deepEqual(planServerSettingsUpdate(current, { allowSoundboard: false }, 0),
    { ok: true, updates: { allowSoundboard: false, recentSoundCacheEnabled: false } });
  assert.deepEqual(planServerSettingsUpdate(current, { maxUsers: 2 }, 3),
    { ok: false, problem: { code: 'members-over-limit', memberCount: 3 } });
  assert.deepEqual(planServerSettingsUpdate(current, { maxUsers: LIMITS.MAX_USERS_UNLIMITED }, 3),
    { ok: true, updates: { maxUsers: LIMITS.MAX_USERS_UNLIMITED } });
  assert.deepEqual(planServerSettingsUpdate({ ...current, voiceMode: 'sfu' }, { turnEnabled: true }, 0),
    { ok: false, problem: { code: 'turn-in-sfu' } });
  assert.deepEqual(planServerSettingsUpdate({ ...current, turnEnabled: true }, { voiceMode: 'sfu' }, 0),
    { ok: true, updates: { voiceMode: 'sfu', turnEnabled: false } });
  assert.deepEqual(planServerSettingsUpdate(current, { name: ' x ' }, 0), { ok: true, updates: {} },
    'a name too short to be one is left alone over the wire');
  assert.equal(normalizeServerName('  Friends  '), 'Friends');
  assert.equal(normalizeServerName(' x '), null);
});

test('config set refuses a per-file attachment limit above the total, like the app', async (t) => {
  const f = await stoppedServer(t);
  // The default per-file limit (50 MB) is above a 1000-byte total, so the total alone is refused too.
  await assert.rejects(f.run('config', 'set', 'maxAttachmentStorageBytes', '1000'), {
    message: translate('config.attachmentFileOverTotal', { file: LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT, total: 1000 }),
  });
  await f.run('config', 'set', 'maxAttachmentFileBytes', '500');
  await f.run('config', 'set', 'maxAttachmentStorageBytes', '1000');
  await assert.rejects(f.run('config', 'set', 'maxAttachmentFileBytes', '2000'),
    { message: translate('config.attachmentFileOverTotal', { file: 2000, total: 1000 }) });
  const server = await f.read((ctx) => ctx.serverRepo.getServer());
  assert.equal(server.maxAttachmentStorageBytes, 1000);
  assert.equal(server.maxAttachmentFileBytes, 500, 'nothing was written by the refused change');
  await f.run('config', 'set', 'maxAttachmentFileBytes', '1000');
  assert.equal((await f.read((ctx) => ctx.serverRepo.getServer())).maxAttachmentFileBytes, 1000);
});

test('turning the soundboard off from the CLI also turns the recent sounds cache off', async (t) => {
  const f = await stoppedServer(t);
  await withContext(f.dataDir, (ctx) => ctx.serverRepo.updateServer({ recentSoundCacheEnabled: true }), false);
  await f.run('config', 'set', 'allowSoundboard', 'false');
  const server = await f.read((ctx) => ctx.serverRepo.getServer());
  assert.equal(server.allowSoundboard, false);
  assert.equal(server.recentSoundCacheEnabled, false);
});

test('the member limit and the server name keep their rules through the shared plan', async (t) => {
  const f = await stoppedServer(t, { members: 3 });
  await assert.rejects(f.run('config', 'set', 'maxUsers', '2'), { message: translate('config.tooManyMembers', { count: 3 }) });
  await f.run('config', 'set', 'maxUsers', '5');
  await assert.rejects(f.run('config', 'set', 'name', ' x '), { message: translate('config.nameTooShort') });
  await f.run('config', 'set', 'name', '  Friends  ');
  const server = await f.read((ctx) => ctx.serverRepo.getServer());
  assert.equal(server.maxUsers, 5);
  assert.equal(server.name, 'Friends');
});

test('ports follow the protocol range: start, create and config set refuse what the server cannot listen on', async (t) => {
  const f = await stoppedServer(t);
  for (const value of ['0', '80', '1023', '65536', '70000', '3000abc', '']) {
    assert.throws(() => parsePort(value), { message: translate('validation.port', { value, min: LIMITS.MIN_PORT, max: LIMITS.MAX_PORT }) });
  }
  assert.equal(parsePort(' 1024 '), 1024);
  assert.equal(parsePort('65535'), 65535);
  await assert.rejects(f.run('config', 'set', 'port', '70000'), { message: /Invalid value for port: 70000/ });
  assert.equal(readLocalConfig(f.dataDir).port, undefined, 'the refused port is not saved');
  await assert.rejects(f.run('start', '--port', '80'), { message: /Invalid value for port: 80/ });
});

test('roles are created by the server rules: no ADMINISTRATOR, no second Admin, at most 32 characters', async (t) => {
  assert.equal(PERMISSION_OPTIONS.some((entry) => entry.name === 'ADMINISTRATOR'), false, 'ADMINISTRATOR is not offered');
  for (const token of ['ADMINISTRATOR', 'administrator', 'Administrator']) {
    assert.throws(() => parsePermissionNames(`SPEAK,${token}`), { message: translate('validation.administratorPermission') });
  }
  assert.deepEqual(roleNameProblem('admin'), { code: 'reserved-name' });
  assert.equal(roleNameProblem('M'), null, 'a one-letter name is valid, as in the app');
  assert.equal(roleNameProblem('x'.repeat(33))?.field, 'name');
  const parsed = parseNewRole({ name: 'Mods', permissions: Permission.ADMINISTRATOR | Permission.SPEAK });
  assert.equal(parsed.ok, true);
  assert.equal(customRoleRecord(parsed.role, parsed.role.permissions, 'id', 1).permissions, Permission.SPEAK,
    'ADMINISTRATOR never reaches a custom role');

  const f = await stoppedServer(t);
  t.mock.method(prompts, 'askMultiChoice', async (_question, choices) => {
    assert.equal(choices.some((choice) => choice.includes('ADMINISTRATOR')), false);
    return [];
  });
  await assert.rejects(f.run('roles', 'create', 'Admin', ''), { message: translate('roles.nameReserved', { name: 'Admin' }) });
  await assert.rejects(f.run('roles', 'create', 'x'.repeat(33), ''), { message: translate('roles.nameInvalid') });
  await assert.rejects(f.run('roles', 'create', 'Mods', '', 'SPEAK,ADMINISTRATOR'),
    { message: translate('validation.administratorPermission') });
  await f.run('roles', 'create', 'M', '#ff0000');
  await f.run('roles', 'create', 'Speakers', '', 'SPEAK');
  const roles = await f.read((ctx) => ctx.roleRepo.listAll());
  assert.equal(roles.filter((role) => role.name.toLowerCase() === 'admin').length, 1, 'only the built-in Admin exists');
  assert.deepEqual(roles.filter((role) => ['M', 'Speakers'].includes(role.name))
    .map((role) => [role.name, role.color, role.permissions]).sort(),
  [['M', '#ff0000', 0], ['Speakers', null, Permission.SPEAK]]);
});
