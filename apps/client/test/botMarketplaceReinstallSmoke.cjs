const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { test } = require('node:test');
const { BotClient, MessageType } = require('@monky/bot-sdk');
const repoRoot = path.resolve(__dirname, '..', '..', '..');
const { createFixture, identity } = require(path.join(repoRoot, 'apps', 'server', 'dist', 'testFixtures', 'bots.js'));

test('real marketplace install, private command, unlink and relink preserve the bot identity', { timeout: 60_000 }, async t => {
  const fixture = await createFixture();
  let bot;
  t.after(async () => {
    await bot?.close();
    await fixture.dispose();
  });
  const owner = await fixture.human('Marketplace owner');
  const publicKey = identity().publicKey;
  const registrationFile = path.join(fixture.dataDir, 'bot-registrations.json');
  const errors = [];
  const startBot = () => {
    bot = new BotClient({
      publicKey, requestedCapabilities: ['commands'], registrationFile,
      name: 'Reinstall fixture', avatarBase64: null, autoReconnect: false,
    });
    bot.on('error', error => errors.push(error));
    bot.command({ name: 'ping', description: 'Check this installation', handler: ctx => ctx.reply('Fixture pong') });
    return bot;
  };
  let listener = await startBot().serve({
    name: 'Reinstall fixture', port: 0, host: '127.0.0.1', publicHost: '127.0.0.1',
  });
  const install = async () => {
    const preview = await owner.peer.request(MessageType.BOT_INSTALL_PREVIEW, {
      manifestUrl: `http://127.0.0.1:${listener.address().port}/manifest`,
    });
    assert.equal(preview.type, MessageType.BOT_INSTALL_PREVIEW_RESULT);
    const installed = await owner.peer.request(MessageType.BOT_INSTALL, {
      previewId: preview.payload.previewId, grantedCapabilities: ['commands'],
    });
    assert.equal(installed.type, MessageType.BOT_INSTALLED);
    assert.deepEqual(installed.payload.bot.permissions.granted, ['commands']);
    return installed.payload.bot.id;
  };
  const assertCommand = async botId => {
    const catalog = await owner.peer.request(MessageType.COMMANDS_LIST);
    assert.equal(catalog.type, MessageType.COMMANDS_LIST_RESPONSE);
    assert.ok(catalog.payload.commands.some(command => command.botId === botId && command.name === 'ping'));
    const channelId = owner.auth.payload.server.channels.find(channel => channel.type === 'TEXT').id;
    const before = owner.peer.messages.length;
    const invoked = await owner.peer.request(MessageType.COMMAND_INVOKE, { botId, commandName: 'ping', channelId });
    assert.equal(invoked.type, MessageType.COMMAND_INVOKED);
    const response = await owner.peer.wait(message => message.type === MessageType.COMMAND_RESPONSE
      && message.payload.invocationId === invoked.payload.invocationId, before);
    assert.equal(response.payload.content, 'Fixture pong');
    assert.equal(response.payload.ephemeral, true);
  };
  const firstId = await install();
  await assertCommand(firstId);
  const before = JSON.parse(fs.readFileSync(registrationFile, 'utf8'));
  assert.equal(before.publicKey, publicKey);
  assert.equal(before.registrations.length, 1);
  const revoked = once(bot, 'message');
  assert.equal((await owner.peer.request(MessageType.BOT_REVOKE, { botId: firstId })).type, MessageType.BOT_REVOKED);
  assert.equal((await revoked)[0].type, MessageType.BOT_REVOKED);
  const secondId = await install();
  assert.notEqual(secondId, firstId);
  await assertCommand(secondId);
  const after = JSON.parse(fs.readFileSync(registrationFile, 'utf8'));
  assert.equal(after.publicKey, publicKey);
  assert.equal(after.registrations.length, 1);
  assert.notEqual(after.registrations[0].token, before.registrations[0].token);
  assert.deepEqual(errors, []);

  // An older SDK may have been offline when its saved token was revoked.
  await bot.close();
  assert.equal((await owner.peer.request(MessageType.BOT_REVOKE, { botId: secondId })).type, MessageType.BOT_REVOKED);
  startBot();
  const rejected = once(bot, 'auth_failed');
  listener = await bot.serve({ name: 'Reinstall fixture', port: 0, host: '127.0.0.1', publicHost: '127.0.0.1' });
  await rejected;
  const restoredId = await install();
  await assertCommand(restoredId);
  const restored = JSON.parse(fs.readFileSync(registrationFile, 'utf8'));
  assert.equal(restored.publicKey, publicKey);
  assert.equal(restored.registrations.length, 1);
  assert.equal(errors.length, 1, 'Only the explicitly rejected old token is expected');
});

