import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { MediaError, SourceRecoveryError } from '@monky/bot-sdk/dist/localRuntime';
import {
  parseWorkerCommand, parseWorkerReply, workerBase64, workerError, workerResult, workerVersion, WORKER_LIMITS,
} from '../src/main/localExecution/workerProtocol';

const paths = { node: process.execPath, ytDlp: path.resolve('fixture-ytdlp'), ffmpeg: path.resolve('fixture-ffmpeg') };
const track = { id: 'abcdefghijk', title: 'Controlled fixture',
  url: 'https://www.youtube.com/watch?v=abcdefghijk', duration: 0.12 };
const start = {
  type: 'start', id: 'task-fixture', paths, directory: path.resolve('cache', 'task-00000000-0000-0000-0000-000000000000'),
  mode: 'task', spec: { operation: 'youtube.stream', url: track.url },
};

test('private worker protocol accepts only fixed operations, explicit paths and bounded controls', () => {
  assert.deepEqual(parseWorkerCommand(start), start);
  for (const message of [
    { type: 'read', id: start.id, requestId: 1, count: 8 },
    { type: 'ack', id: start.id, requestId: 2, playedFrames: 8 },
    { type: 'pause', id: start.id, requestId: 3, paused: true },
    { type: 'stop', id: start.id, reason: 'permission_revoked' },
  ]) assert.deepEqual(parseWorkerCommand(message), message);
  for (const message of [
    { ...start, paths: { ...paths, node: 'node' } },
    { ...start, paths: { ...paths, ffmpeg: `${paths.ffmpeg}\0` } },
    { ...start, paths: { ...paths, args: ['-e', 'arbitrary code'] } },
    { ...start, spec: { operation: 'youtube.stream', url: 'https://untrusted.test/audio' } },
    { ...start, spec: { operation: 'shell', command: 'not permitted' } },
    { ...start, script: 'not permitted' },
    { ...start, id: '' }, { ...start, id: 'x'.repeat(129) },
    { ...start, maxOutputBytes: 67108864 },
    { type: 'read', id: start.id, requestId: 1, count: 9 },
    { type: 'read', id: start.id, requestId: 1, count: 0 },
    { type: 'read', id: start.id, requestId: 1, count: 1.5 },
    { type: 'ack', id: start.id, requestId: 1, playedFrames: -1 },
    { type: 'pause', id: start.id, requestId: 1, paused: 'true' },
    { type: 'stop', id: start.id, reason: 'run-program' },
    { type: 'ready', id: start.id },
  ]) assert.throws(() => parseWorkerCommand(message));
});

test('worker replies exclude signed media URLs and non-JSON binary transport', () => {
  assert.deepEqual(workerResult({ operation: 'youtube.resolve', track }), { operation: 'youtube.resolve', track });
  assert.throws(() => workerResult({ operation: 'youtube.resolve',
    track: { ...track, audioUrl: 'https://rr1.googlevideo.com/videoplayback?signature=private' } }));
  assert.throws(() => parseWorkerReply({ type: 'frames', id: start.id, requestId: 1,
    frames: [Uint8Array.of(0xf8, 0xff, 0xfe)], done: false }));
  assert.throws(() => parseWorkerReply({ type: 'frames', id: start.id, requestId: 1, frames: [], done: false }));
  assert.throws(() => parseWorkerReply({ type: 'frames', id: start.id, requestId: 1,
    frames: Array.from({ length: 9 }, () => '+P/+'), done: false }));
  assert.throws(() => parseWorkerReply({ type: 'result', id: start.id,
    result: { operation: 'youtube.preview', mimeType: 'audio/ogg', audioBase64: 'A'.repeat(WORKER_LIMITS.messageBytes) } }));
  assert.throws(() => parseWorkerReply({ type: 'result', id: start.id,
    result: { operation: 'youtube.search', tracks: Array.from({ length: 1000 }, () => track) } }));
  const cyclic: Record<string, unknown> = { type: 'result', id: start.id };
  cyclic.result = cyclic;
  assert.throws(() => parseWorkerReply(cyclic));
});

test('bounded frame base64 is canonical and compact receipt versions contain no controls', () => {
  assert.deepEqual(workerBase64('+P/+', 1275), Buffer.from([0xf8, 0xff, 0xfe]));
  assert.equal(workerBase64(Buffer.alloc(1275).toString('base64'), 1275).length, 1275);
  for (const value of ['', '/x==', 'not base64', Buffer.alloc(1276).toString('base64')]) {
    assert.throws(() => workerBase64(value, 1275));
  }
  assert.equal(workerVersion('v24.20.0'), 'v24.20.0');
  assert.equal(workerVersion('8.0.1'), '8.0.1');
  for (const version of ['', ' x', 'x\n', 'x\0x', 'x\u0085x', 'x\u2028x', 'x\u2029x', 'x'.repeat(129)]) {
    assert.throws(() => workerVersion(version));
  }
});

test('private failure replies preserve bounded SDK error codes and authoritative recovery counts', () => {
  const recovery = workerError(new SourceRecoveryError(7));
  assert.equal(recovery.reason, 'provider_unavailable');
  assert.deepEqual(recovery.sourceFailure, { code: 'recovery_failed', attempts: 7 });
  const reply = { type: 'failure', id: start.id, reason: recovery.reason, detail: recovery.message,
    sourceFailure: recovery.sourceFailure };
  assert.deepEqual(parseWorkerReply(reply), reply);
  for (const [code, reason] of [
    ['input', 'invalid_request'], ['unsupported', 'invalid_request'],
    ['tools', 'tools_missing'], ['runtime', 'tools_missing'],
    ['unavailable', 'provider_unavailable'], ['timeout', 'timeout'], ['busy', 'busy'],
  ] as const) {
    const error = workerError(new MediaError(code, 'https://rr1.googlevideo.com/videoplayback?signature=private'));
    assert.equal(error.reason, reason);
    assert.deepEqual(error.sourceFailure, { code });
  }
  for (const attempts of [1, 100]) {
    assert.deepEqual(workerError(new SourceRecoveryError(attempts)).sourceFailure, { code: 'recovery_failed', attempts });
  }
  assert.deepEqual(workerError(new SourceRecoveryError()).sourceFailure, { code: 'recovery_failed', attempts: 5 });
  assert.equal(workerError(new MediaError('cancelled')).sourceFailure, undefined);
  assert.equal(workerError(new MediaError('recovery_failed')).sourceFailure, undefined);
  for (const sourceFailure of [
    { code: 'recovery_failed', attempts: 0 }, { code: 'recovery_failed', attempts: 101 },
    { code: 'recovery_failed' }, { code: 'unavailable', audioUrl: 'https://untrusted.test/audio' },
    { code: 'run-program' },
  ]) assert.throws(() => parseWorkerReply({ ...reply, sourceFailure }));
});
