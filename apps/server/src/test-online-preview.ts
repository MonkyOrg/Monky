import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { UserSummary, VoiceParticipantState } from '@monky/shared';
import { MonkyServer } from './server';
import { WebSocketServer } from './infrastructure/websocket/WebSocketServer';
import { LanBroadcaster } from './infrastructure/discovery/LanBroadcaster';
import { countOnlineUsers, countVoiceUsers } from './cli/onlineUsers';
import { SignalingService } from './application/services/SignalingService';

test('homepage preview, monitor stats and CLI restart checks count humans rather than bots', async (t) => {
  const probe = http.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-online-preview-'));
  let server: MonkyServer | undefined;
  t.after(async () => {
    try {
      await server?.stop();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  const alice: UserSummary = { id: 'alice', clientId: 'identity', nickname: 'Alice', status: 'ONLINE', joinedAt: 1 };
  const bot: UserSummary = { ...alice, id: 'bot', nickname: 'Not a person', isBot: true };
  const online = new Map<string, { user: UserSummary }>([
    ['alice:one', { user: alice }], ['alice:two', { user: alice }], ['bot:one', { user: bot }],
  ]);
  t.mock.method(WebSocketServer.prototype, 'getOnlineUsersMap', () => online);
  const voiceStates: Record<string, VoiceParticipantState> = {};
  t.mock.method(SignalingService.prototype, 'getAllVoiceStates', () => voiceStates);
  t.mock.method(LanBroadcaster.prototype, 'start', async () => {});
  server = await MonkyServer.create({ port: address.port, dataDir, voiceMode: 'p2p', discoveryPort: 0 });
  await server.start();
  const preview = async () => {
    const response = await fetch(`http://127.0.0.1:${address.port}/preview`);
    assert.equal(response.status, 200);
    const result: unknown = await response.json();
    assert.ok(result && typeof result === 'object' && 'userCount' in result && 'users' in result &&
      'voiceUserCount' in result && 'voiceUsers' in result);
    return result;
  };
  assert.equal((await preview()).userCount, 1);
  assert.deepEqual((await preview()).users, [{ nickname: 'Alice', avatarUrl: null }]);
  assert.equal((await server.getStats()).onlineUsers, 1);
  assert.equal(await countOnlineUsers(address.port), 1);
  assert.equal(await countVoiceUsers(address.port), 0, 'online without voice is not an interrupted call');
  assert.equal((await preview()).voiceUserCount, 0);
  const voice = (sessionId: string, userId: string): VoiceParticipantState => ({
    sessionId, userId, channelId: 'voice-channel', isMuted: false, isDeafened: false,
    isSpeaking: false, isCameraOn: false, isScreenSharing: false, isSharingScreenAudio: false,
    serverMuted: false, serverDeafened: false,
  });
  voiceStates['alice:two'] = voice('alice:two', alice.id);
  voiceStates['bot:one'] = voice('bot:one', bot.id);
  assert.equal(await countVoiceUsers(address.port), 1);
  assert.deepEqual((await preview()).voiceUsers, [{ nickname: 'Alice', avatarUrl: null }]);
  voiceStates['alice:one'] = voice('alice:one', alice.id);
  assert.equal(await countVoiceUsers(address.port), 1, 'two devices count as one affected person');
  delete voiceStates['alice:two'];
  assert.equal(await countVoiceUsers(address.port), 1);
  alice.invisible = true;
  assert.deepEqual((await preview()).users, [], 'public previews must not expose invisible identities');
  assert.equal(await countOnlineUsers(address.port), 1, 'invisible people still need a shutdown warning');
  assert.deepEqual((await preview()).voiceUsers, [], 'voice preview must not expose invisible identities');
  assert.equal(await countVoiceUsers(address.port), 1, 'invisible voice participants are still affected');
  online.delete('alice:one');
  online.delete('alice:two');
  assert.equal((await preview()).userCount, 0);
  assert.deepEqual((await preview()).users, []);
  assert.equal((await server.getStats()).onlineUsers, 0);
  assert.equal(await countOnlineUsers(address.port), 0);
  assert.equal(await countVoiceUsers(address.port), 0, 'disconnected stale voice entries and bots do not count');
  assert.equal(online.size, 1, 'excluding bots from counters must not disconnect them');
});
