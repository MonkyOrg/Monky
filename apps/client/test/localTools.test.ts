import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { MakeDirectoryOptions, PathLike } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { gzipSync } from 'node:zlib';
import { MANAGED_NODE_VERSION, managedNodeArtifact, managedFfmpegArchiveEntry } from '@monky/bot-sdk';
import { LOCAL_TOOL_IDS, localToolReceiptSchema, type LocalToolId } from '@monky/shared';
import {
  LocalTools, LOCAL_TASK_CACHE_MAX_BYTES, LOCAL_TOOLS_CACHE_MAX_BYTES,
  type LocalTaskCacheOwner, type LocalToolPaths, type LocalToolsOptions,
} from '../src/main/localExecution/LocalTools';
import { LocalExecutionError } from '../src/main/localExecution/errors';
import { checkToolExtraction, extractLocalTool, localToolExtractionSupport } from '../src/main/localExecution/toolExtraction';

const versions: Record<LocalToolId, string> = {
  node: `v${MANAGED_NODE_VERSION}`, 'yt-dlp': '2026.09.15', ffmpeg: 'ffmpeg 6.1.1 (controlled libopus fixture)',
};
const checksum = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const signal = (): AbortSignal => new AbortController().signal;
const reason = (expected: string): (error: unknown) => boolean =>
  (error) => error instanceof LocalExecutionError && error.reason === expected;

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => { throw new Error('Deferred was not initialized'); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function holdWindowsFile(filename: string): Promise<() => Promise<void>> {
  const held = deferred<void>();
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $file = [System.IO.File]::Open($env:MONKY_TEST_LOCK, 'Open', 'Read', 'ReadWrite')
    try { [Console]::Out.WriteLine('LOCKED'); [Console]::In.ReadLine() | Out-Null }
    finally { $file.Dispose() }
  `], { env: { ...process.env, MONKY_TEST_LOCK: filename }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, timeout: 30_000 });
  let output = '';
  let diagnostic = '';
  child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.includes('LOCKED')) held.resolve(); });
  child.stderr.on('data', (data: Buffer) => { diagnostic += data.toString(); });
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`File lock process failed: ${code}; ${diagnostic}`)));
  });
  await Promise.race([held.promise, exited.then(() => { throw new Error('File lock process exited before holding the file'); })]);
  return async () => {
    if (!child.stdin.destroyed && !child.stdin.writableEnded) child.stdin.end('\n');
    await exited;
  };
}

async function probeCacheCleanup(operation: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Reject a deadlocked synthetic probe so its fixture can still shut down and report the failure.
    await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Probe cache cleanup deadlocked')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function tarFixture(member: string, contents: Buffer): Buffer {
  const header = Buffer.alloc(512);
  header.write(member, 0, 100, 'utf8');
  header.write('0000700\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(`${contents.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.fill(32, 148, 156);
  header.write('0', 156);
  header.write('ustar\0', 257);
  header.write('00', 263);
  const sum = header.reduce((total, value) => total + value, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return Buffer.concat([header, contents, Buffer.alloc((512 - contents.length % 512) % 512 + 1024)]);
}

function zipFixture(member: string, contents: Buffer): Buffer {
  const filename = Buffer.from(member);
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(contents.length, 18);
  local.writeUInt32LE(contents.length, 22);
  local.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(contents.length, 20);
  central.writeUInt32LE(contents.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + filename.length, 12);
  end.writeUInt32LE(local.length + filename.length + contents.length, 16);
  return Buffer.concat([local, filename, contents, central, filename, end]);
}

async function xzFixture(contents: Buffer): Promise<Buffer> {
  const child = spawn('/usr/bin/xz', ['--compress', '--stdout'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const chunks: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
  child.stderr.resume();
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Fixture compressor failed: ${code}`)));
  });
  child.stdin.end(contents);
  await closed;
  return Buffer.concat(chunks);
}

interface FixtureAsset {
  tool: LocalToolId;
  name: string;
  url: string;
  repository: string | null;
  version: string;
  bytes: Buffer;
}

async function fixtureAssets(nodeContents?: Buffer): Promise<FixtureAsset[]> {
  const node = managedNodeArtifact(process.platform, process.arch);
  const nodeBytes = nodeContents ?? Buffer.from('controlled node executable; never executed by these tests');
  const ytName = process.platform === 'win32' ? process.arch === 'arm64' ? 'yt-dlp_arm64.exe' : 'yt-dlp.exe'
    : process.platform === 'darwin' ? 'yt-dlp_macos' : process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  const ffBytes = Buffer.from('controlled ffmpeg executable; never executed by these tests');
  const ffName = process.platform === 'darwin' ? `ffmpeg-darwin-${process.arch}`
    : `ffmpeg-master-latest-${process.platform === 'win32' ? 'win' : 'linux'}${process.arch === 'arm64' ? 'arm64' : '64'}-gpl.${process.platform === 'win32' ? 'zip' : 'tar.xz'}`;
  const ffRepository = process.platform === 'darwin' ? 'eugeneware/ffmpeg-static' : 'yt-dlp/FFmpeg-Builds';
  const ffArchive = process.platform === 'darwin' ? ffBytes : process.platform === 'win32'
    ? zipFixture(managedFfmpegArchiveEntry(ffName), ffBytes)
    : await xzFixture(tarFixture(managedFfmpegArchiveEntry(ffName), ffBytes));
  return [
    {
      tool: 'node', name: node.name, url: `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/${node.name}`,
      repository: null, version: `v${MANAGED_NODE_VERSION}`,
      bytes: node.entry ? gzipSync(tarFixture(node.entry, nodeBytes)) : nodeBytes,
    },
    {
      tool: 'yt-dlp', name: ytName, repository: 'yt-dlp/yt-dlp', version: 'fixture-2026',
      url: `https://github.com/yt-dlp/yt-dlp/releases/download/fixture-2026/${ytName}`,
      bytes: Buffer.from('controlled yt-dlp executable; never executed by these tests'),
    },
    {
      tool: 'ffmpeg', name: ffName, repository: ffRepository, version: 'b6.1.1',
      url: `https://github.com/${ffRepository}/releases/download/b6.1.1/${ffName}`, bytes: ffArchive,
    },
  ];
}

function heldResponse(bytes: Buffer, abort: AbortSignal, released: Promise<void>): Response {
  let stop: () => void = () => undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      let finished = false;
      const cancel = (): void => {
        if (finished) return;
        finished = true;
        abort.removeEventListener('abort', cancel);
        controller.error(abort.reason);
      };
      stop = (): void => { finished = true; abort.removeEventListener('abort', cancel); };
      abort.addEventListener('abort', cancel, { once: true });
      controller.enqueue(new Uint8Array(bytes.subarray(0, 4)));
      released.then(() => {
        if (finished) return;
        stop();
        controller.enqueue(new Uint8Array(bytes.subarray(4)));
        controller.close();
      });
      if (abort.aborted) cancel();
    },
    cancel() { stop(); },
  });
  return new Response(body);
}

