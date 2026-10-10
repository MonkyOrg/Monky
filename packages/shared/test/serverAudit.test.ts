import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SERVER_AUDIT_ACTIONS, SERVER_AUDIT_ACTIVITY_ACTIONS, SERVER_AUDIT_CATEGORIES, SERVER_AUDIT_LIMITS, isServerAuditAction,
  serverAuditGetSchema, serverAuditPageSchema, type ServerAuditEntry,
} from '../src/serverAudit';
import { ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS, Permission, hasPermission, stripAdministrator } from '../src/permissions';
import { createProtocolOffer } from '../src/protocolCompatibility';
import { roleCreateSchema } from '../src/validators';

const entry = (id: number, overrides: Partial<ServerAuditEntry> = {}): ServerAuditEntry => ({
  id,
  createdAt: 1_700_000_000_000 + id,
  action: 'voice.move',
  actor: { type: 'user', id: 'admin', name: 'Admin' },
  target: { type: 'user', id: 'member', name: 'Member' },
  related: {
    from: { type: 'channel', id: 'lobby', name: 'Lobby' },
    to: { type: 'channel', id: 'stage', name: 'Stage' },
  },
  changes: [],
  detail: null,
  ...overrides,
});

test('viewing the audit log is its own permission, granted to administrators but not to managers', () => {
  assert.equal(Permission.VIEW_AUDIT_LOG, 1 << 20);
  assert.equal(hasPermission(DEFAULT_PERMISSIONS, Permission.VIEW_AUDIT_LOG), false);
  assert.equal(hasPermission(Permission.MANAGE_SERVER, Permission.VIEW_AUDIT_LOG), false);
  assert.equal(hasPermission(Permission.VIEW_SERVER_MONITOR, Permission.VIEW_AUDIT_LOG), false);
  assert.equal(hasPermission(Permission.VIEW_AUDIT_LOG, Permission.MANAGE_SERVER), false);
  assert.equal(hasPermission(ADMIN_PERMISSIONS, Permission.VIEW_AUDIT_LOG), true);
  const role = roleCreateSchema.parse({ name: 'Auditors', permissions: Permission.VIEW_AUDIT_LOG | Permission.ADMINISTRATOR });
  assert.equal(stripAdministrator(role.permissions), Permission.VIEW_AUDIT_LOG);
});

test('the audit log is a human-only negotiated feature', () => {
  assert.ok(createProtocolOffer('client').features.includes('server-audit'));
  assert.equal(createProtocolOffer('bot').features.includes('server-audit'), false);
});

test('every known action belongs to a filter category', () => {
  assert.ok(SERVER_AUDIT_ACTIVITY_ACTIONS.every(action => isServerAuditAction(action)));
  assert.ok(SERVER_AUDIT_LIMITS.MAX_ACTIVITY_ENTRIES < SERVER_AUDIT_LIMITS.MAX_ENTRIES, 'moderation always keeps a share');
  const categories = new Set<string>(SERVER_AUDIT_CATEGORIES);
  for (const [action, category] of Object.entries(SERVER_AUDIT_ACTIONS)) {
    assert.ok(categories.has(category), `${action} has an unknown category`);
    assert.match(action, /^[a-z]+(\.[a-z]+)+$/);
    assert.equal(isServerAuditAction(action), true);
  }
  assert.equal(isServerAuditAction('toString'), false);
  assert.equal(isServerAuditAction('channel.explode'), false);
});

test('requests are bounded, strict and never combine both directions', () => {
  assert.equal(serverAuditGetSchema.safeParse({ serverId: 's' }).success, true);
  assert.equal(serverAuditGetSchema.safeParse({ serverId: 's', before: 10, category: 'voice', query: ' Admin ' }).success, true);
  assert.equal(serverAuditGetSchema.parse({ serverId: 's', query: '  Admin ' }).query, 'Admin');
  for (const payload of [
    {}, { serverId: '' }, { serverId: 's', before: 1, after: 2 }, { serverId: 's', before: 0 },
    { serverId: 's', after: -1 }, { serverId: 's', category: 'everything' },
    { serverId: 's', limit: SERVER_AUDIT_LIMITS.MAX_PAGE_SIZE + 1 },
    { serverId: 's', query: 'x'.repeat(SERVER_AUDIT_LIMITS.MAX_QUERY_LENGTH + 1) },
    { serverId: 's', actorId: 'admin' },
  ]) {
    assert.equal(serverAuditGetSchema.safeParse(payload).success, false, JSON.stringify(payload));
  }
});

test('pages accept actions and fields from newer servers but reject malformed or unordered entries', () => {
  const page = { serverId: 's', entries: [entry(3), entry(2, { action: 'sticker.create' }), entry(1)], hasMore: false, retentionDays: 90 };
  assert.equal(serverAuditPageSchema.safeParse(page).success, true);
  assert.equal(serverAuditPageSchema.safeParse({ ...page, entries: [entry(1), entry(2)] }).success, false);
  assert.equal(serverAuditPageSchema.safeParse({ ...page, entries: [entry(2), entry(2)] }).success, false);
  const invalid: unknown[] = [
    { ...entry(1), action: 'Channel Create' },
    { ...entry(1), extra: true },
    { ...entry(1), changes: [{ field: 'name<script>', after: 'x' }] },
    { ...entry(1), changes: Array.from({ length: SERVER_AUDIT_LIMITS.MAX_CHANGES + 1 }, () => ({ field: 'name' })) },
    { ...entry(1), related: Object.fromEntries(Array.from({ length: SERVER_AUDIT_LIMITS.MAX_RELATED + 1 }, (_, index) =>
      [`ref${index}`, { type: 'user', id: `u${index}`, name: 'U' }])) },
    { ...entry(1), detail: 'x'.repeat(SERVER_AUDIT_LIMITS.MAX_DETAIL_LENGTH + 1) },
    { ...entry(1), target: { type: 'user', id: 'member', name: 'x'.repeat(SERVER_AUDIT_LIMITS.MAX_NAME_LENGTH + 1) } },
  ];
  for (const candidate of invalid) {
    assert.equal(serverAuditPageSchema.safeParse({ ...page, entries: [candidate] }).success, false, JSON.stringify(candidate).slice(0, 80));
  }
  const values = entry(1, { changes: [
    { field: 'name', before: 'old', after: 'new' }, { field: 'userLimit', before: 5, after: 10 },
    { field: 'private', before: false, after: true }, { field: 'password' },
    { field: 'permissionsGranted', after: ['MANAGE_CHANNELS'] }, { field: 'category', before: null, after: 'Voice' },
  ] });
  assert.equal(serverAuditPageSchema.safeParse({ ...page, entries: [values] }).success, true);
});
