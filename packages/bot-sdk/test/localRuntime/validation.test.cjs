const assert = require('node:assert/strict');
const { test } = require('node:test');
const { LIMITS } = require('@monky/shared');
const {
  YouTubeSource, MediaError, MediaToolError, SourceRecoveryError, IncompleteAudioError,
  OggOpusParser, musicInput, videoUrl, audioUrl, parseTrack, checkMediaTool, checkMediaTools,
  youtubeExtractorArgs, MUSIC_PREVIEW_DURATION_MS, SOURCE_RECOVERY_FAILURE_LIMIT,
} = require('../../dist/localRuntime');
const { tools, signal, track, page, headers, ogg } = require('./fixtures.cjs');

test('individual video URLs are canonicalized without playlist or radio context', () => {
  for (const input of [
    'https://youtu.be/abcdefghijk?t=2',
    'https://www.youtube.com/watch?v=abcdefghijk',
    'http://m.youtube.com/shorts/abcdefghijk',
    'https://youtu.be/abcdefghijk?list=RDabcdefghijk&start_radio=1',
    'https://www.youtube.com/watch?v=abcdefghijk&list=PLfixture&index=7&t=2',
    'https://youtube.com/watch?list=PLfixture&index=7&v=abcdefghijk&start_radio=1',
    'https://music.youtube.com/watch?v=abcdefghijk&list=RDabcdefghijk&si=fixture',
    'https://www.youtube.com/embed/abcdefghijk?list=PLfixture&index=2#t=3',
  ]) {
    assert.equal(videoUrl(input), track().url);
    assert.deepEqual(musicInput(input), { kind: 'url', value: track().url });
  }
});

test('URL validation rejects other providers, ambiguous videos, credentials and normalized authorities', () => {
  for (const input of [
    'https://youtube.com/playlist?list=fixture',
    'https://spotify.com/track/fixture', 'file:///fixture', 'http://127.0.0.1/x',
    'https://youtube.com.evil.test/watch?v=abcdefghijk',
    'https://fixture-user@youtube.com/watch?v=abcdefghijk',
    'https://youtube.com:444/watch?v=abcdefghijk',
    'https://youtube.com/live/abcdefghijk', 'https://youtu.be/abcdefghijk/extra',
    'https://youtu.be/%61bcdefghijk', 'https://youtube.com/playlist?list=fixture&v=abcdefghijk',
    'https://youtube.com/watch?list=fixture&index=2',
    'https://youtu.be/?list=fixture', 'https://youtube.com/watch?v=&list=fixture',
    'https://youtube.com/watch?v=abcdefghij', 'https://youtube.com/watch?v=abcdefghijkl',
    'https://youtube.com/watch?v=abcdefghijk%0A', 'https://youtube.com/watch?v=abcdefghijk%00',
    'https://youtube.com/watch?v=abcdefghij%2F',
    'https://youtube.com/watch?v=abcdefghijk&v=12345678901',
    'https://youtube.com/watch?v=abcdefghijk&v=abcdefghijk',
    'https://@youtube.com/watch?v=abcdefghijk', 'https://youtube.com:443/watch?v=abcdefghijk',
    'http://youtube.com:80/watch?v=abcdefghijk', 'https://youtube.com:/watch?v=abcdefghijk',
    'ftp://youtube.com/watch?v=abcdefghijk', '//youtube.com/watch?v=abcdefghijk',
    'https:youtube.com/watch?v=abcdefghijk', 'https:////youtube.com/watch?v=abcdefghijk',
    'https://%79outube.com/watch?v=abcdefghijk', 'https://youtube.com\\watch?v=abcdefghijk',
    'https://youtube.com/watch?v=abcde\nfghijk', 'https://you\ttube.com/watch?v=abcdefghijk',
  ]) assert.throws(() => videoUrl(input), { code: 'unsupported' }, input);
  assert.deepEqual(musicInput(' original fixture '), { kind: 'search', value: 'original fixture' });
  for (const input of [null, 42, '', ' ', 'a'.repeat(201), 'ytsearch999:fixture', 'https://localhost']) {
    assert.throws(() => musicInput(input), MediaError);
  }
  assert.equal(musicInput('a'.repeat(200)).value.length, LIMITS.MAX_BOT_AUTOCOMPLETE_QUERY_LENGTH);
});