async function fixture(t: TestContext, options: {
  probe?: LocalToolsOptions['probe'];
  onChanged?: () => void;
  download?: (asset: FixtureAsset, abort: AbortSignal) => Promise<Response>;
  badHash?: LocalToolId;
  nodeContents?: Buffer;
  disposeFailure?: string;
} = {}): Promise<{
  root: string; base: string; tools: LocalTools; assets: FixtureAsset[]; requests: string[]; probes: LocalToolId[];
}> {
  const base = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'monky-local-tools-'));
  const root = path.join(base, 'managed');
  const requests: string[] = [];
  const probes: LocalToolId[] = [];
  const assets = await fixtureAssets(options.nodeContents);
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const abort = init?.signal;
    assert.ok(abort, 'Managed requests must carry their cancellation signal');
    abort.throwIfAborted();
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).has('Authorization'), false);
    requests.push(url);
    const digest = (asset: FixtureAsset): string => options.badHash === asset.tool ? '0'.repeat(64) : checksum(asset.bytes);
    if (url === `https://nodejs.org/dist/v${MANAGED_NODE_VERSION}/SHASUMS256.txt`) {
      const asset = assets[0];
      assert.ok(asset);
      return new Response(`${digest(asset)}  ${asset.name}\n`);
    }
    const release = assets.find((asset) => asset.repository && url === `https://api.github.com/repos/${asset.repository}/releases/latest`);
    if (release) {
      return new Response(JSON.stringify({
        draft: false, prerelease: false, tag_name: release.version,
        assets: [{ name: release.name, browser_download_url: release.url, size: release.bytes.length, digest: `sha256:${digest(release)}` }],
      }));
    }
    const asset = assets.find((entry) => entry.url === url);
    assert.ok(asset, `Unexpected request: ${url}`);
    if (init?.method === 'HEAD') return new Response(null, { headers: { 'Content-Length': String(asset.bytes.length) } });
    return options.download ? options.download(asset, abort) : new Response(new Uint8Array(asset.bytes));
  });
  const tools = new LocalTools({
    root, onChanged: options.onChanged,
    probe: async (tool, paths, abort) => {
      probes.push(tool);
      for (const filename of Object.values(paths)) {
        assert.equal(path.isAbsolute(filename), true);
        assert.equal(path.relative(root, filename).startsWith('..'), false);
      }
      return options.probe ? options.probe(tool, paths, abort) : versions[tool];
    },
  });
  t.after(async () => {
    try {
      // Blocked-owner fixtures simulate native state; no live descendants use their temporary data.
      if (options.disposeFailure) await assert.rejects(tools.dispose(), reason(options.disposeFailure));
      else await tools.dispose();
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
  return { root, base, tools, assets, requests, probes };
}

function executable(paths: LocalToolPaths, tool: LocalToolId): string {
  return tool === 'yt-dlp' ? paths.ytDlp : paths[tool];
}

test('inventory initialization is filesystem-only and never crosses the explicit preparation boundary', async (t) => {
  const { tools, root, requests, probes } = await fixture(t);
  await tools.initialize();
  const snapshot = await tools.snapshot();
  assert.equal(snapshot.supported, true);
  assert.ok(snapshot.tools.every((tool) => tool.status === 'absent' && !tool.progress && !tool.failure));
  assert.equal(snapshot.toolsBytes, 0);
  assert.equal(snapshot.cacheBytes, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tools.prepare(controller.signal), reason('cancelled'));
  assert.deepEqual(requests, []);
  assert.deepEqual(probes, []);
  assert.deepEqual(await fs.readdir(path.join(root, 'tools')), []);
});

test('unsupported targets fail before downloads/probes, and roots must be explicit non-root absolute paths', async (t) => {
  const { base, requests, probes } = await fixture(t);
  assert.throws(() => new LocalTools({ root: 'relative', probe: async () => 'fixture' }), reason('invalid_request'));
  assert.throws(() => new LocalTools({ root: path.parse(base).root, probe: async () => 'fixture' }), reason('invalid_request'));
  const tools = new LocalTools({ root: path.join(base, 'unsupported'), platform: 'aix', probe: async () => assert.fail('Probe') });
  try {
    assert.equal((await tools.snapshot()).supported, false);
    await assert.rejects(tools.prepare(signal()), reason('unsupported_platform'));
    assert.deepEqual(requests, []);
    assert.deepEqual(probes, []);
  } finally { await tools.dispose(); }
});

test('verified generations publish exact receipts and truthful inventory, without upgrades on reuse or restart', async (t) => {
  const { tools, root, assets, requests, probes } = await fixture(t);
  const paths = await tools.prepare(signal());
  const snapshot = await tools.snapshot();
  let total = 0;
  for (const tool of snapshot.tools) {
    assert.equal(tool.status, 'ready');
    assert.equal(tool.version, versions[tool.id]);
    assert.deepEqual(tool.requiredBy, []);
    const filename = executable(paths, tool.id);
    const directory = path.dirname(filename);
    const receiptFile = path.join(directory, 'receipt.json');
    const receipt = localToolReceiptSchema.parse(JSON.parse(await fs.readFile(receiptFile, 'utf8')));
    const bytes = await fs.readFile(filename);
    assert.equal(receipt.id, tool.id);
    assert.equal(receipt.executableSha256, checksum(bytes));
    assert.equal(receipt.sizeBytes, bytes.length);
    const asset = assets.find((entry) => entry.tool === tool.id);
    assert.ok(asset);
    assert.equal(receipt.sourceUrl, asset.url);
    const archived = tool.id === 'node' ? process.platform !== 'win32' : tool.id === 'ffmpeg' && process.platform !== 'darwin';
    assert.equal(tool.sizeBytes, bytes.length + (await fs.stat(receiptFile)).size + (archived ? asset.bytes.length : 0));
    const names = [path.basename(filename), 'receipt.json'];
    if (archived) {
      names.push('artifact');
      assert.deepEqual(await fs.readFile(path.join(directory, 'artifact')), asset.bytes);
    }
    assert.deepEqual((await fs.readdir(directory)).sort(), names.sort());
    total += tool.sizeBytes;
  }
  assert.equal(snapshot.toolsBytes, total);
  assert.deepEqual((await fs.readdir(path.join(root, 'tools'))).sort(), [...LOCAL_TOOL_IDS].sort());
  const downloads = requests.length;
  assert.deepEqual(await tools.prepare(signal()), paths);
  assert.equal(requests.length, downloads);
  assert.deepEqual(probes, [...LOCAL_TOOL_IDS], 'Unchanged verified tools must not launch three version processes for every task');
  const restarted = new LocalTools({ root, probe: async () => assert.fail('Inventory must not execute tools') });
  try {
    assert.ok((await restarted.snapshot()).tools.every((tool) => tool.status === 'ready'));
    assert.equal(requests.length, downloads);
  } finally { await restarted.dispose(); }
});

test('warm preparation still hashes every executable but reuses successful native checks', async (t) => {
  const { tools, probes } = await fixture(t);
  const paths = await tools.prepare(signal());
  const reads = new Set<string>();
  const open = fs.open.bind(fs);
  t.mock.method(fs, 'open', (...args: Parameters<typeof fs.open>) => {
    const filename = String(args[0]);
    if (Object.values(paths).includes(filename)) reads.add(filename);
    return open(...args);
  });
  await tools.prepare(signal());
  assert.deepEqual([...reads].sort(), Object.values(paths).sort(), 'Skipping native probes cannot skip integrity reads');
  assert.deepEqual(probes, [...LOCAL_TOOL_IDS]);
  const original = await fs.readFile(paths.ytDlp);
  await fs.unlink(paths.ytDlp);
  await fs.writeFile(paths.ytDlp, original, { mode: 0o700 });
  await tools.prepare(signal());
  assert.deepEqual(probes, [...LOCAL_TOOL_IDS, 'yt-dlp'], 'A replacement file must receive its own native check even with identical bytes');
  await tools.prepare(signal());
  assert.deepEqual(probes, [...LOCAL_TOOL_IDS, 'yt-dlp']);
});

test('native verification is not restored from receipts across a manager restart or tool removal', async (t) => {
  const { tools, root, probes } = await fixture(t);
  await tools.prepare(signal());
  const restartedProbes: LocalToolId[] = [];
  const restarted = new LocalTools({ root, probe: async (tool) => { restartedProbes.push(tool); return versions[tool]; } });
  try {
    await restarted.snapshot();
    assert.deepEqual(restartedProbes, []);
    await restarted.prepare(signal());
    await restarted.prepare(signal());
    assert.deepEqual(restartedProbes, [...LOCAL_TOOL_IDS]);
  } finally { await restarted.dispose(); }
  await tools.remove('yt-dlp');
  await tools.prepare(signal());
  assert.deepEqual(probes, [...LOCAL_TOOL_IDS, 'yt-dlp']);
});

test('multiple consumers share downloads; one cancellation does not revoke another approved consumer', async (t) => {
  const started = deferred<AbortSignal>();
  const released = deferred<void>();
  const { tools, assets, requests } = await fixture(t, {
    download: async (asset, abort) => {
      if (asset.tool !== 'node') return new Response(new Uint8Array(asset.bytes));
      started.resolve(abort);
      return heldResponse(asset.bytes, abort, released.promise);
    },
  });
  const firstController = new AbortController();
  const first = tools.prepare(firstController.signal);
  const second = tools.prepare(signal());
  const downloadSignal = await started.promise;
  firstController.abort();
  await assert.rejects(first, reason('cancelled'));
  assert.equal(downloadSignal.aborted, false);
  released.resolve();
  await second;
  for (const asset of assets) {
    assert.equal(requests.filter((url) => url === asset.url).length, asset.tool === 'node' ? 2 : 1);
  }
});

test('the last cancelled consumer waits for partial download cleanup, and late stream delivery cannot publish', async (t) => {
  const started = deferred<void>();
  const released = deferred<void>();
  const { tools, root, probes } = await fixture(t, {
    download: async (asset, abort) => {
      started.resolve();
      return heldResponse(asset.bytes, abort, released.promise);
    },
  });
  const controller = new AbortController();
  const pending = tools.prepare(controller.signal);
  await started.promise;
  controller.abort();
  await assert.rejects(pending, reason('cancelled'));
  released.resolve();
  assert.deepEqual(await fs.readdir(path.join(root, 'tools')), []);
  assert.deepEqual(probes, []);
  assert.equal((await tools.snapshot()).tools[0]?.status, 'absent');
});

test('a newly approved consumer waits for cancelled work to settle before creating a fresh generation', async (t) => {
  const started = deferred<void>();
  const stopped = deferred<void>();
  const released = deferred<void>();
  let held = false;
  const { tools, root } = await fixture(t, {
    download: async (asset, abort) => {
      if (held) return new Response(new Uint8Array(asset.bytes));
      held = true;
      started.resolve();
      abort.addEventListener('abort', () => stopped.resolve(), { once: true });
      return heldResponse(asset.bytes, abort, released.promise);
    },
  });
  const controller = new AbortController();
  const first = tools.prepare(controller.signal);
  await started.promise;
  controller.abort();
  await stopped.promise;
  const second = tools.prepare(signal());
  await assert.rejects(first, reason('cancelled'));
  await second;
  released.resolve();
  assert.deepEqual((await fs.readdir(path.join(root, 'tools'))).sort(), [...LOCAL_TOOL_IDS].sort());
  assert.ok((await tools.snapshot()).tools.every((tool) => tool.status === 'ready'));
});

test('a consumer arriving during cancellation keeps shared work alive instead of restarting its download', async (t) => {
  const started = deferred<AbortSignal>();
  const released = deferred<void>();
  const { tools, assets, requests } = await fixture(t, {
    download: async (asset, abort) => {
      if (asset.tool !== 'node') return new Response(new Uint8Array(asset.bytes));
      started.resolve(abort);
      return heldResponse(asset.bytes, abort, released.promise);
    },
  });
  const controller = new AbortController();
  const first = tools.prepare(controller.signal);
  const shared = await started.promise;
  controller.abort();
  const second = tools.prepare(signal());
  await assert.rejects(first, reason('cancelled'));
  assert.equal(shared.aborted, false);
  released.resolve();
  await second;
  assert.equal(requests.filter((url) => url === assets[0]?.url).length, 2);
});

test('removal cancels and joins an outstanding probe, rejects new preparation, and prevents late publication', async (t) => {
  const started = deferred<AbortSignal>();
  const released = deferred<string>();
  const { tools, root } = await fixture(t, {
    probe: async (_tool, _paths, abort) => { started.resolve(abort); return released.promise; },
  });
  const pending = tools.prepare(signal());
  const rejected = assert.rejects(pending, reason('cancelled'));
  const probeSignal = await started.promise;
  const removed = tools.remove('node');
  assert.equal(probeSignal.aborted, true);
  await assert.rejects(tools.prepare(signal()), reason('busy'));
  assert.equal((await tools.snapshot()).tools[0]?.status, 'removing');
  released.resolve(versions.node);
  await removed;
  await rejected;
  assert.deepEqual(await fs.readdir(path.join(root, 'tools')), []);
  assert.equal((await tools.snapshot()).tools[0]?.status, 'absent');
});

test('removal during the atomic rename removes the late generation before returning', async (t) => {
  const { tools, root } = await fixture(t);
  const started = deferred<void>();
  const released = deferred<void>();
  const original = fs.rename.bind(fs);
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>): Promise<void> => {
    if (String(args[1]) === path.join(root, 'tools', 'node')) { started.resolve(); await released.promise; }
    await original(...args);
  });
  const pending = tools.prepare(signal());
  const rejected = assert.rejects(pending, reason('cancelled'));
  await started.promise;
  const removed = tools.remove('node');
  released.resolve();
  await removed;
  await rejected;
  assert.deepEqual(await fs.readdir(path.join(root, 'tools')), []);
});

