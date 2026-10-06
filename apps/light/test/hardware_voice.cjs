const assert = require('node:assert/strict');
const { test } = require('node:test');
const { NativeClient } = require('./native_client.cjs');
const { createServerFixture } = require('./server_fixture.cjs');

test('opt-in native microphone capture uses only a disposable loopback call and respects mute', { timeout: 60_000 }, async t => {
  const fixture = await createServerFixture(t);
  const sink = new NativeClient(fixture, { nickname: 'Silent sink', muted: true });
  const source = new NativeClient(fixture, { nickname: 'Hardware microphone', synthetic: false, muted: true });
  const auth = await source.wait('authenticated');
  await sink.wait('authenticated');
  const channelId = auth.channels.find(channel => channel.type === 'VOICE').id;
  await source.join(channelId);
  await sink.join(channelId);
  assert.equal((await source.nativeAudioState()).recording, false, 'Muted entry must not start the microphone');
  await source.command('mute', { enabled: false });
  const deadline = Date.now() + 15_000;
  let capture;
  do {
    const since = source.events.length;
    await source.state();
    await new Promise(resolve => setTimeout(resolve, 100));
    const report = source.events.slice(since).findLast(event => event.event === 'media-stats' && Array.isArray(event.stats));
    capture = report?.stats.find(value => value.type === 'media-source' && value.kind === 'audio');
    if (capture?.totalSamplesDuration > 0.1) break;
  } while (Date.now() < deadline);
  assert.ok(capture?.totalSamplesDuration > 0.1, 'The physical microphone did not deliver PCM to WebRTC');
  assert.equal((await source.nativeAudioState()).recording, true);

  const listed = await source.command('devices');
  assert.equal(listed.event, 'audio-devices', JSON.stringify(listed));
  assert.ok(listed.inputs.length > 0 && listed.outputs.length > 0, 'No physical audio endpoints were listed');
  for (const device of [...listed.inputs, ...listed.outputs]) {
    assert.ok(device.id && device.name, 'Physical endpoints need a stable ID and a name');
  }
  const input = listed.inputs[0];
  const selectSince = source.events.length;
  assert.equal((await source.command('set-input', { deviceId: input.id })).event, 'command-accepted');
  const selected = await source.wait(event => event.event === 'audio-device-selected' &&
    event.stats.input.requestedId === input.id, selectSince);
  assert.deepEqual(selected.stats.input, { requestedId: input.id, id: input.id, name: input.name, fallback: false });
  assert.equal((await source.nativeAudioState()).inputDeviceId, input.id);
  const before = capture.totalSamplesDuration;
  do {
    const since = source.events.length;
    await source.state();
    await new Promise(resolve => setTimeout(resolve, 100));
    const report = source.events.slice(since).findLast(event => event.event === 'media-stats' && Array.isArray(event.stats));
    capture = report?.stats.find(value => value.type === 'media-source' && value.kind === 'audio') ?? capture;
    if (capture.totalSamplesDuration > before + 0.1) break;
  } while (Date.now() < deadline + 10_000);
  assert.ok(capture.totalSamplesDuration > before + 0.1, 'Capture did not continue on the selected physical input');
  await source.command('mute', { enabled: true });
  let device;
  do {
    device = await source.nativeAudioState();
    if (!device.recording) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < deadline);
  assert.equal(device.recording, false, 'Muting must release physical capture');
  await source.command('deafen', { enabled: true });
  device = await source.nativeAudioState();
  assert.equal(device.recording, false);
  assert.equal(device.playing, false);
  await source.close();
  await sink.close();
  t.diagnostic('Physical capture delivered PCM locally, switched to a listed input and stopped on mute. No audio was saved; the remote participant transmitted no sound.');
});
