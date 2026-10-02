import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PERMISSIONS, MessageType, Permission, ProtocolErrorCode, eventTimeInZone, eventOccurrenceStart, eventSaveSchema, eventInterestedListResultSchema, eventResultSchema, type EventSave } from '@monky/shared';
import { CommunityService, CommunityError } from './application/services/CommunityService';
import { BotSelectorService } from './application/services/BotSelectorService';
import { SqliteBotSelectorRepository } from './infrastructure/database/SqliteBotSelectorRepository';
import { SqliteCommunityRepository } from './infrastructure/database/SqliteCommunityRepository';
import { DatabaseConnection } from './infrastructure/database/DatabaseConnection';
import { SqliteNativePollRepository } from './infrastructure/database/SqliteNativePollRepository';
import { NativePollService } from './application/services/NativePollService';
import { createFixture, createApprovedBotFixture, record, records, text } from './testFixtures/bots';

const PNG_DATA = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

async function setup(t: test.TestContext) {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const owner = await fixture.human('Event owner');
  const member = await fixture.human('Event member');
  const db = fixture.database.getDb();
  const repository = new SqliteCommunityRepository(db);
  const allowed = new Set<string>();
  const selectors = new BotSelectorService(new SqliteBotSelectorRepository(db));
  let service!: CommunityService;
  const polls = new NativePollService(new SqliteNativePollRepository(db), {
    consume: (refs, userId, channelId) => service.consumeImageAssets(refs, userId, channelId)
      .map(url => url.split('/').pop()!),
    delete: paths => service.deleteImagePaths(paths),
  });
  service = new CommunityService(repository, fixture.channelService, fixture.permissions, fixture.avatars, selectors,
    id => allowed.has(id), polls);
  const voiceId = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'VOICE')?.id);
  const now = Date.now();
  const draft: EventSave = {
    title: 'Community event', description: 'Details', location: { kind: 'voice', channelId: voiceId },
    startsAt: now + 60_000, endsAt: now + 120_000, repeat: 'none', timeZone: 'UTC',
  };
  await service.updateSettings(owner.id, { eventsEnabled: true });
  return { ...fixture, owner, member, repository, service, selectors, polls, allowed, draft, now };
}

test('event contracts reject invalid dates, recurrence and image URLs', () => {
  assert.throws(() => eventTimeInZone('2026-02-30T10:00', 'UTC'));
  assert.throws(() => eventTimeInZone('2026-01-01T10:00', 'Invalid/Zone'));
  assert.equal(eventSaveSchema.safeParse({
    title: 'Event', description: '', location: { kind: 'external', label: 'Outside' },
    startsAt: 1, endsAt: null, repeat: 'none', timeZone: 'UTC',
  }).success, false);
  assert.equal(eventSaveSchema.safeParse({
    title: 'Event', description: '', location: { kind: 'text', channelId: 'channel' },
    startsAt: 1, endsAt: null, repeat: 'none', timeZone: 'UTC',
  }).success, false);
});

test('private event audiences use member-or-role access, manager and creator bypass, ACL intersection and live revocation', async t => {
  const f = await setup(t);
  const roleMember = await f.human('Role audience member');
  const outsider = await f.human('Audience outsider');
  const manager = await f.human('Audience manager');
  await f.roleRepo.create({
    id: 'event-audience-role', name: 'Event audience', color: null, position: 2,
    permissions: DEFAULT_PERMISSIONS, isDefault: false, createdAt: f.now,
  });
  await f.roleRepo.assignRole(roleMember.id, 'event-audience-role');
  await f.roleRepo.create({
    id: 'event-manager-role', name: 'Event manager', color: null, position: 3,
    permissions: DEFAULT_PERMISSIONS | Permission.MANAGE_SERVER, isDefault: false, createdAt: f.now,
  });
  await f.roleRepo.assignRole(manager.id, 'event-manager-role');
  const event = await f.service.saveEvent(f.owner.id, {
    ...f.draft,
    audience: {
      visibility: 'private',
      userIds: [f.member.id],
      roleIds: ['event-audience-role'],
    },
  }, f.now);
  assert.equal((await f.service.snapshot(f.member.id)).events.some(entry => entry.id === event.id), true);
  assert.equal((await f.service.snapshot(roleMember.id)).events.some(entry => entry.id === event.id), true);
  assert.equal((await f.service.snapshot(outsider.id)).events.some(entry => entry.id === event.id), false);
  assert.equal((await f.service.snapshot(f.owner.id)).events[0].audience.visibility, 'private');
  assert.deepEqual((await f.service.snapshot(manager.id)).events[0].audience, event.audience);
  assert.deepEqual((await f.service.snapshot(f.member.id)).events[0].audience, { visibility: 'private' });
  await outsider.peer.error(MessageType.EVENT_GET, { id: event.id }, ProtocolErrorCode.PERMISSION_DENIED);
  assert.equal(eventResultSchema.parse((await manager.peer.request(MessageType.EVENT_GET, { id: event.id })).payload).event.id, event.id);

  await f.permissions.withRoleMutation(() => f.roleRepo.unassignRole(roleMember.id, 'event-audience-role'), {
    userId: roleMember.id, roleId: 'event-audience-role',
  });
  assert.equal((await f.service.snapshot(roleMember.id)).events.some(entry => entry.id === event.id), false);
  assert.equal((await f.service.getEvent(f.owner.id, event.id)).id, event.id);

  const aclRoom = await f.channelService.createChannel({
    name: 'Audience ACL intersection', type: 'VOICE', isPrivate: true, allowedRoleIds: [],
  });
  assert.ok(aclRoom.channel);
  const aclEvent = await f.service.saveEvent(f.owner.id, {
    ...f.draft,
    title: 'ACL private event',
    location: { kind: 'voice', channelId: aclRoom.channel.id },
    audience: { visibility: 'private', userIds: [f.member.id], roleIds: [] },
  }, f.now);
  assert.equal((await f.service.snapshot(f.member.id)).events.some(entry => entry.id === aclEvent.id), false);
  const external = await f.service.saveEvent(f.owner.id, {
    ...f.draft,
    title: 'External private event',
    location: { kind: 'external', label: 'https://example.test/private' },
    audience: { visibility: 'private', userIds: [f.member.id], roleIds: [] },
  }, f.now);
  assert.equal((await f.service.getEvent(f.member.id, external.id)).id, external.id);
  await outsider.peer.error(MessageType.EVENT_GET, { id: external.id }, ProtocolErrorCode.PERMISSION_DENIED);
  const legacyPublic = await f.service.saveEvent(f.owner.id, { ...f.draft, title: 'Legacy public default' }, f.now);
  assert.deepEqual(legacyPublic.audience, { visibility: 'public' });
  assert.equal((await f.service.getEvent(outsider.id, legacyPublic.id)).id, legacyPublic.id);
});