test('disposal waits for in-flight checking and cleans its generation without permitting new work', async (t) => {
  const started = deferred<AbortSignal>();
  const released = deferred<string>();
  const { tools, root } = await fixture(t, {
    probe: async (_tool, _paths, abort) => { started.resolve(abort); return released.promise; },
  });
  const pending = tools.prepare(signal());
  const rejected = assert.rejects(pending, reason('executor_unavailable'));
  const probeSignal = await started.promise;
  const disposed = tools.dispose();
  assert.equal(probeSignal.aborted, true);
  await assert.rejects(tools.prepare(signal()), reason('executor_unavailable'));
  await assert.rejects(tools.allocateTaskCache(), reason('executor_unavailable'));
  released.resolve(versions.node);
  await disposed;
  await rejected;
  assert.deepEqual(await fs.readdir(path.join(root, 'tools')), []);
});

test('shutdown also joins maintenance that began before initialization finished', async (t) => {
  const { tools, root } = await fixture(t);
  await fs.mkdir(path.join(root, 'tools', 'node'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools', 'node', 'unfinished'), 'partial');
  const removed = tools.remove('node');
  const disposed = tools.dispose();
  await removed;
  await disposed;
  assert.deepEqual(await fs.readdir(path.join(root, 'tools')), []);
});

for (const guarded of [false, true]) {
  for (const action of ['remove', 'clearCache', 'dispose', 'remove-and-dispose'] as const) {
    test(`${guarded ? 'guarded ' : ''}${action} drains a cancelled probe that releases its own task cache in finally`, async (t) => {
      const started = deferred<{ directory: string; abort: AbortSignal }>();
      let manager: LocalTools;
      let cleaned = false;
      let nativeCloses = 0;
      const instance = await fixture(t, {
        probe: async (tool, _paths, abort) => {
          const directory = await manager.allocateTaskCache();
          let owner: LocalTaskCacheOwner | undefined;
          let closing: Promise<void> | undefined;
          const close = (): Promise<void> => {
            closing ??= (async () => {
              nativeCloses++;
              owner?.confirmNativeClosed();
              await probeCacheCleanup(manager.removeTaskCache(directory));
              cleaned = true;
            })();
            return closing;
          };
          if (guarded) owner = manager.registerTaskCacheOwner(directory, close);
          await fs.writeFile(path.join(directory, 'worker-output'), 'controlled probe data');
          started.resolve({ directory, abort });
          try {
            await new Promise<void>((resolve) => {
              const cancelled = (): void => {
                abort.removeEventListener('abort', cancelled);
                resolve();
              };
              abort.addEventListener('abort', cancelled, { once: true });
              if (abort.aborted) cancelled();
            });
            return versions[tool];
          } finally {
            await close();
          }
        },
      });
      manager = instance.tools;
      const pending = manager.prepare(signal());
      const rejected = assert.rejects(pending, reason(action === 'dispose' ? 'executor_unavailable' : 'cancelled'));
      const probe = await started.promise;
      const management = action === 'remove' ? manager.remove('node')
        : action === 'clearCache' ? manager.clearCache()
          : action === 'dispose' ? manager.dispose()
            : Promise.all([manager.remove('node'), manager.dispose()]);
      const closed = action === 'dispose' || action === 'remove-and-dispose';
      assert.equal(probe.abort.aborted, true);
      await assert.rejects(manager.allocateTaskCache(), reason(closed ? 'executor_unavailable' : 'busy'));
      await assert.rejects(manager.prepare(signal()), reason(closed ? 'executor_unavailable' : 'busy'));
      await Promise.all([management, rejected]);
      assert.equal(cleaned, true, 'The probe must finish its owned cleanup before management returns');
      assert.equal(nativeCloses, 1);
      assert.deepEqual(instance.probes, ['node']);
      assert.deepEqual(await fs.readdir(path.join(instance.root, 'tools')), []);
      assert.deepEqual(await fs.readdir(path.join(instance.root, 'cache')), []);
      await assert.rejects(manager.removeTaskCache(probe.directory), reason('invalid_request'));
      await assert.rejects(manager.removeTaskCache(instance.base), reason('invalid_request'));
      if (!closed) assert.equal((await manager.snapshot()).tools[0]?.status, 'absent');
    });
  }
}

test('unconfirmed failed probe retains its independent owner, staged executable and cache across management attempts', async (t) => {
  const allocated = deferred<{ directory: string; candidate: string }>();
  let manager: LocalTools;
  let nativeStarts = 0;
  let closeAttempts = 0;
  const instance = await fixture(t, {
    disposeFailure: 'worker_failed',
    probe: async (_tool, paths) => {
      const directory = await manager.allocateTaskCache();
      manager.registerTaskCacheOwner(directory, async () => {
        closeAttempts++;
        throw new LocalExecutionError('worker_failed', { cause: new Error('Exit 7 without native closure confirmation') });
      });
      nativeStarts++;
      await fs.writeFile(path.join(directory, 'worker-output'), 'retained probe data');
      allocated.resolve({ directory, candidate: paths.node });
      throw new LocalExecutionError('worker_failed');
    },
  });
  manager = instance.tools;
  await assert.rejects(manager.prepare(signal()), reason('worker_failed'));
  const { directory, candidate } = await allocated.promise;
  const original = await fs.readFile(candidate);
  assert.equal(closeAttempts, 0, 'The preparation has failed without returning a runtime cleanup owner');
  await assert.rejects(manager.removeTaskCache(directory), reason('worker_failed'));
  for (const manage of [
    () => manager.clearCache(), () => manager.remove('node'), () => manager.dispose(), () => manager.dispose(),
  ]) {
    await assert.rejects(manage(), reason('worker_failed'));
    assert.deepEqual(await fs.readFile(candidate), original);
    assert.equal(await fs.readFile(path.join(directory, 'worker-output'), 'utf8'), 'retained probe data');
  }
  assert.equal(closeAttempts, 4);
  assert.equal(nativeStarts, 1);
  assert.deepEqual(instance.probes, ['node']);
  assert.ok(path.basename(path.dirname(candidate)).startsWith('.stage-node-'));
  await assert.rejects(fs.stat(path.join(instance.root, 'tools', 'node')), { code: 'ENOENT' });
  await assert.rejects(manager.prepare(signal()), reason('executor_unavailable'));
  await assert.rejects(manager.allocateTaskCache(), reason('executor_unavailable'));
});

test('a failed pre-ready factory keeps its guarded cache and installed tools despite never returning a runtime', async (t) => {
  const { tools, requests } = await fixture(t, { disposeFailure: 'worker_failed' });
  const paths = await tools.prepare(signal());
  const expectedNode = await fs.readFile(paths.node);
  const expectedFfmpeg = await fs.readFile(paths.ffmpeg);
  const allocated = deferred<string>();
  let nativeStarts = 0;
  const createRuntime = async (): Promise<never> => {
    const directory = await tools.allocateTaskCache();
    tools.registerTaskCacheOwner(directory, async () => {
      throw new LocalExecutionError('worker_failed', { cause: new Error('Factory lost the worker before its ready reply') });
    });
    nativeStarts++;
    await fs.writeFile(path.join(directory, 'worker-output'), 'pre-ready data');
    allocated.resolve(directory);
    throw new LocalExecutionError('worker_failed');
  };
  await assert.rejects(createRuntime(), reason('worker_failed'));
  const directory = await allocated.promise;
  const downloads = requests.length;
  await assert.rejects(tools.remove('ffmpeg'), reason('worker_failed'));
  await assert.rejects(tools.clearCache(), reason('worker_failed'));
  await assert.rejects(tools.dispose(), reason('worker_failed'));
  assert.equal(nativeStarts, 1);
  assert.equal(requests.length, downloads);
  assert.deepEqual(await fs.readFile(paths.node), expectedNode);
  assert.deepEqual(await fs.readFile(paths.ffmpeg), expectedFfmpeg);
  assert.equal(await fs.readFile(path.join(directory, 'worker-output'), 'utf8'), 'pre-ready data');
});

test('a fulfilled owner close without explicit native confirmation cannot authorize cache or staging deletion', async (t) => {
  const { tools, root } = await fixture(t, { disposeFailure: 'worker_failed' });
  const directory = await tools.allocateTaskCache();
  const stage = path.join(root, 'tools', `.stage-node-${randomUUID()}`);
  await fs.mkdir(stage);
  await fs.writeFile(path.join(stage, 'candidate'), 'still guarded');
  await fs.writeFile(path.join(directory, 'worker-output'), 'not a closure proof');
  let closes = 0;
  tools.registerTaskCacheOwner(directory, async () => { closes++; });
  await assert.rejects(tools.clearCache(), reason('worker_failed'));
  await assert.rejects(tools.remove('node'), reason('worker_failed'));
  await assert.rejects(tools.dispose(), reason('worker_failed'));
  assert.equal(closes, 3);
  assert.equal(await fs.readFile(path.join(stage, 'candidate'), 'utf8'), 'still guarded');
  assert.equal(await fs.readFile(path.join(directory, 'worker-output'), 'utf8'), 'not a closure proof');
});

test('native cache-owner registration and confirmation require an exact live lease and cannot be overwritten', async (t) => {
  const { tools, root } = await fixture(t);
  await tools.initialize();
  const unknown = path.join(root, 'cache', `task-${randomUUID()}`);
  await fs.mkdir(unknown);
  assert.throws(() => tools.registerTaskCacheOwner(unknown, async () => undefined), reason('invalid_request'));
  const directory = await tools.allocateTaskCache();
  let owner: LocalTaskCacheOwner;
  owner = tools.registerTaskCacheOwner(directory, async () => {
    owner.confirmNativeClosed();
    await tools.removeTaskCache(directory);
  });
  assert.throws(() => tools.registerTaskCacheOwner(directory, async () => undefined), reason('invalid_request'));
  await assert.rejects(tools.removeTaskCache(directory), reason('worker_failed'));
  owner.confirmNativeClosed();
  await tools.removeTaskCache(directory);
  assert.throws(() => owner.confirmNativeClosed(), reason('invalid_request'));
  assert.throws(() => tools.registerTaskCacheOwner(directory, async () => undefined), reason('invalid_request'));
  await assert.rejects(tools.removeTaskCache(directory), reason('invalid_request'));
  assert.equal((await fs.stat(unknown)).isDirectory(), true);
  await tools.clearCache();
});

test('failed disposal retries only filesystem cleanup, coalesces attempts and remains closed to new work', async (t) => {
  const { tools, requests, probes } = await fixture(t);
  const directory = await tools.allocateTaskCache();
  const filename = path.join(directory, 'worker-output');
  await fs.writeFile(filename, 'retryable cache');
  const original = fs.unlink.bind(fs);
  let locked = true;
  let deletions = 0;
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>): Promise<void> => {
    if (String(args[0]) === filename) {
      deletions++;
      if (locked) throw Object.assign(new Error('Controlled filesystem lock'), { code: 'EACCES' });
    }
    await original(...args);
  });
  const first = tools.dispose();
  assert.equal(tools.dispose(), first);
  await assert.rejects(first, reason('storage_failed'));
  assert.equal(deletions, 1);
  assert.equal(await fs.readFile(filename, 'utf8'), 'retryable cache');
  await assert.rejects(tools.allocateTaskCache(), reason('executor_unavailable'));
  await assert.rejects(tools.prepare(signal()), reason('executor_unavailable'));
  locked = false;
  const retry = tools.dispose();
  assert.notEqual(retry, first);
  assert.equal(tools.dispose(), retry);
  await retry;
  assert.equal(deletions, 2);
  await tools.dispose();
  assert.equal(deletions, 2);
  assert.deepEqual(requests, []);
  assert.deepEqual(probes, []);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  await assert.rejects(tools.removeTaskCache(directory), reason('invalid_request'));
});