test('audio resources stay restricted to HTTPS googlevideo videoplayback endpoints', () => {
  const allowed = 'https://rr1---sn-fixture.googlevideo.com/videoplayback?x=1';
  assert.equal(audioUrl(allowed), allowed);
  for (const input of [
    undefined, {}, 'not a URL', 'http://rr1.googlevideo.com/videoplayback',
    'https://googlevideo.com.evil.test/videoplayback', 'https://googlevideo.com/videoplayback',
    'https://a.b.googlevideo.com/videoplayback', 'https://localhost/videoplayback',
    'https://rr1.googlevideo.com/other', 'https://rr1.googlevideo.com:8443/videoplayback',
    'https://fixture-user@rr1.googlevideo.com/videoplayback',
  ]) assert.throws(() => audioUrl(input), { code: 'unavailable' });
});

test('metadata enforces unrestricted non-live videos up to one hour and sanitizes titles', () => {
  const base = { id: 'abcdefghijk', title: 'Original fixture', duration: 60,
    live_status: 'not_live', availability: 'public', age_limit: 0 };
  assert.deepEqual(parseTrack(base, true), { id: base.id, title: base.title, duration: 60, url: track().url });
  assert.equal(parseTrack({ ...base, duration: 3600 }, true).duration, 3600);
  assert.equal(parseTrack({ ...base, title: '\0\n' + 'x'.repeat(200) }, true).title, 'x'.repeat(150));
  for (const change of [
    { duration: Infinity }, { duration: NaN }, { duration: 0 }, { duration: -1 }, { duration: 3601 },
    { duration: '60' }, { is_live: true }, { was_live: true }, { live_status: 'is_upcoming' },
    { live_status: 'post_live' }, { availability: 'subscriber_only' }, { availability: 'private' },
    { availability: 'unlisted' }, { age_limit: 18 }, { age_limit: '0' }, { id: 'abcdefghijk\n' },
    { id: 'short' }, { title: undefined },
  ]) assert.throws(() => parseTrack({ ...base, ...change }, true), { code: 'unsupported' });
  for (const value of [null, [], false]) assert.throws(() => parseTrack(value), { code: 'unavailable' });
});

test('required executable paths are snapshotted and never replaced by ambient defaults', async () => {
  for (const paths of [undefined, null, {}, { ...tools, node: '' }, { ...tools, ytDlp: undefined },
    { ...tools, ffmpeg: ' \t' }, { ...tools, node: 'node\0.exe' }]) {
    assert.throws(() => new YouTubeSource(paths), { code: 'tools' });
  }
  const paths = { ...tools };
  const calls = [];
  const source = new YouTubeSource(paths, { capture: async (executable, args) => {
    calls.push(executable);
    if (executable === tools.node) return 'v22.0.0';
    if (executable === tools.ytDlp) return '2026.08.19';
    if (executable === tools.ffmpeg) return args.includes('-version') ? 'ffmpeg version 8.0.1' : ' A....D libopus';
    assert.fail('No fallback executable is allowed.');
  } });
  paths.node = 'node';
  paths.ytDlp = 'yt-dlp';
  paths.ffmpeg = 'ffmpeg';
  await source.check(signal());
  assert.deepEqual(calls, [tools.node, tools.ytDlp, tools.ffmpeg, tools.ffmpeg]);
  await assert.rejects(new YouTubeSource(tools).check(signal()),
    error => error instanceof MediaToolError && error.tool === 'node' && error.executable === tools.node);
});