test('text-channel events persist through websocket requests and enforce channel type and visibility', async t => {
  const f = await setup(t);
  const channelId = text(records(record(f.owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  const result = eventResultSchema.parse((await f.owner.peer.request(MessageType.EVENT_SAVE, {
    ...f.draft, location: { kind: 'text', channelId },
  })).payload);
  assert.deepEqual(result.event.location, { kind: 'text', channelId });
  assert.deepEqual(f.repository.event(result.event.id)?.location, result.event.location);
  assert.equal((await f.service.getEvent(f.member.id, result.event.id)).id, result.event.id);
  const privateRoom = await f.channelService.createChannel({
    name: 'private-text-event', type: 'TEXT', isPrivate: true, allowedRoleIds: [],
  });
  assert.ok(privateRoom.channel);
  const privateEvent = await f.service.saveEvent(f.owner.id, {
    ...f.draft, location: { kind: 'text', channelId: privateRoom.channel.id },
  }, f.now);
  assert.equal((await f.service.snapshot(f.member.id)).events.some(event => event.id === privateEvent.id), false);
  await f.member.peer.error(MessageType.EVENT_GET, { id: privateEvent.id }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.member.peer.error(MessageType.EVENT_GET_INTERESTED, { id: privateEvent.id }, ProtocolErrorCode.PERMISSION_DENIED);
  await assert.rejects(f.service.setInterest(f.member.id, privateEvent.id, true), CommunityError);
  await assert.rejects(f.service.saveEvent(f.owner.id, {
    ...f.draft, location: { kind: 'voice', channelId },
  }), CommunityError);
  assert.equal(f.draft.location.kind, 'voice');
  if (f.draft.location.kind === 'voice') {
    await assert.rejects(f.service.saveEvent(f.owner.id, {
      ...f.draft, location: { kind: 'text', channelId: f.draft.location.channelId },
    }), CommunityError);
  }
  await assert.rejects(f.service.saveEvent(f.owner.id, {
    ...f.draft, location: { kind: 'text', channelId: 'missing-channel' },
  }), CommunityError);
  const forum = await f.channelService.createChannel({ name: 'Event forum', type: 'FORUM' });
  assert.ok(forum.channel);
  const base = await f.channelRepo.findById(channelId);
  assert.ok(base);
  const threadId = 'event-forum-thread';
  await f.channelRepo.create({
    ...base,
    id: threadId,
    name: 'Forum thread',
    forumId: forum.channel.id,
    position: 0,
    createdAt: f.now,
  });
  f.database.getDb().prepare('UPDATE channels SET forum_parent_id = ? WHERE id = ?')
    .run(forum.channel.id, threadId);
  await assert.rejects(f.service.saveEvent(f.owner.id, {
    ...f.draft, location: { kind: 'text', channelId: threadId },
  }), CommunityError);
  await f.owner.peer.error(MessageType.POLL_CREATE, {
    channelId: threadId,
    clientMessageId: 'thread-poll',
    question: 'Poll inside a thread?',
    options: [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }],
    durationMinutes: 60,
  }, ProtocolErrorCode.CHANNEL_NOT_FOUND);
});

test('interested members are paginated public identities, including offline members, with private-event ACL', async t => {
  const f = await setup(t);
  const event = await f.service.saveEvent(f.owner.id, f.draft, f.now);
  await f.service.setInterest(f.member.id, event.id, true);
  await f.service.setInterest(f.owner.id, event.id, true);
  await f.owner.peer.close();
  const first = eventInterestedListResultSchema.parse((await f.member.peer.request(MessageType.EVENT_GET_INTERESTED, { id: event.id, limit: 1 })).payload);
  assert.equal(first.users.length, 1);
  assert.deepEqual(Object.keys(first.users[0]).sort(), ['avatarUrl', 'id', 'nickname']);
  assert.ok(first.nextCursor);
  const second = eventInterestedListResultSchema.parse((await f.member.peer.request(MessageType.EVENT_GET_INTERESTED, {
    id: event.id, cursor: first.nextCursor, limit: 1,
  })).payload);
  assert.equal(second.nextCursor, null);
  assert.deepEqual([...first.users, ...second.users].map(user => user.id).sort(), [f.member.id, f.owner.id].sort());
  assert.equal((await f.service.interestedMembers(f.owner.id, { id: event.id, cursor: 'zzzz', limit: 50 })).users.length, 0);
  await f.member.peer.error(MessageType.EVENT_GET_INTERESTED, { id: event.id, limit: 51 }, ProtocolErrorCode.COMMUNITY_INVALID);
  const room = await f.channelService.createChannel({ name: 'Private event room', type: 'VOICE', isPrivate: true, allowedRoleIds: [] });
  assert.ok(room.channel);
  const hidden = await f.service.saveEvent(f.owner.id, { ...f.draft, location: { kind: 'voice', channelId: room.channel.id } }, f.now);
  await f.service.setInterest(f.owner.id, hidden.id, true);
  await f.member.peer.error(MessageType.EVENT_GET, { id: hidden.id }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.member.peer.error(MessageType.EVENT_GET_INTERESTED, { id: hidden.id }, ProtocolErrorCode.PERMISSION_DENIED);
  await f.service.updateSettings(f.owner.id, { eventsEnabled: false });
  await f.member.peer.error(MessageType.EVENT_GET_INTERESTED, { id: event.id }, ProtocolErrorCode.PERMISSION_DENIED);
});

test('event links resolve historical entries outside snapshots and reject deleted events and bots', async t => {
  const f = await setup(t);
  const event = await f.service.saveEvent(f.owner.id, f.draft, f.now);
  f.repository.saveEvent({ ...event, status: 'ended', endedAt: event.endsAt });
  assert.equal((await f.service.snapshot(f.member.id)).events.length, 0);
  const result = eventResultSchema.parse((await f.member.peer.request(MessageType.EVENT_GET, { id: event.id })).payload);
  assert.equal(result.event.id, event.id);
  assert.equal(result.event.status, 'ended');
  const account = await f.owner.peer.request(MessageType.BOT_CREATE);
  const bot = await f.bot(text(account.payload.token));
  await bot.peer.error(MessageType.EVENT_GET, { id: event.id }, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.error(MessageType.EVENT_GET_INTERESTED, { id: event.id }, ProtocolErrorCode.PERMISSION_DENIED);
  f.repository.deleteEvent(event.id);
  await f.member.peer.error(MessageType.EVENT_GET, { id: event.id }, ProtocolErrorCode.PERMISSION_DENIED);
});

test('event reads never disclose details or interested members when access changes during the lookup', async t => {
  const f = await setup(t);
  const event = await f.service.saveEvent(f.owner.id, f.draft, f.now);
  await f.service.setInterest(f.owner.id, event.id, true);
  const access = f.channelService.canUserAccessChannel;
  const version = f.wsServer.getChannelAccessVersion;
  let changed = false;
  t.mock.method(f.wsServer, 'getChannelAccessVersion', () => {
    const value = version.call(f.wsServer);
    return changed && value !== null ? value + 1 : value;
  });
  t.mock.method(f.channelService, 'canUserAccessChannel', async (userId: string, channelId: string) => {
    const result = await access.call(f.channelService, userId, channelId);
    if (userId === f.member.id) changed = true;
    return result;
  });
  for (const type of [MessageType.EVENT_GET, MessageType.EVENT_GET_INTERESTED]) {
    changed = false;
    await f.member.peer.error(type, { id: event.id }, ProtocolErrorCode.PERMISSION_DENIED);
  }
});

test('calendar recurrence preserves local time, handles DST gaps and clamps monthly dates without drifting', () => {
  const daily = { anchorStartsAt: eventTimeInZone('2026-03-07T10:00', 'America/New_York'), timeZone: 'America/New_York', repeat: 'daily' as const };
  assert.equal(eventOccurrenceStart(daily, 1), Date.parse('2026-03-08T14:00:00Z'));
  assert.equal(eventTimeInZone('2026-03-08T02:30', 'America/New_York'), Date.parse('2026-03-08T07:30:00Z'));
  const monthly = { ...daily, anchorStartsAt: Date.parse('2026-01-31T10:00:00Z'), timeZone: 'UTC', repeat: 'monthly' as const };
  assert.equal(eventOccurrenceStart(monthly, 1), Date.parse('2026-02-28T10:00:00Z'));
  assert.equal(eventOccurrenceStart(monthly, 2), Date.parse('2026-03-31T10:00:00Z'));
});

test('settings and event management require explicit permission and persist without granting it to members', async t => {
  const f = await setup(t);
  await assert.rejects(f.service.updateSettings(f.member.id, { eventsEnabled: false }), CommunityError);
  await assert.rejects(f.service.saveEvent(f.member.id, f.draft), CommunityError);
  const event = await f.service.saveEvent(f.owner.id, {
    ...f.draft, imageSources: [PNG_DATA, PNG_DATA],
  }, f.now);
  assert.equal(f.repository.event(event.id)?.title, f.draft.title);
  assert.equal(event.imageUrls.length, 2);
  assert.equal(event.imageUrl, event.imageUrls[0]);
  for (const url of event.imageUrls) assert.ok(f.avatars.getAvatarFile(url.split('/').pop()!));
  const reordered = await f.service.saveEvent(f.owner.id, {
    ...f.draft,
    id: event.id,
    expectedRevision: event.revision,
    imageSources: [event.imageUrls[1], event.imageUrls[0]],
  }, f.now);
  assert.deepEqual(reordered.imageUrls, [event.imageUrls[1], event.imageUrls[0]]);
  await assert.rejects(f.service.saveEvent(f.owner.id, {
    ...f.draft,
    id: reordered.id,
    expectedRevision: reordered.revision,
    imageSources: ['/avatars/unrelated.png'],
  }, f.now), CommunityError);
  const deletable = await f.service.saveEvent(f.owner.id, {
    ...f.draft,
    title: 'Disposable event carousel',
    imageSources: [PNG_DATA, PNG_DATA],
  }, f.now);
  const deletedPaths = deletable.imageUrls.map(url => url.split('/').pop()!);
  await f.service.controlEvent(f.owner.id, {
    id: deletable.id, expectedRevision: deletable.revision, action: 'delete',
  }, f.now);
  assert.ok(deletedPaths.every(path => !f.avatars.getAvatarFile(path)));
  await assert.rejects(f.service.saveEvent(f.owner.id, { ...f.draft, id: event.id, expectedRevision: 10 }), CommunityError);
  await assert.rejects(f.service.saveEvent(f.owner.id, { ...f.draft, title: 'Rejected' }, f.now, () => {
    throw new CommunityError('Revoked');
  }), CommunityError);
  assert.equal(f.repository.events().length, 1);
  const textChannelId = text(records(record(f.owner.auth.payload.server).channels)
    .find(channel => channel.type === 'TEXT')?.id);
  const bot = await f.botService.create(f.owner.id);
  assert.ok(bot.success && bot.bot);
  f.allowed.add(bot.bot.id);
  const action = f.service.createLiveAction(bot.bot.id, f.owner.id, {
    channelId: textChannelId,
    invocationId: 'master-switch-action',
    title: 'Action closed by master switch',
    description: '',
    expiresAt: f.now + 120_000,
    content: { kind: 'form', form: {
      title: 'Action',
      fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }],
    } },
  }, f.now);
  const form = await f.service.createNativeForm(f.owner.id, {
    channelId: textChannelId,
    durationMinutes: 10,
    form: {
      title: 'Form closed by master switch',
      fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }],
    },
  }, f.now);
  const poll = f.polls.create(f.owner.id, {
    channelId: textChannelId,
    clientMessageId: 'master-switch-poll',
    question: 'Poll closed by master switch',
    options: [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }],
    durationMinutes: 10,
    liveAction: true,
  }, f.now).poll;
  const ordinaryPoll = f.polls.create(f.owner.id, {
    channelId: textChannelId,
    clientMessageId: 'master-switch-ordinary-poll',
    question: 'Ordinary poll remains open',
    options: [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }],
    durationMinutes: 10,
  }, f.now).poll;
  const closedPolls = await f.service.updateSettings(
    f.owner.id,
    { eventsEnabled: false },
    () => {},
    f.now + 1_000,
  );
  assert.equal(closedPolls.some(entry => entry.id === poll.id && entry.closedAt === f.now + 1_000), true);
  assert.equal(f.repository.liveAction(action.id), undefined);
  assert.equal(f.repository.nativeForm(form.id)?.closedAt, f.now + 1_000);
  assert.equal(f.polls.repository.findById(poll.id)?.closedAt, f.now + 1_000);
  assert.equal(f.polls.repository.findById(ordinaryPoll.id)?.closedAt, null);
  assert.equal(f.repository.settings().disabledAt, f.now + 1_000);
  await f.service.updateSettings(f.owner.id, { eventsEnabled: false }, () => {}, f.now + 20_000);
  assert.equal(f.repository.settings().disabledAt, f.now + 1_000);
  assert.throws(() => f.service.createLiveAction(bot.bot!.id, f.owner.id, {
    channelId: textChannelId,
    invocationId: 'disabled-action',
    title: 'Rejected action',
    description: '',
    expiresAt: f.now + 120_000,
    content: { kind: 'form', form: {
      title: 'Action',
      fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }],
    } },
  }, f.now + 20_000), CommunityError);
  await assert.rejects(f.service.createNativeForm(f.owner.id, {
    channelId: textChannelId,
    durationMinutes: 10,
    form: {
      title: 'Rejected form',
      fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }],
    },
  }, f.now + 20_000), CommunityError);
  assert.equal(f.service.advance(f.now + 70_000).started.length, 0);
  const disabledSnapshot = await f.service.snapshot(f.member.id);
  assert.equal(disabledSnapshot.events.length, 0);
  assert.equal(disabledSnapshot.liveActions.length, 0);
  assert.equal(disabledSnapshot.polls.length, 0);
  assert.equal(disabledSnapshot.nativeForms.length, 0);
  assert.equal(f.repository.events().length, 1);
  const restartedRepository = new SqliteCommunityRepository(f.database.getDb());
  const restartedService = new CommunityService(
    restartedRepository,
    f.channelService,
    f.permissions,
    f.avatars,
    f.selectors,
    id => f.allowed.has(id),
    f.polls,
  );
  await restartedService.updateSettings(f.owner.id, { eventsEnabled: true }, () => {}, f.now + 61_000);
  const resumed = f.repository.event(event.id)!;
  assert.equal(resumed.startsAt, event.startsAt + 60_000);
  assert.equal(resumed.endsAt, event.endsAt! + 60_000);
  assert.equal(resumed.anchorStartsAt, event.anchorStartsAt + 60_000);
  assert.equal(f.repository.settings().disabledAt, null);
});