test('a confirmed retained owner retries a transient cache error without another native execution', async (t) => {
  const { tools, requests, probes } = await fixture(t);
  const directory = await tools.allocateTaskCache();
  const filename = path.join(directory, 'worker-output');
  await fs.writeFile(filename, 'confirmed worker data');
  let owner: LocalTaskCacheOwner;
  let confirmed = false;
  let nativeStarts = 0;
  let nativeCloses = 0;
  let closeAttempts = 0;
  owner = tools.registerTaskCacheOwner(directory, async () => {
    closeAttempts++;
    if (!confirmed) {
      nativeCloses++;
      confirmed = true;
      owner.confirmNativeClosed();
    }
    await tools.removeTaskCache(directory);
  });
  nativeStarts++;
  const original = fs.unlink.bind(fs);
  let locked = true;
  let deletions = 0;
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>): Promise<void> => {
    if (String(args[0]) === filename) {
      deletions++;
      if (locked) throw Object.assign(new Error('Controlled filesystem lock'), { code: 'EACCES' });
    }
    await original(...args);
  });
  const first = tools.dispose();
  assert.equal(tools.dispose(), first);
  await assert.rejects(first, reason('storage_failed'));
  assert.equal(closeAttempts, 1);
  assert.equal(deletions, 1, 'A failed owner close must not fall through into an ordinary sweep');
  assert.equal(nativeCloses, 1);
  assert.equal(await fs.readFile(filename, 'utf8'), 'confirmed worker data');
  locked = false;
  const retry = tools.dispose();
  assert.equal(tools.dispose(), retry);
  await retry;
  assert.equal(closeAttempts, 2);
  assert.equal(deletions, 2);
  assert.equal(nativeCloses, 1);
  assert.equal(nativeStarts, 1);
  await tools.dispose();
  assert.equal(closeAttempts, 2);
  assert.deepEqual(requests, []);
  assert.deepEqual(probes, []);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  assert.throws(() => owner.confirmNativeClosed(), reason('invalid_request'));
});

