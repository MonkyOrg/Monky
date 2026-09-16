import assert from 'node:assert/strict';
import childProcess, { type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getEventListeners } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'node:test';
import { OggOpusParser, terminate } from '@monky/bot-sdk/dist/localRuntime';
import { LOCAL_EXECUTION_RUNTIME_LIMITS } from '@monky/shared';
import {
  LOCAL_TASK_CACHE_MAX_BYTES, LOCAL_TOOLS_CACHE_MAX_BYTES, LocalTools, type LocalToolPaths,
} from '../src/main/localExecution/LocalTools';
import { createLocalRuntimeTask, localWorkerEnvironment, probeLocalTool } from '../src/main/localExecution/workerClient';
import { workerDeferred, WORKER_LIMITS } from '../src/main/localExecution/workerProtocol';
import { LocalExecutionError } from '../src/main/localExecution/errors';
import { missingLocalToolFile } from '../src/main/localExecution/localToolsStorage';

const track = { id: 'abcdefghijk', title: 'Controlled worker fixture',
  url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: 0.12 };
const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const reason = (expected: string) => (error: unknown): boolean =>
  error instanceof LocalExecutionError && error.reason === expected;
const fixtureFfmpeg = process.env.MONKY_WORKER_TEST_FFMPEG;

async function until(predicate: () => boolean, timeout = 4000): Promise<void> {
  const deadline = performance.now() + timeout;
  while (!predicate() && performance.now() < deadline) await wait(5);
  assert.ok(predicate(), 'Expected worker lifecycle state did not arrive.');
}

function program(onStart: string, onControl = '', ready = true): string {
  return `
    const fs = require('node:fs');
    const path = require('node:path');
    const track = ${JSON.stringify(track)};
    let start;
    const send = message => new Promise((resolve,reject) =>
      process.send(message, error => error ? reject(error) : resolve()));
    const finish = async () => {
      await send({type:'closed',id:start.id});
      process.disconnect();
    };
    process.on('message', message => {
      const run = async () => {
        if (message.type === 'start') {
          start = message;
          ${ready ? "await send({type:'ready',id:start.id});" : ''}
          ${onStart}
        } else if (message.type === 'stop') {
          await finish();
        } else {
          ${onControl}
        }
      };
      run().catch(error => { process.stderr.write(error.message); process.exitCode=1; process.disconnect(); });
    });
  `;
}

function generatedSource(mode: 'complete' | 'recover' | 'blocked'): string {
  const sourceModule = require.resolve('@monky/bot-sdk/dist/localRuntime/source');
  const processModule = require.resolve('@monky/bot-sdk/dist/localRuntime/process');
  return `
    const assert=require('node:assert/strict');
    const fs=require('node:fs');
    const path=require('node:path');
    const {IncomingMessage}=require('node:http');
    const {Socket}=require('node:net');
    const {channel}=require('node:diagnostics_channel');
    const helpers=require(${JSON.stringify(processModule)});
    const sources=require(${JSON.stringify(sourceModule)});
    const Original=sources.YouTubeSource;
    const mode=${JSON.stringify(mode)};
    const track=${JSON.stringify(track)};
    const audioUrl='https://rr1.googlevideo.com/videoplayback';
    const nativeIds=[];
    let ffmpeg;
    channel('child_process').subscribe(message=>{
      message.process.once('spawn',()=>{
        if(message.process.spawnfile===ffmpeg) {
          nativeIds.push(message.process.pid);
          fs.writeFileSync('native-ids.json',JSON.stringify(nativeIds));
        }
      });
    });
    sources.YouTubeSource=class extends Original {
      constructor(paths) {
        ffmpeg=paths.ffmpeg;
        const filename=path.join(process.cwd(),'generated.ogg');
        let generating, interrupted=false;
        const requests=[];
        const generate=signal=>generating??=(async()=>{
          const data=await helpers.captureBytes(paths.ffmpeg,[
            '-nostdin','-hide_banner','-loglevel','error',
            '-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=0.12',
            '-ac','2','-ar','48000','-c:a','libopus','-b:a','96k','-frame_duration','20',
            '-f','ogg','-page_duration','20000','pipe:1',
          ],signal,15000,262144);
          signal.throwIfAborted();
          fs.writeFileSync(filename,data,{mode:0o600});
          return data;
        })();
        const capture=async(executable,args,signal,timeout,limit)=>{
          if(executable!==paths.ytDlp) return helpers.capture(executable,args,signal,timeout,limit);
          assert.ok(args.includes('--ignore-config') && args.includes('--no-remote-components'));
          if(args.includes('--version')) return '2026.08.19';
          await generate(signal);
          return JSON.stringify({...track,url:audioUrl,availability:'public',age_limit:0,live_status:'not_live'});
        };
        const captureBytes=async(executable,args,signal,...bounds)=>{
          assert.equal(executable,paths.ffmpeg);
          assert.equal(args[args.indexOf('-i')+1],audioUrl);
          const local=[...args];
          local[local.indexOf('-i')+1]=filename;
          local[local.indexOf('-protocol_whitelist')+1]='file';
          local.splice(local.indexOf('-rw_timeout'),2);
          return helpers.captureBytes(executable,local,signal,...bounds);
        };
        const request=async(url,headers,signal)=>{
          assert.equal(url.href,audioUrl);
          assert.equal(headers.Cookie,undefined);
          assert.equal(headers.Authorization,undefined);
          signal.throwIfAborted();
          if(mode==='blocked') {
            fs.writeFileSync('input-pending','1');
            return new Promise((_resolve,reject)=>{
              const abort=()=>{fs.writeFileSync('input-aborted','1');reject(signal.reason);};
              signal.addEventListener('abort',abort,{once:true});
              if(signal.aborted) abort();
            });
          }
          const data=await generate(signal);
          const range=/^bytes=(\\d+)-(\\d*)$/.exec(headers.Range);
          assert.ok(range);
          const from=Number(range[1]),end=range[2]?Math.min(Number(range[2]),data.length-1):data.length-1;
          const cut=mode==='recover' && !interrupted && from===0;
          if(cut) interrupted=true;
          const to=cut?Math.floor(data.length/2):end+1;
          requests.push({from,end,to});
          fs.writeFileSync('requests.json',JSON.stringify(requests));
          const response=new IncomingMessage(new Socket());
          response.statusCode=from>=data.length?416:206;
          response.headers=from>=data.length?{'content-range':'bytes */'+data.length}:{
            'content-range':'bytes '+from+'-'+end+'/'+data.length,
            'content-length':String(end-from+1),'content-type':'audio/ogg','etag':'"generated-v1"',
          };
          response.complete=!cut;
          const abort=()=>response.destroy();
          signal.addEventListener('abort',abort,{once:true});
          response.once('close',()=>signal.removeEventListener('abort',abort));
          if(from<data.length) response.push(data.subarray(from,to));
          response.push(null);
          if(signal.aborted) abort();
          return response;
        };
        super(paths,{capture,captureBytes,request});
        fs.writeFileSync('advanced','0');
      }
      async open(track,signal,options) {
        assert.deepEqual(options,{mode:'persistent',progress:'playback'});
        const stream=await super.open(track,signal,options);
        let advanced=0;
        return {
          ...stream,
          markFrameAdvanced:()=>{
            stream.markFrameAdvanced();
            fs.writeFileSync('advanced',String(++advanced));
          },
          setPaused:paused=>{
            stream.setPaused(paused);
            fs.writeFileSync('paused',String(paused));
          },
        };
      }
    };
  `;
}

