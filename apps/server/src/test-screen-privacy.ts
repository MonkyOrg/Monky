import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { MessageType, ProtocolErrorCode, nativeScreenSignalSchema, type NativeScreenSource } from '@monky/shared';
import { createApprovedBotFixture, record, records, text, type Received } from './testFixtures/bots';

function assertHidden(state: Record<string, unknown>): void {
  assert.deepEqual(state.screenShareIds, []);
  assert.deepEqual(state.nativeScreenShares, []);
  assert.equal(state.isScreenSharing, false);
  assert.equal(state.isSharingScreenAudio, false);
}

function screenState(messages: Received[], sessionId: string): Record<string, unknown> | undefined {
  return messages.filter(message => message.type === MessageType.VOICE_STATE_CHANGED)
    .map(message => record(message.payload.voiceState)).reverse().find(state => state.sessionId === sessionId);
}

test('real sockets hide private screens from administrators, auth snapshots, late joins and bots; identity grants span devices', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Unselected administrator');
  const publisher = await f.human('Private publisher');
  const viewer = await f.human('Selected viewer');
  const room = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'VOICE')?.id);
  const publisherSessionId = text(record(publisher.auth.payload.currentUser).sessionId);
  for (const user of [owner, publisher, viewer]) {
    assert.equal((await user.peer.request(MessageType.VOICE_JOIN, { channelId: room })).type, MessageType.VOICE_USER_JOINED);
  }
  const source: NativeScreenSource = {
    shareId: 'private-live', instanceId: randomUUID(), audio: true,
    video: { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 12000 },
    audience: { userIds: [viewer.id], roleIds: [] },
  };
  const announce = { screenShareIds: [source.shareId], nativeScreenShares: [source], isScreenSharing: true, isSharingScreenAudio: true };
  assert.equal((await publisher.peer.request(MessageType.VOICE_STATE_UPDATE, announce)).type, MessageType.VOICE_STATE_CHANGED);
  await Promise.all([owner.peer.barrier(), viewer.peer.barrier()]);
  assertHidden(screenState(owner.peer.messages, publisherSessionId)!);
  const visible = screenState(viewer.peer.messages, publisherSessionId)!;
  assert.equal(visible.isScreenSharing, true);
  assert.equal(visible.isSharingScreenAudio, true);
  assert.equal('audience' in records(visible.nativeScreenShares)[0], false);
  assert.deepEqual(records(screenState(publisher.peer.messages, publisherSessionId)!.nativeScreenShares)[0].audience, source.audience);

  const outsider = await f.human('Late outsider');
  assertHidden(record(record(record(outsider.auth.payload.server).voiceStates)[publisherSessionId]));
  const lateJoin = await outsider.peer.request(MessageType.VOICE_JOIN, { channelId: room });
  assertHidden(record(records(lateJoin.payload.participants).find(value => record(value.voiceState).sessionId === publisherSessionId)!.voiceState));
  const device = await f.human('Selected viewer device two', viewer.keys);
  const ownSnapshot = record(record(record(device.auth.payload.server).voiceStates)[publisherSessionId]);
  assert.equal(ownSnapshot.isScreenSharing, true);
  assert.equal('audience' in records(ownSnapshot.nativeScreenShares)[0], false);
  await device.peer.request(MessageType.VOICE_JOIN, { channelId: room });
  const watch = {
    action: 'watch', fromSessionId: 'forged', targetSessionId: publisherSessionId, publisherSessionId,
    channelId: room, shareId: source.shareId, sourceInstanceId: source.instanceId,
    subscriptionId: randomUUID(), quality: 'source', backend: 'browser',
  };
  await owner.peer.error(MessageType.NATIVE_SCREEN_SIGNAL, watch, ProtocolErrorCode.PERMISSION_DENIED);
  await outsider.peer.error(MessageType.NATIVE_SCREEN_SIGNAL, watch, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal((await device.peer.request(MessageType.NATIVE_SCREEN_SIGNAL, watch)).type, MessageType.NATIVE_SCREEN_SIGNAL_ACK);
  await viewer.peer.error(MessageType.RTC_SIGNAL, {
    fromSessionId: 'forged', targetSessionId: publisherSessionId, signalType: 'screen-watch',
    streamId: source.shareId, subscriptionId: 'old-publisher', watcherSubscriptionId: 'old-viewer',
    subscriptionRevision: 1, watching: true,
  }, ProtocolErrorCode.PERMISSION_DENIED);

  const created = await owner.peer.request(MessageType.BOT_CREATE, {});
  const bot = await f.bot(text(created.payload.token));
  assert.equal(JSON.stringify(bot.auth.payload).includes(source.instanceId), false);
  assert.equal(JSON.stringify(bot.auth.payload).includes(source.shareId), false);
  const since = bot.peer.messages.length;
  await publisher.peer.request(MessageType.VOICE_STATE_UPDATE, { isSpeaking: true });
  await bot.peer.barrier();
  assert.equal(JSON.stringify(bot.peer.messages.slice(since)).includes(source.instanceId), false);
  assert.equal(JSON.stringify(bot.peer.messages.slice(since)).includes(source.shareId), false);
  await publisher.peer.error(MessageType.VOICE_STATE_UPDATE, {
    ...announce, nativeScreenShares: [{ ...source, audience: { userIds: [], roleIds: [] } }],
  }, ProtocolErrorCode.BAD_REQUEST);
  assert.deepEqual(f.signalingService.getVoiceState(publisherSessionId)?.nativeScreenShares?.[0].audience, source.audience);
});

