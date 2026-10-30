const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const shared = require('@monky/shared');
const { loadMain, fakeIpcMain } = require('./mainModules.cjs');

test('calendar IPC validates sender and payload, persists ICS, handles cancel/failure and tears down', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-event-calendar-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const dialogs = [], warnings = [];
  const frame = {}, contents = { mainFrame: frame, isDestroyed: () => false };
  const window = { webContents: contents, isDestroyed: () => false };
  const event = { sender: contents, senderFrame: frame };
  let selection = { canceled: false, filePath: path.join(directory, 'event.ics') };
  let dialogGate;
  const globals = { console: { warn: (...args) => warnings.push(args) } };
  const { registerEventCalendarIpc } = loadMain('serverEventCalendarIpc', {
    globals,
    local: { i18n: { mt: key => key } },
    packages: { electron: {
      app: { getPath: () => directory },
      dialog: { showSaveDialog: async (_owner, options) => { dialogs.push(options); return dialogGate ? await dialogGate : selection; } },
    } },
  });
  const { IpcRegistry } = loadMain('ipc/registry', { globals });
  const ipc = fakeIpcMain();
  const handlers = ipc.handlers;
  const registry = new IpcRegistry(ipc, { main: () => contents, overlay: () => null });
  registerEventCalendarIpc(registry, window, () => 'sanitized.ics');
  const handler = handlers.get(shared.EVENT_CALENDAR_IPC);
  const startsAt = Date.parse('2026-10-01T10:00Z');
  const input = {
    serverId: 'server', serverName: 'Server', location: 'Voice',
    link: shared.createServerInviteLink({ v: 1, host: 'localhost', port: 3000, eventId: 'event' }),
    event: { id: 'event', creatorUserId: 'owner', title: 'Event', description: '', location: { kind: 'voice', channelId: 'voice' },
      startsAt, endsAt: null, anchorStartsAt: startsAt, timeZone: 'UTC', repeat: 'none', imageUrl: null, status: 'scheduled',
      revision: 0, occurrence: 0, createdAt: startsAt, startedAt: null, endedAt: null, interested: false, interestedCount: 0 },
  };
  for (const sender of [{ ...event, sender: {} }, { ...event, senderFrame: {} }]) {
    assert.equal((await handler(sender, input)).status, 'failed');
  }
  assert.equal((await handler(event, { ...input, extra: 'invalid' })).status, 'failed');
  assert.equal(dialogs.length, 0);
  assert.equal((await handler(event, input)).status, 'saved');
  assert.match(fs.readFileSync(selection.filePath, 'utf8'), /^BEGIN:VCALENDAR\r\n/);
  assert.equal(dialogs[0].defaultPath, path.join(directory, 'sanitized.ics'));
  assert.equal(dialogs[0].filters[0].extensions[0], 'ics');
  selection = { canceled: true };
  assert.equal((await handler(event, input)).status, 'cancelled');
  selection = { canceled: false, filePath: path.join(directory, 'missing', 'event.ics') };
  assert.equal((await handler(event, input)).error, 'calendar.failed');
  let release;
  dialogGate = new Promise(resolve => { release = resolve; });
  const pending = handler(event, input);
  assert.equal((await handler(event, input)).status, 'failed');
  registry.dispose();
  const discarded = path.join(directory, 'discarded.ics');
  release({ canceled: false, filePath: discarded });
  assert.equal((await pending).status, 'cancelled');
  assert.equal(fs.existsSync(discarded), false);
  assert.equal(handlers.size, 0);
  assert.ok(warnings.length >= 5);
});