test('one real bot links to two server endpoints without mixing tokens or changing its identity', { timeout: 60_000 }, async t => {
  const vps = await createFixture();
  let pc, bot;
  t.after(async () => {
    await bot?.close();
    await pc?.dispose();
    await vps.dispose();
  });
  pc = await createFixture({ webSocketPath: '/monky/callback?route=pc' });
  const vpsOwner = await vps.human('VPS owner');
  const pcOwner = await pc.human('PC owner');
  const publicKey = identity().publicKey;
  const registrationFile = path.join(vps.dataDir, 'multi-server-registrations.json');
  const errors = [];
  bot = new BotClient({
    publicKey, requestedCapabilities: ['commands'], registrationFile,
    name: 'Multi-server fixture', avatarBase64: null, autoReconnect: false,
  });
  bot.on('error', error => errors.push(error));
  bot.command({ name: 'ping', description: 'Check this server', handler: ctx => ctx.reply('Pong from this registration') });
  const listener = await bot.serve({
    name: 'Multi-server fixture', port: 0, host: '127.0.0.1', publicHost: '127.0.0.1',
  });
  const install = async owner => {
    const preview = await owner.peer.request(MessageType.BOT_INSTALL_PREVIEW, {
      manifestUrl: `http://127.0.0.1:${listener.address().port}/manifest`,
    });
    assert.equal(preview.type, MessageType.BOT_INSTALL_PREVIEW_RESULT);
    const installed = await owner.peer.request(MessageType.BOT_INSTALL, {
      previewId: preview.payload.previewId, grantedCapabilities: ['commands'],
    });
    assert.equal(installed.type, MessageType.BOT_INSTALLED);
    return installed.payload.bot.id;
  };
  const vpsId = await install(vpsOwner);
  const vpsRegistration = JSON.parse(fs.readFileSync(registrationFile, 'utf8')).registrations[0];
  const pcId = await install(pcOwner);
  assert.notEqual(vpsId, pcId);
  assert.equal(bot.serverCount, 2);
  const saved = JSON.parse(fs.readFileSync(registrationFile, 'utf8'));
  assert.equal(saved.publicKey, publicKey);
  assert.equal(saved.registrations.length, 2);
  assert.deepEqual(saved.registrations.find(entry => entry.serverId === vpsId), vpsRegistration);
  assert.equal(saved.registrations.find(entry => entry.serverId === pcId).serverUrl,
    `${pc.url}/monky/callback?route=pc`);
  assert.notEqual(saved.registrations[0].token, saved.registrations[1].token);
  for (const [owner, botId, otherId] of [[vpsOwner, vpsId, pcId], [pcOwner, pcId, vpsId]]) {
    const catalog = await owner.peer.request(MessageType.COMMANDS_LIST);
    assert.ok(catalog.payload.commands.some(command => command.botId === botId && command.name === 'ping'));
    assert.ok(catalog.payload.commands.every(command => command.botId !== otherId));
  }
  const revoked = once(bot, 'message');
  assert.equal((await pcOwner.peer.request(MessageType.BOT_REVOKE, { botId: pcId })).type, MessageType.BOT_REVOKED);
  assert.equal((await revoked)[0].type, MessageType.BOT_REVOKED);
  // A new installation waits for the serialized removal before saving its own credentials.
  await install(pcOwner);
  const relinked = JSON.parse(fs.readFileSync(registrationFile, 'utf8'));
  assert.equal(relinked.publicKey, publicKey);
  assert.equal(relinked.registrations.length, 2);
  assert.deepEqual(relinked.registrations.find(entry => entry.serverId === vpsId), vpsRegistration);
  assert.deepEqual(errors, []);
});
