import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MessageType, Permission, ProtocolErrorCode, hasPermission,
  type ServerAuditEntry, type ServerAuditGetPayload, type ServerAuditPagePayload,
} from '@monky/shared';
import { ProtocolRequestError } from '../src/renderer/core/NetworkClient';
import {
  ServerAuditError, ServerAuditSource, canOpenServerAudit, endsServerAudit,
} from '../src/renderer/core/ServerAuditSource';
import { setLanguage, t } from '../src/renderer/i18n';
import { formatAuditEntry, formatAuditValue } from '../src/renderer/views/serverAuditFormat';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const entry = (id: number, overrides: Partial<ServerAuditEntry> = {}): ServerAuditEntry => ({
  id, createdAt: 1_700_000_000_000, action: 'channel.create',
  actor: { type: 'user', id: 'admin', name: 'Admin' }, target: { type: 'channel', id: 'c', name: 'general' },
  related: {}, changes: [], detail: null, ...overrides,
});
const page = (entries: ServerAuditEntry[], serverId = 'server-a'): ServerAuditPagePayload =>
  ({ serverId, entries, hasMore: false, retentionDays: 90 });

function fixture() {
  let status: ReturnType<ConstructorParameters<typeof ServerAuditSource>[0]['getStatus']> = 'CONNECTED';
  let allowed = Permission.VIEW_AUDIT_LOG;
  let active = true;
  const store = {
    serverDetails: { id: 'server-a', protocol: { version: 38, minimumVersion: 35, features: ['server-audit'] } },
    currentUser: { id: 'auditor', sessionId: 'auditor:device', isBot: false },
    hasPermission: (permission: Permission) => hasPermission(allowed, permission),
  };
  const requests: Array<{ type: MessageType; payload: ServerAuditGetPayload; id: string; result: ReturnType<typeof deferred<unknown>> }> = [];
  const cancelled: string[] = [];
  const client: ConstructorParameters<typeof ServerAuditSource>[0] = {
    getStatus: () => status,
    getConnectionId: () => 'socket-a',
    sendRequest: (type, payload, id) => {
      const result = deferred<unknown>();
      requests.push({ type, payload, id, result });
      return result.promise;
    },
    cancelRequest: (id) => { cancelled.push(id); return true; },
  };
  return {
    store, requests, cancelled,
    source: () => new ServerAuditSource(client, store, () => active),
    permission: (bits: number) => { allowed = bits; },
    disconnect: () => { status = 'RECONNECTING'; },
    switchServer: () => { active = false; },
  };
}

test('the menu offers the audit log only to connected humans with the permission on servers that have it', () => {
  const f = fixture();
  assert.equal(canOpenServerAudit(f.store, true), true);
  assert.equal(canOpenServerAudit(f.store, false), false);
  f.permission(Permission.MANAGE_SERVER | Permission.VIEW_SERVER_MONITOR);
  assert.equal(canOpenServerAudit(f.store, true), false);
  f.permission(Permission.ADMINISTRATOR);
  assert.equal(canOpenServerAudit(f.store, true), true);
  assert.equal(canOpenServerAudit({ ...f.store, currentUser: { ...f.store.currentUser, isBot: true } }, true), false);
  assert.equal(canOpenServerAudit({ ...f.store, serverDetails: { id: 'old', protocol: { version: 38, minimumVersion: 35, features: [] } } }, true), false);
});

test('reads are bound to the server, validated and always retired', async () => {
  const f = fixture();
  const source = f.source();
  const reading = source.read({ category: 'voice', query: 'ana' });
  assert.equal(f.requests[0].type, MessageType.SERVER_AUDIT_GET);
  assert.deepEqual(f.requests[0].payload, { category: 'voice', query: 'ana', serverId: 'server-a' });
  f.requests[0].result.resolve(page([entry(2), entry(1)]));
  assert.deepEqual((await reading).entries.map(item => item.id), [2, 1]);
  assert.ok(f.cancelled.includes(f.requests[0].id), 'completed requests are retired so late frames are dropped');

  for (const [query, response] of [
    [{}, page([entry(1)], 'server-b')],
    [{ before: 5 }, page([entry(5)])],
    [{ after: 5 }, page([entry(6), entry(5)])],
    [{}, { serverId: 'server-a', entries: [{ ...entry(1), extra: true }], hasMore: false, retentionDays: 90 }],
  ] as const) {
    const pending = source.read(query);
    f.requests.at(-1)?.result.resolve(response);
    await assert.rejects(pending, (error: unknown) => error instanceof ServerAuditError && error.reason === 'invalidResponse');
  }
});