test('automatic start/end, subscriptions and manual early start operate once per occurrence', async t => {
  const f = await setup(t);
  const event = await f.service.saveEvent(f.owner.id, f.draft, f.now);
  await f.service.setInterest(f.member.id, event.id, true);
  assert.equal((await f.service.publicEvent(event, f.member.id)).interestedCount, 1);
  assert.equal(f.service.advance(f.now + 59_999).started.length, 0);
  assert.equal(f.service.advance(f.now + 60_000).started[0]?.id, event.id);
  assert.equal(f.service.advance(f.now + 70_000).started.length, 0);
  assert.equal(f.service.advance(f.now + 120_000).changed, true);
  assert.equal(f.repository.event(event.id)?.status, 'ended');
  const second = await f.service.saveEvent(f.owner.id, f.draft, f.now);
  await f.service.controlEvent(f.owner.id, { id: second.id, expectedRevision: second.revision, action: 'start' }, f.now);
  assert.equal(f.repository.event(second.id)?.startedAt, f.now);
  await assert.rejects(f.service.controlEvent(f.member.id, {
    id: second.id, expectedRevision: 1, action: 'end',
  }), CommunityError);
});

test('recurrence skips missed occurrences after downtime and retains subscriptions', async t => {
  const f = await setup(t);
  const event = await f.service.saveEvent(f.owner.id, { ...f.draft, repeat: 'daily' }, f.now);
  await f.service.setInterest(f.member.id, event.id, true);
  const now = f.now + 90 * 86_400_000 + 70_000;
  const result = f.service.advance(now);
  assert.equal(result.started.length, 1);
  assert.equal(result.started[0].occurrence, 90);
  assert.equal((await f.service.publicEvent(result.started[0], f.member.id)).interested, true);
  assert.equal(f.service.advance(now).changed, false);
});

