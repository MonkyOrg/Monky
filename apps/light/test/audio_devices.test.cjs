const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { NativeClient } = require('./native_client.cjs');
const { createServerFixture } = require('./server_fixture.cjs');

const inputs = [
  { id: 'fixture-mic-default', name: 'Fixture default microphone' },
  { id: 'fixture-mic-headset', name: 'Fixture headset microphone á' },
];
const outputs = [
  { id: 'fixture-out-default', name: 'Fixture default speakers' },
  { id: 'fixture-out-headset', name: 'Fixture headset' },
];

async function devices(client) {
  const result = await client.command('devices');
  assert.equal(result.event, 'audio-devices', JSON.stringify(result));
  return result;
}

async function setDevices(client, values) {
  const since = client.events.length;
  assert.equal((await client.command('fixture-audio-devices', values)).event, 'command-accepted');
  return since;
}

function selected(client, since, predicate) {
  return client.wait(event => event.event === 'audio-device-selected' && predicate(event.stats), since);
}

test('audio devices are listed on demand, persisted in the profile and switched during a call', { timeout: 60_000 }, async t => {
  const fixture = await createServerFixture(t, { voiceMode: 'sfu' });
  const profile = path.join(fixture.directory, 'devices-profile');
  const alice = new NativeClient(fixture, { nickname: 'Device Alice', profile });
  const bob = new NativeClient(fixture, { nickname: 'Device Bob' });
  const auth = await alice.wait('authenticated');
  await bob.wait('authenticated');
  await setDevices(alice, { inputs, outputs });

  const idle = await devices(alice);
  assert.deepEqual(idle.inputs, inputs);
  assert.deepEqual(idle.outputs, outputs);
  assert.equal(idle.inputDeviceId, null);
  assert.equal(idle.outputDeviceId, null);
  const listedIdle = await alice.state();
  assert.equal(listedIdle.mediaActive, false);
  assert.equal(listedIdle.audioDevice.createdDevices, 0, 'Listing devices must not keep an audio device open');

  for (const invalid of [{}, { deviceId: 7 }, { deviceId: '' }, { deviceId: 'x'.repeat(1025) }]) {
    assert.equal((await alice.command('set-input', invalid)).event, 'command-error', JSON.stringify(invalid));
  }
  assert.equal((await alice.command('set-input', { deviceId: inputs[1].id })).event, 'command-accepted');
  const settings = JSON.parse(fs.readFileSync(path.join(profile, 'monky-light-settings.json'), 'utf8'));
  assert.equal(settings.inputDeviceId, inputs[1].id);
  assert.equal(settings.outputDeviceId, null);
  await alice.close();

  const restarted = new NativeClient(fixture, { nickname: 'Device Alice', profile });
  const again = await restarted.wait('authenticated');
  assert.equal(again.sessionId, auth.sessionId, 'Settings must not change the profile identity');
  await setDevices(restarted, { inputs, outputs });
  assert.equal((await devices(restarted)).inputDeviceId, inputs[1].id);

  const channelId = again.channels.find(channel => channel.type === 'VOICE').id;
  const joinSince = restarted.events.length;
  await restarted.join(channelId);
  const initial = await selected(restarted, joinSince, () => true);
  assert.deepEqual(initial.stats.input, { requestedId: inputs[1].id, id: inputs[1].id, name: inputs[1].name, fallback: false });
  assert.deepEqual(initial.stats.output, { requestedId: null, id: null, name: null, fallback: false });
  await bob.join(channelId);
  await restarted.untilState(value => value.audioDevice.selectedInput === inputs[1].id &&
    value.audioDevice.selectedOutput === outputs[0].id && value.audioDevice.nonzeroPlayoutCallbacks >= 25,
  'Persisted input device was not used for the call');
  await bob.decodedFrom(again.sessionId);

  const switchSince = restarted.events.length;
  assert.equal((await restarted.command('set-output', { deviceId: outputs[1].id })).event, 'command-accepted');
  await selected(restarted, switchSince, stats => stats.output.id === outputs[1].id);
  const switched = await restarted.untilState(value => value.audioDevice.selectedOutput === outputs[1].id &&
    value.audioDevice.playing, 'Output switch was not applied during the call');
  await restarted.untilState(value => value.audioDevice.outputEnergy > switched.audioDevice.outputEnergy + 0.1 &&
    value.audioDevice.runningDevices === 1, 'Playback did not continue on the selected output');

  await restarted.command('mute', { enabled: true });
  await restarted.untilState(value => !value.audioDevice.recording, 'Mute did not stop capture');
  const unplugSince = await setDevices(restarted, { inputs: [inputs[0]], outputs });
  await restarted.wait('audio-devices-changed', unplugSince);
  const fallback = await selected(restarted, unplugSince, stats => stats.input.fallback);
  assert.deepEqual(fallback.stats.input, { requestedId: inputs[1].id, id: null, name: null, fallback: true });
  const unplugged = await restarted.untilState(value => value.audioDevice.selectedInput === inputs[0].id,
    'Removing the selected microphone did not fall back to the default');
  assert.equal(unplugged.audioDevice.recording, false, 'Device fallback must not reopen a muted microphone');
  assert.equal(unplugged.phase, 'admitted');

  const replugSince = await setDevices(restarted, { inputs, outputs });
  await selected(restarted, replugSince, stats => stats.input.id === inputs[1].id && !stats.input.fallback);
  await restarted.command('mute', { enabled: false });
  await restarted.untilState(value => value.audioDevice.selectedInput === inputs[1].id && value.audioDevice.recording,
    'Reconnected microphone was not selected again');
  await bob.decodedFrom(again.sessionId);

  const defaultSince = restarted.events.length;
  assert.equal((await restarted.command('set-input', { deviceId: null })).event, 'command-accepted');
  await selected(restarted, defaultSince, stats => stats.input.requestedId === null && stats.input.id === null);
  const persisted = JSON.parse(fs.readFileSync(path.join(profile, 'monky-light-settings.json'), 'utf8'));
  assert.equal(persisted.inputDeviceId, null);
  assert.equal(persisted.outputDeviceId, outputs[1].id);
  await restarted.close();
  await bob.close();
});

test('unreadable device settings are reported without blocking the profile identity', { timeout: 30_000 }, async t => {
  const fixture = await createServerFixture(t);
  const profile = path.join(fixture.directory, 'invalid-settings-profile');
  const first = new NativeClient(fixture, { nickname: 'Settings', profile });
  const auth = await first.wait('authenticated');
  await first.close();
  fs.writeFileSync(path.join(profile, 'monky-light-settings.json'), '{"format":"monky-light-settings","version":99}');
  const second = new NativeClient(fixture, { nickname: 'Settings', profile });
  const warning = await second.wait(event => event.event === 'warning' && /profile settings/i.test(event.detail));
  assert.doesNotMatch(warning.detail, /version.:99/);
  assert.equal((await second.wait('authenticated')).sessionId, auth.sessionId);
  assert.equal((await devices(second)).inputDeviceId, null);
  assert.equal((await second.command('set-output', { deviceId: 'monky-test-pcm-sink' })).event, 'command-accepted');
  assert.equal(JSON.parse(fs.readFileSync(path.join(profile, 'monky-light-settings.json'), 'utf8')).version, 1);
  await second.close();
});
