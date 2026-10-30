import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { LIMITS, ProtocolErrorCode } from '@monky/shared';
import { CommunityError } from './application/services/CommunityService';
import { createFixture, record, records, text } from './testFixtures/bots';

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const PNG_DATA = `data:image/png;base64,${PNG}`;
const GIF = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

async function setup(t: TestContext) {
  const f = await createFixture();
  t.after(() => f.dispose());
  const owner = await f.human('Image owner');
  const channelId = text(records(record(owner.auth.payload.server).channels).find((channel) => channel.type === 'TEXT')?.id);
  const created = await f.botService.create(owner.id);
  assert.ok(created.success);
  const avatarsDir = path.join(f.dataDir, 'avatars');
  return { ...f, owner, channelId, botId: created.bot.id, files: () => fs.readdirSync(avatarsDir).sort() };
}

test('avatars, the server icon, community images and bot avatars read an upload by one rule (S-APP-9)', async (t) => {
  const f = await setup(t);
  const refused = {
    'invalid characters': 'not base64!',
    'line breaks': `${PNG.slice(0, 40)}\n${PNG.slice(40)}`,
    // Same bytes as PNG, but the unused low bits of the last character are set.
    'non-canonical padding': `${PNG.slice(0, -2)}J=`,
    'a GIF data URL': `data:image/gif;base64,${GIF}`,
    'GIF bytes': GIF,
  };
  for (const [name, input] of Object.entries(refused)) {
    const avatar = await f.userService.updateAvatar(f.owner.id, input);
    assert.equal(avatar.success, false, `avatar: ${name}`);
    assert.equal(avatar.errorCode, ProtocolErrorCode.AVATAR_INVALID_TYPE, `avatar: ${name}`);
    const icon = await f.authService.updateServerSettings({ iconBase64: input });
    assert.equal(icon.success, false, `icon: ${name}`);
    assert.ok(icon.errorMessage, `icon: ${name}`);
    await assert.rejects(f.communityService.stageImage(f.owner.id, f.channelId, input),
      (error) => error instanceof CommunityError && error.code === ProtocolErrorCode.COMMUNITY_INVALID, `community: ${name}`);
    const bot = await f.botService.updateProfile(f.botId, { avatarBase64: input });
    assert.equal(bot.success, false, `bot: ${name}`);
    if (!bot.success) assert.equal(bot.errorCode, ProtocolErrorCode.AVATAR_INVALID_TYPE, `bot: ${name}`);
  }
  assert.equal((await f.userRepo.findById(f.owner.id))?.avatarPath, null);
  assert.equal((await f.serverRepo.getServer())?.iconPath, null);
  assert.deepEqual(f.files(), [], 'nothing refused reached the disk');

  // The size is checked before decoding, and said as such.
  const huge = 'A'.repeat(Math.ceil((LIMITS.MAX_AVATAR_SIZE + 1) / 3) * 4);
  const tooLarge = await f.userService.updateAvatar(f.owner.id, huge);
  assert.equal(tooLarge.errorCode, ProtocolErrorCode.AVATAR_TOO_LARGE);
  const tooLargeBot = await f.botService.updateProfile(f.botId, { avatarBase64: huge });
  assert.equal(tooLargeBot.success, false);
  if (!tooLargeBot.success) assert.equal(tooLargeBot.errorCode, ProtocolErrorCode.AVATAR_TOO_LARGE);

  for (const input of [PNG, PNG_DATA]) {
    assert.equal((await f.userService.updateAvatar(f.owner.id, input)).success, true);
    assert.equal((await f.authService.updateServerSettings({ iconBase64: input })).success, true);
    assert.match((await f.communityService.stageImage(f.owner.id, f.channelId, input)).url, /\.png$/);
    assert.equal((await f.botService.updateProfile(f.botId, { avatarBase64: input })).success, true);
  }

  // Older desktop apps labeled a picture by its file name; people keep that, bots must say what they send.
  const mislabeled = `data:image/jpeg;base64,${PNG}`;
  const person = await f.userService.updateAvatar(f.owner.id, mislabeled);
  assert.match(text(person.updatedUser?.avatarUrl), /\.png$/);
  const bot = await f.botService.updateProfile(f.botId, { avatarBase64: mislabeled });
  assert.equal(bot.success, false);
  if (!bot.success) assert.equal(bot.errorCode, ProtocolErrorCode.AVATAR_INVALID_TYPE);
});

test('a replaced avatar or icon keeps the previous file until the new one is recorded (S-APP-9)', async (t) => {
  const f = await setup(t);
  assert.equal((await f.userService.updateAvatar(f.owner.id, PNG_DATA)).success, true);
  assert.equal((await f.authService.updateServerSettings({ iconBase64: PNG_DATA })).success, true);
  const avatar = text((await f.userRepo.findById(f.owner.id))?.avatarPath);
  const icon = text((await f.serverRepo.getServer())?.iconPath);
  const stored = f.files();
  assert.deepEqual(stored, [avatar, icon].sort());

  const updateUser = f.userRepo.update;
  f.userRepo.update = async () => { throw new Error('disk full'); };
  await assert.rejects(f.userService.updateAvatar(f.owner.id, PNG_DATA), /disk full/);
  f.userRepo.update = updateUser;
  const updateServer = f.serverRepo.updateServer;
  f.serverRepo.updateServer = async () => { throw new Error('disk full'); };
  await assert.rejects(f.authService.updateServerSettings({ iconBase64: PNG_DATA }), /disk full/);
  f.serverRepo.updateServer = updateServer;

  assert.equal((await f.userRepo.findById(f.owner.id))?.avatarPath, avatar);
  assert.equal((await f.serverRepo.getServer())?.iconPath, icon);
  assert.deepEqual(f.files(), stored, 'the previous files are kept and the unrecorded ones removed');

  // Once recorded, the replacement takes the previous file's place.
  assert.equal((await f.userService.updateAvatar(f.owner.id, PNG)).success, true);
  assert.equal((await f.authService.updateServerSettings({ iconBase64: PNG })).success, true);
  const current = [text((await f.userRepo.findById(f.owner.id))?.avatarPath), text((await f.serverRepo.getServer())?.iconPath)];
  assert.deepEqual(f.files(), current.sort());
  assert.ok(!current.includes(avatar) && !current.includes(icon));

  // Removing one clears the record before its file.
  assert.equal((await f.userService.updateAvatar(f.owner.id, null)).success, true);
  assert.equal((await f.authService.updateServerSettings({ iconBase64: null })).success, true);
  assert.deepEqual(f.files(), []);
});