test('private voice events cannot be listed or subscribed to by unauthorized members', async t => {
  const f = await setup(t);
  const privateChannel = await f.channelService.createChannel({
    name: 'event-private', type: 'VOICE', isPrivate: true, allowedRoleIds: [],
  });
  assert.ok(privateChannel.channel);
  const event = await f.service.saveEvent(f.owner.id, {
    ...f.draft, location: { kind: 'voice', channelId: privateChannel.channel.id },
  }, f.now);
  assert.equal((await f.service.snapshot(f.member.id)).events.length, 0);
  await assert.rejects(f.service.setInterest(f.member.id, event.id, true), CommunityError);
  assert.equal((await f.service.snapshot(f.owner.id)).events.length, 1);
});

test('live actions persist with ownership/revision/deadline enforcement and capability revocation', async t => {
  const f = await setup(t);
  const bot = await f.botService.create(f.owner.id);
  assert.ok(bot.success && bot.bot);
  const botId = bot.bot.id;
  const channelId = text(records(record(f.owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  const image = await f.service.stageImage(f.owner.id, channelId, PNG_DATA, f.now);
  const input = {
    channelId, invocationId: 'invocation', title: 'Native form', description: '',
    imageAssetRefs: [image.ref],
    imagePresentation: { format: 'portrait' as const, fit: 'contain' as const, size: 'compact' as const },
    expiresAt: f.now + 60_000, content: { kind: 'form' as const, form: {
      title: 'Response', fields: [{ name: 'answer', type: 'text' as const, label: 'Answer', required: true }],
    } },
  };
  assert.throws(() => f.service.createLiveAction(botId, f.owner.id, input, f.now), CommunityError);
  f.allowed.add(botId);
  assert.deepEqual(f.service.resolveImageAssets([image.ref], f.owner.id, channelId), [image.url]);
  assert.throws(() => f.service.resolveImageAssets([image.ref], f.member.id, channelId), CommunityError);
  const action = f.service.createLiveAction(botId, f.owner.id, input, f.now);
  assert.equal(f.repository.liveAction(action.id)?.botId, botId);
  assert.equal(action.imageUrls.length, 1);
  assert.deepEqual(action.imagePresentation, input.imagePresentation);
  const actionImage = action.imageUrls[0].split('/').pop()!;
  assert.ok(f.avatars.getAvatarFile(actionImage));
  assert.throws(() => f.service.closeLiveAction('another-bot', action.id), CommunityError);
  assert.throws(() => f.service.updateLiveAction(botId, { id: action.id, expectedRevision: 99, title: 'Changed' }, f.now), CommunityError);
  assert.equal((await f.service.snapshot(f.member.id)).liveActions.length, 1);
  f.allowed.delete(botId);
  assert.equal((await f.service.snapshot(f.member.id)).liveActions.length, 0);
  assert.equal(f.service.advance(f.now).changed, true);
  assert.equal(f.repository.liveActions().length, 0);
  assert.equal(f.avatars.getAvatarFile(actionImage), null);
});

test('live actions can be closed by their creator or an event manager, but not another member', async t => {
  const f = await setup(t);
  const bot = await f.botService.create(f.owner.id);
  assert.ok(bot.success && bot.bot);
  const botId = bot.bot.id;
  f.allowed.add(botId);
  const channelId = text(records(record(f.owner.auth.payload.server).channels)
    .find(channel => channel.type === 'TEXT')?.id);
  const definition = {
    channelId, invocationId: 'close-live-action', title: 'Closable action', description: '',
    expiresAt: f.now + 60_000,
    content: {
      kind: 'form' as const,
      form: { title: 'Close', fields: [{ name: 'answer', label: 'Answer', type: 'text' as const, required: true }] },
    },
  };
  const creatorAction = f.service.createLiveAction(botId, f.owner.id, definition, f.now);
  await assert.rejects(f.service.closeLiveActionForUser(f.member.id, creatorAction.id), CommunityError);
  await f.service.closeLiveActionForUser(f.owner.id, creatorAction.id);
  assert.equal(f.repository.liveAction(creatorAction.id), undefined);

  const managedAction = f.service.createLiveAction(botId, f.member.id, {
    ...definition, invocationId: 'manager-close-live-action',
  }, f.now);
  await f.service.closeLiveActionForUser(f.owner.id, managedAction.id);
  assert.equal(f.repository.liveAction(managedAction.id), undefined);
});

test('channel deletion cleanup removes staged and persisted community media', async t => {
  const f = await setup(t);
  const channelId = text(records(record(f.owner.auth.payload.server).channels)
    .find(channel => channel.type === 'TEXT')?.id);
  const bot = await f.botService.create(f.owner.id);
  assert.ok(bot.success && bot.bot);
  const botId = bot.bot.id;
  f.allowed.add(botId);
  const actionImage = await f.service.stageImage(f.owner.id, channelId, PNG_DATA, f.now);
  const action = f.service.createLiveAction(botId, f.owner.id, {
    channelId, invocationId: 'media-cleanup-invocation', title: 'Media cleanup', description: '',
    expiresAt: f.now + 60_000, imageAssetRefs: [actionImage.ref],
    content: {
      kind: 'form',
      form: { title: 'Cleanup', fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }] },
    },
  }, f.now);
  const pollImage = await f.service.stageImage(f.owner.id, channelId, PNG_DATA, f.now);
  const poll = f.polls.create(f.owner.id, {
    channelId, question: 'Cleanup poll?', imageAssetRefs: [pollImage.ref],
    durationMinutes: 60,
    options: [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }],
  }, f.now).poll;
  const unusedImage = await f.service.stageImage(f.owner.id, channelId, PNG_DATA, f.now);
  const paths = [...action.imageUrls.map(url => url.split('/').pop()!), ...poll.imagePaths];
  for (const imagePath of paths) assert.ok(f.avatars.getAvatarFile(imagePath));

  const cleanup = f.service.prepareChannelDeletion(channelId);
  await f.channelRepo.delete(channelId);
  cleanup();

  assert.equal(f.repository.liveAction(action.id), undefined);
  assert.equal(f.polls.repository.findById(poll.id), undefined);
  for (const imagePath of paths) assert.equal(f.avatars.getAvatarFile(imagePath), null);
  assert.throws(() => f.service.consumeImageAssets([unusedImage.ref], f.owner.id, channelId), CommunityError);
});

