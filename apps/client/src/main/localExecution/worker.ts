import { ChildProcess } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import path from 'node:path';
import {
  checkMediaTool, errorDiagnostic, MediaError, terminate, YouTubeSource,
  type AudioStream, type MusicSource, type Track,
} from '@monky/bot-sdk/dist/localRuntime';
import { LIMITS, LOCAL_EXECUTION_RUNTIME_LIMITS } from '@monky/shared';
import type { LocalToolPaths } from './LocalTools';
import { LocalExecutionError } from './errors';
import {
  parseWorkerCommand, workerDeferred, workerDirectories, workerError, workerId, workerResult, workerVersion,
  WORKER_LIMITS, type WorkerOutcome, type WorkerReply, type WorkerStart,
} from './workerProtocol';

export interface WorkerChannel {
  send(message: WorkerReply): Promise<void>;
  receive(listener: (message: unknown) => void): () => void;
  disconnected(listener: () => void): () => void;
}

export interface WorkerImplementation {
  id: string;
  source(paths: LocalToolPaths): MusicSource;
  probe: typeof checkMediaTool;
  verify(start: WorkerStart): Promise<void>;
  cleanupNative(): Promise<void>;
  producerActive(): boolean;
}

function publicTrack(track: Track): Track {
  return { id: track.id, title: track.title, url: track.url, duration: track.duration };
}

function cancelled(error: unknown): boolean {
  return error instanceof MediaError && error.code === 'cancelled' ||
    error instanceof LocalExecutionError && ['cancelled', 'executor_unavailable', 'permission_revoked', 'timeout'].includes(error.reason);
}