async function fixture(t: TestContext, script?: string, preload?: string, realTools = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'monky-private-worker-'));
  const cache = path.join(root, 'cache');
  await fs.mkdir(cache);
  // Explicit test executable, never a production fallback to Electron/process.execPath.
  const paths: LocalToolPaths = {
    node: process.execPath, ytDlp: path.join(root, 'managed', 'yt-dlp.exe'), ffmpeg: path.join(root, 'managed', 'ffmpeg.exe'),
  };
  const rows: Array<{ child: ChildProcess; command: string; args: readonly string[]; options: SpawnOptions; closed: boolean }> = [];
  const live = new Set<string>();
  const owners = new Map<string, { close: () => Promise<void>; confirmed: boolean; confirmations: number }>();
  const allocated: string[] = [];
  const removed: string[] = [];
  const removalAttempts: string[] = [];
  const logs: Array<{ message: string; error: unknown }> = [];
  let onRemove: (directory: string) => Promise<void> = async () => undefined;
  let beforeCleanup: () => Promise<void> = async () => undefined;
  let releaseAllocation: Promise<void> | undefined;
  const manager = realTools ? new LocalTools({
    root, probe: async () => { throw new Error('This fixture must not install or download tools.'); },
  }) : undefined;
  if (manager) await manager.initialize();
  const tools = {
    allocateTaskCache: async (): Promise<string> => {
      const directory = manager ? await manager.allocateTaskCache() : path.join(cache, `task-${randomUUID()}`);
      if (!manager) await fs.mkdir(directory, { mode: 0o700 });
      live.add(directory);
      allocated.push(directory);
      if (releaseAllocation) await releaseAllocation;
      return directory;
    },
    registerTaskCacheOwner: (directory: string, close: () => Promise<void>) => {
      assert.ok(live.has(directory), 'Only an allocated cache can acquire a native owner.');
      assert.equal(owners.has(directory), false, 'A cache cannot acquire a second owner.');
      const native = manager?.registerTaskCacheOwner(directory, close);
      const owner = { close, confirmed: false, confirmations: 0 };
      owners.set(directory, owner);
      return {
        confirmNativeClosed: (): void => {
          assert.equal(owners.get(directory), owner);
          native?.confirmNativeClosed();
          owner.confirmed = true;
          owner.confirmations++;
        },
      };
    },
    removeTaskCache: async (directory: string): Promise<void> => {
      assert.ok(live.has(directory), 'Only a specifically allocated directory may be deleted.');
      const registered = owners.get(directory);
      if (registered && !registered.confirmed) throw new LocalExecutionError('worker_failed');
      removalAttempts.push(directory);
      const owner = rows.find(row => row.options.cwd === directory);
      if (owner) assert.equal(owner.closed, true, 'Native worker close must precede cache removal.');
      await onRemove(directory);
      if (manager) await manager.removeTaskCache(directory);
      else await fs.rm(directory, { recursive: true, force: true });
      live.delete(directory);
      owners.delete(directory);
      removed.push(directory);
    },
  };
  const nativeSpawn = childProcess.spawn;
  const scriptPath = path.join(root, 'controlled-worker.cjs');
  const preloadPath = path.join(root, 'controlled-preload.cjs');
  if (script !== undefined) await fs.writeFile(scriptPath, script, { mode: 0o600 });
  if (preload !== undefined) await fs.writeFile(preloadPath, preload, { mode: 0o600 });
  t.mock.method(childProcess, 'spawn', (command: string, args: readonly string[], options: SpawnOptions) => {
    if (command !== paths.node) return nativeSpawn(command, args, options);
    assert.deepEqual(args, [path.resolve(__dirname, '..', 'src', 'main', 'localExecution', 'worker.js')]);
    assert.ok(typeof options.cwd === 'string');
    assert.equal(owners.get(options.cwd)?.confirmed, false, 'A guarded cache owner must exist before native startup.');
    const controlledArgs = script === undefined ? args : [scriptPath];
    const child = nativeSpawn(command, preload === undefined ? controlledArgs : ['--require', preloadPath, ...controlledArgs], options);
    const row = { child, command, args, options, closed: false };
    child.once('close', () => { row.closed = true; });
    rows.push(row);
    return child;
  });
  t.after(async () => {
    try { await beforeCleanup(); }
    finally {
      for (const row of rows) {
        row.child.stdout?.destroy();
        await terminate(row.child);
      }
      await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  const logError = (message: string, error: unknown): void => { logs.push({ message, error }); };
  const start = (signal = new AbortController().signal) => createLocalRuntimeTask({
    id: randomUUID(), paths, spec: { operation: 'youtube.stream', url: track.url }, signal,
  }, tools, logError);
  return {
    root, cache, paths, rows, allocated, removed, removalAttempts, owners, manager, logs, tools, logError, start,
    setOnRemove: (callback: typeof onRemove) => { onRemove = callback; },
    setBeforeCleanup: (callback: typeof beforeCleanup) => { beforeCleanup = callback; },
    holdAllocation: (promise: Promise<void>) => { releaseAllocation = promise; },
  };
}

test('child environment replaces profiles and PATH, drops interpreter injection, and retains secure TLS/proxy policy', () => {
  const directory = path.resolve('cache', 'task-00000000-0000-0000-0000-000000000000');
  const paths = { node: process.execPath, ytDlp: path.resolve('managed', 'yt-dlp'), ffmpeg: path.resolve('managed', 'ffmpeg') };
  const inherited = {
    PATH: path.resolve('untrusted'), HOME: path.resolve('normal-profile'), USERPROFILE: path.resolve('normal-profile'),
    NODE_OPTIONS: '--require injected.js', NODE_PATH: path.resolve('injected'),
    NODE_COMPILE_CACHE: path.resolve('outside-cache'), PYTHONPATH: path.resolve('injected-python'),
    PYTHONHOME: path.resolve('ambient-python'), PYTHONSTARTUP: 'injected.py',
    LD_PRELOAD: 'injected.so', LD_LIBRARY_PATH: path.resolve('injected'), DYLD_INSERT_LIBRARIES: 'injected.dylib',
    ELECTRON_RUN_AS_NODE: '1', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    HTTPS_PROXY: 'https://proxy.example.test:8443', NO_PROXY: 'localhost,127.0.0.1',
    NODE_EXTRA_CA_CERTS: path.resolve('policy-ca.pem'), SSL_CERT_FILE: path.resolve('policy-ca.pem'),
    MONKY_MUSIC_NODE: 'ambient-node', NETRC: path.resolve('private-netrc'),
  };
  const original = { ...inherited };
  const environment = localWorkerEnvironment(paths, directory, 'task-fixture', inherited);
  assert.deepEqual(inherited, original);
  for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'NODE_COMPILE_CACHE', 'PYTHONPATH', 'PYTHONHOME',
    'PYTHONSTARTUP', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'ELECTRON_RUN_AS_NODE', 'MONKY_MUSIC_NODE', 'NETRC']) {
    assert.equal(environment[name], undefined, name);
  }
  for (const name of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', 'APPDATA', 'LOCALAPPDATA',
    'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR']) {
    assert.ok(environment[name]?.startsWith(directory + path.sep), name);
  }
  assert.equal(environment.NODE_TLS_REJECT_UNAUTHORIZED, '1');
  assert.equal(environment.NODE_EXTRA_CA_CERTS, inherited.NODE_EXTRA_CA_CERTS);
  assert.equal(environment.SSL_CERT_FILE, inherited.SSL_CERT_FILE);
  assert.equal(environment.HTTPS_PROXY, inherited.HTTPS_PROXY);
  assert.equal(environment.NO_PROXY, inherited.NO_PROXY);
  assert.equal(environment.PATH?.includes(inherited.PATH), false);
  assert.equal(environment.PATH?.split(path.delimiter)[0], path.dirname(paths.node));
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const windows = localWorkerEnvironment(paths, directory, 'task-fixture', { SystemRoot: systemRoot, SYSTEMROOT: 'untrusted' });
    assert.equal(windows.SYSTEMROOT, systemRoot);
    assert.equal(Object.keys(windows).filter(key => key.toUpperCase() === 'SYSTEMROOT').length, 1);
  }
});