test('live action WebSocket API requires bot consent plus the actual invoking human permission', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Live owner');
  const member = await f.human('Live member');
  await owner.peer.request(MessageType.COMMUNITY_UPDATE_SETTINGS, { eventsEnabled: true });
  const channelId = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  const account = await owner.peer.request(MessageType.BOT_CREATE);
  const botId = text(record(account.payload.bot).id);
  const bot = await f.bot(text(account.payload.token));
  await bot.peer.request(MessageType.COMMAND_REGISTER, { commands: [{ name: 'live', description: 'Native action' }] });
  const invoke = async (peer: typeof owner.peer, id = channelId) =>
    text((await peer.request(MessageType.COMMAND_INVOKE, { botId, channelId: id, commandName: 'live', locale: 'en' })).payload.invocationId);
  const input = {
    channelId, title: 'Native action', description: '', expiresAt: Date.now() + 60000,
    content: { kind: 'form', form: { title: 'Answer', fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }] } },
  };
  await bot.peer.error(MessageType.LIVE_ACTION_CREATE, { ...input, invocationId: await invoke(member.peer) }, ProtocolErrorCode.PERMISSION_DENIED);
  await bot.peer.error(MessageType.LIVE_ACTION_CREATE, { ...input, invocationId: 'forged' }, ProtocolErrorCode.PERMISSION_DENIED);
  const created = await bot.peer.request(MessageType.LIVE_ACTION_CREATE, { ...input, invocationId: await invoke(owner.peer) });
  assert.equal(created.type, MessageType.LIVE_ACTION_SNAPSHOT);
  assert.equal(created.payload.creatorUserId, owner.id);
  const id = text(created.payload.id);
  await member.peer.error(MessageType.LIVE_ACTION_CLOSE, { id }, ProtocolErrorCode.PERMISSION_DENIED);
  await member.peer.error(MessageType.LIVE_ACTION_SUBMIT, {
    id, expectedRevision: 0, values: {}, locale: 'en',
  }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
  await member.peer.error(MessageType.LIVE_ACTION_SUBMIT, {
    id, expectedRevision: 0, values: { answer: 'yes' }, locale: 'en', userId: owner.id,
  }, ProtocolErrorCode.COMMUNITY_INVALID);
  assert.equal((await member.peer.request(MessageType.LIVE_ACTION_SUBMIT, {
    id, expectedRevision: 0, values: { answer: 'yes' }, locale: 'en',
  })).type, MessageType.COMMUNITY_ACK);
  const submission = await bot.peer.wait(message => message.type === MessageType.LIVE_ACTION_SUBMITTED);
  assert.equal(submission.payload.userId, member.id);
  const privateChannel = await f.channelService.createChannel({ name: 'Private live', type: 'TEXT', isPrivate: true, allowedRoleIds: [] });
  assert.ok(privateChannel.channel);
  const privateAction = await bot.peer.request(MessageType.LIVE_ACTION_CREATE, {
    ...input, channelId: privateChannel.channel.id, invocationId: await invoke(owner.peer, privateChannel.channel.id),
  });

  assert.equal(privateAction.type, MessageType.LIVE_ACTION_SNAPSHOT);
  const visible = await member.peer.request(MessageType.COMMUNITY_GET);
  assert.equal(records(visible.payload.liveActions).length, 1);
  assert.equal((await owner.peer.request(MessageType.LIVE_ACTION_CLOSE, { id })).type, MessageType.COMMUNITY_ACK);
  assert.equal(records((await member.peer.request(MessageType.COMMUNITY_GET)).payload.liveActions).length, 0);
  const state = f.botPermissions.get(botId);
  assert.ok(state);
  await owner.peer.request(MessageType.BOT_PERMISSIONS_UPDATE, {
    botId, expectedRevision: state.revision, granted: state.granted.filter(capability => capability !== 'live_actions'),
  });
  assert.equal(records((await member.peer.request(MessageType.COMMUNITY_GET)).payload.liveActions).length, 0);
});

