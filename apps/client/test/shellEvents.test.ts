import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { MessageType, Permission, type ServerDetails, type ServerSettingsUpdatedPayload, type UserSummary } from '@monky/shared';
import { appEvents } from '../src/renderer/core/EventBus';
import { chatMessageNotice } from '../src/renderer/core/chatNotificationPolicy';
import { syncSavedServer } from '../src/renderer/core/savedServerSync';
import { bindServerStateEvents, reconcileChannelAccess } from '../src/renderer/core/serverStateEvents';
import { sessionManager } from '../src/renderer/core/SessionManager';
import { routeSessionEvent } from '../src/renderer/core/sessionRouting';
import { connectionStore } from '../src/renderer/stores/connectionStore';
import { settingsStore, type ResolvedChatSoundMode } from '../src/renderer/stores/settingsStore';
import { voiceStore } from '../src/renderer/stores/voiceStore';

const SETTINGS_UPDATED = `message.${MessageType.SERVER_SETTINGS_UPDATED}` as const;
const user: UserSummary = { id: 'self', clientId: 'self-key', nickname: 'Self', status: 'ONLINE', joinedAt: 1 };

function details(name: string, channelIds: string[] = []): ServerDetails {
  return {
    id: `id-${name}`, name, createdAt: 1, maxUsers: 0, voiceMode: 'p2p', members: [user], voiceStates: {},
    channels: channelIds.map((id, position) => ({ id, name: id, type: 'TEXT', position, createdAt: 1 })),
  } as ServerDetails;
}

/** Two servers on the app's own session manager, the one the handlers read. */
function servers(context: TestContext) {
  sessionManager.install();
  const visible = sessionManager.create('visible.test', 5301, 'Self');
  const background = sessionManager.create('background.test', 5302, 'Self');
  sessionManager.activate(visible.key);
  context.mock.method(settingsStore, 'save', () => {});
  context.after(() => {
    voiceStore.reset();
    sessionManager.remove(visible.key);
    sessionManager.remove(background.key);
  });
  return { visible, background };
}

test('a chat message calls attention by the channel settings, the screen and whether it mentions', () => {
  const notice = (soundMode: ResolvedChatSoundMode, isMention: boolean, foreground: boolean, viewing: boolean) =>
    chatMessageNotice({ soundMode, isMention, foreground, viewing });
  assert.deepEqual(notice('all', false, true, false), { sound: true, unread: true, mention: null },
    'every message: the cue and the unread dot');
  assert.deepEqual(notice('all', false, true, true), { sound: true, unread: false, mention: null },
    'the conversation on screen gets the cue but no dot');
  assert.deepEqual(notice('all', false, false, false), { sound: false, unread: true, mention: null },
    'a server in the background marks the dot without a cue (#400)');
  assert.deepEqual(notice('mentions', false, true, false), { sound: false, unread: false, mention: null },
    'mentions only: an ordinary message stays quiet');
  assert.deepEqual(notice('mentions', true, true, false), { sound: true, unread: true, mention: 'badge' },
    'a mention not seen keeps the @-badge');
  assert.deepEqual(notice('mentions', true, true, true), { sound: true, unread: false, mention: 'read' },
    'a mention seen live is read on the server at once (#14)');
  assert.deepEqual(notice('none', true, true, false), { sound: false, unread: false, mention: 'badge' },
    'a silenced channel still shows that it mentions the member');
});

