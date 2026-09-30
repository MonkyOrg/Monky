'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const directory = argument('artifacts');
assert.equal(process.platform, 'darwin');
assert.ok(directory && path.isAbsolute(directory), 'Use an explicit absolute artifacts directory.');

if (!process.versions.electron) {
  const { fork } = require('node:child_process');
  const { createMacAudioSource } = require('./macAudioSource.cjs');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(directory, { recursive: true });
  const children = new Set();
  const launch = (role, extra = []) => {
    const child = role === 'source'
      ? createMacAudioSource(directory)
      : fork(__filename, [`--role=${role}`, `--artifacts=${directory}`, ...extra], {
        execPath: require('electron'), env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    children.add(child);
    if (role !== 'source') {
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    child.once('exit', () => children.delete(child));
    return child;
  };
  const watchdog = setTimeout(() => {
    console.error('Owned audio fixture exceeded its deadline.');
    for (const child of children) child.kill('SIGKILL');
    process.exitCode = 1;
  }, 45000);
  void (async () => {
    const source = launch('source');
    const [identity] = await once(source, 'message', { signal: AbortSignal.timeout(15000) });
    assert.equal(identity.type, 'ready');
    assert.equal(identity.pid, source.pid);
    const exiting = launch('host-exit', [`--window=${identity.hwnd}`, `--source-pid=${identity.pid}`]);
    const [exitCode, exitSignal] = await once(exiting, 'exit', { signal: AbortSignal.timeout(10000) });
    assert.equal(exitSignal, null);
    assert.equal(exitCode, 0, 'Application shutdown must retire active capture without Main dispatch.');
    const host = launch('host', [`--window=${identity.hwnd}`, `--source-pid=${identity.pid}`]);
    host.on('message', message => {
      if (message.type === 'capture-ready') source.stdin.write('play\n');
      if (message.type === 'close-source') source.send({ command: 'close-source', id: require('node:crypto').randomUUID() });
    });
    const [code, signal] = await once(host, 'exit');
    assert.equal(signal, null);
    assert.equal(code, 0);
    source.stdin.end('close\n');
    const [sourceCode] = await once(source, 'exit', { signal: AbortSignal.timeout(5000) });
    assert.equal(sourceCode, 0);
    console.log(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
  })().catch(error => {
    console.error(error);
    process.exitCode = 1;
  }).finally(() => {
    clearTimeout(watchdog);
    for (const child of children) child.kill('SIGTERM');
  });
  return;
}

const { app } = require('electron');
const role = argument('role');
const profile = path.join(directory, role);
fs.mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.setPath('sessionData', path.join(profile, 'session'));
process.env.MONKY_HOME = path.join(profile, 'monky');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});
process.on('disconnect', () => app.quit());

function energy(packet, channel, frequency) {
  const coefficient = 2 * Math.cos(2 * Math.PI * frequency / packet.format.sampleRate);
  let previous = 0, before = 0;
  for (let frame = 0; frame < packet.frames; frame++) {
    const sample = packet.pcm.readFloatLE((frame * packet.format.channels + channel) * 4);
    assert.ok(Number.isFinite(sample));
    const next = sample + coefficient * previous - before;
    before = previous;
    previous = next;
  }
  return previous * previous + before * before - coefficient * previous * before;
}

async function runHost() {
  const audio = require('..');
  assert.equal(audio.isPacketCaptureSupported(), true);
  const selection = { includeWindowId: Number(argument('window')), expectedProcessId: Number(argument('source-pid')) };
  const invalid = audio.createPacketCapture({ ...selection, expectedProcessStartTimeUs: '1' }, () => {});
  await assert.rejects(invalid.ready, { code: 'ERR_AUDIO_TARGET' });
  const invalidClosed = await invalid.closed;
  assert.equal(invalidClosed.state, 'failed');
  const system = audio.createPacketCapture({ excludePid: process.pid }, () => {});
  let systemClosed;
  try {
    await system.ready;
  } finally {
    systemClosed = await system.stop();
  }
  assert.equal(systemClosed.state, 'closed', 'System capture must not inspect protected unrelated processes.');
  assert.equal(systemClosed.queuedPackets, 0);
  const cancellations = [];
  for (const waitMs of [0, 10]) {
    const capture = audio.createPacketCapture(selection, () => {});
    const ready = capture.ready.then(() => 'ready', error => error.code);
    if (waitMs) await delay(waitMs);
    const closed = await capture.stop();
    const readiness = await ready;
    assert.ok(['ready', 'ERR_AUDIO_CANCELLED'].includes(readiness), readiness);
    assert.equal(closed.queuedPackets, 0);
    assert.ok(['closed', 'failed'].includes(closed.state));
    cancellations.push({ waitMs, readiness, closed });
  }
  const rounds = [];
  for (let round = 0; round < 2; round++) {
    const observed = { frames: 0, packets: 0, firstTimestamp: null, lastTimestamp: null,
      left880: 0, left1320: 0, right880: 0, right1320: 0, errors: [] };
    const capture = audio.createPacketCapture(selection, event => {
      if (event.type === 'error') observed.errors.push({ code: event.error.code, message: event.error.message });
      if (event.type !== 'packet') return;
      assert.equal(event.captureClock, 'mach-host-us');
      assert.equal(event.qpcTimestampUs, null);
      assert.equal(event.devicePosition, null);
      assert.equal(event.format.sampleRate, 48000);
      assert.equal(event.format.channels, 2);
      assert.equal(event.pcm.length, event.frames * 8);
      assert.equal(event.flags.timestampError, false);
      assert.ok(Number.isSafeInteger(event.captureTimestampUs));
      assert.ok(observed.lastTimestamp === null || event.captureTimestampUs >= observed.lastTimestamp);
      observed.firstTimestamp ??= event.captureTimestampUs;
      observed.lastTimestamp = event.captureTimestampUs;
      observed.frames += event.frames;
      observed.packets++;
      observed.left880 += energy(event, 0, 880);
      observed.left1320 += energy(event, 0, 1320);
      observed.right880 += energy(event, 1, 880);
      observed.right1320 += energy(event, 1, 1320);
    });
    let succeeded = false;
    try {
      await capture.ready;
      process.send({ type: 'capture-ready' });
      const busy = audio.createPacketCapture(selection, () => {});
      await assert.rejects(busy.ready, { code: 'ERR_AUDIO_BUSY' });
      assert.equal((await busy.closed).state, 'failed');
      assert.equal(audio.start(selection, () => {}).success, false, 'Legacy capture must not steal the packet owner.');
      const deadline = performance.now() + 10000;
      while (observed.frames < 96000 && observed.errors.length === 0 && performance.now() < deadline) await delay(20);
      assert.deepEqual(observed.errors, []);
      assert.ok(observed.frames >= 96000, JSON.stringify(observed));
      assert.ok(observed.left880 > 1 && observed.left880 > observed.left1320 * 5, JSON.stringify(observed));
      assert.ok(observed.right1320 > 1 && observed.right1320 > observed.right880 * 5, JSON.stringify(observed));
      succeeded = true;
    } finally {
      observed.closed = await capture.stop();
      if (succeeded) assert.equal(observed.closed.state, 'closed', JSON.stringify(observed.closed));
      else console.error('Native audio failure:', observed.errors);
      assert.equal(observed.closed.queuedPackets, 0);
    }
    rounds.push(observed);
  }
  const lost = audio.createPacketCapture(selection, () => {});
  await lost.ready;
  process.send({ type: 'close-source' });
  const lostClosed = await lost.closed;
  assert.equal(lostClosed.state, 'failed');
  assert.equal(lostClosed.error.code, 'ERR_AUDIO_TARGET');
  assert.equal(lostClosed.queuedPackets, 0);
  fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify({ platform: process.platform,
    arch: process.arch, recordedMedia: false, measuredOnlyOwnedSyntheticApplication: true,
    systemCaptureReadiness: systemClosed, cancellations, rounds, lostClosed }, null, 2));
}

void app.whenReady().then(async () => {
  if (role === 'host-exit') {
    const capture = require('..').createPacketCapture({
      includeWindowId: Number(argument('window')), expectedProcessId: Number(argument('source-pid')),
    }, () => {});
    await capture.ready;
    app.quit();
    return;
  }
  assert.equal(role, 'host');
  await runHost();
  app.quit();
}).catch(fail);

function fail(error) {
  console.error(error);
  app.exit(1);
}