test('real explicit Node probe runs the compiled worker in a private profile and settles after cleanup', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  assert.equal(await fs.realpath(require.resolve('@monky/bot-sdk/dist/localRuntime')),
    await fs.realpath(path.resolve(__dirname, '..', '..', '..', '..', 'packages', 'bot-sdk', 'dist', 'localRuntime', 'index.js')));
  const signal = new AbortController().signal;
  f.setOnRemove(async directory => {
    for (const name of ['temp', 'home', 'config', 'cache', 'data', 'state', 'runtime']) {
      assert.ok((await fs.stat(path.join(directory, name))).isDirectory());
    }
  });
  const version = await probeLocalTool('node', f.paths, signal, f.tools, f.logError);
  assert.equal(version, process.version);
  assert.equal(f.rows.length, 1, 'The probe itself must not spawn --version from Main.');
  const row = f.rows[0];
  assert.equal(row.command, f.paths.node);
  assert.equal(row.options.shell, false);
  assert.equal(row.options.windowsHide, true);
  assert.equal(row.options.detached, process.platform !== 'win32');
  assert.equal(row.options.serialization, 'json');
  assert.deepEqual(row.options.stdio, ['ignore', 'pipe', 'pipe', 'ipc']);
  assert.equal(row.options.cwd, f.allocated[0]);
  assert.equal(row.options.env?.HOME, path.join(f.allocated[0], 'home'));
  assert.equal(row.options.env?.TMPDIR, path.join(f.allocated[0], 'temp'));
  assert.equal(row.closed, true);
  assert.deepEqual(f.removed, f.allocated);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
  assert.deepEqual(f.logs, []);
});

test('real worker abort tears down a controlled SDK capture and its descendant before deleting private files', { timeout: 15000 }, async t => {
  const checks = require.resolve('@monky/bot-sdk/dist/localRuntime/toolChecks');
  const helpers = require.resolve('@monky/bot-sdk/dist/localRuntime/process');
  const nativeCode = `
    const fs = require('node:fs');
    const path = require('node:path');
    const child = require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const target=path.join(process.cwd(),'controlled-native.json');
    fs.writeFileSync(target+'.tmp',JSON.stringify({parent:process.pid,descendant:child.pid}));
    fs.renameSync(target+'.tmp',target);
    setInterval(()=>{},1000);
  `;
  const f = await fixture(t, undefined, `
    const {capture}=require(${JSON.stringify(helpers)});
    require(${JSON.stringify(checks)}).checkMediaTool=(_tool,paths,signal)=>
      capture(paths.node,['-e',${JSON.stringify(nativeCode)}],signal,10000,65536);
  `);
  const controller = new AbortController();
  const probing = probeLocalTool('node', f.paths, controller.signal, f.tools, f.logError);
  const rejected = assert.rejects(probing, reason('cancelled'));
  f.setBeforeCleanup(async () => { controller.abort(); await rejected; });
  await until(() => f.allocated.length === 1);
  const filename = path.join(f.allocated[0], 'controlled-native.json');
  let data: unknown;
  const deadline = performance.now() + 5000;
  while (data === undefined && performance.now() < deadline) {
    try { data = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) {
      if (!missingLocalToolFile(error)) throw error;
      await wait(5);
    }
  }
  assert.ok(typeof data === 'object' && data !== null && 'parent' in data && 'descendant' in data);
  assert.equal(typeof data.parent, 'number');
  assert.equal(typeof data.descendant, 'number');
  if (typeof data.parent !== 'number' || typeof data.descendant !== 'number') throw new Error('Invalid controlled native IDs.');
  const pids = [data.parent, data.descendant];
  for (const pid of pids) assert.ok(Number.isSafeInteger(pid) && pid > 0);
  f.setOnRemove(async () => {
    for (const pid of pids) assert.throws(() => process.kill(pid, 0),
      error => error instanceof Error && 'code' in error && error.code === 'ESRCH');
  });
  controller.abort();
  await rejected;
  assert.equal(f.rows[0].child.exitCode, 0);
  assert.deepEqual(f.removed, f.allocated);
  assert.deepEqual(f.logs, []);
});

test('explicit FFmpeg probe returns its actual version after private-worker encoder validation',
  { skip: !fixtureFfmpeg, timeout: 30000 }, async t => {
    assert.ok(fixtureFfmpeg && path.isAbsolute(fixtureFfmpeg), 'An explicit test FFmpeg path is required.');
    const f = await fixture(t);
    f.paths.ffmpeg = fixtureFfmpeg;
    const version = await probeLocalTool('ffmpeg', f.paths, new AbortController().signal, f.tools, f.logError);
    assert.match(version, /^[0-9A-Za-z][0-9A-Za-z._+-]*$/);
    assert.ok(version.length <= 128);
    assert.notEqual(version, 'libopus');
    assert.deepEqual(f.removed, f.allocated);
    assert.equal(f.rows[0].child.exitCode, 0);
  });

test('generated FFmpeg preview crosses the real private worker as bounded stereo Opus Ogg',
  { skip: !fixtureFfmpeg, timeout: 30000 }, async t => {
    assert.ok(fixtureFfmpeg && path.isAbsolute(fixtureFfmpeg), 'An explicit test FFmpeg path is required.');
    const f = await fixture(t, undefined, generatedSource('complete'));
    f.paths.ffmpeg = fixtureFfmpeg;
    const task = await createLocalRuntimeTask({
      id: randomUUID(), paths: f.paths, spec: { operation: 'youtube.preview', url: track.url },
      signal: new AbortController().signal,
    }, f.tools, f.logError);
    f.setBeforeCleanup(() => task.close());
    const result = await task.result;
    assert.ok(result.operation === 'youtube.preview');
    const bytes = Buffer.from(result.audioBase64, 'base64');
    assert.ok(bytes.length > 0 && bytes.length <= 262144);
    const parser = new OggOpusParser();
    const packets = parser.push(bytes);
    parser.finish();
    assert.ok(packets.length >= 6);
    assert.ok(packets.every(packet => packet.length > 0 && packet.length <= 1275));
    assert.deepEqual(f.removed, f.allocated);
    await task.closed;
    await task.close();
  });

