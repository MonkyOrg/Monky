const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { test } = require('node:test');
const { MessageType } = require('@monky/shared');
const { NativeClient } = require('./native_client.cjs');
const { createServerFixture } = require('./server_fixture.cjs');

const execute = promisify(execFile);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const mib = bytes => Math.round(bytes / (1024 * 1024) * 100) / 100;

async function sample(pid) {
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $p = Get-Process -Id ${pid}
    [pscustomobject]@{
      seconds = [System.Diagnostics.Stopwatch]::GetTimestamp() / [System.Diagnostics.Stopwatch]::Frequency
      cpuSeconds = $p.TotalProcessorTime.TotalSeconds
      workingSetBytes = $p.WorkingSet64
      privateBytes = $p.PrivateMemorySize64
      threads = $p.Threads.Count
    } | ConvertTo-Json -Compress
  `], { windowsHide: true, timeout: 10_000, maxBuffer: 4096 });
  const result = JSON.parse(stdout);
  for (const value of Object.values(result)) assert.ok(Number.isFinite(value) && value >= 0);
  return result;
}

test('measure the owned native Windows process, not its server or test driver', { timeout: 120_000 }, async t => {
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
    const start = await sample(alice.child.pid);
    await sleep(10_000);
    const end = await sample(alice.child.pid);
    const seconds = end.seconds - start.seconds;
    assert.ok(seconds >= 10 && end.cpuSeconds >= start.cpuSeconds);
    t.diagnostic(`RESOURCE ${JSON.stringify({
      phase, intervalSeconds: Math.round(seconds * 100) / 100,
      oneCoreCpuPercent: Math.round((end.cpuSeconds - start.cpuSeconds) / seconds * 10000) / 100,
      workingSetMiB: mib(end.workingSetBytes), privateMiB: mib(end.privateBytes), threads: end.threads,
    })}`);
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
  await alice.close();
  await bob.close();
});
