const assert = require('node:assert/strict');
const { createHash, randomUUID, sign } = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const { fork } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const test = require('node:test');
const { MessageType, PROTOCOL_VERSION } = require('@monky/shared');
const { identity, Peer, record, text } = require('../dist/testFixtures/bots');
const { prepareUpdateRestart } = require('../dist/infrastructure/lifecycle/updateRestart');
const processHelpers = require('../dist/cli/process');
const pm2 = require('../dist/cli/pm2');
const prompts = require('../dist/cli/prompts');
const lifecycle = require('../dist/cli/commands/serverLifecycle');
const update = require('../dist/cli/commands/update');
const downloads = require('../dist/cli/releaseDownload');
const { countVoiceUsers, countOnlineUsers } = require('../dist/cli/onlineUsers');

const version = '18.0.0-beta';
const bytes = Buffer.from('verified synthetic CLI archive');
const digest = createHash('sha256').update(bytes).digest('hex');
const artifact = {
  version, name: `monky-cli-${version}.tgz`,
  url: `https://github.com/MonkyOrg/Monky/releases/download/v${version}/monky-cli-${version}.tgz`,
  size: bytes.length, digest: `sha256:${digest}`,
};

for (const reason of ['stopped', 'update']) {
  test(`the real CLI consumes ${reason} intent and notifies clients before PM2 IPC shutdown`, { timeout: 20000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-shutdown-'));
    const preload = path.join(root, 'loopback.cjs');
    fs.writeFileSync(preload, `
      const http = require('node:http');
      const listen = http.Server.prototype.listen;
      http.Server.prototype.listen = function () {
        this.once('listening', () => process.send({ qaPort: this.address().port }));
        return listen.call(this, 0, '127.0.0.1');
      };
      require(${JSON.stringify(path.resolve(__dirname, '../dist/infrastructure/discovery/LanBroadcaster.js'))})
        .LanBroadcaster.prototype.start = async () => {};
    `);
    const child = fork(path.resolve(__dirname, '../dist/index.js'), ['--data', root], {
      execArgv: ['--require', preload],
      env: { ...process.env, MONKY_HOME: path.join(root, 'isolated-cli') },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8000); });
    let peer;
    t.after(async () => {
      await peer?.close();
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    });
    const port = await new Promise((resolve, reject) => {
      const finish = (error, value) => {
        clearTimeout(timer);
        child.off('message', message);
        child.off('error', failed);
        child.off('exit', exited);
        if (error) reject(error);
        else resolve(value);
      };
      const failed = error => finish(error);
      const exited = code => finish(new Error(`CLI exited before readiness (${code}): ${stderr}`));
      const message = value => {
        if (value && typeof value === 'object' && Number.isInteger(value.qaPort) && value.qaPort > 0) {
          finish(undefined, value.qaPort);
        }
      };
      const timer = setTimeout(() => finish(new Error(`CLI readiness timed out: ${stderr}`)), 10000);
      child.on('message', message);
      child.once('error', failed);
      child.once('exit', exited);
    });
    peer = new Peer(new (require('ws').WebSocket)(`ws://127.0.0.1:${port}`));
    await once(peer.ws, 'open');
    const keys = identity();
    const challenge = await peer.request(MessageType.AUTH_CONNECT, {
      protocolVersion: PROTOCOL_VERSION, nickname: 'CLI notice viewer',
      publicKey: keys.publicKey, deviceId: randomUUID(),
    });
    assert.equal(challenge.type, MessageType.AUTH_CHALLENGE);
    const signature = sign(null, Buffer.from(text(challenge.payload.nonce), 'hex'), keys.privateKey).toString('hex');
    const auth = await peer.request(MessageType.AUTH_CHALLENGE_RESPONSE, { signature });
    assert.equal(auth.type, MessageType.AUTH_SUCCESS);
    assert.match(text(record(auth.payload.server).serverVersion), /^\d+\.\d+\.\d+/);
    const clearIntent = reason === 'update' ? prepareUpdateRestart(root, child.pid) : undefined;
    const notice = peer.wait(message => message.type === MessageType.SERVER_SHUTDOWN);
    const exited = once(child, 'exit');
    child.send('shutdown');
    assert.deepEqual((await notice).payload, { reasonCode: reason });
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    clearIntent?.();
  });
}

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-update-'));
  const globalRoot = path.join(root, 'different prefix & spaces', 'node_modules');
  const packageDir = path.join(globalRoot, '@monky', 'server');
  const profile = path.join(root, 'isolated registry');
  const dataDir = path.join(root, 'server data & identity');
  const receipt = path.join(root, 'restart.json');
  const commands = [];
  const questions = [];
  const previousHome = process.env.MONKY_HOME;
  process.env.MONKY_HOME = profile;
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
    name: '@monky/server', version: '17.0.3-beta', bin: { monky: 'old-cli.cjs' },
  }));
  fs.writeFileSync(path.join(packageDir, 'old-cli.cjs'), "throw new Error('OLD CLI MUST NOT RUN');");
  t.after(() => {
    if (previousHome === undefined) delete process.env.MONKY_HOME;
    else process.env.MONKY_HOME = previousHome;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const read = fs.readFileSync.bind(fs);
  t.mock.method(fs, 'readFileSync', (filename, ...args) => {
    if (path.resolve(String(filename)) === path.resolve(__dirname, '../package.json')) {
      return JSON.stringify({ version: '17.0.3-beta' });
    }
    return read(filename, ...args);
  });
  t.mock.method(lifecycle, 'restartServerCommand', () => assert.fail('Old in-memory restart must never run'));
  t.mock.method(pm2, 'isPm2Available', () => options.pm2 !== false);
  t.mock.method(prompts, 'confirm', async (question) => {
    questions.push(question);
    return questions.length !== 2 || options.restart !== false;
  });
  const release = {
    tag_name: `v${version}`, html_url: `https://github.com/MonkyOrg/Monky/releases/tag/v${version}`,
    prerelease: true, assets: [{ name: artifact.name, browser_download_url: artifact.url, size: bytes.length, digest: artifact.digest }],
  };
  t.mock.method(https, 'get', (_url, _options, callback) => {
    const request = new EventEmitter();
    request.setTimeout = () => request;
    request.destroy = () => request;
    queueMicrotask(() => {
      const response = Readable.from([JSON.stringify([release])]);
      response.statusCode = 200;
      callback(response);
    });
    return request;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url) === artifact.url) return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    assert.match(String(url), /monky-compatibility-18\.0\.0-beta\.json$/);
    return new Response(JSON.stringify({
      schemaVersion: 1, version, protocolVersion: PROTOCOL_VERSION, botSdkVersion: version,
    }));
  });
  t.mock.method(processHelpers, 'runSync', (command, args, settings = {}) => {
    commands.push({ command, args, settings });
    assert.equal(command, 'npm', 'fixtures must never start PM2 or run a global install');
    if (args[0] === '-v') return { status: 0, stdout: '11.17.0\n' };
    if (args[0] === 'root') return { status: options.prefixFailure ? 1 : 0, stdout: `${globalRoot}\n` };
    assert.equal(args[0], 'install');
    assert.equal(args[args.length - 1], './package.tgz');
    assert.deepEqual(read(path.join(settings.cwd, 'package.tgz')), bytes);
    if (options.installFailure) return { status: 1 };
    const installedVersion = options.wrongVersion ? '17.0.3-beta' : version;
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: '@monky/server', version: installedVersion, bin: { monky: 'fresh-cli.cjs' },
    }));
    if (!options.missingEntry) fs.writeFileSync(path.join(packageDir, 'fresh-cli.cjs'), `
      require('node:fs').writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({
        version: ${JSON.stringify(installedVersion)}, argv: process.argv.slice(2), home: process.env.MONKY_HOME
      }));
      process.exitCode = ${options.restartFailure ? 9 : 0};
    `);
    return { status: 0 };
  });
  return { root, globalRoot, packageDir, profile, dataDir, receipt, commands, questions };
}