test('overlapping maintenance and disposal coalesce the retained owner cleanup before a filesystem-only retry', async (t) => {
  const { tools } = await fixture(t);
  const directory = await tools.allocateTaskCache();
  const filename = path.join(directory, 'worker-output');
  await fs.writeFile(filename, 'confirmed worker data');
  const deleting = deferred<void>();
  const released = deferred<void>();
  const original = fs.unlink.bind(fs);
  let locked = true;
  let deletions = 0;
  let nativeCloses = 0;
  let closeAttempts = 0;
  let confirmed = false;
  let owner: LocalTaskCacheOwner;
  owner = tools.registerTaskCacheOwner(directory, async () => {
    closeAttempts++;
    if (!confirmed) {
      confirmed = true;
      nativeCloses++;
      owner.confirmNativeClosed();
    }
    await tools.removeTaskCache(directory);
  });
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>): Promise<void> => {
    if (String(args[0]) === filename) {
      deletions++;
      if (locked) {
        deleting.resolve();
        await released.promise;
        throw Object.assign(new Error('Controlled filesystem lock'), { code: 'EACCES' });
      }
    }
    await original(...args);
  });
  const removed = assert.rejects(tools.remove('node'), reason('storage_failed'));
  await deleting.promise;
  const disposed = assert.rejects(tools.dispose(), reason('storage_failed'));
  released.resolve();
  await Promise.all([removed, disposed]);
  assert.equal(closeAttempts, 1);
  assert.equal(deletions, 1);
  assert.equal(nativeCloses, 1);
  locked = false;
  await tools.dispose();
  assert.equal(closeAttempts, 2);
  assert.equal(deletions, 2);
  assert.equal(nativeCloses, 1);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
});

test('probe cancellation is bounded and successful-looking late results cannot bypass the deadline', async (t) => {
  const started = deferred<AbortSignal>();
  const { tools, root } = await fixture(t, {
    probe: async (_tool, _paths, abort) => new Promise<string>((_resolve, reject) => {
      abort.addEventListener('abort', () => reject(abort.reason), { once: true });
      started.resolve(abort);
    }),
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = tools.prepare(signal());
  const rejected = assert.rejects(pending, reason('timeout'));
  const probeSignal = await started.promise;
  t.mock.timers.tick(9_999);
  assert.equal(probeSignal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.deepEqual(await fs.readdir(path.join(root, 'tools')), []);
  assert.equal((await tools.snapshot()).tools[0]?.failure, 'timeout');
});

test('yt-dlp cold-start probes retain the SDK time budget instead of timing out after fifteen seconds', async (t) => {
  const started = deferred<AbortSignal>();
  const released = deferred<string>();
  const { tools } = await fixture(t, {
    probe: async (tool, _paths, abort) => {
      if (tool !== 'yt-dlp') return versions[tool];
      started.resolve(abort);
      return new Promise<string>((resolve, reject) => {
        const cancel = (): void => reject(abort.reason);
        abort.addEventListener('abort', cancel, { once: true });
        released.promise.then((version) => {
          abort.removeEventListener('abort', cancel);
          resolve(version);
        });
        if (abort.aborted) cancel();
      });
    },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = tools.prepare(signal());
  const probeSignal = await started.promise;
  t.mock.timers.tick(20_000);
  assert.equal(probeSignal.aborted, false);
  released.resolve(versions['yt-dlp']);
  await pending;
  assert.ok((await tools.snapshot()).tools.every((tool) => tool.status === 'ready'));
});

test('candidates altered by a probe are rejected before atomic publication', async (t) => {
  const { tools, root } = await fixture(t, {
    probe: async (tool, paths) => {
      await fs.writeFile(executable(paths, tool), 'changed after the verified download');
      return versions[tool];
    },
  });
  await assert.rejects(tools.prepare(signal()), reason('integrity_failed'));
  assert.deepEqual(await fs.readdir(path.join(root, 'tools')), []);
});

test('retrying an interrupted download cleans partial files and reuses completed tools', async (t) => {
  let interrupt = true;
  const { tools, root, assets, requests } = await fixture(t, {
    download: async (asset) => {
      if (asset.tool !== 'yt-dlp' || !interrupt) return new Response(new Uint8Array(asset.bytes));
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new Error('Controlled interrupted download'));
          else { sent = true; controller.enqueue(new Uint8Array(asset.bytes.subarray(0, 4))); }
        },
      }));
    },
  });
  await assert.rejects(tools.prepare(signal()), LocalExecutionError);
  const failed = await tools.snapshot();
  assert.equal(failed.tools.find((tool) => tool.id === 'node')?.status, 'ready');
  assert.equal(failed.tools.find((tool) => tool.id === 'yt-dlp')?.status, 'failed');
  assert.equal(failed.tools.find((tool) => tool.id === 'yt-dlp')?.progress, null);
  assert.ok((await fs.readdir(path.join(root, 'tools'))).every((name) => !name.startsWith('.stage-')));
  const downloads = (tool: LocalToolId): number => requests.filter((url) => url === assets.find((asset) => asset.tool === tool)?.url).length;
  const completedDownloads = downloads('node');
  const interruptedDownloads = downloads('yt-dlp');
  assert.ok(completedDownloads > 0 && interruptedDownloads > 0);
  assert.equal(downloads('ffmpeg'), 0);
  interrupt = false;
  await tools.prepare(signal());
  assert.ok((await tools.snapshot()).tools.every((tool) => tool.status === 'ready' && !tool.progress && !tool.failure));
  assert.equal(downloads('node'), completedDownloads, 'A completed download must not be repeated');
  assert.equal(downloads('yt-dlp'), interruptedDownloads + 1);
  assert.ok(downloads('ffmpeg') > 0);
  assert.ok((await fs.readdir(path.join(root, 'tools'))).every((name) => !name.startsWith('.stage-')));
});

test('wrong upstream checksums never reach the probe or leave a half-installed tool', async (t) => {
  const { tools, root, requests, probes } = await fixture(t, { badHash: 'node' });
  await assert.rejects(tools.prepare(signal()), reason('integrity_failed'));
  assert.deepEqual(probes, []);
  assert.deepEqual(await fs.readdir(path.join(root, 'tools')), []);
  const requestsBefore = requests.length;
  const node = (await tools.snapshot()).tools[0];
  assert.equal(node?.status, 'failed');
  assert.equal(node?.failure, 'integrity_failed');
  assert.equal(requests.length, requestsBefore);
  await tools.remove('node');
  assert.equal((await tools.snapshot()).tools[0]?.status, 'absent');
});

test('failed partial-file cleanup is surfaced and blocks more installations until explicit maintenance succeeds', async (t) => {
  const { tools, root, requests } = await fixture(t, { badHash: 'node' });
  const original = fs.unlink.bind(fs);
  let deny = true;
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>): Promise<void> => {
    if (deny && String(args[0]).startsWith(path.join(root, 'tools', '.stage-node-'))) {
      throw Object.assign(new Error('Controlled cleanup denial'), { code: 'EACCES' });
    }
    await original(...args);
  });
  await assert.rejects(tools.prepare(signal()), reason('storage_failed'));
  const calls = requests.length;
  await assert.rejects(tools.prepare(signal()), reason('storage_failed'));
  assert.equal(requests.length, calls);
  const failed = await tools.snapshot();
  assert.equal(failed.tools[0]?.failure, 'storage_failed');
  assert.ok(failed.toolsBytes > 0);
  deny = false;
  await tools.remove('node');
  assert.equal((await tools.snapshot()).toolsBytes, 0);
});

test('explicit preparation retry cleans a retained failed staging directory before downloading again', async (t) => {
  let interrupt = true;
  let nodeDownloads = 0;
  const { tools, root, requests } = await fixture(t, {
    download: async (asset) => {
      if (asset.tool === 'node') nodeDownloads++;
      if (asset.tool !== 'yt-dlp' || !interrupt) return new Response(new Uint8Array(asset.bytes));
      let sent = false;
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent) controller.error(new Error('Controlled download interruption'));
          else { sent = true; controller.enqueue(new Uint8Array(asset.bytes.subarray(0, 4))); }
        },
      }));
    },
  });
  const unlink = fs.unlink.bind(fs);
  let locked = true;
  t.mock.method(fs, 'unlink', async (filename: Parameters<typeof fs.unlink>[0]): Promise<void> => {
    if (locked && String(filename).startsWith(path.join(root, 'tools', '.stage-yt-dlp-'))) {
      throw Object.assign(new Error('Controlled retained staging lock'), { code: 'EACCES' });
    }
    await unlink(filename);
  });
  await assert.rejects(tools.prepare(signal()), reason('storage_failed'));
  const requestsBeforeRetry = requests.length;
  await assert.rejects(tools.prepare(signal(), true), reason('storage_failed'));
  assert.equal(requests.length, requestsBeforeRetry, 'a persistent cleanup failure must remain fail-closed');
  locked = false;
  interrupt = false;
  await assert.rejects(tools.prepare(signal()), reason('storage_failed'), 'a bot request cannot silently authorize recovery');
  await tools.prepare(signal(), true);
  assert.ok((await tools.snapshot()).tools.every((tool) => tool.status === 'ready'));
  assert.ok((await fs.readdir(path.join(root, 'tools'))).every((name) => !name.startsWith('.stage-')));
  assert.equal(nodeDownloads, 1, 'recovery must preserve an already installed Node');
});