/** The production entry always supplies the fixed implementation below; tests can supply controlled sources. */
export function runLocalWorker(transport: WorkerChannel, implementation: WorkerImplementation): {
  closed: Promise<void>; stop(): Promise<void>; fail(error: unknown): Promise<void>;
} {
  const id = workerId(implementation.id);
  const controller = new AbortController();
  const completion = workerDeferred<void>();
  const operations = new Set<Promise<WorkerOutcome<void>>>();
  let start: WorkerStart | undefined;
  let stream: AudioStream | undefined;
  let iterator: AsyncIterator<Uint8Array> | undefined;
  let reading = false;
  let eof = false;
  let paused = false;
  let closing = false;
  let failure: LocalExecutionError | undefined;
  let requestId = 0;
  let delivered = 0;
  let played = 0;
  let advanced = 0;

  const send = (message: WorkerReply): Promise<void> => transport.send(message);
  const advance = (): void => {
    if (eof || closing || !stream || advanced === played) return;
    // SDK finalization closes the source before next() reports EOF. Defer terminal-read ACKs until that result.
    if (reading && !implementation.producerActive()) return;
    const mark = stream.markFrameAdvanced;
    if (!mark) throw new LocalExecutionError('worker_failed');
    while (advanced < played) { mark.call(stream); advanced++; }
  };
  const remember = (error: unknown): void => {
    if (controller.signal.aborted && cancelled(error)) return;
    failure ??= workerError(error);
  };
  const shutdown = (error?: unknown): Promise<void> => {
    if (error !== undefined) failure ??= workerError(error);
    if (closing) return completion.promise;
    closing = true;
    controller.abort(failure ?? new LocalExecutionError('cancelled'));
    const finish = async (): Promise<void> => {
      try {
        // Abort/close before joining reads: iterator.return() can be queued behind a blocked next().
        const releases = await Promise.allSettled([
          Promise.resolve().then(() => stream?.close()),
          implementation.cleanupNative(),
        ]);
        for (const result of releases) if (result.status === 'rejected') failure ??= workerError(result.reason);
        while (operations.size) {
          const results = await Promise.all([...operations]);
          for (const result of results) if (!result.ok) remember(result.error);
        }
        if (iterator?.return) {
          try { await iterator.return(); }
          catch (error) { remember(error); }
        }
        // An open that completed after abort closes its returned stream in execute().
        await implementation.cleanupNative();
        if (failure) await send({ type: 'failure', id, reason: failure.reason, detail: errorDiagnostic(failure),
          ...(failure.sourceFailure ? { sourceFailure: failure.sourceFailure } : {}) });
        await send({ type: 'closed', id });
      } catch (error) {
        failure ??= workerError(error);
      } finally {
        removeMessages();
        removeDisconnect();
        if (failure) completion.reject(failure);
        else completion.resolve(undefined);
      }
    };
    void finish();
    return completion.promise;
  };
  const launch = (action: () => Promise<void>): void => {
    if (operations.size >= WORKER_LIMITS.pendingCommands) {
      void shutdown(new LocalExecutionError('busy'));
      return;
    }
    const outcome = Promise.resolve().then(action).then<WorkerOutcome<void>, WorkerOutcome<void>>(
      () => ({ ok: true, value: undefined }), error => ({ ok: false, error }),
    );
    operations.add(outcome);
    void outcome.then(result => {
      operations.delete(outcome);
      if (!result.ok && !closing) void shutdown(result.error);
    });
  };
  const execute = async (input: WorkerStart): Promise<void> => {
    await implementation.verify(input);
    controller.signal.throwIfAborted();
    await send({ type: 'ready', id });
    controller.signal.throwIfAborted();
    if (input.mode === 'probe') {
      const version = await implementation.probe(input.tool === 'yt-dlp' ? 'ytDlp' : input.tool,
        input.paths, controller.signal);
      controller.signal.throwIfAborted();
      await send({ type: 'version', id, version: workerVersion(version) });
      void shutdown();
      return;
    }
    const source = implementation.source(input.paths);
    const spec = input.spec;
    switch (spec.operation) {
      case 'youtube.search': {
        const tracks = await source.search(spec.query, controller.signal);
        controller.signal.throwIfAborted();
        await send({ type: 'result', id, result: workerResult({ operation: spec.operation, tracks: tracks.map(publicTrack) }) });
        break;
      }
      case 'youtube.resolve': {
        const track = await source.resolve(spec.url, controller.signal);
        controller.signal.throwIfAborted();
        await send({ type: 'result', id, result: workerResult({ operation: spec.operation, track: publicTrack(track) }) });
        break;
      }
      case 'youtube.preview': {
        const audio = await source.preview(spec.url, controller.signal);
        controller.signal.throwIfAborted();
        if (!(audio instanceof Uint8Array) || !audio.byteLength || audio.byteLength > LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES) {
          throw new LocalExecutionError('worker_failed');
        }
        await send({ type: 'result', id, result: workerResult({
          operation: spec.operation, mimeType: 'audio/ogg', audioBase64: Buffer.from(audio).toString('base64'),
        }) });
        break;
      }
      case 'youtube.stream': {
        const track = await source.resolve(spec.url, controller.signal);
        controller.signal.throwIfAborted();
        stream = await source.open(track, controller.signal, { mode: 'persistent', progress: 'playback' });
        if (controller.signal.aborted) {
          await stream.close();
          controller.signal.throwIfAborted();
        }
        if (stream.recoveryMode !== 'persistent' || !stream.markFrameAdvanced || !stream.setPaused) {
          throw new LocalExecutionError('worker_failed');
        }
        stream.setPaused(paused);
        iterator = stream.frames[Symbol.asyncIterator]();
        await send({ type: 'result', id, result: workerResult({ operation: spec.operation, track: publicTrack(track) }) });
        return;
      }
    }
    void shutdown();
  };
  const read = async (count: number, sequence: number): Promise<void> => {
    let completed = false;
    try {
      if (!iterator || !start || start.mode !== 'task' || start.spec.operation !== 'youtube.stream') {
        throw new LocalExecutionError('invalid_request');
      }
      const frames: string[] = [];
      while (!eof && frames.length < count) {
        controller.signal.throwIfAborted();
        const next = await iterator.next();
        controller.signal.throwIfAborted();
        if (next.done) { eof = true; break; }
        if (!(next.value instanceof Uint8Array) || !next.value.byteLength ||
            next.value.byteLength > LOCAL_EXECUTION_RUNTIME_LIMITS.frameBytes) {
          throw new LocalExecutionError('worker_failed');
        }
        frames.push(Buffer.from(next.value).toString('base64'));
      }
      delivered += frames.length;
      if (delivered > 0xffffffff) throw new LocalExecutionError('worker_failed');
      await send({ type: 'frames', id, requestId: sequence, frames, done: eof });
      completed = true;
      if (eof) void shutdown();
    } finally {
      reading = false;
      if (completed) advance();
    }
  };
  const receive = (raw: unknown): void => {
    try {
      const message = parseWorkerCommand(raw);
      if (message.id !== id) throw new LocalExecutionError('invalid_request');
      if (message.type === 'stop') { void shutdown(); return; }
      if (closing) return;
      if (message.type === 'start') {
        if (start) throw new LocalExecutionError('invalid_request');
        start = message;
        launch(() => execute(message));
        return;
      }
      if (!start || start.mode !== 'task' || start.spec.operation !== 'youtube.stream' ||
          message.requestId <= requestId) throw new LocalExecutionError('invalid_request');
      requestId = message.requestId;
      if (message.type === 'pause') {
        paused = message.paused;
        if (!eof) stream?.setPaused?.(paused);
        launch(() => send({ type: 'accepted', id, requestId: message.requestId, operation: 'pause' }));
      } else if (message.type === 'ack') {
        if (message.playedFrames < played || message.playedFrames > delivered) throw new LocalExecutionError('invalid_request');
        // Demux EOF closes the SDK source even while the receiver still owns a small buffered tail.
        played = message.playedFrames;
        advance();
        launch(() => send({ type: 'accepted', id, requestId: message.requestId, operation: 'ack' }));
      } else {
        if (reading) throw new LocalExecutionError('busy');
        reading = true;
        launch(() => read(message.count, message.requestId));
      }
    } catch (error) { void shutdown(error); }
  };
  const removeMessages = transport.receive(receive);
  const removeDisconnect = transport.disconnected(() => { void shutdown(new LocalExecutionError('executor_unavailable')); });
  return { closed: completion.promise, stop: () => shutdown(), fail: error => shutdown(error) };
}

