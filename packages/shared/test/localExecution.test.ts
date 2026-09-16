import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  localBotIdentitySchema,
  localExecutionSubjectSchema,
  localOperationSchema,
  localPermissionChangeSchema,
  localPermissionsFileSchema,
  localToolIdSchema,
  localTaskSpecSchema,
  localTaskResultSchema,
  localRuntimeSourceFailureSchema,
} from '../src/localExecution.js';

const bot = {
  serverOrigin: 'wss://example.test',
  serverId: 'server',
  serverName: 'Server',
  botId: 'bot',
  botName: 'Bot',
  botPublicKey: `302a300506032b6570032100${'AB'.repeat(32)}`,
};

test('local grants normalize origins and supported public key representations', () => {
  const parsed = localBotIdentitySchema.parse({ ...bot, serverOrigin: 'WSS://EXAMPLE.test:443/' });
  assert.equal(parsed.serverOrigin, 'wss://example.test');
  assert.equal(parsed.botPublicKey, bot.botPublicKey.toLowerCase());
  assert.equal(localBotIdentitySchema.safeParse({ ...bot, botPublicKey: 'ab'.repeat(32) }).success, true);
});

test('local subjects reject malformed, credentialed and non-server origins without throwing', () => {
  for (const origin of [
    '', 'not a URL', 'https://example.test', 'file:///etc/passwd', 'javascript:alert(1)',
    'wss://user:password@example.test', 'wss://example.test/private', 'wss://example.test?token=private',
    'wss://example.test#private', 'x'.repeat(4096),
  ]) {
    assert.equal(localBotIdentitySchema.safeParse({ ...bot, serverOrigin: origin }).success, false, origin);
  }
  assert.equal(localExecutionSubjectSchema.safeParse(bot).success, false);
  assert.equal(localExecutionSubjectSchema.safeParse({ ...bot, connectionId: 'connection' }).success, true);
  assert.equal(localExecutionSubjectSchema.safeParse({ ...bot, connectionId: 'connection', argv: ['--script'] }).success, false);
});

test('local capabilities expose fixed operations and tools, not arbitrary programs', () => {
  for (const operation of ['youtube.search', 'youtube.resolve', 'youtube.preview', 'youtube.stream']) {
    assert.equal(localOperationSchema.safeParse(operation).success, true);
  }
  for (const value of ['shell', 'node -e process.exit()', 'https://example.test/tool.exe', '..\\node.exe']) {
    assert.equal(localOperationSchema.safeParse(value).success, false);
    assert.equal(localToolIdSchema.safeParse(value).success, false);
  }
  assert.equal(localPermissionChangeSchema.safeParse({ permissionId: 'permission', enabled: true }).success, true);
  assert.equal(localPermissionChangeSchema.safeParse({ permissionId: 'permission', enabled: true, botToken: 'token' }).success, false);
});

test('temporary consent cannot be serialized as a persistent authorization', () => {
  const permission = {
    id: 'a'.repeat(64), bot, capability: 'youtube-audio', decision: 'always', updatedAt: Date.now(),
  };
  assert.equal(localPermissionsFileSchema.safeParse({ version: 1, permissions: [permission] }).success, true);
  assert.equal(localPermissionsFileSchema.safeParse({
    version: 1, permissions: [{ ...permission, decision: 'connection' }],
  }).success, false);
  assert.equal(localPermissionsFileSchema.safeParse({ version: 2, permissions: [] }).success, false);
});

test('task requests and replies carry public metadata, not arbitrary commands or private media URLs', () => {
  const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const track = { id: 'jNQXAC9IVRw', title: 'Reference', url, duration: 19 };
  assert.equal(localTaskSpecSchema.safeParse({ operation: 'youtube.stream', url }).success, true);
  assert.equal(localTaskSpecSchema.safeParse({
    operation: 'youtube.stream', url, cookies: 'browser-cookies',
  }).success, false);
  assert.equal(localTaskSpecSchema.safeParse({
    operation: 'youtube.resolve', url: 'https://example.test/file',
  }).success, false);
  assert.equal(localTaskResultSchema.safeParse({ operation: 'youtube.resolve', track }).success, true);
  assert.equal(localTaskResultSchema.safeParse({
    operation: 'youtube.resolve', track: { ...track, audioUrl: 'https://private.googlevideo.com/videoplayback' },
  }).success, false);
  assert.equal(localTaskResultSchema.safeParse({
    operation: 'youtube.resolve', track: { ...track, id: 'aaaaaaaaaaa' },
  }).success, false);
});

test('source failures preserve bounded recovery information without native diagnostics or private data', () => {
  assert.deepEqual(localRuntimeSourceFailureSchema.parse({ code: 'recovery_failed', attempts: 5 }),
    { code: 'recovery_failed', attempts: 5 });
  assert.equal(localRuntimeSourceFailureSchema.safeParse({ code: 'unavailable' }).success, true);
  for (const failure of [
    { code: 'recovery_failed', attempts: 0 }, { code: 'recovery_failed', attempts: 101 },
    { code: 'recovery_failed', attempts: 1.5 }, { code: 'recovery_failed' },
    { code: 'unavailable', message: 'Native diagnostic text' },
    { code: 'unavailable', audioUrl: 'https://example.test/private-audio' },
    { code: 'unknown' },
  ]) assert.equal(localRuntimeSourceFailureSchema.safeParse(failure).success, false);
});