test('generated FFmpeg stream resumes private input and retains its EOF tail without counting prefetched frames',
  { skip: !fixtureFfmpeg, timeout: 30000 }, async t => {
    assert.ok(fixtureFfmpeg && path.isAbsolute(fixtureFfmpeg), 'An explicit test FFmpeg path is required.');
    const f = await fixture(t, undefined, generatedSource('recover'));
    f.paths.ffmpeg = fixtureFfmpeg;
    let applied = -1, requests: unknown;
    f.setOnRemove(async directory => {
      applied = Number(await fs.readFile(path.join(directory, 'advanced'), 'utf8'));
      requests = JSON.parse(await fs.readFile(path.join(directory, 'requests.json'), 'utf8'));
      const pids: unknown = JSON.parse(await fs.readFile(path.join(directory, 'native-ids.json'), 'utf8'));
      assert.ok(Array.isArray(pids) && pids.length >= 2);
      for (const pid of pids) {
        assert.ok(typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0);
        assert.throws(() => process.kill(pid, 0),
          error => error instanceof Error && 'code' in error && error.code === 'ESRCH');
      }
    });
    const task = await f.start();
    f.setBeforeCleanup(() => task.close());
    const result = await task.result;
    assert.ok(result.operation === 'youtube.stream');
    assert.deepEqual(result.track, track);
    const first = await task.readFrames(2);
    assert.equal(first.frames.length, 2);
    assert.equal(first.done, false);
    assert.equal(await fs.readFile(path.join(f.allocated[0], 'advanced'), 'utf8'), '0');
    await task.acknowledgeFrames(2);
    await task.acknowledgeFrames(2);
    await task.setPaused(true);
    assert.equal(await fs.readFile(path.join(f.allocated[0], 'paused'), 'utf8'), 'true');
    await task.setPaused(false);
    const tail = await task.readFrames(8);
    assert.equal(tail.done, true);
    assert.ok(tail.frames.length >= 4 && tail.frames.length <= 8);
    assert.ok([...first.frames, ...tail.frames].every(frame => frame.byteLength > 0 && frame.byteLength <= 1275));
    await task.acknowledgeFrames(first.frames.length + tail.frames.length);
    assert.equal(applied, 2);
    assert.ok(Array.isArray(requests) && requests.length >= 2);
    assert.ok(requests.some(request => typeof request === 'object' && request !== null &&
      'from' in request && typeof request.from === 'number' && request.from > 0));
    assert.deepEqual(f.removed, f.allocated);
    assert.equal(f.rows[0].child.exitCode, 0);
    await task.closed;
  });

test('generated FFmpeg blocked input remains pausable and cancellation joins native teardown before cache release',
  { skip: !fixtureFfmpeg, timeout: 30000 }, async t => {
    assert.ok(fixtureFfmpeg && path.isAbsolute(fixtureFfmpeg), 'An explicit test FFmpeg path is required.');
    const f = await fixture(t, undefined, generatedSource('blocked'));
    f.paths.ffmpeg = fixtureFfmpeg;
    const controller = new AbortController();
    const task = await f.start(controller.signal);
    f.setBeforeCleanup(() => task.close());
    await task.result;
    const reading = task.readFrames(8);
    const cancelled = assert.rejects(reading, reason('cancelled'));
    const pendingFile = path.join(f.allocated[0], 'input-pending');
    const deadline = performance.now() + 5000;
    let pending = false;
    while (!pending && performance.now() < deadline) {
      try { await fs.access(pendingFile); pending = true; }
      catch (error) {
        if (!missingLocalToolFile(error)) throw error;
        await wait(5);
      }
    }
    assert.equal(pending, true);
    await task.setPaused(true);
    assert.equal(await fs.readFile(path.join(f.allocated[0], 'paused'), 'utf8'), 'true');
    f.setOnRemove(async directory => {
      assert.equal(await fs.readFile(path.join(directory, 'input-aborted'), 'utf8'), '1');
    });
    controller.abort();
    await task.close();
    await cancelled;
    await task.closed;
    assert.deepEqual(f.removed, f.allocated);
    assert.equal(f.rows[0].child.exitCode, 0);
  });

test('already aborted and allocation-time cancellation start no native worker', async t => {
  const f = await fixture(t);
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(f.start(cancelled.signal));
  assert.equal(f.allocated.length, 0);
  const gate = workerDeferred<void>();
  f.holdAllocation(gate.promise);
  const controller = new AbortController();
  const creating = f.start(controller.signal);
  const rejected = assert.rejects(creating, reason('cancelled'));
  await until(() => f.allocated.length === 1);
  controller.abort();
  assert.equal(f.rows.length, 0);
  gate.resolve(undefined);
  await rejected;
  assert.deepEqual(f.removed, f.allocated);
});

test('private profile creation failure is a storage error and releases the allocation without spawning', async t => {
  const f = await fixture(t);
  const original = fs.mkdir;
  t.mock.method(fs, 'mkdir', (directory: string, options?: Parameters<typeof fs.mkdir>[1]) => {
    if (path.basename(directory) === 'temp') {
      throw Object.assign(new Error('Controlled private storage failure'), { code: 'ENOSPC' });
    }
    return original(directory, options);
  });
  await assert.rejects(f.start(), reason('storage_failed'));
  assert.equal(f.rows.length, 0);
  assert.deepEqual(f.removed, f.allocated);
});

test('cancelling real worker startup waits for native close and private cache removal', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const probing = probeLocalTool('node', f.paths, controller.signal, f.tools, f.logError);
  const rejected = assert.rejects(probing, reason('cancelled'));
  await until(() => f.rows.length === 1);
  controller.abort();
  await rejected;
  assert.ok(f.rows.every(row => row.closed));
  assert.equal(f.rows[0].child.exitCode, 0);
  assert.equal(f.rows[0].child.signalCode, null);
  assert.deepEqual(f.removed, f.allocated);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.deepEqual(f.logs, []);
});

test('a pending pull does not block pause, ACK, or graceful close', { timeout: 10000 }, async t => {
  const f = await fixture(t, program(
    `globalThis.reads=0; await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`,
    `if(message.type==='read' && globalThis.reads++ === 0)
       await send({type:'frames',id:start.id,requestId:message.requestId,frames:['+P/+','+P/+'],done:false});
     else if(message.type === 'ack' || message.type === 'pause')
       await send({type:'accepted',id:start.id,requestId:message.requestId,operation:message.type});`,
  ));
  const task = await f.start();
  await task.result;
  assert.equal((await task.readFrames(2)).frames.length, 2);
  const read = task.readFrames(8);
  const rejected = assert.rejects(read, reason('cancelled'));
  await task.setPaused(true);
  await task.acknowledgeFrames(2);
  await task.setPaused(false);
  await task.close();
  await rejected;
  await task.closed;
  assert.deepEqual(f.removed, f.allocated);
  assert.ok(f.rows.every(row => row.closed));
});

test('a full control window does not consume an ACK that must be retried', async t => {
  const f = await fixture(t, program(
    `globalThis.controls=[]; await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`,
    `if(message.type==='read')
       await send({type:'frames',id:start.id,requestId:message.requestId,frames:['+P/+'],done:false});
     else if(message.type==='pause') {
       globalThis.controls.push(message);
       if(globalThis.controls.length===${WORKER_LIMITS.pendingCommands}) for(const control of globalThis.controls)
         await send({type:'accepted',id:start.id,requestId:control.requestId,operation:'pause'});
     } else if(message.type==='ack') {
       fs.writeFileSync(path.join(process.cwd(),'acknowledged'),String(message.playedFrames));
       await send({type:'accepted',id:start.id,requestId:message.requestId,operation:'ack'});
     }`,
  ));
  const task = await f.start();
  await task.result;
  await task.readFrames(1);
  const controls = Array.from({ length: WORKER_LIMITS.pendingCommands }, () => task.setPaused(true));
  await assert.rejects(task.acknowledgeFrames(1), reason('busy'));
  await Promise.all(controls);
  await task.acknowledgeFrames(1);
  assert.equal(await fs.readFile(path.join(f.allocated[0], 'acknowledged'), 'utf8'), '1');
  await task.close();
});