test('Windows sharing violations during publication are retried without downloading twice', { skip: process.platform !== 'win32' }, async (t) => {
  let nodeDownloads = 0;
  const { tools, root } = await fixture(t, { download: async (asset) => {
    if (asset.tool === 'node') nodeDownloads++;
    return new Response(new Uint8Array(asset.bytes));
  } });
  const rename = fs.rename.bind(fs);
  let failures = 0;
  t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>): Promise<void> => {
    if (String(args[1]) === path.join(root, 'tools', 'node') && failures++ < 2) {
      throw Object.assign(new Error('Controlled Windows sharing violation'), { code: 'EPERM' });
    }
    await rename(...args);
  });
  await tools.prepare(signal());
  assert.ok((await tools.snapshot()).tools.every((tool) => tool.status === 'ready'));
  assert.equal(failures, 3);
  assert.equal(nodeDownloads, 1);
});

test('explicit retry recovers after a real Windows file-sharing lock is released', { skip: process.platform !== 'win32' }, async (t) => {
  let release: (() => Promise<void>) | undefined;
  t.after(async () => { await release?.(); });
  let failProbe = true;
  const { tools, root } = await fixture(t, { probe: async (tool, paths) => {
    if (tool === 'yt-dlp' && failProbe) {
      release = await holdWindowsFile(paths.ytDlp);
      throw new LocalExecutionError('tool_install_failed');
    }
    return versions[tool];
  } });
  await assert.rejects(tools.prepare(signal()), reason('storage_failed'));
  await assert.rejects(tools.prepare(signal(), true), reason('storage_failed'));
  assert.ok((await fs.readdir(path.join(root, 'tools'))).some((name) => name.startsWith('.stage-yt-dlp-')),
    'a genuinely locked file must not be reported as cleaned up');
  assert.equal((await tools.snapshot()).tools[0]?.status, 'ready');
  assert.ok(release);
  await release();
  failProbe = false;
  await tools.prepare(signal(), true);
  assert.ok((await tools.snapshot()).tools.every((tool) => tool.status === 'ready'));
  assert.ok((await fs.readdir(path.join(root, 'tools'))).every((name) => !name.startsWith('.stage-')));
  await tools.remove('yt-dlp');
  const remaining = await tools.snapshot();
  assert.equal(remaining.tools.find((tool) => tool.id === 'yt-dlp')?.status, 'absent');
  assert.equal(remaining.tools.find((tool) => tool.id === 'node')?.status, 'ready');
  assert.equal(remaining.tools.find((tool) => tool.id === 'ffmpeg')?.status, 'ready');
});

test('a failed initial storage scan is retryable after access is restored, without a new manager', async (t) => {
  const { tools, root } = await fixture(t);
  const original = fs.readdir.bind(fs);
  let inaccessible = true;
  t.mock.method(fs, 'readdir', (...args: Parameters<typeof fs.readdir>) => {
    if (inaccessible && String(args[0]) === path.join(root, 'tools')) {
      throw Object.assign(new Error('Controlled initial read denial'), { code: 'EACCES' });
    }
    return original(...args);
  });
  await assert.rejects(tools.initialize(), reason('storage_failed'));
  inaccessible = false;
  await tools.initialize();
  assert.equal((await tools.snapshot()).toolsBytes, 0);
  await tools.prepare(signal(), true);
  assert.ok((await tools.snapshot()).tools.every((tool) => tool.status === 'ready'));
});

test('modified executables become invalid before reuse and require explicit removal, never silent repair', async (t) => {
  const { tools, probes, requests } = await fixture(t);
  const paths = await tools.prepare(signal());
  const oldRequests = requests.length;
  const oldProbes = probes.length;
  await fs.writeFile(paths.node, 'corrupted executable');
  const snapshot = await tools.snapshot();
  assert.equal(snapshot.tools[0]?.status, 'invalid');
  assert.equal(snapshot.tools[0]?.failure, 'integrity_failed');
  await assert.rejects(tools.prepare(signal()), reason('integrity_failed'));
  await assert.rejects(tools.prepare(signal(), true), reason('integrity_failed'), 'explicit retry must not replace a tampered tool');
  assert.equal(probes.length, oldProbes);
  assert.equal(requests.length, oldRequests);
  await tools.remove('node');
  await tools.prepare(signal());
  assert.ok(requests.length > oldRequests);
  assert.equal((await tools.snapshot()).tools[0]?.status, 'ready');
});

test('malformed, forged and semantically tampered receipts fail closed after restart', async (t) => {
  const { tools, root, probes, requests } = await fixture(t);
  const paths = await tools.prepare(signal());
  const filename = path.join(path.dirname(paths.node), 'receipt.json');
  const original = await fs.readFile(filename, 'utf8');
  const receipt = localToolReceiptSchema.parse(JSON.parse(original));
  const cases: unknown[] = [
    '{ unfinished',
    { ...receipt, id: 'ffmpeg' },
    { ...receipt, sourceUrl: 'https://unapproved.example/node.exe' },
    { ...receipt, artifactName: '../node.exe' },
    { ...receipt, sizeBytes: receipt.sizeBytes + 1 },
    { ...receipt, executableSha256: '0'.repeat(64) },
    { ...receipt, artifactSha256: '0'.repeat(64) },
    { ...receipt, command: 'unapproved extra field' },
  ];
  const oldProbes = probes.length;
  const oldRequests = requests.length;
  for (const invalid of cases) {
    await fs.writeFile(filename, typeof invalid === 'string' ? invalid : JSON.stringify(invalid));
    const restarted = new LocalTools({ root, probe: async () => assert.fail('Invalid receipts must never execute') });
    try {
      assert.equal((await restarted.snapshot()).tools[0]?.status, 'invalid');
      await assert.rejects(restarted.prepare(signal()), reason('integrity_failed'));
    } finally { await restarted.dispose(); }
  }
  await fs.writeFile(filename, original);
  assert.equal(probes.length, oldProbes);
  assert.equal(requests.length, oldRequests);
});

test('even schema-valid edits to a previously verified receipt invalidate its immutable generation', async (t) => {
  const { tools } = await fixture(t);
  const paths = await tools.prepare(signal());
  const filename = path.join(path.dirname(paths.ffmpeg), 'receipt.json');
  const receipt = localToolReceiptSchema.parse(JSON.parse(await fs.readFile(filename, 'utf8')));
  await fs.writeFile(filename, JSON.stringify({ ...receipt, version: 'forged version' }));
  assert.equal((await tools.snapshot()).tools[2]?.status, 'invalid');
  await fs.writeFile(filename, `${JSON.stringify(receipt)}\n`);
  await assert.rejects(tools.prepare(signal()), reason('integrity_failed'));
});

test('retained archive hashes are verified offline rather than trusting a tampered receipt after restart', async (t) => {
  const { tools, root } = await fixture(t);
  const paths = await tools.prepare(signal());
  const tool = process.platform === 'win32' ? 'ffmpeg' : 'node';
  const receiptFile = path.join(path.dirname(executable(paths, tool)), 'receipt.json');
  const receipt = localToolReceiptSchema.parse(JSON.parse(await fs.readFile(receiptFile, 'utf8')));
  await fs.writeFile(receiptFile, JSON.stringify({ ...receipt, artifactSha256: '0'.repeat(64) }));
  const restarted = new LocalTools({ root, probe: async () => assert.fail('An invalid archive must not execute') });
  try {
    assert.equal((await restarted.snapshot()).tools.find((entry) => entry.id === tool)?.status, 'invalid');
    await assert.rejects(restarted.prepare(signal()), reason('integrity_failed'));
  } finally { await restarted.dispose(); }
});

test('stale inventory reads during removal cannot mark the next generation invalid', async (t) => {
  const { tools } = await fixture(t);
  const paths = await tools.prepare(signal());
  const receiptFile = path.join(path.dirname(paths.node), 'receipt.json');
  const started = deferred<void>();
  const released = deferred<void>();
  const original = fs.open.bind(fs);
  let held = false;
  t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>): Promise<Awaited<ReturnType<typeof fs.open>>> => {
    if (!held && String(args[0]) === receiptFile) {
      held = true;
      started.resolve();
      await released.promise;
    }
    return original(...args);
  });
  const snapshot = tools.snapshot();
  await started.promise;
  await tools.remove('node');
  released.resolve();
  assert.equal((await snapshot).tools[0]?.status, 'absent');
  await tools.prepare(signal());
  assert.equal((await tools.snapshot()).tools[0]?.status, 'ready');
});

test('escaping tool junctions are invalid, and explicit removal only unlinks the managed reference', async (t) => {
  const { tools, root, base, probes } = await fixture(t);
  await tools.initialize();
  const outside = path.join(base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel'), 'untouched');
  const link = path.join(root, 'tools', 'node');
  await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await tools.snapshot()).tools[0]?.status, 'invalid');
  await assert.rejects(tools.prepare(signal()), reason('integrity_failed'));
  assert.deepEqual(probes, []);
  await tools.remove('node');
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'untouched');
  await assert.rejects(fs.lstat(link), { code: 'ENOENT' });
});