test('two-version update launches the newly installed CLI with the original isolated server/profile', async (t) => {
  const f = fixture(t);
  await update.updateCommand({ args: [], dataDir: f.dataDir, dataDirSpecified: true }, ['--beta', '--yes']);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.receipt, 'utf8')), {
    version, argv: ['--data', f.dataDir, 'restart', '--after-update'], home: f.profile,
  });
  const install = f.commands.find((call) => call.args[0] === 'install');
  assert.ok(install.args.includes('--allow-scripts=mediasoup'));
  assert.equal(fs.existsSync(install.settings.cwd), false, 'owned staging is removed');
});

test('declined restart and absent PM2 install the package without starting anything', async (t) => {
  for (const options of [{ restart: false }, { pm2: false }]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const f = fixture(subtest, options);
      await update.updateCommand({ args: [], dataDir: f.dataDir, dataDirSpecified: true }, ['--beta']);
      assert.equal(fs.existsSync(f.receipt), false);
    });
  }
});

test('installation, prefix, version and entry failures cannot execute the old restart', async (t) => {
  for (const failure of ['installFailure', 'prefixFailure', 'wrongVersion', 'missingEntry']) {
    await t.test(failure, async (subtest) => {
      const f = fixture(subtest, { [failure]: true });
      await assert.rejects(update.updateCommand({ args: [], dataDir: f.dataDir, dataDirSpecified: true }, ['--beta', '--yes']));
      assert.equal(fs.existsSync(f.receipt), false);
      const install = f.commands.find((call) => call.args[0] === 'install');
      assert.equal(fs.existsSync(install.settings.cwd), false);
    });
  }
});