test('host returns final buffered frames with done after the worker exits and removes its cache', async t => {
  const f = await fixture(t, program(
    `await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`,
    `if(message.type === 'read') {
       await send({type:'frames',id:start.id,requestId:message.requestId,frames:['+P/+','+P/+'],done:true});
       await finish();
     }`,
  ));
  const task = await f.start();
  await task.result;
  const result = await task.readFrames(8);
  assert.deepEqual(result, { frames: [Buffer.from([0xf8, 0xff, 0xfe]), Buffer.from([0xf8, 0xff, 0xfe])], done: true });
  assert.equal(f.rows[0].closed, true);
  assert.deepEqual(f.removed, f.allocated);
  await task.acknowledgeFrames(2);
  await task.acknowledgeFrames(2);
  await assert.rejects(task.acknowledgeFrames(1), reason('invalid_request'));
  await assert.rejects(task.acknowledgeFrames(3), reason('invalid_request'));
  assert.deepEqual(await task.readFrames(1), { frames: [], done: true });
  await task.close();
});

test('host retains the 25-frame playback checkpoint after EOF, physical close and cache removal', async t => {
  const f = await fixture(t, program(
    `globalThis.remaining=25;
     await send({type:'result',id:start.id,result:{operation:'youtube.stream',track:{...track,duration:0.5}}});`,
    `if(message.type==='read') {
       const count=Math.min(message.count,globalThis.remaining);
       globalThis.remaining-=count;
       await send({type:'frames',id:start.id,requestId:message.requestId,
         frames:Array.from({length:count},()=>'+P/+'),done:globalThis.remaining===0});
       if(globalThis.remaining===0) await finish();
     }`,
  ));
  const controller = new AbortController();
  const task = await f.start(controller.signal);
  await task.result;
  let delivered = 0, done = false;
  while (!done) {
    const batch = await task.readFrames(8);
    delivered += batch.frames.length;
    done = batch.done;
  }
  assert.equal(delivered, 25);
  await task.closed;
  await task.close();
  assert.equal(controller.signal.aborted, false, 'Producer EOF must not cancel the playback checkpoint.');
  assert.deepEqual(f.removed, f.allocated);
  assert.equal(f.rows[0].closed, true);
  await task.setPaused(true);
  await task.setPaused(false);
  for (let played = 1; played <= delivered; played++) {
    await wait(20);
    await task.acknowledgeFrames(played);
  }
  await task.acknowledgeFrames(delivered);
  await assert.rejects(task.acknowledgeFrames(delivered - 1), reason('invalid_request'));
  await assert.rejects(task.acknowledgeFrames(delivered + 1), reason('invalid_request'));
  controller.abort();
  await assert.rejects(task.acknowledgeFrames(delivered), reason('cancelled'));
});

test('one-shot result does not resolve before cache cleanup', async t => {
  const f = await fixture(t, program(`
    await send({type:'result',id:start.id,result:{operation:'youtube.resolve',track}});
    await finish();
  `));
  const gate = workerDeferred<void>();
  let removing = false, settled = false;
  f.setOnRemove(async () => { removing = true; await gate.promise; });
  const task = await createLocalRuntimeTask({
    id: randomUUID(), paths: f.paths, spec: { operation: 'youtube.resolve', url: track.url },
    signal: new AbortController().signal,
  }, f.tools, f.logError);
  void task.result.then(() => { settled = true; });
  await until(() => removing);
  assert.equal(settled, false);
  gate.resolve(undefined);
  assert.deepEqual(await task.result, { operation: 'youtube.resolve', track });
  await task.closed;
  assert.equal(settled, true);
});

test('typed source failures received before ready survive factory rejection and cleanup', async t => {
  const f = await fixture(t, program(`
    await send({type:'failure',id:start.id,reason:'tools_missing',detail:'Controlled startup failure',
      sourceFailure:{code:'runtime'}});
  `, '', false));
  await assert.rejects(f.start(), { reason: 'tools_missing', sourceFailure: { code: 'runtime' } });
  assert.deepEqual(f.removed, f.allocated);
  assert.equal(f.rows[0].child.exitCode, 0);
});

for (const operation of ['youtube.search', 'youtube.resolve', 'youtube.preview'] as const) {
  test(`${operation} source failure survives private result rejection without diagnostic payload fields`, async t => {
    const sources = require.resolve('@monky/bot-sdk/dist/localRuntime/source');
    const errors = require.resolve('@monky/bot-sdk/dist/localRuntime/errors');
    const f = await fixture(t, undefined, `
      const sources=require(${JSON.stringify(sources)});
      const {MediaError}=require(${JSON.stringify(errors)});
      const Original=sources.YouTubeSource;
      const fail=async()=>{throw new MediaError('unavailable','https://rr1.googlevideo.com/videoplayback?signature=private');};
      sources.YouTubeSource=class extends Original { search=fail; resolve=fail; preview=fail; };
    `);
    await assert.rejects(async () => {
      const task = await createLocalRuntimeTask({
        id: randomUUID(), paths: f.paths, signal: new AbortController().signal,
        spec: operation === 'youtube.search' ? { operation, query: 'controlled fixture' } : { operation, url: track.url },
      }, f.tools, f.logError);
      await task.result;
    }, { reason: 'provider_unavailable', sourceFailure: { code: 'unavailable' } });
    await until(() => f.removed.length === 1);
    assert.doesNotMatch(f.logs.map(log => String(log.error)).join('\n'), /googlevideo|signature|private/);
  });
}

test('private probe rejection preserves the SDK tool code and completes owned-cache release', async t => {
  const checks = require.resolve('@monky/bot-sdk/dist/localRuntime/toolChecks');
  const errors = require.resolve('@monky/bot-sdk/dist/localRuntime/errors');
  const f = await fixture(t, undefined, `
    const {MediaError}=require(${JSON.stringify(errors)});
    require(${JSON.stringify(checks)}).checkMediaTool=async()=>{throw new MediaError('tools','Controlled encoder failure');};
  `);
  await assert.rejects(probeLocalTool('ffmpeg', f.paths, new AbortController().signal, f.tools, f.logError),
    { reason: 'tools_missing', sourceFailure: { code: 'tools' } });
  assert.deepEqual(f.removed, f.allocated);
  assert.equal(f.rows[0].child.exitCode, 1);
});

for (const bad of [
  `await send({type:'result',id:start.id,result:{operation:'youtube.stream',track:{...track,audioUrl:'https://rr1.googlevideo.com/videoplayback'}}});`,
  `await send({type:'ready',id:start.id});`,
  `await send({type:'result',id:'another-worker',result:{operation:'youtube.stream',track}});`,
]) {
  test('malformed, duplicate or foreign startup replies fail closed without exposing metadata', async t => {
    const f = await fixture(t, program(bad));
    await assert.rejects(async () => {
      const task = await f.start();
      await task.result;
    }, reason('worker_failed'));
    await until(() => f.removed.length === 1);
    assert.ok(f.rows.every(row => row.closed));
    assert.doesNotMatch(f.logs.map(entry => String(entry.error)).join('\n'), /googlevideo/);
  });
}

for (const fields of [
  `frames:['${'A'.repeat(1704)}'],done:false`,
  `frames:[],done:false`,
  `frames:['+P/+','+P/+'],done:false`,
]) {
  test('malformed or over-request frame batches stop the owned worker', async t => {
    const f = await fixture(t, program(
      `await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`,
      `if(message.type==='read') await send({type:'frames',id:start.id,requestId:message.requestId,${fields}});`,
    ));
    const task = await f.start();
    await task.result;
    await assert.rejects(task.readFrames(1), reason('worker_failed'));
    await assert.rejects(task.closed, reason('worker_failed'));
    await task.close();
    assert.deepEqual(f.removed, f.allocated);
  });
}