test('role grants refresh visibility; removal/deletion and withdrawal revoke exact native video/audio leases', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Role owner');
  const publisher = await f.human('Role publisher');
  const viewer = await f.human('Role viewer');
  const room = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'VOICE')?.id);
  const pub = text(record(publisher.auth.payload.currentUser).sessionId);
  const view = text(record(viewer.auth.payload.currentUser).sessionId);
  for (const user of [owner, publisher, viewer]) await user.peer.request(MessageType.VOICE_JOIN, { channelId: room });
  const created = await owner.peer.request(MessageType.ROLE_CREATE, { name: 'Screen viewers', permissions: 0 });
  const roleId = text(records(created.payload.roles).find(role => role.name === 'Screen viewers')?.id);
  const source = {
    shareId: 'role-live', instanceId: randomUUID(), audio: true,
    video: { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 12000 },
    audience: { userIds: [], roleIds: [roleId] },
  };
  await publisher.peer.request(MessageType.VOICE_STATE_UPDATE, { screenShareIds: [source.shareId], nativeScreenShares: [source] });
  await viewer.peer.barrier();
  assertHidden(screenState(viewer.peer.messages, pub)!);
  const grant = async () => {
    await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: viewer.id, roleId });
    await f.wsServer['refreshScreenRoles']();
    await viewer.peer.barrier();
    assert.equal(screenState(viewer.peer.messages, pub)?.isScreenSharing, true);
  };
  const watch = async () => {
    const subscriptionId = randomUUID();
    const signal = {
      fromSessionId: view, targetSessionId: pub, publisherSessionId: pub, channelId: room,
      shareId: source.shareId, sourceInstanceId: source.instanceId, subscriptionId,
    };
    assert.equal((await viewer.peer.request(MessageType.NATIVE_SCREEN_SIGNAL,
      { ...signal, action: 'watch', quality: 'source', backend: 'native' })).type, MessageType.NATIVE_SCREEN_SIGNAL_ACK);
    assert.equal((await publisher.peer.request(MessageType.NATIVE_SCREEN_SIGNAL,
      { ...signal, fromSessionId: pub, targetSessionId: view, action: 'accepted', quality: 'source', backend: 'native', generation: 1 })).type,
    MessageType.NATIVE_SCREEN_SIGNAL_ACK);
    return signal;
  };
  const revoked = async (signal: Awaited<ReturnType<typeof watch>>) => {
    await Promise.all([publisher.peer.barrier(), viewer.peer.barrier()]);
    const stopped = publisher.peer.messages.find(message => message.type === MessageType.NATIVE_SCREEN_SIGNAL
      && message.payload.action === 'stop' && message.payload.subscriptionId === signal.subscriptionId);
    const closed = viewer.peer.messages.find(message => message.type === MessageType.NATIVE_SCREEN_SIGNAL
      && message.payload.action === 'closed' && message.payload.subscriptionId === signal.subscriptionId);
    assert.ok(stopped);
    assert.ok(closed);
    const stopSignal = nativeScreenSignalSchema.parse(stopped.payload);
    const closedSignal = nativeScreenSignalSchema.parse(closed.payload);
    assert.equal(stopSignal.fromSessionId, view);
    assert.equal(stopSignal.targetSessionId, pub);
    assert.equal(stopSignal.sourceInstanceId, source.instanceId);
    assert.equal(closedSignal.fromSessionId, pub);
    assert.equal(closedSignal.targetSessionId, view);
    assert.equal(closedSignal.sourceInstanceId, source.instanceId);
    await publisher.peer.error(MessageType.NATIVE_SCREEN_SIGNAL, {
      ...signal, fromSessionId: pub, targetSessionId: view, action: 'accepted', quality: 'source', backend: 'native', generation: 1,
    }, ProtocolErrorCode.PERMISSION_DENIED);
  };
  await grant();
  const original = await watch();
  await f.human('Unrelated late member');
  const unrelated = await owner.peer.request(MessageType.ROLE_CREATE, { name: 'Unrelated role', permissions: 0 });
  const unrelatedRoleId = text(records(unrelated.payload.roles).find(role => role.name === 'Unrelated role')?.id);
  await owner.peer.request(MessageType.ROLE_ASSIGN, { userId: owner.id, roleId: unrelatedRoleId });
  await owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: owner.id, roleId: unrelatedRoleId });
  await publisher.peer.barrier();
  assert.equal(publisher.peer.messages.some(message => message.type === MessageType.NATIVE_SCREEN_SIGNAL
    && message.payload.action === 'stop' && message.payload.subscriptionId === original.subscriptionId), false,
  'logins and unrelated role changes never interrupt an existing private subscription');
  await owner.peer.request(MessageType.ROLE_UNASSIGN, { userId: viewer.id, roleId });
  await revoked(original);
  assertHidden(screenState(viewer.peer.messages, pub)!);
  await grant();
  const deletion = await watch();
  await owner.peer.request(MessageType.ROLE_DELETE, { roleId });
  await revoked(deletion);
  assertHidden(screenState(viewer.peer.messages, pub)!);
  await publisher.peer.request(MessageType.VOICE_STATE_UPDATE, { screenShareIds: [], nativeScreenShares: [] });
  await publisher.peer.request(MessageType.VOICE_STATE_UPDATE, {
    screenShareIds: [source.shareId], nativeScreenShares: [{ ...source, audience: { userIds: [viewer.id], roleIds: [] } }],
  });
  const withdrawal = await watch();
  await publisher.peer.request(MessageType.VOICE_STATE_UPDATE, { screenShareIds: [], nativeScreenShares: [] });
  await revoked(withdrawal);
  assert.equal(f.signalingService.getVoiceState(view)?.channelId, room, 'voice stays connected');
});