function samePath(first: string, second: string): boolean {
  return process.platform === 'win32' ? path.resolve(first).toLowerCase() === path.resolve(second).toLowerCase()
    : path.resolve(first) === path.resolve(second);
}

async function verifyContext(start: WorkerStart): Promise<void> {
  const directories = workerDirectories(start.directory);
  if (!samePath(process.cwd(), start.directory) || !samePath(process.execPath, start.paths.node) ||
      process.env.MONKY_LOCAL_WORKER_ID !== start.id) throw new LocalExecutionError('worker_failed');
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[key] !== directories.temp) throw new LocalExecutionError('worker_failed');
  }
  if (process.env.HOME !== directories.home || process.env.USERPROFILE !== directories.home ||
      process.env.XDG_CONFIG_HOME !== directories.config || process.env.XDG_CACHE_HOME !== directories.cache ||
      process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.NODE_COMPILE_CACHE ||
      process.env.PYTHONPATH || process.env.PYTHONHOME || process.env.LD_PRELOAD ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new LocalExecutionError('worker_failed');
}

async function main(): Promise<void> {
  if (!process.send || !process.connected || process.argv.length !== 2) throw new LocalExecutionError('worker_failed');
  const children = new Map<ChildProcess, Promise<void>>();
  let ffmpeg: string | undefined;
  const spawned = channel('child_process');
  const ownChild = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || !('process' in message) ||
        !(message.process instanceof ChildProcess)) return;
    const child = message.process;
    const closed = new Promise<void>(resolve => child.once('close', () => { children.delete(child); resolve(); }));
    children.set(child, closed);
  };
  spawned.subscribe(ownChild);
  const runtime = runLocalWorker({
    send: message => new Promise<void>((resolve, reject) => {
      if (!process.connected || !process.send) { reject(new LocalExecutionError('executor_unavailable')); return; }
      process.send(message, error => error ? reject(error) : resolve());
    }),
    receive: listener => { process.on('message', listener); return () => process.off('message', listener); },
    disconnected: listener => { process.on('disconnect', listener); return () => process.off('disconnect', listener); },
  }, {
    id: workerId(process.env.MONKY_LOCAL_WORKER_ID),
    source: paths => { ffmpeg = paths.ffmpeg; return new YouTubeSource(paths); },
    probe: checkMediaTool,
    verify: verifyContext,
    cleanupNative: async () => {
      while (children.size) await Promise.all([...children].map(async ([child, closed]) => {
        // Diagnostics publish before spawnfile exists. Join taskkill after spawn, never recursively kill the killer.
        if (typeof child.spawnfile !== 'string' || path.basename(child.spawnfile).toLowerCase() !== 'taskkill.exe') {
          await terminate(child);
        }
        await closed;
      }));
    },
    producerActive: () => [...children.keys()].some(child => ffmpeg !== undefined &&
      typeof child.spawnfile === 'string' && samePath(child.spawnfile, ffmpeg) &&
      child.exitCode === null && child.signalCode === null),
  });
  const stop = (): void => { void runtime.stop(); };
  const fail = (error: unknown): void => { void runtime.fail(error); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  process.on('uncaughtException', fail);
  process.on('unhandledRejection', fail);
  try { await runtime.closed; }
  finally {
    spawned.unsubscribe(ownChild);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    process.off('uncaughtException', fail);
    process.off('unhandledRejection', fail);
    if (process.connected) process.disconnect();
  }
}

if (require.main === module) {
  void main().catch(error => {
    console.error(errorDiagnostic(error));
    process.exitCode = 1;
  });
}
