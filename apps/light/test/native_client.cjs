const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { nativeExecutable } = require('./native_test_paths.cjs');

class NativeClient {
  events = [];
  waiters = new Set();
  stderr = '';
  failure = null;
  ended = false;
  expectedPeerFailures = new Set();

  constructor(fixture, { nickname, profile, password, synthetic = true, microphoneAccess, defaultProcessing = false, muted = false, deafened = false } = {}) {
    this.nickname = nickname;
    this.profile = profile ?? path.join(fixture.directory, `native-${randomUUID()}`);
    const env = { ...process.env };
    delete env.MONKY_LIGHT_PASSWORD;
    if (password !== undefined) env.MONKY_LIGHT_PASSWORD = password;
    const args = [
      '--profile', this.profile, '--server', fixture.url, '--nickname', nickname,
    ];
    if (microphoneAccess) {
      assert.ok(synthetic, 'Permission simulation is allowed only in the synthetic executable');
      args.push('--fixture-microphone-access', microphoneAccess);
    }
    if (defaultProcessing) {
      assert.ok(synthetic, 'Processing override is allowed only in the synthetic executable');
      args.push('--fixture-default-processing');
    }
    if (muted) args.push('--muted');
    if (deafened) args.push('--deafened');
    this.child = spawn(nativeExecutable(synthetic ? 'monky-light-fixture' : 'monky-light'), args,
      { stdio: ['pipe', 'pipe', 'pipe'], env });
    let partial = '';
    this.child.stdout.setEncoding('utf8').on('data', chunk => {
      partial += chunk;
      if (partial.length > 16 * 1024 * 1024) {
        this.fail(new Error('Native stdout exceeded its per-message limit'));
        this.child.kill();
        return;
      }
      let end;
      while ((end = partial.indexOf('\n')) >= 0) {
        const line = partial.slice(0, end).replace(/\r$/, '');
        partial = partial.slice(end + 1);
        let event;
        try { event = JSON.parse(line); } catch (error) {
          this.fail(new Error(`Native stdout is not JSON: ${line.slice(0, 200)}`, { cause: error }));
          this.child.kill();
          return;
        }
        this.events.push(event);
        if (this.events.length > 20_000) {
          this.fail(new Error('Native event journal exceeded its fixture limit'));
          this.child.kill();
          return;
        }
        for (const waiter of [...this.waiters]) {
          if (waiter.matches(event)) waiter.finish(null, event);
        }
        if (event.event === 'media-error' && !this.expectedPeerFailures.delete(event.sessionId)) {
          this.fail(new Error(`Native media failed (${nickname}): ${event.detail}; recent events: ` +
            JSON.stringify(this.events.filter(value => !['media-stats', 'state'].includes(value.event)).slice(-10))));
        }
      }
    });
    this.child.stderr.setEncoding('utf8').on('data', chunk => {
      this.stderr = (this.stderr + chunk).slice(-64 * 1024);
    });
    this.child.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.closed = new Promise(resolve => this.child.once('close', (code, signal) => {
      this.ended = true;
      this.fail(new Error(`Native process closed: code=${code} signal=${signal}; recent events: ` +
        `${JSON.stringify(this.events.slice(-8))}\n${this.stderr}`));
      resolve({ code, signal });
    }));
    fixture.onCleanup(() => {
      if (process.platform !== 'darwin' || !fs.existsSync(this.profile)) return;
      const account = fs.realpathSync.native(this.profile);
      const result = spawnSync('security', [
        'delete-generic-password', '-s', 'org.monky.light.identity.ed25519-seed.v1', '-a', account,
      ], { encoding: 'utf8', timeout: 5000 });
      assert.ifError(result.error);
      assert.ok(result.status === 0 || result.status === 44, `Exact fixture Keychain cleanup failed: ${result.stderr}`);
    });
    fixture.onCleanup(() => this.close());
  }

  fail(error) {
    this.failure ??= error;
    for (const waiter of [...this.waiters]) waiter.finish(this.failure);
  }

  wait(matches, since = 0, timeout = 15_000) {
    if (typeof matches === 'string') {
      const name = matches;
      matches = event => event.event === name;
    }
    const existing = this.events.slice(since).find(matches);
    if (existing) return Promise.resolve(existing);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const waiter = {
        matches,
        finish: (error, event) => {
          clearTimeout(timer);
          this.waiters.delete(waiter);
          if (error) reject(error);
          else resolve(event);
        },
      };
      const failure = new Error(`Native event timed out (${this.nickname})`);
      const timer = setTimeout(() => {
        const recent = this.events.filter(event => !['media-stats', 'state'].includes(event.event)).slice(-10);
        const state = this.events.findLast(event => event.event === 'state');
        failure.message += `; recent events: ${JSON.stringify(recent)}; state: ${JSON.stringify(state)}\n${this.stderr.slice(-2000)}`;
        waiter.finish(failure);
      }, timeout);
      this.waiters.add(waiter);
    });
  }

  command(command, values = {}) {
    if (this.failure) return Promise.reject(this.failure);
    assert.equal(this.ended, false, 'Native controller cannot send after process exit');
    const id = randomUUID();
    const reply = this.wait(event => event.id === id);
    this.child.stdin.write(JSON.stringify({ command, id, ...values }) + '\n');
    return reply;
  }

  async state() {
    const result = await this.command('stats');
    assert.equal(result.event, 'state');
    return result;
  }

  async nativeAudioState() {
    const since = this.events.length;
    await this.state();
    const result = await this.wait(event => event.event === 'media-stats' &&
      event.detail === 'Native audio device', since);
    return result.stats;
  }

  async untilState(predicate, message, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    let last;
    do {
      last = await this.state();
      if (predicate(last)) return last;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    assert.fail(`${message}; last state: ${JSON.stringify(last)}\n${this.stderr.slice(-4000)}`);
  }

  async join(channelId) {
    const since = this.events.length;
    assert.equal((await this.command('join', { channelId })).event, 'command-accepted');
    const admitted = await this.wait(event => event.event === 'voice-admitted' && event.channelId === channelId, since);
    await this.wait(event => event.event === 'media-initialized' && event.generation === admitted.generation, since);
    return admitted;
  }

  async decodedFrom(sessionId, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    const since = this.events.length;
    let last;
    do {
      await this.state();
      await new Promise(resolve => setTimeout(resolve, 50));
      last = this.events.slice(since).findLast(event => event.event === 'media-stats' && event.sessionId === sessionId &&
        Array.isArray(event.stats));
      if (last?.stats.some(report => report.type === 'inbound-rtp' && report.kind === 'audio' &&
        report.totalAudioEnergy > 0 && report.totalSamplesReceived > 0)) return last;
    } while (Date.now() < deadline);
    assert.fail(`No decoded audio for session ${sessionId}: ${JSON.stringify(last)}`);
  }

  async close() {
    if (this.ended) return;
    const timeout = setTimeout(() => this.child.kill(), 5000);
    try {
      this.child.stdin.end('{"command":"quit"}\n');
      const result = await this.closed;
      assert.deepEqual(result, { code: 0, signal: null }, this.stderr);
      assert.ok(this.events.some(event => event.event === 'stopped'), 'Native client did not complete graceful teardown');
    } finally {
      clearTimeout(timeout);
    }
  }
}

module.exports = { NativeClient };