test('readiness preserves supported Node, libopus, finite per-tool deadlines and capture limits', async () => {
  const calls = [];
  await checkMediaTools(tools, signal(), async (executable, args, abortSignal, timeoutMs, limit) => {
    calls.push({ executable, args, timeoutMs, limit });
    assert.equal(abortSignal.aborted, false);
    if (executable === tools.node) return 'v22.0.0';
    if (executable === tools.ytDlp) return '2026.08.19';
    return args.includes('-version') ? 'ffmpeg version 8.0.1' : ' A....D libopus Opus';
  });
  assert.deepEqual(calls, [
    { executable: tools.node, args: ['--version'], timeoutMs: 5000, limit: 65536 },
    { executable: tools.ytDlp, args: [...youtubeExtractorArgs(tools.node), '--version'], timeoutMs: 30000, limit: 65536 },
    { executable: tools.ffmpeg, args: ['-version'], timeoutMs: 15000, limit: 65536 },
    { executable: tools.ffmpeg, args: ['-hide_banner', '-encoders'], timeoutMs: 15000, limit: 131072 },
  ]);
  for (const [tool, values] of [
    ['node', ['', 'v20.0.0', 'v22.garbage', 'v22.0.0\nunexpected', '{"token":"synthetic-private"}']],
    ['ytDlp', ['', 'another executable', '2026.08.19\nunexpected', '{"title":"synthetic-private"}']],
    ['ffmpeg', ['--enable-libopus', 'libopus is unavailable', 'pcm_s16le']],
  ]) {
    for (const value of values) {
      await assert.rejects(checkMediaTool(tool, tools, signal(), async (_executable, args) =>
        tool === 'ffmpeg' && args.includes('-version') ? 'ffmpeg version 8.0.1' : value), error => {
        assert.ok(error instanceof MediaToolError);
        assert.equal(error.tool, tool);
        assert.equal(error.code, tool === 'node' ? 'runtime' : 'tools');
        assert.doesNotMatch(error.detail, /synthetic-private/);
        if (tool === 'ffmpeg') assert.match(error.detail, /libopus encoder/);
        return true;
      });
    }
  }
  for (const version of ['2026.08.19', '2026.08.19.232506', '2026.08.19+custom.1']) {
    assert.equal(await checkMediaTool('ytDlp', tools, signal(), async () => `${version}\n`), version);
  }
  await assert.rejects(checkMediaTool('ffmpeg', tools, signal(), async () => {
    throw new MediaError('timeout', 'Media process exceeded 15000 ms. token=synthetic-private');
  }), error => error.code === 'timeout' && /15000/.test(error.detail) && !/synthetic-private/.test(error.detail));
});

test('FFmpeg readiness returns only its actual bounded version after validating libopus', async () => {
  for (const version of ['8.0.1', 'n8.0-27-gabc0123', 'N-120000-gabc0123', 'git-2026-08-15-abc0123',
    '8.0.1-custom+build.2', '8.' + 'a'.repeat(126)]) {
    const calls = [];
    const abortSignal = signal();
    const result = await checkMediaTool('ffmpeg', tools, abortSignal,
      async (executable, args, receivedSignal, timeout, limit) => {
        calls.push(args);
        assert.equal(executable, tools.ffmpeg);
        assert.equal(receivedSignal, abortSignal);
        assert.equal(timeout, 15000);
        if (args.includes('-version')) {
          assert.equal(limit, 65536);
          return `  ffmpeg version ${version} Copyright (c) FFmpeg developers\r\n` +
            'configuration: --enable-libopus https://fixture.test/build-path\r\nlibavutil 60.8.100\r\n';
        }
        assert.equal(limit, 131072);
        assert.deepEqual(args, ['-hide_banner', '-encoders']);
        return ' A....D libopus Opus encoder';
      });
    assert.equal(result, version);
    assert.ok(result.length > 0 && result.length <= 128);
    assert.equal(result, result.trim());
    assert.doesNotMatch(result, /[\r\n]|configuration|Copyright|https:|libopus/);
    assert.deepEqual(calls, [['-version'], ['-hide_banner', '-encoders']]);
  }
});