test('cache overrun while running stops playback and surfaces storage failure', { timeout: 10000 }, async t => {
  const f = await fixture(t, program(`await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`));
  const task = await f.start();
  await task.result;
  const file = await fs.open(path.join(f.allocated[0], 'oversized-output'), 'w');
  try { await file.truncate(LOCAL_TASK_CACHE_MAX_BYTES + 1); }
  finally { await file.close(); }
  await assert.rejects(task.closed, reason('storage_failed'));
  await task.close();
  assert.deepEqual(f.removed, f.allocated);
});

test('streaming beyond 64 MiB releases each handed-off batch instead of retaining a lifetime cache charge',
  { timeout: 60000 }, async t => {
    const packetBytes = LOCAL_EXECUTION_RUNTIME_LIMITS.frameBytes;
    const frameCount = Math.ceil(LOCAL_TASK_CACHE_MAX_BYTES / packetBytes) + 8;
    const f = await fixture(t, program(`
      const file=fs.openSync(path.join(process.cwd(),'retained-cache'),'w');
      fs.ftruncateSync(file,${LOCAL_TASK_CACHE_MAX_BYTES - 1024 * 1024}); fs.closeSync(file);
      const packet=Buffer.alloc(${packetBytes}); packet[0]=0xf8;
      globalThis.packet=packet.toString('base64');
      globalThis.remaining=${frameCount};
      await send({type:'result',id:start.id,result:{operation:'youtube.stream',track:{...track,duration:${frameCount * 0.02}}}});
    `, `
      if(message.type==='read') {
        const count=Math.min(message.count,globalThis.remaining);
        globalThis.remaining-=count;
        await send({type:'frames',id:start.id,requestId:message.requestId,
          frames:Array.from({length:count},()=>globalThis.packet),done:globalThis.remaining===0});
        if(globalThis.remaining===0) await finish();
      } else if(message.type==='ack') {
        await send({type:'accepted',id:start.id,requestId:message.requestId,operation:'ack'});
      }
    `));
    const task = await f.start();
    f.setBeforeCleanup(() => task.close());
    await task.result;
    let bytes = 0, delivered = 0, done = false;
    while (!done) {
      const batch = await task.readFrames(LOCAL_EXECUTION_RUNTIME_LIMITS.frameBatch);
      assert.ok(batch.frames.length <= LOCAL_EXECUTION_RUNTIME_LIMITS.frameBatch);
      bytes += batch.frames.reduce((total, frame) => total + frame.byteLength, 0);
      delivered += batch.frames.length;
      done = batch.done;
      await task.acknowledgeFrames(delivered);
    }
    await task.closed;
    assert.equal(delivered, frameCount);
    assert.ok(bytes > LOCAL_TASK_CACHE_MAX_BYTES);
    assert.deepEqual(f.removed, f.allocated);
    assert.deepEqual(f.logs, []);
  });

test('live retained frame payload and disk usage still share the task cache budget', async t => {
  const f = await fixture(t, program(`
    const file=fs.openSync(path.join(process.cwd(),'retained-cache'),'w');
    fs.ftruncateSync(file,${LOCAL_TASK_CACHE_MAX_BYTES - 5120}); fs.closeSync(file);
    await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});
  `, `
    if(message.type==='read') {
      const packet=Buffer.alloc(${LOCAL_EXECUTION_RUNTIME_LIMITS.frameBytes}); packet[0]=0xf8;
      await send({type:'frames',id:start.id,requestId:message.requestId,
        frames:Array.from({length:8},()=>packet.toString('base64')),done:true});
      await finish();
    }
  `));
  const task = await f.start();
  await task.result;
  await assert.rejects(task.readFrames(8), reason('storage_failed'));
  await assert.rejects(task.closed, reason('storage_failed'));
  await task.close();
  assert.deepEqual(f.removed, f.allocated);
});

test('final cache scan rejects a short-lived oversized probe before returning success', async t => {
  const f = await fixture(t, program(`
    const file = fs.openSync(path.join(process.cwd(),'oversized-output'),'w');
    fs.ftruncateSync(file,${LOCAL_TASK_CACHE_MAX_BYTES + 1}); fs.closeSync(file);
    await send({type:'version',id:start.id,version:'v24.20.0'}); await finish();
  `));
  await assert.rejects(probeLocalTool('node', f.paths, new AbortController().signal, f.tools, f.logError), reason('storage_failed'));
  assert.deepEqual(f.removed, f.allocated);
});

test('global cache overrun is detected without deleting data outside the allocated task directory', { timeout: 10000 }, async t => {
  const f = await fixture(t, program(`await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`));
  const task = await f.start();
  await task.result;
  const filename = path.join(f.cache, 'controlled-global-overflow');
  const file = await fs.open(filename, 'w');
  try { await file.truncate(LOCAL_TOOLS_CACHE_MAX_BYTES + 1); }
  finally { await file.close(); }
  await assert.rejects(task.closed, reason('storage_failed'));
  await task.close();
  assert.ok((await fs.stat(filename)).size > LOCAL_TOOLS_CACHE_MAX_BYTES);
  assert.deepEqual(f.removed, f.allocated);
});

test('cache scans reject links without following or deleting their targets', { timeout: 10000 }, async t => {
  const f = await fixture(t, program(`await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`));
  const target = path.join(f.root, 'controlled-outside-target');
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, 'sentinel'), 'unchanged');
  const task = await f.start();
  await task.result;
  await fs.symlink(target, path.join(f.allocated[0], 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(task.closed, reason('storage_failed'));
  await task.close();
  assert.equal(await fs.readFile(path.join(target, 'sentinel'), 'utf8'), 'unchanged');
  assert.deepEqual(f.removed, f.allocated);
});

test('an allocated task path cannot turn into a regular file and still satisfy the cache scan', { timeout: 10000 }, async t => {
  const f = await fixture(t, program(`await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`));
  const file = path.join(f.root, 'controlled-file');
  await fs.writeFile(file, 'data');
  const stat = await fs.stat(file);
  const task = await f.start();
  await task.result;
  const original = fs.lstat;
  t.mock.method(fs, 'lstat', (filename: string) =>
    filename === f.allocated[0] ? Promise.resolve(stat) : original(filename));
  await assert.rejects(task.closed, reason('storage_failed'));
  await task.close();
  assert.deepEqual(f.removed, f.allocated);
});

for (const operation of ['lstat', 'opendir'] as const) {
  test(`extractor descendants disappearing during ${operation} are not mistaken for a lost cache lease`, async t => {
    const f = await fixture(t, program(`await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`));
    const task = await f.start();
    await task.result;
    const unpacked = path.join(f.allocated[0], 'temp', '_MEI-controlled');
    const file = path.join(unpacked, 'python-fixture.bin');
    await fs.mkdir(unpacked);
    await fs.writeFile(file, 'controlled extractor data');
    let disappeared = false;
    if (operation === 'lstat') {
      const original = fs.lstat;
      t.mock.method(fs, 'lstat', async (filename: string) => {
        if (filename === file && !disappeared) { await fs.rm(file); disappeared = true; }
        return original(filename);
      });
    } else {
      const original = fs.opendir;
      t.mock.method(fs, 'opendir', async (filename: string) => {
        if (filename === unpacked && !disappeared) {
          await fs.rm(unpacked, { recursive: true });
          disappeared = true;
        }
        return original(filename);
      });
    }
    await until(() => disappeared);
    await task.close();
    await task.closed;
    assert.deepEqual(f.removed, f.allocated);
    assert.deepEqual(f.logs, []);
  });
}