test('fresh restart failure is reported after install, without falling back to cached code', async (t) => {
  const f = fixture(t, { restartFailure: true });
  await assert.rejects(update.updateCommand({ args: [], dataDir: f.dataDir, dataDirSpecified: true }, ['--beta', '--yes']));
  assert.equal(JSON.parse(fs.readFileSync(f.receipt, 'utf8')).version, version);
});

test('artifact transfer reports actual chunks and verifies size plus SHA-256 before installation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const progress = [];
  let verified = false;
  const request = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 4));
      controller.enqueue(bytes.subarray(4));
      controller.close();
    },
  }));
  await downloads.downloadCliArtifact(artifact, path.join(root, 'good.tgz'), {
    request, onProgress: (value) => progress.push(value), onVerifying: () => { verified = true; },
  });
  assert.deepEqual(progress.map((value) => value.received), [0, 4, bytes.length]);
  assert.ok(progress.every((value) => value.total === bytes.length));
  assert.equal(verified, true);
  assert.deepEqual(fs.readFileSync(path.join(root, 'good.tgz')), bytes);
  await assert.rejects(downloads.downloadCliArtifact({ ...artifact, digest: `sha256:${'0'.repeat(64)}` }, path.join(root, 'bad-hash.tgz'), { request }));
  await assert.rejects(downloads.downloadCliArtifact({ ...artifact, size: 3 }, path.join(root, 'too-large.tgz'), { request }));
  await assert.rejects(downloads.downloadCliArtifact(artifact, path.join(root, 'short.tgz'), { request: async () => new Response(bytes.subarray(0, 3)) }));
});

test('legacy release checksums, trusted redirects and exclusive output remain enforced', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-cli-transfer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const legacy = { ...artifact, digest: null };
  await downloads.downloadCliArtifact(legacy, path.join(root, 'legacy.tgz'), {
    request: async (url) => String(url).endsWith('checksums-sha256.txt')
      ? new Response(`${digest}  ./${artifact.name}\n`) : new Response(bytes),
  });
  assert.equal(downloads.checksumForArtifact(`${digest}  ${artifact.name}\n${digest}  ${artifact.name}\n`, artifact.name), null);
  const output = path.join(root, 'keep.tgz');
  fs.writeFileSync(output, 'keep me');
  await assert.rejects(downloads.downloadCliArtifact(artifact, output, { request: async () => new Response(bytes) }));
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep me');
  let calls = 0;
  await assert.rejects(downloads.downloadCliArtifact(artifact, path.join(root, 'redirect.tgz'), {
    request: async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
    },
  }));
  assert.equal(calls, 1);
});

test('TTY uses a progress bar and non-TTY logs never emit cursor control or pretend npm is downloading', () => {
  for (const tty of [true, false]) {
    let text = '';
    let time = 0;
    const progress = downloads.createCliDownloadProgress({
      isTTY: tty, write(value) { text += value; return true; },
    }, () => time);
    progress.update({ received: 0, total: 100 });
    time = 150;
    progress.update({ received: 50, total: 100 });
    time = 300;
    progress.update({ received: 100, total: 100 });
    progress.finish();
    if (tty) {
      assert.match(text, /\[##########----------\]/);
      assert.match(text, /50/);
    } else {
      assert.doesNotMatch(text, /\x1b|\r/);
      assert.equal(text.trim().split('\n').length, 2);
    }
  }
});

test('voice restart checks never substitute online counts when a server lacks voice data', async (t) => {
  let value = { userCount: 8 };
  const server = http.createServer((_request, response) => {
    response.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const port = server.address().port;
  assert.equal(await countOnlineUsers(port), 8);
  assert.equal(await countVoiceUsers(port), null);
  value = { userCount: 8, voiceUserCount: 2 };
  assert.equal(await countVoiceUsers(port), 2);
  for (const invalid of [-1, 1.5, '2', null]) {
    value = { userCount: 8, voiceUserCount: invalid };
    assert.equal(await countVoiceUsers(port), null);
  }
  value = { userCount: 8, voiceUserCount: 0 };
  assert.equal(await countVoiceUsers(port), 0);
});