test('native live forms enforce creation, editable responses, results and close permissions', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Form owner');
  const member = await f.human('Form member');
  await owner.peer.request(MessageType.COMMUNITY_UPDATE_SETTINGS, { eventsEnabled: true });
  const channelId = text(records(record(owner.auth.payload.server).channels)
    .find(channel => channel.type === 'TEXT')?.id);
  const input = {
    channelId,
    durationMinutes: 60,
    form: {
      title: 'Native registration',
      description: 'One editable response per member.',
      submitLabel: 'Register',
      fields: [
        { name: 'name', label: 'Name', type: 'text', required: true, maxLength: 100 },
        { name: 'bio', label: 'Bio', type: 'text', multiline: true, required: false, maxLength: 1000 },
        { name: 'age', label: 'Age', type: 'integer', required: true },
        { name: 'confirmed', label: 'Confirmed', type: 'boolean', required: true },
        {
          name: 'team', label: 'Team', type: 'select', required: true, presentation: 'buttons',
          choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }],
        },
        {
          name: 'topics', label: 'Topics', type: 'multi-select', required: true,
          choices: [{ value: 'news', label: 'News' }, { value: 'events', label: 'Events' }],
        },
      ],
    },
  };
  await member.peer.error(MessageType.NATIVE_FORM_CREATE, input, ProtocolErrorCode.PERMISSION_DENIED);
  const forum = await f.channelService.createChannel({ name: 'Form forum', type: 'FORUM' });
  const base = await f.channelRepo.findById(channelId);
  assert.ok(forum.channel && base);
  const threadId = 'native-form-thread';
  await f.channelRepo.create({
    ...base,
    id: threadId,
    name: 'Native form thread',
    forumId: forum.channel.id,
    position: 0,
    createdAt: Date.now(),
  });
  f.database.getDb().prepare('UPDATE channels SET forum_parent_id = ? WHERE id = ?')
    .run(forum.channel.id, threadId);
  await owner.peer.error(MessageType.NATIVE_FORM_CREATE, {
    ...input,
    channelId: threadId,
  }, ProtocolErrorCode.PERMISSION_DENIED);
  const created = await owner.peer.request(MessageType.NATIVE_FORM_CREATE, input);
  assert.equal(created.type, MessageType.NATIVE_FORM_SNAPSHOT);
  const formId = text(created.payload.id);
  assert.equal(records((await member.peer.request(MessageType.COMMUNITY_GET)).payload.nativeForms).length, 1);
  const legacy = await f.human('Client without forms', undefined, undefined, false, undefined, { minimumVersion: 35, features: ['server-community'] });
  const legacySnapshot = record((await legacy.peer.request(MessageType.COMMUNITY_GET)).payload);
  assert.equal(Object.hasOwn(legacySnapshot, 'nativeForms'), false);
  await legacy.peer.error(MessageType.NATIVE_FORM_SUBMIT, {
    id: formId, expectedRevision: 0, values: {},
  }, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
  await member.peer.error(MessageType.NATIVE_FORM_RESULTS, { id: formId }, ProtocolErrorCode.PERMISSION_DENIED);
  await member.peer.error(MessageType.NATIVE_FORM_CLOSE, { id: formId }, ProtocolErrorCode.PERMISSION_DENIED);

  await member.peer.error(MessageType.NATIVE_FORM_SUBMIT, {
    id: formId, expectedRevision: 0,
    values: { name: 'Invalid', age: 20, confirmed: true, team: 'a', topics: ['news', 'news'] },
  }, ProtocolErrorCode.BOT_INTERACTION_INVALID);
  const firstValues = {
    name: 'First', bio: 'Initial', age: 20, confirmed: true, team: 'a', topics: ['news', 'events'],
  };
  const first = await member.peer.request(MessageType.NATIVE_FORM_SUBMIT, {
    id: formId, expectedRevision: 0, values: firstValues,
  });

  test('private bot actions and native forms enforce audience OR semantics, manager bypass and role revocation', async t => {
    const f = await setup(t);
    const outsider = await f.human('Private action outsider');
    const manager = await f.human('Private action manager');
    await f.roleRepo.create({
      id: 'private-action-members', name: 'Private action members', color: null, position: 2,
      permissions: DEFAULT_PERMISSIONS, isDefault: false, createdAt: f.now,
    });
    await f.roleRepo.assignRole(f.member.id, 'private-action-members');
    await f.roleRepo.create({
      id: 'private-action-manager', name: 'Private action manager', color: null, position: 3,
      permissions: DEFAULT_PERMISSIONS | Permission.MANAGE_SERVER, isDefault: false, createdAt: f.now,
    });
    await f.roleRepo.assignRole(manager.id, 'private-action-manager');
    const createdBot = await f.botService.create(f.owner.id);
    assert.ok(createdBot.success && createdBot.bot);
    const botId = createdBot.bot.id;
    const channelId = text(records(record(f.owner.auth.payload.server).channels)
      .find(channel => channel.type === 'TEXT')?.id);
    f.allowed.add(botId);
    const action = f.service.createLiveAction(botId, f.owner.id, {
      channelId,
      invocationId: 'private-action-invocation',
      title: 'Private bot action',
      description: 'Restricted',
      expiresAt: f.now + 60_000,
      audience: { visibility: 'private', userIds: [], roleIds: ['private-action-members'] },
      content: {
        kind: 'form',
        form: {
          title: 'Private bot form',
          fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }],
        },
      },
    }, f.now);
    assert.equal(await f.service.canViewLiveAction(f.member.id, action), true);
    assert.equal(await f.service.canViewLiveAction(outsider.id, action), false);
    assert.equal(await f.service.canViewLiveAction(manager.id, action), true);
    assert.deepEqual((await f.service.snapshot(f.member.id)).liveActions[0].audience, { visibility: 'private' });
    assert.deepEqual((await f.service.snapshot(manager.id)).liveActions[0].audience, action.audience);

    const form = await f.service.createNativeForm(f.owner.id, {
      channelId,
      durationMinutes: 30,
      audience: { visibility: 'private', userIds: [outsider.id], roleIds: ['private-action-members'] },
      form: {
        title: 'Private native form',
        fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }],
      },
    }, f.now);
    assert.equal((await f.service.snapshot(f.member.id)).nativeForms.some(entry => entry.id === form.id), true);
    assert.equal((await f.service.snapshot(outsider.id)).nativeForms.some(entry => entry.id === form.id), true);
    await f.service.submitNativeForm(f.member.id, {
      id: form.id, expectedRevision: form.revision, values: { answer: 'member' },
    }, f.now + 1);
    await f.service.submitNativeForm(outsider.id, {
      id: form.id, expectedRevision: form.revision, values: { answer: 'direct user' },
    }, f.now + 2);
    assert.equal((await f.service.nativeFormResults(manager.id, { id: form.id, limit: 50 })).responses.length, 2);
    const anonymousForm = await f.service.createNativeForm(f.owner.id, {
      channelId,
      durationMinutes: 30,
      form: {
        title: 'Anonymous native form',
        anonymous: true,
        fields: [{ name: 'answer', label: 'Answer', type: 'text', required: true }],
      },
    }, f.now);
    await f.service.submitNativeForm(f.member.id, {
      id: anonymousForm.id, expectedRevision: anonymousForm.revision, values: { answer: 'same answer' },
    }, f.now + 1);
    await f.service.submitNativeForm(outsider.id, {
      id: anonymousForm.id, expectedRevision: anonymousForm.revision, values: { answer: 'same answer' },
    }, f.now + 2);
    const anonymousResults = await f.service.nativeFormResults(
      manager.id, { id: anonymousForm.id, limit: 1 },
    );
    assert.equal(anonymousResults.responses[0]?.user, null);
    assert.deepEqual(anonymousResults.responses[0]?.response, { values: { answer: 'same answer' } });
    assert.ok(anonymousResults.nextCursor);
    assert.notEqual(anonymousResults.nextCursor, f.member.id);
    assert.notEqual(anonymousResults.nextCursor, outsider.id);
    const nextAnonymousResults = await f.service.nativeFormResults(manager.id, {
      id: anonymousForm.id, cursor: anonymousResults.nextCursor!, limit: 1,
    });
    assert.equal(nextAnonymousResults.responses[0]?.user, null);
    assert.deepEqual(nextAnonymousResults.responses[0]?.response, { values: { answer: 'same answer' } });

    await f.permissions.withRoleMutation(() => f.roleRepo.unassignRole(f.member.id, 'private-action-members'), {
      userId: f.member.id, roleId: 'private-action-members',
    });
    assert.equal(await f.service.canViewLiveAction(f.member.id, f.repository.liveAction(action.id)!), false);
    assert.equal((await f.service.snapshot(f.member.id)).nativeForms.some(entry => entry.id === form.id), false);
    await assert.rejects(f.service.submitNativeForm(f.member.id, {
      id: form.id, expectedRevision: form.revision, values: { answer: 'stale role' },
    }), CommunityError);
    await f.service.closeNativeForm(manager.id, form.id, f.now + 3);
  });

  test('private poll messages are non-disclosing in realtime, history, jumps, replies, search totals and cursors', async t => {
    const f = await setup(t);
    const outsider = await f.human('Private poll outsider');
    const manager = await f.human('Private poll manager');
    await f.roleRepo.create({
      id: 'private-poll-readers', name: 'Private poll readers', color: null, position: 2,
      permissions: DEFAULT_PERMISSIONS, isDefault: false, createdAt: f.now,
    });
    await f.roleRepo.assignRole(f.member.id, 'private-poll-readers');
    await f.roleRepo.create({
      id: 'private-poll-manager', name: 'Private poll manager', color: null, position: 3,
      permissions: DEFAULT_PERMISSIONS | Permission.MANAGE_SERVER, isDefault: false, createdAt: f.now,
    });
    await f.roleRepo.assignRole(manager.id, 'private-poll-manager');
    const channelId = text(records(record(f.owner.auth.payload.server).channels)
      .find(channel => channel.type === 'TEXT')?.id);
    const memberStart = f.member.peer.messages.length;
    const outsiderStart = outsider.peer.messages.length;
    const created = await f.owner.peer.request(MessageType.POLL_CREATE, {
      channelId,
      clientMessageId: 'private-poll-message',
      question: 'audiencepagination private poll',
      options: [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }],
      durationMinutes: 60,
      audience: { visibility: 'private', userIds: [], roleIds: ['private-poll-readers'] },
    });
    assert.equal(created.type, MessageType.CHAT_MESSAGE);
    await f.member.peer.barrier();
    await outsider.peer.barrier();
    assert.equal(f.member.peer.messages.slice(memberStart).some(message =>
      message.type === MessageType.CHAT_MESSAGE && message.payload.id === 'private-poll-message'), true);
    assert.equal(outsider.peer.messages.slice(outsiderStart).some(message =>
      message.type === MessageType.CHAT_MESSAGE && message.payload.id === 'private-poll-message'), false);

    const memberHistory = await f.chatService.loadHistory(channelId, 100, undefined, undefined, f.member.id);
    const outsiderHistory = await f.chatService.loadHistory(channelId, 100, undefined, undefined, outsider.id);
    const managerHistory = await f.chatService.loadHistory(channelId, 100, undefined, undefined, manager.id);
    assert.deepEqual(memberHistory.find(message => message.id === 'private-poll-message')?.poll?.audience, { visibility: 'private' });
    assert.equal(outsiderHistory.some(message => message.id === 'private-poll-message'), false);
    assert.deepEqual(managerHistory.find(message => message.id === 'private-poll-message')?.poll?.audience, {
      visibility: 'private', userIds: [], roleIds: ['private-poll-readers'],
    });
    assert.deepEqual(await f.chatService.loadHistory(
      channelId, 20, undefined, 'private-poll-message', outsider.id,
    ), []);
    await outsider.peer.error(MessageType.CHAT_SEND, {
      channelId, content: 'Cannot reply', replyToMessageId: 'private-poll-message',
    }, ProtocolErrorCode.BAD_REQUEST);

    for (let index = 0; index < 26; index++) {
      await f.messageRepo.create({
        id: `audience-public-${index}`,
        channelId,
        userId: f.owner.id,
        content: 'audiencepagination public message',
        createdAt: f.now + 100 + index,
        isSystem: false,
      });
    }
    const first = await f.searchService.search(outsider.id, { query: 'audiencepagination' });
    assert.equal(first.total, 26);
    assert.equal(first.messages.length, 25);
    assert.ok(first.nextCursor);
    assert.equal(first.messages.some(message => message.id === 'private-poll-message'), false);
    const second = await f.searchService.search(outsider.id, {
      query: 'audiencepagination', cursor: first.nextCursor,
    });
    assert.equal(second.total, 26);
    assert.equal(second.messages.length, 1);
    assert.equal(second.nextCursor, undefined);
    assert.equal((await f.searchService.search(f.member.id, { query: 'audiencepagination' })).total, 27);
    assert.equal((await f.searchService.search(manager.id, { query: 'audiencepagination' })).total, 27);

    const poll = f.polls.repository.findByMessageId('private-poll-message');
    assert.ok(poll);
    await outsider.peer.error(MessageType.POLL_VOTE, {
      id: poll.id, optionIds: [poll.options[0].id],
    }, ProtocolErrorCode.PERMISSION_DENIED);
    await f.permissions.withRoleMutation(() => f.roleRepo.unassignRole(f.member.id, 'private-poll-readers'), {
      userId: f.member.id, roleId: 'private-poll-readers',
    });
    assert.equal((await f.chatService.loadHistory(channelId, 100, undefined, undefined, f.member.id))
      .some(message => message.id === 'private-poll-message'), false);
    assert.equal((await f.searchService.search(f.member.id, { query: 'audiencepagination' })).total, 26);
    await f.member.peer.error(MessageType.POLL_VOTE, {
      id: poll.id, optionIds: [poll.options[0].id],
    }, ProtocolErrorCode.PERMISSION_DENIED);

    await f.channelService.updateChannel({
      channelId, isPrivate: true, allowedRoleIds: [], inheritCategoryPermissions: false,
    });
    assert.equal((await f.chatService.loadHistory(channelId, 100, undefined, undefined, manager.id))
      .some(message => message.id === 'private-poll-message'), false);
  });
  assert.equal(first.type, MessageType.NATIVE_FORM_SNAPSHOT);
  assert.equal(record(first.payload).responseCount, 1);
  assert.deepEqual(record(record(first.payload).myResponse).values, firstValues);
  const firstCreatedAt = Number(record(record(first.payload).myResponse).createdAt);

  const updatedValues = { ...firstValues, name: 'Updated', team: 'b' };
  const updated = await member.peer.request(MessageType.NATIVE_FORM_SUBMIT, {
    id: formId, expectedRevision: 0, values: updatedValues,
  });
  assert.equal(record(updated.payload).responseCount, 1);
  assert.deepEqual(record(record(updated.payload).myResponse).values, updatedValues);
  assert.equal(Number(record(record(updated.payload).myResponse).createdAt), firstCreatedAt);
  assert.ok(Number(record(record(updated.payload).myResponse).updatedAt) >= firstCreatedAt);

  const results = await owner.peer.request(MessageType.NATIVE_FORM_RESULTS, { id: formId });
  assert.equal(results.type, MessageType.NATIVE_FORM_RESULTS_RESULT);
  assert.equal(records(results.payload.responses).length, 1);
  assert.equal(record(records(results.payload.responses)[0].user).id, member.id);
  assert.deepEqual(record(record(records(results.payload.responses)[0]).response).values, updatedValues);

  assert.equal((await owner.peer.request(MessageType.NATIVE_FORM_CLOSE, { id: formId })).type, MessageType.COMMUNITY_ACK);
  assert.equal(records((await member.peer.request(MessageType.COMMUNITY_GET)).payload.nativeForms).length, 0);
  const closedAt = f.communityService.repository.nativeForm(formId)?.closedAt;
  assert.ok(closedAt);
  f.communityService.advance(closedAt + 30 * 86_400_000 - 1);
  assert.ok(f.communityService.repository.nativeForm(formId));
  f.communityService.advance(closedAt + 30 * 86_400_000);
  assert.equal(f.communityService.repository.nativeForm(formId), undefined);
  assert.equal(f.communityService.repository.nativeFormResponse(formId, member.id), undefined);
});