for (const code of ['EACCES', 'EIO']) {
  test(`a real ${code} failure within an extractor directory is not swallowed as cleanup`, async t => {
    const f = await fixture(t, program(`await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`));
    const task = await f.start();
    await task.result;
    const unpacked = path.join(f.allocated[0], 'temp', '_MEI-controlled');
    const file = path.join(unpacked, 'python-fixture.bin');
    await fs.mkdir(unpacked);
    await fs.writeFile(file, 'controlled extractor data');
    const original = fs.lstat;
    t.mock.method(fs, 'lstat', (filename: string) => {
      if (filename === file) throw Object.assign(new Error('Controlled filesystem failure'), { code });
      return original(filename);
    });
    await assert.rejects(task.closed, reason('storage_failed'));
    await task.close();
    assert.deepEqual(f.removed, f.allocated);
  });
}

test('a lease root disappearing during descendant cleanup fails the same scan', async t => {
  const f = await fixture(t, program(`await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`));
  const task = await f.start();
  await task.result;
  const file = path.join(f.allocated[0], 'temp', 'disappearing-child');
  await fs.writeFile(file, 'controlled extractor data');
  const originalStat = fs.lstat;
  const originalOpen = fs.opendir;
  let lost = false, scans = 0, lossDetectedInScan = 0;
  t.mock.method(fs, 'opendir', (filename: string) => {
    if (filename === f.cache) scans++;
    return originalOpen(filename);
  });
  t.mock.method(fs, 'lstat', (filename: string) => {
    if (filename === file) {
      lost = true;
      throw Object.assign(new Error('Controlled vanished child'), { code: 'ENOENT' });
    }
    if (filename === f.allocated[0] && lost) {
      lossDetectedInScan ||= scans;
      throw Object.assign(new Error('Controlled lost lease root'), { code: 'ENOENT' });
    }
    return originalStat(filename);
  });
  await assert.rejects(task.closed, reason('storage_failed'));
  await task.close();
  assert.equal(lossDetectedInScan, 1);
  assert.deepEqual(f.removed, f.allocated);
});

test('bounded scans do not overlap and cache removal joins an in-flight scan', { timeout: 10000 }, async t => {
  const f = await fixture(t, program(`await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`));
  const task = await f.start();
  await task.result;
  const original = fs.opendir;
  const gate = workerDeferred<void>();
  let scanning = false, rootReads = 0;
  t.mock.method(fs, 'opendir', async (filename: string) => {
    if (filename === f.cache) {
      rootReads++;
      if (!scanning) { scanning = true; await gate.promise; }
    }
    return original(filename);
  });
  await until(() => scanning);
  await wait(WORKER_LIMITS.cachePollMs * 2 + 20);
  assert.equal(rootReads, 1);
  const closing = task.close();
  await until(() => f.rows[0].closed);
  assert.deepEqual(f.removed, []);
  gate.resolve(undefined);
  await closing;
  await task.closed;
  assert.deepEqual(f.removed, f.allocated);
});

test('cleanup failure rejects result and closed instead of manufacturing success', async t => {
  const f = await fixture(t, program(`await send({type:'version',id:start.id,version:'v24.20.0'}); await finish();`));
  f.setOnRemove(async () => { throw new LocalExecutionError('storage_failed'); });
  await assert.rejects(probeLocalTool('node', f.paths, new AbortController().signal, f.tools, f.logError), reason('storage_failed'));
  assert.deepEqual(f.removed, []);
  assert.ok(f.rows.every(row => row.closed));
});

test('confirmed native cleanup retries a failed cache deletion and coalesces concurrent closes', async t => {
  const f = await fixture(t, program(`await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`));
  const gate = workerDeferred<void>();
  let unlocked = false;
  f.setOnRemove(async () => {
    if (!unlocked) throw new LocalExecutionError('storage_failed');
    await gate.promise;
  });
  const task = await f.start();
  await task.result;
  await assert.rejects(task.close(), reason('storage_failed'));
  await assert.rejects(task.closed, reason('storage_failed'));
  assert.equal(f.removalAttempts.length, 1);
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].closed, true);
  const owner = f.owners.get(f.allocated[0]);
  assert.ok(owner?.confirmed);
  assert.equal(owner.confirmations, 1);
  unlocked = true;
  const retry = task.close();
  const concurrent = task.close();
  assert.equal(retry, concurrent);
  await until(() => f.removalAttempts.length === 2);
  assert.deepEqual(f.removed, []);
  gate.resolve(undefined);
  await retry;
  await task.close();
  assert.equal(f.removalAttempts.length, 2);
  assert.deepEqual(f.removed, f.allocated);
  assert.equal(f.owners.size, 0);
  assert.equal(f.rows.length, 1, 'Filesystem retry must not rerun the worker or provider.');
});

test('a confirmed probe cleanup owner survives rejection and a closed LocalTools disposal retry', async t => {
  const f = await fixture(t, program(`
    fs.writeFileSync(path.join(process.cwd(),'locked-fixture.bin'),'controlled data');
    await send({type:'version',id:start.id,version:'v24.20.0'}); await finish();
  `), undefined, true);
  const manager = f.manager;
  assert.ok(manager);
  let locked = true, unlinks = 0;
  const attemptsPerFailure = process.platform === 'win32' ? 6 : 1;
  const original = fs.unlink;
  t.mock.method(fs, 'unlink', (filename: string) => {
    if (filename === path.join(f.allocated[0] ?? f.cache, 'locked-fixture.bin')) {
      unlinks++;
      if (locked) throw Object.assign(new Error('Controlled transient file lock'), { code: 'EPERM' });
    }
    return original(filename);
  });
  await assert.rejects(probeLocalTool('node', f.paths, new AbortController().signal, f.tools, f.logError), reason('storage_failed'));
  assert.equal(f.rows.length, 1);
  assert.equal(f.rows[0].closed, true);
  assert.equal(f.removalAttempts.length, 1, 'A bounded filesystem retry must not start another native cleanup operation.');
  assert.equal(unlinks, attemptsPerFailure);
  assert.equal(f.owners.get(f.allocated[0])?.confirmed, true);
  await assert.rejects(manager.dispose());
  assert.equal(f.removalAttempts.length, 2);
  assert.equal(unlinks, attemptsPerFailure * 2);
  await assert.rejects(manager.allocateTaskCache(), reason('executor_unavailable'));
  await assert.rejects(manager.prepare(new AbortController().signal), reason('executor_unavailable'));
  locked = false;
  const retry = manager.dispose();
  assert.equal(manager.dispose(), retry);
  await retry;
  assert.equal(f.removalAttempts.length, 3);
  assert.equal(unlinks, attemptsPerFailure * 2 + 1);
  assert.deepEqual(f.removed, f.allocated);
  assert.equal(f.owners.size, 0);
  assert.equal(f.rows.length, 1);
  await assert.rejects(manager.removeTaskCache(f.allocated[0]), reason('invalid_request'));
});