test('hard-linked executables and incomplete published directories are not reusable installations', async (t) => {
  const { tools, root, base } = await fixture(t);
  const paths = await tools.prepare(signal());
  const outside = path.join(base, 'linked-executable');
  await fs.link(paths.node, outside);
  assert.equal((await tools.snapshot()).tools[0]?.status, 'invalid');
  await tools.remove('node');
  assert.equal((await fs.stat(outside)).nlink, 1);
  await fs.mkdir(path.join(root, 'tools', 'node'));
  await fs.writeFile(paths.node, 'unfinished published file');
  assert.equal((await tools.snapshot()).tools[0]?.status, 'invalid');
  await assert.rejects(tools.prepare(signal()), reason('integrity_failed'));
});

test('only recognized abandoned staging generations are cleaned during initialization', async (t) => {
  const { tools, root } = await fixture(t);
  const staging = path.join(root, 'tools', `.stage-node-${randomUUID()}`);
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, 'partial'), 'interrupted download');
  const unknown = path.join(root, 'tools', '.unrecognized');
  await fs.writeFile(unknown, 'preserved');
  await tools.initialize();
  await assert.rejects(fs.stat(staging), { code: 'ENOENT' });
  assert.equal((await tools.snapshot()).toolsBytes, Buffer.byteLength('preserved'));
  assert.equal(await fs.readFile(unknown, 'utf8'), 'preserved');
});

test('a linked root is rejected before creating storage in the external target', async (t) => {
  const { base } = await fixture(t);
  const external = path.join(base, 'external-root');
  const linked = path.join(base, 'linked-root');
  await fs.mkdir(external);
  await fs.symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  const tools = new LocalTools({ root: linked, probe: async () => assert.fail('Linked root must not execute') });
  await assert.rejects(tools.initialize(), reason('integrity_failed'));
  await assert.rejects(tools.dispose(), reason('integrity_failed'));
  assert.deepEqual(await fs.readdir(external), []);
  await fs.unlink(linked);
});

test('task cache allocation, real inventory, isolated removal and clearing preserve other parent-owned data', async (t) => {
  const { tools, root, base } = await fixture(t);
  const first = await tools.allocateTaskCache();
  const second = await tools.allocateTaskCache();
  assert.notEqual(first, second);
  assert.equal(path.dirname(first), path.join(root, 'cache'));
  await fs.writeFile(path.join(first, 'preview.ogg'), Buffer.alloc(321));
  await fs.mkdir(path.join(second, 'nested'));
  await fs.writeFile(path.join(second, 'nested', 'stream'), Buffer.alloc(123));
  await fs.writeFile(path.join(root, 'parent-owned.json'), 'keep');
  assert.equal((await tools.snapshot()).cacheBytes, 444);
  await assert.rejects(tools.removeTaskCache(base), reason('invalid_request'));
  await tools.removeTaskCache(first);
  assert.equal((await tools.snapshot()).cacheBytes, 123);
  await tools.clearCache();
  assert.equal((await tools.snapshot()).cacheBytes, 0);
  assert.deepEqual(await fs.readdir(path.join(root, 'cache')), []);
  assert.equal(await fs.readFile(path.join(root, 'parent-owned.json'), 'utf8'), 'keep');
});

test('preparation disclosure is filesystem-free and accounts for retained archives without charging installed tools again', async (t) => {
  const { tools } = await fixture(t);
  const before = tools.preparationInfo('youtube-audio');
  assert.deepEqual(before.tools.map((tool) => tool.info.id), ['node', 'yt-dlp', 'ffmpeg']);
  assert.ok(before.tools.every((tool) => tool.maximumAdditionalBytes >= 350 * 1024 ** 2));
  assert.equal(before.maximumCacheBytes, 512 * 1024 ** 2);
  if (process.platform === 'win32') {
    assert.equal(before.tools[2].maximumAdditionalBytes - before.tools[0].maximumAdditionalBytes, 350 * 1024 ** 2);
  }
  before.tools[0].info.status = 'ready';
  assert.equal(tools.preparationInfo('youtube-audio').tools[0].info.status, 'absent', 'The disclosure is a read-only copy');
  await tools.prepare(signal());
  const installed = tools.preparationInfo('youtube-audio');
  assert.ok(installed.tools.every((tool) => tool.maximumAdditionalBytes === 0 && tool.info.sizeBytes > 0));
});

test('concurrent releases of an owned cache share one deletion, but a released lease is rejected', async (t) => {
  const { tools } = await fixture(t);
  const directory = await tools.allocateTaskCache();
  const filename = path.join(directory, 'worker-output');
  await fs.writeFile(filename, 'controlled cache');
  const started = deferred<void>();
  const released = deferred<void>();
  const original = fs.unlink.bind(fs);
  let deletions = 0;
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>): Promise<void> => {
    if (String(args[0]) === filename) {
      deletions++;
      started.resolve();
      await released.promise;
    }
    await original(...args);
  });
  const first = tools.removeTaskCache(directory);
  await started.promise;
  const second = tools.removeTaskCache(directory);
  try {
    assert.equal(second, first);
    assert.throws(() => tools.registerTaskCacheOwner(directory, async () => undefined), reason('invalid_request'));
  } finally {
    released.resolve();
  }
  await Promise.all([first, second]);
  assert.equal(deletions, 1);
  await assert.rejects(tools.removeTaskCache(directory), reason('invalid_request'));
});

test('inventory waits for owned filesystem cleanup instead of traversing a Windows delete-pending directory', async (t) => {
  const { tools } = await fixture(t);
  const directory = await tools.allocateTaskCache();
  const filename = path.join(directory, 'preview.ogg');
  await fs.writeFile(filename, Buffer.alloc(321));
  const started = deferred<void>();
  const released = deferred<void>();
  const unlink = fs.unlink.bind(fs);
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>): Promise<void> => {
    if (String(args[0]) === filename) { started.resolve(); await released.promise; }
    await unlink(...args);
  });
  const cleanup = tools.removeTaskCache(directory);
  await started.promise;
  let settled = false;
  const snapshot = tools.snapshot();
  void snapshot.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false, 'A tree walk must not race the pending owned deletion');
  } finally {
    released.resolve();
  }
  await cleanup;
  assert.equal((await snapshot).cacheBytes, 0);
  assert.equal((await tools.snapshot()).cacheBytes, 0);
});

for (const action of ['clearCache', 'dispose'] as const) {
  test(`${action} serializes late owned cleanup behind its cache sweep without accepting unknown leases`, async (t) => {
    const { tools, base } = await fixture(t);
    const directory = await tools.allocateTaskCache();
    const filename = path.join(directory, 'worker-output');
    const external = path.join(base, 'external');
    await fs.writeFile(filename, 'controlled cache');
    await fs.writeFile(external, 'untouched');
    const started = deferred<void>();
    const released = deferred<void>();
    const original = fs.unlink.bind(fs);
    let deletions = 0;
    t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>): Promise<void> => {
      if (String(args[0]) === filename) {
        deletions++;
        started.resolve();
        await released.promise;
      }
      await original(...args);
    });
    const management = action === 'clearCache' ? tools.clearCache() : tools.dispose();
    await started.promise;
    const cleanup = tools.removeTaskCache(directory);
    const results = Promise.allSettled([management, cleanup]);
    try {
      await assert.rejects(tools.removeTaskCache(external), reason('invalid_request'));
      await assert.rejects(tools.allocateTaskCache(), reason(action === 'dispose' ? 'executor_unavailable' : 'busy'));
      assert.throws(() => tools.registerTaskCacheOwner(directory, async () => undefined),
        reason(action === 'dispose' ? 'executor_unavailable' : 'busy'));
      assert.equal(await fs.readFile(external, 'utf8'), 'untouched');
    } finally {
      released.resolve();
    }
    for (const result of await results) {
      assert.equal(result.status, 'fulfilled', result.status === 'rejected' ? String(result.reason) : undefined);
    }
    assert.equal(deletions, 1);
    await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
    await assert.rejects(tools.removeTaskCache(directory), reason('invalid_request'));
    assert.equal(await fs.readFile(external, 'utf8'), 'untouched');
  });
}

test('a failed cache deletion remains an owned lease and does not poison a subsequent explicit cleanup', async (t) => {
  const { tools } = await fixture(t);
  const directory = await tools.allocateTaskCache();
  const filename = path.join(directory, 'worker-output');
  await fs.writeFile(filename, 'controlled cache');
  const original = fs.unlink.bind(fs);
  let fail = true;
  t.mock.method(fs, 'unlink', async (...args: Parameters<typeof fs.unlink>): Promise<void> => {
    if (String(args[0]) === filename && fail) {
      fail = false;
      throw Object.assign(new Error('Controlled cleanup failure'), { code: 'EACCES' });
    }
    await original(...args);
  });
  await assert.rejects(tools.removeTaskCache(directory), reason('storage_failed'));
  await tools.removeTaskCache(directory);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
  await assert.rejects(tools.removeTaskCache(directory), reason('invalid_request'));
});

