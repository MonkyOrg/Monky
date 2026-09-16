const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { IncomingMessage } = require('node:http');
const { Socket } = require('node:net');
const { channel } = require('node:diagnostics_channel');
const processes = require('@monky/bot-sdk/dist/localRuntime/process');
const sources = require('@monky/bot-sdk/dist/localRuntime/source');

const worker = path.resolve(__dirname, '..', '..', 'dist-electron', 'main', 'localExecution', 'worker.js');
assert.equal(process.argv[1], worker, 'The fixture must preload the real, fixed private worker.');
assert.ok(process.channel, 'The fixture is not a standalone provider.');

const OriginalSource = sources.YouTubeSource;
const audioUrl = 'https://rr1.googlevideo.com/videoplayback';
const nativeIds = [];
let ffmpeg;
channel('child_process').subscribe(message => {
  message.process.once('spawn', () => {
    if (message.process.spawnfile === ffmpeg) {
      nativeIds.push(message.process.pid);
      fs.writeFileSync('native-ids.json', JSON.stringify(nativeIds));
    }
  });
});

// Only the extractor/upstream dependencies change. Parsing, persistent HTTP,
// FFmpeg transcoding, playback feedback and native cleanup remain production code.
sources.YouTubeSource = class extends OriginalSource {
  constructor(paths) {
    ffmpeg = paths.ffmpeg;
    let generating;
    const generate = signal => generating ??= processes.captureBytes(paths.ffmpeg, [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=8',
      '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k', '-frame_duration', '20',
      '-f', 'ogg', '-page_duration', '20000', 'pipe:1',
    ], signal, 15_000, 1024 * 1024);
    const capture = async (executable, args, signal, timeout, limit) => {
      if (executable !== paths.ytDlp) {
        return processes.capture(executable, args, signal, timeout, limit);
      }
      for (const flag of ['--ignore-config', '--no-cache-dir', '--no-plugin-dirs', '--no-remote-components']) {
        assert.ok(args.includes(flag), `Extractor isolation missing ${flag}`);
      }
      if (args.includes('--version')) return '2026.08.19';
      const requested = args.find(value => /^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/.test(value));
      const id = requested?.slice(-11) ?? 'abcdefghijk';
      const track = {
        id, title: `Locally authored 880 Hz fixture ${id}`,
        webpage_url: `https://www.youtube.com/watch?v=${id}`,
        url: audioUrl, duration: 8, availability: 'public', age_limit: 0, live_status: 'not_live',
      };
      return JSON.stringify(args.some(value => value.startsWith('ytsearch')) ? { entries: [track] } : track);
    };
    const request = async (url, headers, signal) => {
      assert.equal(url.href, audioUrl);
      assert.equal(headers.Cookie, undefined);
      assert.equal(headers.Authorization, undefined);
      signal.throwIfAborted();
      const data = await generate(signal);
      const range = /^bytes=(\d+)-(\d*)$/.exec(headers.Range);
      assert.ok(range, 'The production persistent source must request a bounded byte range.');
      const from = Number(range[1]);
      const end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
      const response = new IncomingMessage(new Socket());
      response.statusCode = from >= data.length ? 416 : 206;
      response.headers = from >= data.length ? { 'content-range': `bytes */${data.length}` } : {
        'content-range': `bytes ${from}-${end}/${data.length}`,
        'content-length': String(end - from + 1),
        'content-type': 'audio/ogg',
        etag: '"authored-local-e2e-v1"',
      };
      response.complete = true;
      const abort = () => response.destroy();
      signal.addEventListener('abort', abort, { once: true });
      response.once('close', () => signal.removeEventListener('abort', abort));
      if (from < data.length) response.push(data.subarray(from, end + 1));
      response.push(null);
      if (signal.aborted) abort();
      return response;
    };
    const captureBytes = (executable, args, signal, timeout, limit, options) => {
      assert.equal(executable, paths.ffmpeg);
      const input = args.indexOf('-i');
      assert.equal(args[input + 1], audioUrl);
      const prefix = [];
      for (let index = 0; index < input; index++) {
        if (['-protocol_whitelist', '-rw_timeout'].includes(args[index])) index++;
        else prefix.push(args[index]);
      }
      return processes.captureBytes(executable, [
        ...prefix, '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=8',
        ...args.slice(input + 2),
      ], signal, timeout, limit, options);
    };
    super(paths, { capture, captureBytes, request });
  }
};