test('a pre-spawn factory failure retains a confirmed cleanup owner until filesystem retry succeeds', async t => {
  const f = await fixture(t, undefined, undefined, true);
  const manager = f.manager;
  assert.ok(manager);
  const original = fs.mkdir;
  t.mock.method(fs, 'mkdir', (directory: string, options?: Parameters<typeof fs.mkdir>[1]) => {
    if (path.basename(directory) === 'temp') {
      assert.equal(f.owners.get(path.dirname(directory))?.confirmed, false);
      throw Object.assign(new Error('Controlled startup filesystem failure'), { code: 'EIO' });
    }
    return original(directory, options);
  });
  let unlocked = false;
  f.setOnRemove(async () => {
    if (!unlocked) throw new LocalExecutionError('storage_failed');
  });
  await assert.rejects(f.start(), reason('storage_failed'));
  assert.equal(f.rows.length, 0);
  assert.equal(f.removalAttempts.length, 1);
  assert.equal(f.owners.get(f.allocated[0])?.confirmed, true);
  unlocked = true;
  await manager.clearCache();
  assert.equal(f.removalAttempts.length, 2);
  assert.deepEqual(f.removed, f.allocated);
  assert.equal(f.owners.size, 0);
  assert.equal(f.rows.length, 0);
  await manager.dispose();
});

for (const scenario of [
  { name: 'probe exit 7', probe: true, ready: true, code: 7 },
  { name: 'probe exit 0 without confirmation', probe: true, ready: true, code: 0 },
  { name: 'pre-ready factory exit 7', probe: false, ready: false, code: 7 },
]) {
  test(`${scenario.name} retains its independent owner and blocks real LocalTools destructive operations`, async t => {
    const f = await fixture(t, program(`process.exit(${scenario.code});`, '', scenario.ready), undefined, true);
    const manager = f.manager;
    assert.ok(manager);
    const stage = path.join(f.root, 'tools', `.stage-node-${randomUUID()}`);
    const candidate = path.join(stage, 'node.exe');
    await fs.mkdir(stage);
    await fs.writeFile(candidate, 'controlled staging artifact');
    if (scenario.probe) {
      await assert.rejects(probeLocalTool('node', f.paths, new AbortController().signal, f.tools, f.logError), reason('worker_failed'));
    } else await assert.rejects(f.start(), reason('worker_failed'));
    assert.equal(f.rows.length, 1);
    assert.equal(f.rows[0].closed, true);
    assert.equal(f.owners.get(f.allocated[0])?.confirmed, false);
    assert.deepEqual(f.removalAttempts, []);
    for (const action of [
      () => manager.removeTaskCache(f.allocated[0]),
      () => manager.clearCache(),
      () => manager.remove('node'),
      () => manager.dispose(),
      () => manager.dispose(),
    ]) {
      await assert.rejects(action());
      assert.ok((await fs.stat(f.allocated[0])).isDirectory());
      assert.equal(await fs.readFile(candidate, 'utf8'), 'controlled staging artifact');
    }
    assert.equal(f.rows.length, 1);
    assert.deepEqual(f.removalAttempts, []);
    assert.deepEqual(f.removed, []);
    assert.equal(f.owners.size, 1);
  });
}

test('unexpected worker exit rejects closed and retains cache when native cleanup was not confirmed', async t => {
  const f = await fixture(t, program(`
    await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});
    setTimeout(()=>process.exit(7),30);
  `));
  const task = await f.start();
  await task.result;
  await assert.rejects(task.closed, reason('worker_failed'));
  await assert.rejects(task.close(), reason('worker_failed'));
  assert.deepEqual(f.removed, []);
  assert.ok(f.rows.every(row => row.closed));
  assert.match(f.logs.map(entry => String(entry.error)).join('\n'), /retained/);
});

test('even an unconfirmed pre-ready exit cannot imply successful native cleanup', async t => {
  const f = await fixture(t, `process.on('message',()=>process.exit(7));`);
  await assert.rejects(f.start(), reason('worker_failed'));
  assert.deepEqual(f.removed, []);
  assert.ok(f.rows.every(row => row.closed));
  assert.match(f.logs.map(entry => String(entry.error)).join('\n'), /retained/);
});

test('failure to spawn the explicit managed executable releases the unused cache', async t => {
  const f = await fixture(t);
  await assert.rejects(probeLocalTool('node', { ...f.paths, node: path.join(f.root, 'missing-node.exe') },
    new AbortController().signal, f.tools, f.logError), reason('worker_failed'));
  assert.deepEqual(f.removed, f.allocated);
  assert.equal(f.rows.length, 0);
});

test('a worker pipe error rejects the task and still completes native cleanup', async t => {
  const f = await fixture(t, program(`await send({type:'result',id:start.id,result:{operation:'youtube.stream',track}});`));
  const task = await f.start();
  await task.result;
  f.rows[0].child.stderr?.emit('error', new Error('Controlled worker pipe failure'));
  await assert.rejects(task.closed, reason('worker_failed'));
  await task.close();
  assert.deepEqual(f.removed, f.allocated);
});

test('SDK recovery failure data survives the child-to-host boundary without becoming queue policy', async t => {
  const sources = require.resolve('@monky/bot-sdk/dist/localRuntime/source');
  const errors = require.resolve('@monky/bot-sdk/dist/localRuntime/errors');
  const f = await fixture(t, undefined, `
    const fs=require('node:fs');
    const sources=require(${JSON.stringify(sources)});
    const {SourceRecoveryError}=require(${JSON.stringify(errors)});
    const Original=sources.YouTubeSource;
    sources.YouTubeSource=class extends Original {
      async resolve(){return {...${JSON.stringify(track)},audioUrl:'https://rr1.googlevideo.com/videoplayback'};}
      async open(){
        return {
          recoveryMode:'persistent',
          frames:(async function*(){yield Uint8Array.of(0xf8,0xff,0xfe);throw new SourceRecoveryError(13);})(),
          markFrameAdvanced:()=>{},setPaused:()=>{},
          close:async()=>{fs.writeFileSync('source-closed','1');},
        };
      }
    };
  `);
  f.setOnRemove(async directory => {
    assert.equal(await fs.readFile(path.join(directory, 'source-closed'), 'utf8'), '1');
  });
  const task = await f.start();
  await task.result;
  const expected = { reason: 'provider_unavailable', sourceFailure: { code: 'recovery_failed', attempts: 13 } };
  await assert.rejects(task.readFrames(8), expected);
  await assert.rejects(task.closed, expected);
  await task.close();
  assert.deepEqual(f.removed, f.allocated);
});

test('graceful-stop deadline terminates only the owned unresponsive worker and rejects unconfirmed cleanup', { timeout: 10000 }, async t => {
  const f = await fixture(t, `
    process.on('message',message=>{
      if(message.type==='start') {
        process.send({type:'ready',id:message.id});
        process.send({type:'result',id:message.id,result:{operation:'youtube.stream',track:${JSON.stringify(track)}}});
      }
    });
  `);
  const task = await f.start();
  await task.result;
  const original = setTimeout;
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, milliseconds?: number) =>
    original(callback, milliseconds === WORKER_LIMITS.stopMs ? 25 : milliseconds));
  await assert.rejects(task.close(), reason('worker_failed'));
  await assert.rejects(task.closed, reason('worker_failed'));
  assert.ok(f.rows.every(row => row.closed));
  assert.equal(f.rows.length, 1);
  assert.deepEqual(f.removed, []);
});

test('diagnostic overflow is bounded and signed URLs never reach the host logger', async t => {
  const f = await fixture(t, program(`
    process.stderr.write('https://rr1.googlevideo.com/videoplayback?signature=fixture-private ' + 'x'.repeat(70000));
  `));
  await assert.rejects(async () => {
    const task = await f.start();
    await task.result;
  }, reason('worker_failed'));
  await until(() => f.removed.length === 1);
  const logs = f.logs.map(entry => String(entry.error)).join('\n');
  assert.doesNotMatch(logs, /fixture-private|googlevideo/);
  assert.ok(logs.length <= 1100);
});
