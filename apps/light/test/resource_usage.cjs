const assert = require('node:assert/strict');
const { test } = require('node:test');
const { MessageType } = require('@monky/shared');
const { NativeClient } = require('./native_client.cjs');
const { createServerFixture } = require('./server_fixture.cjs');
const { measureTree } = require('./process_sampler.cjs');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const seconds = Number(process.env.MONKY_LIGHT_MEASURE_SECONDS ?? 10);
const cycles = Number(process.env.MONKY_LIGHT_MEASURE_CYCLES ?? 0);
assert.ok(Number.isFinite(seconds) && seconds >= 10, 'MONKY_LIGHT_MEASURE_SECONDS must be at least 10');
assert.ok(Number.isSafeInteger(cycles) && cycles >= 0, 'MONKY_LIGHT_MEASURE_CYCLES must be a nonnegative integer');

test('measure the owned native Windows process, not its server or test driver', { timeout: 120_000 + (seconds * 6 + cycles * 30) * 1000 }, async t => {
  assert.equal(process.platform, 'win32', 'This measurement uses Windows process accounting');
  const fixture = await createServerFixture(t);
  const admin = await fixture.connectHuman('Fixture admin');
  const alice = new NativeClient(fixture, { nickname: 'Measured Light', defaultProcessing: true });
  const bob = new NativeClient(fixture, { nickname: 'Remote Light', defaultProcessing: true });
  const auth = await alice.wait('authenticated');
  const bobAuth = await bob.wait('authenticated');
  const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
  async function measure(phase) {
    await sleep(1000);
    const result = await measureTree(alice.child.pid, { seconds, intervalSeconds: Math.min(5, seconds), sleep });
    assert.ok(result.intervalSeconds >= seconds);
    t.diagnostic(`RESOURCE ${JSON.stringify({ phase, ...result })}`);
  }
  await measure('connected-idle');
  await alice.join(channelId);
  await bob.join(channelId);
  await alice.decodedFrom(bobAuth.sessionId);
  await bob.decodedFrom(auth.sessionId);
  await measure('p2p-duplex');
  const since = alice.events.length;
  await admin.peer.request(MessageType.SERVER_UPDATE_SETTINGS, { voiceMode: 'sfu' }, [MessageType.SERVER_SETTINGS_UPDATED]);
  await alice.wait(event => event.event === 'voice-admitted' && event.voiceMode === 'sfu', since);
  await alice.untilState(value => value.retiringMedia === 0 && value.audioDevice.nonzeroPlayoutCallbacks > 25,
    'SFU audio did not stabilize');
  await measure('sfu-duplex');
  for (const client of [alice, bob]) {
    await client.command('deafen', { enabled: true });
    await client.untilState(value => value.audioDevice.runningDevices === 0, 'Deafen left an audio worker active');
  }
  await measure('sfu-deafened');
  await alice.command('leave');
  await alice.untilState(value => value.phase === 'ready' && value.retiringMedia === 0 &&
    value.audioDevice.runningDevices === 0, 'The media engine did not retire');
  await measure('left-voice');
  // Repeated calls expose memory or threads that survive media teardown.
  if (cycles > 0) {
    for (const client of [alice, bob]) await client.command('deafen', { enabled: false });
  }
  for (let cycle = 0; cycle < cycles; cycle++) {
    await alice.join(channelId);
    await alice.decodedFrom(bobAuth.sessionId);
    await alice.command('leave');
    await alice.untilState(value => value.phase === 'ready' && value.retiringMedia === 0 &&
      value.audioDevice.runningDevices === 0, `Call cycle ${cycle + 1} did not retire`);
  }
  if (cycles > 0) await measure(`left-voice-after-${cycles}-cycles`);
  await alice.close();
  await bob.close();
});