test('losing access ends the view, before or after the server answers', async () => {
  const f = fixture();
  const source = f.source();
  const denied = source.read();
  f.requests[0].result.reject(new ProtocolRequestError('no', ProtocolErrorCode.PERMISSION_DENIED));
  await assert.rejects(denied, (error: unknown) => error instanceof ServerAuditError && error.reason === 'permissionDenied');
  const outdated = source.read();
  f.requests[1].result.reject(new ProtocolRequestError('old', ProtocolErrorCode.FEATURE_REQUIRES_UPDATE));
  await assert.rejects(outdated, (error: unknown) => error instanceof ServerAuditError && error.reason === 'updateRequired');

  const revoked = source.read();
  f.permission(0);
  f.requests[2].result.resolve(page([entry(1)]));
  await assert.rejects(revoked, (error: unknown) => error instanceof ServerAuditError && error.reason === 'permissionDenied');
  await assert.rejects(source.read(), ServerAuditError);
  f.permission(Permission.VIEW_AUDIT_LOG);
  f.disconnect();
  assert.throws(() => source.assertCurrent(), (error: unknown) => error instanceof ServerAuditError && error.reason === 'disconnected');
  assert.equal(endsServerAudit(new ServerAuditError('disconnected')), true);
  assert.equal(endsServerAudit(new ServerAuditError('invalidResponse')), false);
  assert.equal(endsServerAudit(new Error('timeout')), false);

  const g = fixture();
  const other = g.source();
  const pending = other.read();
  g.switchServer();
  other.dispose();
  assert.ok(g.cancelled.includes(g.requests[0].id), 'closing cancels what is still pending');
  assert.throws(() => other.assertCurrent(), DOMException);
});

test('entries read as localized sentences with every name escaped', () => {
  setLanguage('pt-BR');
  const move = formatAuditEntry(entry(1, {
    action: 'voice.move',
    actor: { type: 'user', id: 'a', name: '<img src=x onerror=alert(1)>' },
    target: { type: 'user', id: 'm', name: 'Ana & Bia' },
    related: {
      from: { type: 'channel', id: 'l', name: 'Lobby' }, to: { type: 'channel', id: 's', name: 'Palco' },
      invoker: { type: 'user', id: 'x', name: 'Zé' },
    },
  }));
  assert.equal(move.icon, 'graphic_eq');
  assert.equal(move.summary.includes('<img'), false);
  assert.ok(move.summary.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(move.summary.includes('<strong>Ana &amp; Bia</strong>'));
  assert.ok(move.summary.includes('<strong>Lobby</strong>') && move.summary.includes('<strong>Palco</strong>'));
  assert.deepEqual(move.related, [{ label: t('serverAudit.related.invoker'), name: 'Zé' }],
    'related items the sentence does not mention are listed beside it');

  const role = formatAuditEntry(entry(2, {
    action: 'role.update', target: { type: 'role', id: 'r', name: 'Mods' },
    changes: [
      { field: 'permissionsGranted', after: ['KICK_MEMBERS', 'VIEW_AUDIT_LOG'] },
      { field: 'name', before: 'Old', after: 'Mods' },
      { field: 'password' },
      { field: 'futureField', after: true },
    ],
  }));
  assert.deepEqual(role.changes, [
    { label: t('serverAudit.field.permissionsGranted'), before: undefined,
      after: `${t('permissions.kickMembers')}, ${t('permissions.viewAuditLog')}`, changedOnly: false },
    { label: t('serverAudit.field.name'), before: 'Old', after: 'Mods', changedOnly: false },
    { label: t('serverAudit.field.password'), before: undefined, after: undefined, changedOnly: true },
    { label: 'futureField', before: undefined, after: t('serverAudit.yes'), changedOnly: false },
  ]);

  setLanguage('en');
  const unknown = formatAuditEntry(entry(3, { action: 'sticker.create', actor: null }));
  assert.equal(unknown.icon, 'history');
  assert.ok(unknown.summary.startsWith(`<strong>${t('serverAudit.system')}</strong>`));
  assert.ok(unknown.summary.includes('sticker.create'));
  const removed = formatAuditEntry(entry(4, { action: 'voice.disconnect', related: {} }));
  assert.ok(removed.summary.includes(t('serverAudit.removed')));
  assert.equal(formatAuditValue('repeat', 'weekly'), t('community.weekly'));
  assert.equal(formatAuditValue('type', 'VOICE'), t('serverAudit.channelType.VOICE'));
  assert.equal(formatAuditValue('maxFileSize', 1536), '1.5 KB');
  assert.equal(formatAuditValue('category', null), '—');
  assert.equal(formatAuditValue('capabilitiesGranted', ['commands']), t('botPermissions.commands.title'));
  setLanguage('pt-BR');
});