test('native polls persist in chat, personalize votes and close at the voter limit', async t => {
  const f = await createApprovedBotFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Poll owner');
  const member = await f.human('Poll member');
  await owner.peer.request(MessageType.COMMUNITY_UPDATE_SETTINGS, { eventsEnabled: true });
  const channelId = text(records(record(owner.auth.payload.server).channels).find(channel => channel.type === 'TEXT')?.id);
  const memberStart = member.peer.messages.length;
  const created = await owner.peer.request(MessageType.POLL_CREATE, {
    channelId,
    clientMessageId: 'native-poll-message',
    question: 'Which release?',
    options: [{ label: 'Stable', emoji: '✅' }, { label: 'Beta', emoji: null }],
    durationMinutes: 60,
    maxVoters: 2,
    liveAction: true,
  });
  const retried = await owner.peer.request(MessageType.POLL_CREATE, {
    channelId,
    clientMessageId: 'native-poll-message',
    question: 'Which release?',
    options: [{ label: 'Stable', emoji: '✅' }, { label: 'Beta', emoji: null }],
    durationMinutes: 60,
    maxVoters: 2,
    liveAction: true,
  });
  assert.equal(record(retried.payload.poll).id, record(created.payload.poll).id);
  await owner.peer.error(MessageType.POLL_CREATE, {
    channelId,
    clientMessageId: 'native-poll-message',
    question: 'Changed retry',
    options: [{ label: 'Stable', emoji: '✅' }, { label: 'Beta', emoji: null }],
    durationMinutes: 60,
    maxVoters: 2,
    liveAction: true,
  }, ProtocolErrorCode.BAD_REQUEST);
  await owner.peer.error(MessageType.POLL_CREATE, {
    channelId,
    question: 'Invalid emoji?',
    options: [{ label: 'Yes', emoji: 'not an emoji' }, { label: 'No', emoji: null }],
    durationMinutes: 60,
  }, ProtocolErrorCode.BAD_REQUEST);
  await member.peer.error(MessageType.POLL_CREATE, {
    channelId,
    clientMessageId: 'member-live-poll',
    question: 'Unauthorized live action?',
    options: [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }],
    durationMinutes: 60,
    liveAction: true,
  }, ProtocolErrorCode.PERMISSION_DENIED);

  assert.equal(created.type, MessageType.CHAT_MESSAGE, JSON.stringify(created.payload));
  assert.equal(record(created.payload.poll).question, 'Which release?');
  assert.equal(records(record(created.payload.poll).options)[0].emoji, '✅');
  assert.deepEqual(record(created.payload.poll).myVoteOptionIds, []);
  const delivered = await member.peer.wait(message =>
    message.type === MessageType.CHAT_MESSAGE && message.payload.id === 'native-poll-message', memberStart);
  const pollId = text(record(delivered.payload.poll).id);
  const options = records(record(delivered.payload.poll).options);
  const stableId = text(options[0].id);
  const betaId = text(options[1].id);
  await member.peer.error(MessageType.POLL_VOTE, { id: pollId, optionIds: ['missing'] }, ProtocolErrorCode.BAD_REQUEST);
  const first = await member.peer.request(MessageType.POLL_VOTE, { id: pollId, optionIds: [stableId] });
  assert.equal(first.type, MessageType.POLL_UPDATED);
  assert.deepEqual(first.payload.myVoteOptionIds, [stableId]);
  assert.equal(first.payload.totalVotes, 1);
  const changed = await member.peer.request(MessageType.POLL_VOTE, { id: pollId, optionIds: [betaId] });
  assert.deepEqual(changed.payload.myVoteOptionIds, [betaId]);
  assert.equal(records(changed.payload.options).find(option => option.id === stableId)?.votes, 0);
  const closed = await owner.peer.request(MessageType.POLL_VOTE, { id: pollId, optionIds: [stableId] });
  assert.equal(closed.payload.totalVotes, 2);
  assert.ok(closed.payload.closedAt);
  await member.peer.error(MessageType.POLL_VOTE, { id: pollId, optionIds: [stableId] }, ProtocolErrorCode.BAD_REQUEST);
  const ownerHistory = await owner.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
  const ownerMessage = records(ownerHistory.payload.messages).find(message => message.id === 'native-poll-message');
  assert.deepEqual(record(ownerMessage?.poll).myVoteOptionIds, [stableId]);
  const memberHistory = await member.peer.request(MessageType.CHAT_LOAD_HISTORY, { channelId });
  const memberMessage = records(memberHistory.payload.messages).find(message => message.id === 'native-poll-message');
  assert.deepEqual(record(memberMessage?.poll).myVoteOptionIds, [betaId]);
  assert.equal(records(record(memberMessage?.poll).options).reduce((sum, option) => sum + Number(option.votes), 0), 2);
  assert.equal(records((await member.peer.request(MessageType.COMMUNITY_GET)).payload.polls).length, 0);

  const manual = await owner.peer.request(MessageType.POLL_CREATE, {
    channelId,
    clientMessageId: 'manual-close-poll',
    question: 'Close manually?',
    options: [{ label: 'Yes', emoji: null }, { label: 'No', emoji: null }],
    durationMinutes: 60,
    liveAction: true,
  });
  const manualId = text(record(manual.payload.poll).id);
  await member.peer.error(MessageType.POLL_CLOSE, { id: manualId }, ProtocolErrorCode.PERMISSION_DENIED);
  const manuallyClosed = await owner.peer.request(MessageType.POLL_CLOSE, { id: manualId });
  assert.equal(manuallyClosed.type, MessageType.POLL_UPDATED);
  assert.ok(manuallyClosed.payload.closedAt);
  assert.equal(records((await member.peer.request(MessageType.COMMUNITY_GET)).payload.polls).length, 0);
});