test('clearing the cache cannot race a delayed cache allocation', async (t) => {
  const { tools, root } = await fixture(t);
  await tools.initialize();
  const started = deferred<void>();
  const released = deferred<void>();
  const original = fs.mkdir.bind(fs);
  t.mock.method(fs, 'mkdir', async (filename: PathLike, options?: MakeDirectoryOptions & { recursive?: false }): Promise<void> => {
    if (path.basename(String(filename)).startsWith('task-')) { started.resolve(); await released.promise; }
    await original(filename, options);
  });
  const allocated = tools.allocateTaskCache();
  const rejected = assert.rejects(allocated, reason('cancelled'));
  await started.promise;
  const cleared = tools.clearCache();
  await assert.rejects(tools.allocateTaskCache(), reason('busy'));
  released.resolve();
  await cleared;
  await rejected;
  assert.deepEqual(await fs.readdir(path.join(root, 'cache')), []);
});

test('clearing the cache aborts and joins the current installation without leaving partial tools', async (t) => {
  const started = deferred<void>();
  const released = deferred<void>();
  const { tools, root } = await fixture(t, {
    download: async (asset, abort) => {
      started.resolve();
      return heldResponse(asset.bytes, abort, released.promise);
    },
  });
  const cache = await tools.allocateTaskCache();
  await fs.writeFile(path.join(cache, 'temporary'), 'owned cache');
  const pending = tools.prepare(signal());
  const rejected = assert.rejects(pending, reason('cancelled'));
  await started.promise;
  await tools.clearCache();
  await rejected;
  released.resolve();
  assert.deepEqual(await fs.readdir(path.join(root, 'tools')), []);
  assert.equal((await tools.snapshot()).cacheBytes, 0);
});

test('concurrent cache reservations cannot exceed the declared capacity, including stale directories', async (t) => {
  const { tools, root } = await fixture(t);
  await tools.initialize();
  const count = LOCAL_TOOLS_CACHE_MAX_BYTES / LOCAL_TASK_CACHE_MAX_BYTES;
  for (let index = 0; index < count - 1; index++) await fs.mkdir(path.join(root, 'cache', `task-${randomUUID()}`));
  const results = await Promise.allSettled([tools.allocateTaskCache(), tools.allocateTaskCache()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const failed = results.find((result) => result.status === 'rejected');
  assert.ok(failed?.status === 'rejected' && reason('storage_failed')(failed.reason));
  assert.equal((await fs.readdir(path.join(root, 'cache'))).length, count);
  await tools.clearCache();
});

test('cache links never make snapshots or clearing traverse outside managed storage', async (t) => {
  const { tools, root, base } = await fixture(t);
  await tools.initialize();
  const outside = path.join(base, 'outside-cache');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'sentinel'), 'external');
  const cache = path.join(root, 'cache');
  await fs.rmdir(cache);
  await fs.symlink(outside, cache, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(tools.snapshot(), reason('integrity_failed'));
  await assert.rejects(tools.clearCache(), reason('integrity_failed'));
  assert.equal(await fs.readFile(path.join(outside, 'sentinel'), 'utf8'), 'external');
  await fs.unlink(cache);
  await fs.mkdir(cache);
});

test('storage failures are explicit rather than zero-byte inventory or a successful failed install', async (t) => {
  const { tools, probes } = await fixture(t);
  await tools.initialize();
  t.mock.method(fs, 'statfs', async () => { throw Object.assign(new Error('Controlled storage failure'), { code: 'ENOSPC' }); });
  await assert.rejects(tools.prepare(signal()), reason('storage_failed'));
  assert.deepEqual(probes, []);
  assert.equal((await tools.snapshot()).tools[0]?.failure, 'storage_failed');
});

test('inaccessible cache data is reported as a storage failure, not zero bytes', async (t) => {
  const { tools, root } = await fixture(t);
  await tools.initialize();
  const original = fs.readdir.bind(fs);
  t.mock.method(fs, 'readdir', (...args: Parameters<typeof fs.readdir>): ReturnType<typeof fs.readdir> => {
    if (String(args[0]) === path.join(root, 'cache')) {
      return Promise.reject(Object.assign(new Error('Controlled denied directory'), { code: 'EACCES' }));
    }
    return original(...args);
  });
  await assert.rejects(tools.snapshot(), reason('storage_failed'));
});

test('missing archive prerequisites disable preparation without executing or fetching anything', async (t) => {
  const { tools, requests, probes } = await fixture(t);
  await tools.initialize();
  const original = fs.access.bind(fs);
  t.mock.method(fs, 'access', async (...args: Parameters<typeof fs.access>): Promise<void> => {
    if (['tar.exe', 'tar'].includes(path.basename(String(args[0])))) {
      throw Object.assign(new Error('Controlled missing tar'), { code: 'ENOENT' });
    }
    await original(...args);
  });
  assert.equal((await tools.snapshot()).supported, false);
  await assert.rejects(tools.prepare(signal()), reason('unsupported_platform'));
  assert.deepEqual(requests, []);
  assert.deepEqual(probes, []);
});

test('changing OS prerequisites updates support without corrupting otherwise valid tool generations', async (t) => {
  const { tools, requests, probes } = await fixture(t);
  await tools.prepare(signal());
  const calls = requests.length;
  const checked = probes.length;
  const original = fs.access.bind(fs);
  const unavailable = t.mock.method(fs, 'access', async (...args: Parameters<typeof fs.access>): Promise<void> => {
    if (['tar.exe', 'tar'].includes(path.basename(String(args[0])))) {
      throw Object.assign(new Error('Controlled missing tar'), { code: 'ENOENT' });
    }
    await original(...args);
  });
  const snapshot = await tools.snapshot();
  assert.equal(snapshot.supported, false);
  assert.ok(snapshot.tools.every((tool) => tool.status === 'ready'));
  await assert.rejects(tools.prepare(signal()), reason('unsupported_platform'));
  assert.equal(requests.length, calls);
  assert.equal(probes.length, checked);
  unavailable.mock.restore();
  await tools.prepare(signal());
  assert.equal((await tools.snapshot()).supported, true);
  assert.equal(requests.length, calls);
});

test('download notifications are throttled instead of emitting once per small streamed chunk', async (t) => {
  let changes = 0;
  const { tools } = await fixture(t, {
    nodeContents: Buffer.alloc(256 * 1024, 97),
    onChanged: () => { changes++; },
    download: async (asset) => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < asset.bytes.length; offset += 256) {
          controller.enqueue(new Uint8Array(asset.bytes.subarray(offset, offset + 256)));
        }
        controller.close();
      },
    })),
  });
  await tools.prepare(signal());
  assert.ok(changes < 100, `Expected throttled updates, received ${changes}`);
});

test('bounded extraction selects exactly one file, creates no archive directories and rejects traversal/missing members', async (t) => {
  const { base } = await fixture(t);
  const support = await localToolExtractionSupport(process.platform, process.arch);
  assert.ok(support);
  const implementation = await checkToolExtraction(support, signal());
  const member = 'controlled-release/bin/node';
  const bytes = Buffer.from('controlled extracted contents, never executed');
  const archive = path.join(base, 'fixture.tar.gz');
  await fs.writeFile(archive, gzipSync(tarFixture(member, bytes)));
  const destination = path.join(base, 'candidate');
  const options = { support, implementation, archive, format: 'tar.gz', member, destination, maxBytes: 1024, signal: signal() } as const;
  await extractLocalTool(options);
  assert.deepEqual(await fs.readFile(destination), bytes);
  await assert.rejects(extractLocalTool(options), reason('integrity_failed'));
  assert.deepEqual(await fs.readFile(destination), bytes);
  await assert.rejects(fs.stat(path.join(base, 'controlled-release')), { code: 'ENOENT' });
  await assert.rejects(extractLocalTool({ ...options, destination: path.join(base, 'traversal'), member: '../../outside' }), reason('invalid_request'));
  await assert.rejects(extractLocalTool({ ...options, destination: path.join(base, 'missing'), member: 'different-release/bin/node' }), reason('tool_install_failed'));
  await assert.rejects(extractLocalTool({ ...options, destination: path.join(base, 'limited'), maxBytes: 2 }), reason('integrity_failed'));
  const controller = new AbortController();
  const cancelled = extractLocalTool({ ...options, destination: path.join(base, 'cancelled'), signal: controller.signal });
  controller.abort(new LocalExecutionError('cancelled'));
  await assert.rejects(cancelled, reason('cancelled'));
});
