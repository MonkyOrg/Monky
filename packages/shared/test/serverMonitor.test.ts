import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SERVER_MONITOR_LIMITS, serverMonitorGetSchema, serverMonitorSnapshotSchema,
  type ServerMonitorSnapshotPayload,
} from '../src/serverMonitor';
import { ADMIN_PERMISSIONS, DEFAULT_PERMISSIONS, Permission, hasPermission, stripAdministrator } from '../src/permissions';
import { roleCreateSchema, roleUpdateSchema } from '../src/validators';

const snapshot: ServerMonitorSnapshotPayload = {
  serverId: 'server-a',
  stats: {
    serverName: 'Server A', port: 3000, startedAt: 1000, uptimeMs: 10,
    onlineUsers: 2, members: 3, channels: 2, messages: 5, maxUsers: 20,
  },
  entries: [{
    sequence: 1, timestamp: '2026-09-14T13:00:00.000Z', level: 'INFO', category: 'NETWORK',
    message: 'New client connection.',
  }],
  cursor: 1,
  dropped: 0,
};

test('viewing is an independent explicit permission while administrators and owners retain access', () => {
  assert.equal(Permission.VIEW_SERVER_MONITOR, 1 << 16);
  assert.equal(hasPermission(DEFAULT_PERMISSIONS, Permission.VIEW_SERVER_MONITOR), false);
  assert.equal(hasPermission(Permission.MANAGE_SERVER, Permission.VIEW_SERVER_MONITOR), false);
  assert.equal(hasPermission(Permission.VIEW_SERVER_MONITOR, Permission.MANAGE_SERVER), false);
  assert.equal(hasPermission(Permission.VIEW_SERVER_MONITOR, Permission.MANAGE_ROLES), false);
  assert.equal(hasPermission(Permission.ADMINISTRATOR, Permission.VIEW_SERVER_MONITOR), true);
  assert.equal(hasPermission(ADMIN_PERMISSIONS, Permission.VIEW_SERVER_MONITOR), true);
});

test('actual role create/update validators and administrator normalization preserve monitor viewing', () => {
  const created = roleCreateSchema.parse({
    name: 'Monitor readers', permissions: Permission.VIEW_SERVER_MONITOR | Permission.ADMINISTRATOR,
  });
  assert.equal(stripAdministrator(created.permissions), Permission.VIEW_SERVER_MONITOR);
  const updated = roleUpdateSchema.parse({ roleId: 'readers', permissions: Permission.VIEW_SERVER_MONITOR });
  assert.equal(updated.permissions, Permission.VIEW_SERVER_MONITOR);
  assert.equal(roleUpdateSchema.parse({ roleId: 'readers', permissions: 0 }).permissions, 0);
});

test('requests require a bounded server binding and safe integer cursor, never caller-supplied authorization', () => {
  assert.deepEqual(serverMonitorGetSchema.parse({ serverId: 'server-a' }), { serverId: 'server-a' });
  assert.equal(serverMonitorGetSchema.safeParse({ serverId: 'server-a', cursor: 0 }).success, true);
  for (const payload of [
    {}, { serverId: '' }, { serverId: 'x'.repeat(129) },
    { serverId: 'server-a', cursor: -1 }, { serverId: 'server-a', cursor: 0.5 },
    { serverId: 'server-a', cursor: Number.MAX_SAFE_INTEGER + 1 },
    { serverId: 'server-a', cursor: Infinity }, { serverId: 'server-a', cursor: '1' },
    { serverId: 'server-a', userId: 'owner' }, { serverId: 'server-a', permissions: ADMIN_PERMISSIONS },
  ]) assert.equal(serverMonitorGetSchema.safeParse(payload).success, false);
});

test('remote snapshots expose an explicit metrics allowlist and reject private host fields or log metadata', () => {
  assert.deepEqual(serverMonitorSnapshotSchema.parse(snapshot), snapshot);
  for (const payload of [
    { ...snapshot, stats: { ...snapshot.stats, dataDir: 'private/path' } },
    { ...snapshot, stats: { ...snapshot.stats, token: 'private-token' } },
    { ...snapshot, entries: [{ ...snapshot.entries[0], payload: { privateText: 'hidden' } }] },
    { ...snapshot, process: { credentials: 'hidden' } },
  ]) assert.equal(serverMonitorSnapshotSchema.safeParse(payload).success, false);
});

test('snapshot delivery is bounded, ordered and cannot move a cursor behind its entries', () => {
  const bounded = {
    ...snapshot, cursor: SERVER_MONITOR_LIMITS.MAX_BATCH_ENTRIES,
    entries: Array.from({ length: SERVER_MONITOR_LIMITS.MAX_BATCH_ENTRIES }, (_, index) => ({
      ...snapshot.entries[0], sequence: index + 1,
    })),
  };
  assert.equal(serverMonitorSnapshotSchema.safeParse(bounded).success, true);
  assert.equal(serverMonitorSnapshotSchema.safeParse({ ...snapshot, entries: [], cursor: 0 }).success, true);
  for (const payload of [
    { ...bounded, entries: [...bounded.entries, { ...snapshot.entries[0], sequence: bounded.cursor + 1 }] },
    { ...snapshot, entries: [{ ...snapshot.entries[0], message: 'x'.repeat(SERVER_MONITOR_LIMITS.MAX_MESSAGE_LENGTH + 1) }] },
    { ...snapshot, entries: [{ ...snapshot.entries[0], timestamp: `2026-09-14T13:00:00.${'0'.repeat(2000)}Z` }] },
    { ...snapshot, entries: [{ ...snapshot.entries[0], sequence: 0 }], cursor: 0 },
    { ...snapshot, entries: [{ ...snapshot.entries[0], sequence: 2 }] },
    { ...snapshot, entries: [snapshot.entries[0], snapshot.entries[0]] },
    { ...bounded, entries: [...bounded.entries].reverse() },
    { ...snapshot, dropped: -1 },
    { ...snapshot, stats: { ...snapshot.stats, members: -1 } },
    { ...snapshot, stats: { ...snapshot.stats, port: 65536 } },
  ]) assert.equal(serverMonitorSnapshotSchema.safeParse(payload).success, false);
});