test('native poll votes and automatic closing survive a database restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-native-poll-'));
  const filename = path.join(root, 'server.db');
  let database = await DatabaseConnection.create(filename);
  t.after(() => {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  database.getDb().exec(`
    INSERT INTO server_meta (id,name,password_hash,created_at) VALUES ('server','Test','',1);
    INSERT INTO users (id,client_id,nickname,created_at,last_seen_at) VALUES
      ('owner','owner-device','Owner',1,1), ('member','member-device','Member',1,1);
    INSERT INTO channels (id,server_id,name,type,created_at) VALUES ('chat','server','chat','TEXT',1);
  `);
  let service = new NativePollService(new SqliteNativePollRepository(database.getDb()));
  const created = service.create('owner', {
    channelId: 'chat', clientMessageId: 'message', question: 'Persistent?',
    options: [{ label: 'Yes', emoji: '👍' }, { label: 'No', emoji: null }], durationMinutes: 1, liveAction: true,
  }, 1_000);
  const optionId = created.poll.options[0].id;
  service.vote('member', created.poll.id, [optionId], 2_000);
  database.close();
  database = await DatabaseConnection.create(filename);
  service = new NativePollService(new SqliteNativePollRepository(database.getDb()));
  const restored = service.publicPoll(service.get(created.poll.id), 'member');
  assert.deepEqual(restored.myVoteOptionIds, [optionId]);
  assert.equal(restored.options[0].emoji, '👍');
  assert.equal(restored.totalVotes, 1);
  assert.equal(service.activeLiveActions('member', 60_999).length, 1);
  assert.equal(service.advance(61_000).length, 1);
  assert.equal(service.publicPoll(service.get(created.poll.id), 'member').closedAt, 61_000);
  assert.equal(service.activeLiveActions('member', 61_000).length, 0);
});

test('native polls accept several answers atomically and retain staged carousel images', async t => {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Poll owner');
  const member = await f.human('Poll member');
  const channelId = text(records(record(owner.auth.payload.server).channels)
    .find(channel => channel.type === 'TEXT')?.id);
  const uploaded = await owner.peer.request(MessageType.COMMUNITY_IMAGE_UPLOAD, {
    channelId,
    imageData: PNG_DATA,
  });
  const ref = text(uploaded.payload.ref);
  const created = await owner.peer.request(MessageType.POLL_CREATE, {
    channelId,
    clientMessageId: 'multiple-poll',
    question: 'Choose every match',
    options: [{ label: 'One', emoji: null }, { label: 'Two', emoji: null }],
    allowMultiple: true,
    imageAssetRefs: [ref],
    maxVoters: 1,
  });
  const poll = record(created.payload.poll);
  const optionIds = records(poll.options).map(option => text(option.id));
  assert.ok(Array.isArray(poll.imageUrls));
  const imageUrl = text(poll.imageUrls[0]);
  assert.ok(f.avatars.getAvatarFile(imageUrl.split('/').pop()!));
  const voted = await member.peer.request(MessageType.POLL_VOTE, { id: text(poll.id), optionIds });
  const selected = voted.payload.myVoteOptionIds;
  assert.ok(Array.isArray(selected));
  assert.deepEqual([...selected].sort(), [...optionIds].sort());
  assert.equal(voted.payload.totalVotes, 1);
  assert.deepEqual(records(voted.payload.options).map(option => option.votes), [1, 1]);
  assert.ok(voted.payload.closedAt);
});

test('interested members receive a start notice once, including manual starts, and never before start', async t => {
  const f = await setup(t);
  const saved = await f.owner.peer.request(MessageType.EVENT_SAVE, f.draft);
  assert.equal(saved.type, MessageType.EVENT_SAVED);
  const event = record(saved.payload.event);
  await f.member.peer.request(MessageType.EVENT_INTEREST, { id: event.id, interested: true });
  assert.equal(f.member.peer.messages.filter(message => message.type === MessageType.EVENT_STARTED).length, 0);
  const started = await f.owner.peer.request(MessageType.EVENT_CONTROL, { id: event.id, expectedRevision: 0, action: 'start' });
  assert.equal(started.type, MessageType.COMMUNITY_ACK);
  await f.member.peer.wait(message => message.type === MessageType.EVENT_STARTED);
  assert.equal(f.member.peer.messages.filter(message => message.type === MessageType.EVENT_STARTED).length, 1);
  assert.equal(f.owner.peer.messages.filter(message => message.type === MessageType.EVENT_STARTED).length, 0);
});

test('automatic start notices survive an in-progress permission change without duplicate delivery', async t => {
  const f = await setup(t);
  const event = await f.service.saveEvent(f.owner.id, {
    ...f.draft, startsAt: Date.now() + 150, endsAt: Date.now() + 60000,
  });
  await f.service.setInterest(f.member.id, event.id, true);
  let accessPending = true;
  const original = f.wsServer.getChannelAccessVersion;
  t.mock.method(f.wsServer, 'getChannelAccessVersion', () => accessPending ? null : original.call(f.wsServer));
  const deadline = Date.now() + 4000;
  while (f.repository.event(event.id)?.status !== 'active' && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(f.repository.event(event.id)?.status, 'active');
  assert.equal(f.member.peer.messages.filter(message => message.type === MessageType.EVENT_STARTED).length, 0);
  accessPending = false;
  await f.member.peer.wait(message => message.type === MessageType.EVENT_STARTED);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(f.member.peer.messages.filter(message => message.type === MessageType.EVENT_STARTED).length, 1);
});