test('malformed FFmpeg version output is rejected before encoder probing without exposing diagnostics', async () => {
  for (const value of [
    '', 'libopus', '8.0.1', 'another executable', 'ffmpeg version ', 'ffmpeg version\n8.0.1',
    'ffmpeg version 8.0\0synthetic-private', 'ffmpeg version 8.0\u001b[0m',
    'ffmpeg version 8.0\rsynthetic-private', `ffmpeg version 8.${'a'.repeat(127)}`,
    'ffmpeg version {"token":"synthetic-private"}', '{"version":"8.0.1","token":"synthetic-private"}',
    'configuration: synthetic-private\nffmpeg version 8.0.1',
  ]) {
    let calls = 0;
    await assert.rejects(checkMediaTool('ffmpeg', tools, signal(), async (executable, args) => {
      calls++;
      assert.equal(executable, tools.ffmpeg);
      assert.deepEqual(args, ['-version']);
      return value;
    }), error => {
      assert.ok(error instanceof MediaToolError);
      assert.equal(error.tool, 'ffmpeg');
      assert.equal(error.executable, tools.ffmpeg);
      assert.equal(error.code, 'tools');
      assert.match(error.detail, /valid FFmpeg version/);
      assert.doesNotMatch(error.detail, /synthetic-private|configuration/);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('cancellation during either FFmpeg probe cannot publish a version or begin another stage', async () => {
  for (const stage of ['-version', '-encoders']) {
    const controller = new AbortController();
    const calls = [];
    await assert.rejects(checkMediaTool('ffmpeg', tools, controller.signal, async (_executable, args, receivedSignal) => {
      calls.push(args);
      assert.equal(receivedSignal, controller.signal);
      if (args.includes(stage)) controller.abort();
      return args.includes('-version') ? 'ffmpeg version 8.0.1' : ' A....D libopus';
    }), { code: 'cancelled' });
    assert.equal(calls.length, stage === '-version' ? 1 : 2);
  }
});

test('search and resolve retain extractor isolation, bounded results and canonical selection', async () => {
  const calls = [];
  const base = { id: 'abcdefghijk', title: 'Original fixture', duration: 60, availability: 'public' };
  const source = new YouTubeSource(tools, { capture: async (executable, args) => {
    calls.push({ executable, args });
    if (args.includes('--flat-playlist')) {
      return JSON.stringify({ entries: Array.from({ length: 10 }, (_, index) => ({ ...base, id: `abcdefghij${index}` })) });
    }
    return JSON.stringify({ ...base, url: track().audioUrl });
  } });
  assert.equal((await source.search('original fixture', signal())).length, 8);
  const selected = await source.resolve(`${track().url}&list=PLfixture&index=7`, signal());
  assert.equal(selected.url, track().url);
  assert.equal(selected.audioUrl, track().audioUrl);
  for (const { executable, args } of calls) {
    assert.equal(executable, tools.ytDlp);
    for (const flag of ['--ignore-config', '--no-cache-dir', '--no-plugin-dirs', '--no-js-runtimes',
      '--no-remote-components', '--skip-download', '--dump-single-json']) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf('--js-runtimes') + 1], `node:${tools.node}`);
    assert.equal(args.some(arg => /cookie|netrc|username|password|browser|proxy/.test(arg)), false);
  }
  assert.deepEqual(calls[0].args.slice(-2), ['--', 'ytsearch8:original fixture']);
  assert.ok(calls[1].args.includes('--no-playlist'));
  assert.equal(calls[1].args[calls[1].args.indexOf('--format') + 1], 'bestaudio[protocol=https]');
  assert.deepEqual(calls[1].args.slice(-2), ['--', track().url]);
  await assert.rejects(source.search(track().url, signal()), { code: 'input' });
  assert.equal(calls.length, 2);
});

test('search filters unsupported and duplicate results without concealing malformed provider output', async () => {
  const valid = { id: 'abcdefghijk', title: 'Original fixture', duration: 10 };
  let body = { entries: [valid, { ...valid, id: 'abcdefghijl', is_live: true },
    { ...valid, id: 'abcdefghijm', duration: 3601 }, valid] };
  const source = new YouTubeSource(tools, { capture: async () => JSON.stringify(body) });
  assert.deepEqual(await source.search('fixture', signal()), [parseTrack(valid)]);
  for (const invalid of [{}, { entries: [valid, null] }, [], null]) {
    body = invalid;
    await assert.rejects(source.search('fixture', signal()), { code: 'unavailable' });
  }
});

test('resolution never exposes malformed metadata or accepts a different selected video', async () => {
  const metadata = { id: 'abcdefghijk', title: 'Original fixture', duration: 60,
    availability: 'public', url: track().audioUrl };
  for (const [body, code, detail] of [
    ['{"title":"synthetic-private"', 'unavailable', /invalid metadata JSON/],
    [JSON.stringify({ ...metadata, url: 'https://untrusted.test/audio?token=synthetic-private' }), 'unavailable', /authorized HTTPS/],
    [JSON.stringify({ ...metadata, url: undefined }), 'unavailable', /did not return an audio URL/],
    [JSON.stringify({ ...metadata, age_limit: 18 }), 'unsupported', /policy/],
    [JSON.stringify({ ...metadata, availability: 'private' }), 'unsupported', /policy/],
    [JSON.stringify({ ...metadata, id: '12345678901' }), 'unsupported', /did not match/],
  ]) {
    const source = new YouTubeSource(tools, { capture: async () => body });
    await assert.rejects(source.resolve(track().url, signal()), error => {
      assert.equal(error.code, code);
      assert.match(error.detail, detail);
      assert.doesNotMatch(error.detail, /synthetic-private|https?:\/\//);
      return true;
    });
  }
});

test('metadata and readiness cannot publish a result after request cancellation', async () => {
  for (const operation of ['search', 'resolve', 'check']) {
    const controller = new AbortController();
    let calls = 0;
    const source = new YouTubeSource(tools, { capture: async () => {
      calls++;
      controller.abort();
      return 'v22.0.0';
    } });
    const pending = operation === 'search' ? source.search('fixture', controller.signal)
      : operation === 'resolve' ? source.resolve(track().url, controller.signal) : source.check(controller.signal);
    await assert.rejects(pending, { code: 'cancelled' });
    assert.equal(calls, 1);
    await assert.rejects(source.resolve(track().url, controller.signal), { code: 'cancelled' });
    assert.equal(calls, 1);
  }
});

test('preview refreshes public metadata and returns bounded ten-second Ogg Opus, not PCM', async () => {
  const calls = [];
  let resolved = 0;
  let metadata = { id: 'abcdefghijk', title: 'Original fixture', duration: 60, availability: 'public' };
  let bytes = ogg(500);
  const source = new YouTubeSource(tools, {
    capture: async (executable, args) => {
      if (executable === tools.node) return 'v22.0.0';
      if (executable === tools.ffmpeg) return args.includes('-version') ? 'ffmpeg version 8.0.1' : ' A....D libopus';
      if (args.includes('--version')) return '2026.08.19';
      return JSON.stringify({ ...metadata, url: `${track().audioUrl}?signature=${++resolved}` });
    },
    captureBytes: async (...args) => { calls.push(args); return bytes; },
  });
  for (let index = 1; index <= 2; index++) {
    const abortSignal = signal();
    assert.deepEqual(await source.preview('https://youtu.be/abcdefghijk', abortSignal), bytes);
    const [executable, args, receivedSignal, timeout, limit, options] = calls.at(-1);
    assert.equal(executable, tools.ffmpeg);
    assert.equal(receivedSignal, abortSignal);
    assert.equal(timeout, 20000);
    assert.equal(limit, LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES);
    assert.deepEqual(options, { rejectStderr: true });
    for (const [option, expected] of Object.entries({
      '-t': String(MUSIC_PREVIEW_DURATION_MS / 1000), '-frame_duration': '20', '-ar': '48000',
      '-ac': '2', '-c:a': 'libopus', '-f': 'ogg', '-protocol_whitelist': 'https,tls,tcp,crypto',
      '-i': `${track().audioUrl}?signature=${index}`,
    })) assert.equal(args[args.indexOf(option) + 1], expected);
    assert.ok(args.includes('-xerror'));
    assert.equal(args.some(value => /reconnect/.test(value)), false);
    assert.equal(args.at(-1), 'pipe:1');
  }
  bytes = ogg(6);
  await assert.rejects(source.preview(track().url, signal()), error =>
    error instanceof IncompleteAudioError && error.expectedDurationMs === 10000 && error.emittedDurationMs === 120);
  metadata.duration = 0.12;
  assert.deepEqual(await source.preview(track().url, signal()), bytes);
  metadata.availability = 'private';
  await assert.rejects(source.preview(track().url, signal()), { code: 'unsupported' });
  assert.equal(calls.length, 4);
  await assert.rejects(source.preview('http://localhost/private', signal()), { code: 'unsupported' });
});

test('incremental Ogg parsing returns the same complete 20 ms Opus packets across chunk boundaries', () => {
  const bytes = ogg(6);
  for (const size of [1, 9, 17, bytes.length]) {
    const parser = new OggOpusParser();
    const frames = [];
    for (let offset = 0; offset < bytes.length; offset += size) {
      frames.push(...parser.push(bytes.subarray(offset, offset + size)));
    }
    parser.finish();
    assert.deepEqual(frames, Array.from({ length: 6 }, () => Buffer.from([0xf8, 0xff, 0xfe])));
  }
  const packet = Buffer.alloc(300, 0);
  packet[0] = 0xf8;
  const parser = new OggOpusParser();
  assert.deepEqual(parser.push(Buffer.concat([
    ...headers(), page(2, 0, [255], packet.subarray(0, 255)), page(3, 5, [45], packet.subarray(255)),
  ])), [packet]);
  parser.finish();
});

test('Ogg parsing rejects truncation, sequence/serial changes, oversized and non-20ms streams', () => {
  const invalidStreams = [
    ogg().subarray(0, -1), ogg(6, false), Buffer.concat([ogg(), ogg()]),
    Buffer.concat([...headers(), page(3, 4, [3], Buffer.from([0xf8, 0xff, 0xfe]))]),
    Buffer.concat([...headers(), page(2, 4, [3], Buffer.from([0xf8, 0xff, 0xfe]), 8)]),
    Buffer.concat([...headers(), page(2, 5, [3], Buffer.from([0xf8, 0xff, 0xfe]))]),
    Buffer.concat([...headers(), page(2, 4, [3], Buffer.from([0xf0, 0xff, 0xfe]))]),
    Buffer.concat([...headers(), page(2, 4, [255, 255, 255, 255, 255, 1], Buffer.alloc(1276, 0xf8))]),
    Buffer.alloc(256 * 1024 + 1),
  ];
  const [head, tags] = headers();
  head[28 + 8] = 2;
  invalidStreams.push(Buffer.concat([head, tags, page(2, 4, [3], Buffer.from([0xf8, 0xff, 0xfe]))]));
  for (const bytes of invalidStreams) {
    assert.throws(() => {
      const parser = new OggOpusParser();
      parser.push(bytes);
      parser.finish();
    }, { code: 'unavailable' });
  }
});

test('shared errors retain subclass identity and typed recovery details through a consumer alias', () => {
  const MusicError = MediaError;
  const recovery = new SourceRecoveryError();
  assert.ok(recovery instanceof MusicError);
  assert.equal(recovery.code, 'recovery_failed');
  assert.equal(recovery.attempts, SOURCE_RECOVERY_FAILURE_LIMIT);
  assert.ok(new IncompleteAudioError(10000, 120) instanceof MusicError);
  assert.ok(new MediaToolError('node', tools.node, 'runtime', 'unsupported') instanceof MusicError);
  assert.equal(new MusicError('full').code, 'full');
});
