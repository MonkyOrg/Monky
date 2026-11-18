const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtempSync, readFileSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const http = require('node:http');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const shared = require('@monky/shared');
const { loadMain, fakeIpcMain } = require('./mainModules.cjs');
const { AutomationStore } = loadMain('automation/AutomationStore');
const { AutomationService } = loadMain('automation/AutomationService');

function profile(t) {
  const directory = mkdtempSync(join(tmpdir(), 'monky-mcp-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('tool schemas reject arbitrary commands, excessive history, ambiguous destinations and invalid event dates', () => {
  assert.equal(shared.messageLengthLimitFor(null), shared.LIMITS.MAX_MESSAGE_LENGTH);
  assert.equal(shared.messageLengthLimitFor({}), 2000);
  assert.equal(shared.messageLengthLimitFor({ maxMessageLength: 0 }), 0);
  assert.equal(shared.messageLengthLimitFor({ maxMessageLength: 80 }), 80);
  const parse = (tool, args) => shared.automationCommandSchema.safeParse({ tool, args }).success;
  assert.equal(parse('execute_js', { code: 'process.exit()' }), false);
  assert.equal(parse('list_channels', {}), false);
  assert.equal(parse('list_channels', { sessionRef: 'socket', shell: 'anything' }), false);
  assert.equal(parse('read_messages', { sessionRef: 'socket', channelId: 'chat', limit: 51 }), false);
  assert.equal(parse('send_message', { sessionRef: 'socket', channelId: 'chat', content: 'hello' }), false);
  const event = { title: 'Meeting', description: '', startsAt: 1000, endsAt: 2000, timeZone: 'UTC', location: { kind: 'voice', channelId: 'voice' } };
  assert.equal(parse('create_event', { sessionRef: 'socket', event }), true);
  assert.equal(parse('create_event', { sessionRef: 'socket', event: { ...event, endsAt: null } }), false);
  assert.equal(parse('create_event', { sessionRef: 'socket', event: { ...event, endsAt: 999 } }), false);
  assert.equal(parse('create_event', { sessionRef: 'socket', event: { ...event, timeZone: 'unknown' } }), false);
});

async function fixture(t, execute = async () => ({ ok: true, data: { connectedServers: 1 } })) {
  const store = new AutomationStore(profile(t));
  const service = new AutomationService(store, execute);
  t.after(() => service.close());
  const enabled = await service.mutate({ action: 'enable', enabled: true });
  assert.equal(enabled.error, undefined);
  assert.ok(enabled.snapshot.url);
  const created = await service.mutate({ action: 'save', connection: {
    name: 'Personal assistant', serverIds: ['server-a'], capabilities: ['read'],
  } });
  assert.ok(created.credential);
  return { store, service, credential: created.credential, url: created.snapshot.url };
}

test('credentials are private, hashed, persistent and independently revocable', async t => {
  const { store, service, credential } = await fixture(t);
  assert.equal(store.authenticate(credential.token).name, 'Personal assistant');
  assert.equal(store.authenticate('wrong'), undefined);
  assert.equal(JSON.stringify(store.snapshot()).includes('tokenHash'), false);
  assert.equal(readFileSync(store.file, 'utf8').includes(credential.token), false);
  const reloaded = new AutomationStore(require('node:path').dirname(store.file));
  assert.equal(reloaded.authenticate(credential.token).id, credential.id);
  const rotated = await service.mutate({ action: 'rotate', id: credential.id });
  assert.ok(rotated.credential.token);
  assert.equal(store.authenticate(credential.token), undefined);
  assert.ok(store.authenticate(rotated.credential.token));
  await service.mutate({ action: 'revoke', id: credential.id });
  assert.equal(store.authenticate(rotated.credential.token), undefined);
});

test('a real MCP client discovers permitted tools and invocation still enforces grants', async t => {
  let calls = 0;
  const { service, url, credential } = await fixture(t, async () => {
    calls++;
    return { ok: true, data: { connectedServers: 1 } };
  });
  const client = new Client({ name: 'automation-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
  }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 7);
  assert.ok(tools.some(tool => tool.name === 'read_messages' && tool.inputSchema.properties.limit.maximum === 50));
  assert.equal(tools.some(tool => tool.name === 'send_message'), false);
  const result = await client.callTool({ name: 'get_state', arguments: {} });
  assert.equal(result.isError, false);
  assert.deepEqual(result.structuredContent, { connectedServers: 1 });
  const denied = await client.callTool({ name: 'send_message', arguments: {
    sessionRef: 'socket', channelId: 'chat', clientMessageId: randomUUID(), content: 'private message',
  } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /not_authorized/);
  assert.equal(calls, 1);
  const audit = service.snapshot().audit;
  assert.equal(audit.length, 1);
  assert.equal(JSON.stringify(audit).includes('private message'), false);
  await service.mutate({ action: 'revoke', id: credential.id });
  await assert.rejects(client.listTools());
});

test('HTTP rejects missing credentials, foreign origins and hosts, invalid methods and oversized bodies', async t => {
  const { url, credential } = await fixture(t);
  const headers = { Authorization: `Bearer ${credential.token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://foreign.example' }, body: '{}' })).status, 403);
  const foreignHost = await new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { ...headers, Host: 'foreign.example' } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(foreignHost, 403);
  assert.equal((await fetch(url, { headers })).status, 405);
  assert.equal((await fetch(url + '/other', { method: 'POST', headers, body: '{}' })).status, 404);
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'invalid' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers, body: 'x'.repeat(65537) })).status, 413);
});

test('revocation cancels in-flight work and discards its late content', async t => {
  let complete;
  let executionSignal;
  const { service, store, credential } = await fixture(t, (_command, _grant, signal) => {
    executionSignal = signal;
    return new Promise(resolve => { complete = resolve; });
  });
  const pending = service.run(store.get(credential.id), { tool: 'get_state', args: {} }, new AbortController().signal);
  await service.mutate({ action: 'revoke', id: credential.id });
  assert.equal(executionSignal.aborted, true);
  complete({ ok: true, data: { connectedServers: 42 } });
  assert.deepEqual(await pending, { ok: false, code: 'cancelled' });
});

test('disconnecting an MCP request cancels its executor', { timeout: 5000 }, async t => {
  let started;
  const running = new Promise(resolve => { started = resolve; });
  let cancelled;
  const stopped = new Promise(resolve => { cancelled = resolve; });
  const { url, credential } = await fixture(t, (_command, _grant, signal) => new Promise(resolve => {
    signal.addEventListener('abort', () => { cancelled(); resolve({ ok: false, code: 'cancelled' }); }, { once: true });
    started();
  }));
  const client = new Client({ name: 'cancel-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${credential.token}` } },
  }));
  const controller = new AbortController();
  const request = client.callTool({ name: 'get_state', arguments: {} }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(request);
  await running;
  controller.abort();
  await rejected;
  await stopped;
});