test('an access change drops unreadable channels from the chat and finishes commands where the member can no longer act', (context) => {
  const { visible } = servers(context);
  visible.serverStore.setServerDetails(details('Visible', ['hidden', 'silenced', 'no-bots', 'open']), user);
  const denied: Record<string, number> = {
    hidden: Permission.READ_MESSAGES, silenced: Permission.SEND_MESSAGES, 'no-bots': Permission.USE_BOT_COMMANDS,
  };
  context.mock.method(visible.serverStore, 'hasPermission', (permission: number, channelId?: string) =>
    !channelId || denied[channelId] !== permission);
  const revoked: string[] = [];
  const finished: string[] = [];
  context.mock.method(visible.chatStore, 'revokeChannel', (channelId: string) => { revoked.push(channelId); });
  context.mock.method(visible.chatStore, 'finishChannelInvocations', (channelId: string) => { finished.push(channelId); });

  reconcileChannelAccess(['open', 'silenced']);
  assert.deepEqual([revoked, finished], [[], ['silenced']], 'only the channels named are checked');
  finished.length = 0;
  reconcileChannelAccess();
  assert.deepEqual(revoked, ['hidden'], 'a channel that can no longer be read leaves the chat');
  assert.deepEqual(finished, ['silenced', 'no-bots'], 'commands end where the member can no longer write or use bots');
});

test('a server renamed in the background renames its saved entry, and the same settings again redraw nothing', (context) => {
  const { background } = servers(context);
  const savedBefore = connectionStore.savedServers;
  context.after(() => { connectionStore.savedServers = savedBefore; });
  connectionStore.savedServers = [{ host: 'background.test', port: 5302, name: 'Old name', lastConnected: 1 }];
  background.serverStore.setServerDetails(details('Old name'), user);
  const settingsSeen: string[] = [];
  let railRedraws = 0;
  const off = [
    bindServerStateEvents({ reconnect: { settingsUpdated: (sessionKey) => { settingsSeen.push(sessionKey); } } }),
    appEvents.on('connection.saved_servers_changed', () => { railRedraws++; }),
  ];
  context.after(() => off.forEach(unbind => unbind()));
  const update: ServerSettingsUpdatedPayload = { name: 'New name', hasPassword: true, iconUrl: null };
  const deliver = () => routeSessionEvent(background.key, SETTINGS_UPDATED, () => appEvents.emit(SETTINGS_UPDATED, update));

  deliver();
  assert.equal(background.serverStore.serverDetails?.name, 'New name', 'the settings land on the server that sent them');
  assert.equal(background.serverStore.serverDetails?.hasPassword, true);
  assert.equal(connectionStore.findSavedServer({ host: 'background.test', port: 5302 })?.name, 'New name',
    'the rail and Home read the new name from the saved entry (#85)');
  assert.deepEqual(settingsSeen, [background.key], 'the voice mode reconnection hears which server changed');
  assert.equal(railRedraws, 1);
  deliver();
  assert.equal(railRedraws, 1, 'an update that changes nothing on the saved entry does not redraw the rail');
});

test('a sign-in keeps the saved entry and the hosted server list in step with the server', (context) => {
  const savedBefore = connectionStore.savedServers;
  const createdBefore = connectionStore.createdServers;
  context.after(() => {
    connectionStore.savedServers = savedBefore;
    connectionStore.createdServers = createdBefore;
  });
  connectionStore.savedServers = [{ host: '127.0.0.1', port: 5303, name: 'Mine', lastConnected: 1, iconUrl: 'http://127.0.0.1:5303/avatars/old.png' }];
  connectionStore.createdServers = [{ id: 'created', name: 'Mine', port: 5303, voiceChannel: 'Geral', textChannel: 'geral', createdAt: 1, lastStarted: 1 }];

  syncSavedServer({ host: '127.0.0.1', port: 5303 }, { name: 'Renamed', iconUrl: '/avatars/new.png' });
  const entry = connectionStore.findSavedServer({ host: '127.0.0.1', port: 5303 });
  assert.equal(entry?.name, 'Renamed');
  assert.equal(entry?.iconUrl, 'http://127.0.0.1:5303/avatars/new.png', 'the icon is kept as an address the rail can load offline');
  assert.equal(connectionStore.createdServers[0].name, 'Renamed', 'a server hosted here is renamed in "Meus Servidores" too');
  syncSavedServer({ host: '127.0.0.1', port: 5303 }, { name: 'Renamed', iconUrl: null });
  assert.equal(connectionStore.findSavedServer({ host: '127.0.0.1', port: 5303 })?.iconUrl, undefined,
    'an icon the server removed leaves the saved entry');
});
