import assert from 'node:assert/strict';
import test from 'node:test';
import { discordWebCommandSchema, discordWebLayersSchema, discordWebRouting, discordWebShowsServers, discordWebUrl } from '../src/index.js';

test('discordWebRouting marks only Discord\'s entry address, whose shape is not known yet', () => {
  for (const routing of ['https://discord.com/app', 'https://discord.com/app/', 'https://ptb.discord.com/app?x=1'])
    assert.equal(discordWebRouting(routing), true, routing);
  for (const settled of ['https://discord.com/login', 'https://discord.com/channels/@me', 'https://discord.com/apps',
    'https://evil.example/app', 'http://discord.com/app']) assert.equal(discordWebRouting(settled), false, settled);
});

test('discordWebShowsServers splits only the signed-in app, never login or other sites', () => {
  for (const split of ['https://discord.com/channels/@me', 'https://discord.com/channels/1/2', 'https://ptb.discord.com/store',
    'https://discord.com/discovery/servers']) assert.equal(discordWebShowsServers(split), true, split);
  for (const whole of ['https://discord.com/login', 'https://discord.com/app', 'https://discord.com/channelsx',
    'https://discord.com/register', 'https://evil.example/channels/@me', 'http://discord.com/channels/@me'])
    assert.equal(discordWebShowsServers(whole), false, whole);
});

test('discordWebUrl only accepts HTTPS pages of Discord itself', () => {
  assert.equal(discordWebUrl('https://discord.com/app'), 'https://discord.com/app');
  assert.equal(discordWebUrl('https://ptb.discord.com/channels/@me'), 'https://ptb.discord.com/channels/@me');
  assert.equal(discordWebUrl('https://discordapp.com/login'), 'https://discordapp.com/login');
  for (const rejected of [
    'http://discord.com/app',
    'https://discord.com.evil.example/app',
    'https://evildiscord.com/app',
    'https://user:pass@discord.com/app',
    'https://discord.com:8443/app',
    'javascript:alert(1)',
    'https://discord.com/ app',
    'not a url',
  ]) assert.equal(discordWebUrl(rejected), null, rejected);
});

test('discordWebCommandSchema accepts only the known commands, without extra fields', () => {
  const accepted = [
    { action: 'layout', width: 1200, height: 800, visible: true },
    { action: 'mouse', type: 'down', x: 36, y: 140, button: 'left', clickCount: 1, modifiers: [] },
    { action: 'wheel', x: 10, y: 10, deltaX: 0, deltaY: -120, modifiers: ['shift'] },
    { action: 'key', type: 'char', keyCode: 'á', modifiers: [] },
    { action: 'close' },
  ];
  for (const command of accepted) assert.equal(discordWebCommandSchema.safeParse(command).success, true, JSON.stringify(command));
  for (const rejected of [
    { action: 'layout', width: 0, height: 800, visible: true },
    { action: 'layout', width: 1.5, height: 800, visible: true },
    { action: 'mouse', type: 'down', x: Number.NaN, y: 0, modifiers: [] },
    { action: 'key', type: 'down', keyCode: '', modifiers: [] },
    { action: 'key', type: 'down', keyCode: 'a', modifiers: ['hyper'] },
    { action: 'navigate', url: 'https://discord.com/app' },
    { action: 'executeJavaScript', code: '1' },
    { action: 'close', url: 'https://evil.example' },
  ]) assert.equal(discordWebCommandSchema.safeParse(rejected).success, false, JSON.stringify(rejected));
});

test('discordWebLayersSchema takes only boxes of menus and tooltips, a few at most, and the server list\'s scroll', () => {
  const menu = { kind: 'menu', x: 80, y: 120, width: 220, height: 300, radius: 8, shown: true };
  const servers = { top: 32, height: 1252, scrollTop: 0, scrollHeight: 1273, panel: 66 };
  assert.equal(discordWebLayersSchema.safeParse({ popups: [menu, { ...menu, kind: 'tooltip', shown: false }], modal: false, servers }).success, true);
  assert.equal(discordWebLayersSchema.safeParse({ popups: [], modal: true, servers: null }).success, true);
  for (const rejected of [
    { popups: [{ ...menu, kind: 'dialog' }], modal: false, servers },
    { popups: [{ ...menu, width: Number.POSITIVE_INFINITY }], modal: false, servers },
    { popups: [{ ...menu, text: 'Convidar' }], modal: false, servers },
    { popups: [{ ...menu, shown: undefined }], modal: false, servers },
    { popups: Array.from({ length: 9 }, () => menu), modal: false, servers },
    { popups: [], modal: 'yes', servers },
    { popups: [], modal: false, servers, html: '<b>' },
    { popups: [], modal: false, servers: { ...servers, scrollTop: -1 } },
    { popups: [], modal: false, servers: { ...servers, names: ['Lichii'] } },
    { popups: [], modal: false, servers: { ...servers, panel: -1 } },
    { popups: [], modal: false, servers: { top: 32, height: 1252, scrollTop: 0, scrollHeight: 1273 } },
  ]) assert.equal(discordWebLayersSchema.safeParse(rejected).success, false, JSON.stringify(rejected));
});