test('invalid IPC data and unrecognized output cannot cross the boundary', async t => {
  const { service, store, credential } = await fixture(t, async () => ({ ok: true, data: { connectedServers: 1, password: 'secret' } }));
  assert.equal((await service.mutate({ action: 'enable', enabled: 'yes' })).error, 'invalid_input');
  const result = await service.run(store.get(credential.id), { tool: 'get_state', args: {} }, new AbortController().signal);
  assert.deepEqual(result, { ok: false, code: 'failed' });
  for (let index = 0; index < 105; index++) store.record({ connection: 'assistant', tool: 'get_state', destination: '', timestamp: index, result: 'completed' });
  assert.equal(store.snapshot().audit.length, 100);
  assert.equal(store.snapshot().audit[0].timestamp, 5);
});

test('profiles use independent ports and occupied ports never displace another instance', async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  assert.notEqual(a.url, b.url);
  await b.service.close();
  const store = new AutomationStore(profile(t));
  store.setPort(Number(new URL(a.url).port));
  const service = new AutomationService(store, async () => ({ ok: false, code: 'not_ready' }));
  t.after(() => service.close());
  const occupied = await service.mutate({ action: 'enable', enabled: true });
  assert.equal(occupied.snapshot.url, null);
  assert.equal(occupied.snapshot.error, 'port_unavailable');
  const changed = await service.mutate({ action: 'change_port' });
  assert.ok(changed.snapshot.url);
  assert.notEqual(changed.snapshot.url, a.url);
});

test('unreadable storage does not crash startup or overwrite the previous file', t => {
  const directory = profile(t);
  const file = join(directory, 'automation.json');
  writeFileSync(file, '{broken');
  const store = new AutomationStore(directory);
  assert.equal(store.loadError, 'storage_failed');
  assert.equal(store.enabled, false);
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  const failed = new AutomationStore(profile(t));
  mkdirSync(failed.file);
  assert.throws(() => failed.mutate({ action: 'enable', enabled: true }));
  assert.equal(failed.enabled, false);
});

test('IPC accepts only the main frame, correlates replies and cancels pending work on navigation', async t => {
  const { registerAutomationIpc } = loadMain('ipc/automationIpc');
  const { IpcRegistry } = loadMain('ipc/registry');
  const contents = new EventEmitter();
  contents.mainFrame = {};
  contents.isDestroyed = () => false;
  const sent = [];
  contents.send = (...args) => sent.push(args);
  const ipc = fakeIpcMain();
  const registry = new IpcRegistry(ipc, { main: () => contents });
  const service = registerAutomationIpc(registry, { webContents: contents }, profile(t));
  t.after(async () => { registry.dispose(); await service.close(); });
  const invoke = (channel, ...args) => ipc.handlers.get(channel)({ sender: contents, senderFrame: contents.mainFrame }, ...args);
  assert.throws(() => ipc.handlers.get(shared.AUTOMATION_IPC.snapshot)({ sender: contents, senderFrame: {} }));
  await invoke(shared.AUTOMATION_IPC.ready);
  await service.mutate({ action: 'enable', enabled: true });
  const created = await service.mutate({ action: 'save', connection: { name: 'IPC', serverIds: ['a'], capabilities: ['read'] } });
  const store = service.store;
  const running = service.run(store.get(created.credential.id), { tool: 'get_state', args: {} }, new AbortController().signal);
  const request = sent.find(([channel]) => channel === shared.AUTOMATION_REQUEST)[1];
  const validated = shared.automationRequestSchema.parse(request);
  assert.deepEqual(validated.grant, { serverIds: ['a'], capabilities: ['read'] });
  await invoke(shared.AUTOMATION_IPC.reply, { requestId: request.requestId, result: { ok: true, data: { connectedServers: 2 } } });
  assert.deepEqual(await running, { ok: true, data: { connectedServers: 2 } });
  const cancelled = service.run(store.get(created.credential.id), { tool: 'get_state', args: {} }, new AbortController().signal);
  contents.emit('did-start-navigation', {}, 'app://monky', false, true);
  assert.deepEqual(await cancelled, { ok: false, code: 'cancelled' });
  assert.ok(sent.some(([channel]) => channel === shared.AUTOMATION_CANCEL));
});
