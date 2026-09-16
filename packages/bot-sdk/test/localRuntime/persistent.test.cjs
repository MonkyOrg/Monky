const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { test } = require('node:test');
const {
  YouTubeSource, audioUrl, createPersistentInput, SourceRecoveryError, SOURCE_RECOVERY_FAILURE_LIMIT,
} = require('../../dist/localRuntime');
const { tools, signal, track, ogg, decoder, relay, consume, server, range, send, read, quickRetries, until } = require('./fixtures.cjs');

test('persistent playback retains one decoder and exactly the same Opus packets through seven interruptions', { timeout: 10000 }, async t => {
  quickRetries(t, () => {}, 50);
  t.mock.method(console, 'warn', () => {});
  const bytes = ogg(2000);
  let cuts = 0;
  const fixture = await server(t, (request, response) => {
    const { start } = range(request, bytes);
    send(request, response, bytes, { cut: cuts-- > 0 ? start + 4096 : bytes.length });
  });
  const children = decoder(t, relay);
  const source = new YouTubeSource(tools, { request: fixture.request });
  const options = { mode: 'persistent', progress: 'playback' };
  const baselineStream = await source.open(track(40), signal(), options);
  const baseline = await consume(baselineStream, () => baselineStream.markFrameAdvanced());
  const firstRequests = fixture.requests.length;
  cuts = 7;
  const resumedStream = await source.open(track(40), signal(), options);
  const resumed = await consume(resumedStream, () => resumedStream.markFrameAdvanced());
  assert.deepEqual(resumed, baseline);
  assert.equal(resumed.length, 2000);
  assert.equal(children.length, 2, 'Recovering HTTP must not replace the decoder or restart the track.');
  const resumes = fixture.requests.slice(firstRequests + 1);
  assert.equal(resumes.length, 7);
  assert.ok(resumes.every(request => request.ifRange === '"synthetic-v1"'));
  for (const { args } of children) {
    assert.equal(args[args.indexOf('-rw_timeout') + 1], '0');
    assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,tcp');
    assert.equal(args.some(value => /reconnect/.test(value)), false);
    await assert.rejects(read(args[args.indexOf('-i') + 1]), { code: 'ECONNREFUSED' });
  }
});

test('persistent input resumes exactly after forwarded bytes, not after merely received data', async t => {
  quickRetries(t);
  t.mock.method(console, 'warn', () => {});
  const bytes = ogg(1000);
  let cuts = 5, forwarded = 0;
  const positions = [];
  const fixture = await server(t, (request, response) => {
    const { start } = range(request, bytes);
    send(request, response, bytes, { cut: cuts-- > 0 ? start + 4096 : bytes.length });
  });
  const input = await createPersistentInput(track().audioUrl, signal(), audioUrl, (url, headers, abortSignal) => {
    const position = Number(/^bytes=(\d+)-/.exec(headers.Range)[1]);
    positions.push(position);
    assert.equal(position, forwarded);
    return fixture.request(url, headers, abortSignal);
  });
  t.after(() => input.close());
  assert.deepEqual((await read(input.url, {}, undefined, chunk => { forwarded += chunk.length; })).bytes, bytes);
  assert.equal(positions.length, 6);
  assert.ok(positions.slice(1).every((position, index) => position > positions[index]));
  assert.equal(input.failure, undefined);
});

test('closed ranges and complete partial segments remain seekable without an EOF loop', async t => {
  const bytes = ogg(50);
  const fixture = await server(t, (request, response) => {
    const { start } = range(request, bytes);
    send(request, response, bytes, { segmentEnd: Math.min(start + 499, bytes.length - 1) });
  });
  const input = await createPersistentInput(track().audioUrl, signal(), audioUrl, fixture.request);
  t.after(() => input.close());
  const result = await read(input.url, { Range: 'bytes=0-99999' });
  assert.equal(result.status, 206);
  assert.equal(result.headers['content-range'], `bytes 0-${bytes.length - 1}/${bytes.length}`);
  assert.deepEqual(result.bytes, bytes);
  assert.equal(fixture.requests.length, Math.ceil(bytes.length / 500));
  assert.deepEqual((await read(input.url, { Range: 'bytes=100-199' })).bytes, bytes.subarray(100, 200));
  assert.equal((await read(input.url, { Range: `bytes=${bytes.length}-` })).status, 416);
  const count = fixture.requests.length;
  assert.equal((await read(`${input.url}/other`)).status, 404);
  for (const range of ['bytes=1-2,4-5', 'bytes=9-2', 'bytes=9007199254740992-']) {
    assert.equal((await read(input.url, { Range: range })).status, 416);
  }
  assert.equal(fixture.requests.length, count);
});

test('an initial HTTP 200 with Accept-Ranges preserves later nonzero seeks', async t => {
  const bytes = ogg(50);
  const fixture = await server(t, (request, response) => {
    if (range(request, bytes).start !== 0) { send(request, response, bytes); return; }
    response.writeHead(200, {
      'Content-Length': bytes.length, 'Accept-Ranges': 'bytes', ETag: '"synthetic-v1"', Connection: 'close',
    }).end(bytes);
  });
  const input = await createPersistentInput(track().audioUrl, signal(), audioUrl, fixture.request);
  t.after(() => input.close());
  const first = await read(input.url);
  assert.equal(first.headers['accept-ranges'], 'bytes');
  assert.deepEqual(first.bytes, bytes);
  assert.deepEqual((await read(input.url, { Range: 'bytes=100-' })).bytes, bytes.subarray(100));
  assert.equal(fixture.requests[1].ifRange, '"synthetic-v1"');
});

for (const kind of ['ignored range', 'changed entity', 'mismatched range', 'HTTP 403', 'encoded response']) {
  test(`persistent input keeps ${kind} terminal rather than retrying or mixing resources`, async t => {
    quickRetries(t);
    t.mock.method(console, 'warn', () => {});
    const bytes = ogg(500);
    let count = 0;
    const fixture = await server(t, (request, response) => {
      count++;
      if (kind === 'HTTP 403') { response.writeHead(403, { Connection: 'close' }).end(); return; }
      if (kind === 'encoded response') {
        response.writeHead(200, { 'Content-Encoding': 'gzip', Connection: 'close' }).end(bytes);
      } else if (kind === 'ignored range') {
        response.writeHead(200, { 'Content-Length': bytes.length, Connection: 'close' })
          .end(count === 1 ? bytes.subarray(0, 4096) : bytes);
      } else if (kind === 'changed entity') {
        send(request, response, bytes, { cut: count === 1 ? 4096 : bytes.length,
          etag: count === 1 ? '"first"' : '"different"' });
      } else {
        const { start } = range(request, bytes);
        response.writeHead(206, { 'Content-Range': `bytes ${start + 1}-${bytes.length - 1}/${bytes.length}`, Connection: 'close' })
          .end(bytes.subarray(start + 1));
      }
    });
    const input = await createPersistentInput(track().audioUrl, signal(), audioUrl, fixture.request);
    t.after(() => input.close());
    await assert.rejects(read(input.url));
    assert.equal(input.failure.code, 'unavailable');
    assert.equal(input.failure instanceof SourceRecoveryError, false);
    const expected = {
      'ignored range': /refused byte-range resume/, 'changed entity': /changed while resuming/,
      'mismatched range': /mismatched byte range/, 'HTTP 403': /HTTP 403/,
      'encoded response': /unsupported content encoding/,
    };
    assert.match(input.failure.detail, expected[kind]);
    assert.ok(count <= 2);
  });
}

test('redirects are revalidated before requesting another resource and TLS failures are terminal', async t => {
  const fixture = await server(t, (_request, response) => {
    response.writeHead(302, { Location: 'https://untrusted.test/not-a-public-source', Connection: 'close' }).end();
  });
  const input = await createPersistentInput(track().audioUrl, signal(), audioUrl, fixture.request);
  t.after(() => input.close());
  await assert.rejects(read(input.url));
  assert.equal(input.failure.code, 'unavailable');
  assert.equal(fixture.requests.length, 1);
  let calls = 0;
  const tls = await createPersistentInput(track().audioUrl, signal(), audioUrl, async () => {
    calls++;
    throw Object.assign(new Error('Certificate validation failed.'), { code: 'CERT_HAS_EXPIRED' });
  });
  t.after(() => tls.close());
  await assert.rejects(read(tls.url));
  assert.match(tls.failure.detail, /Certificate validation/);
  assert.equal(calls, 1);
});

test('recoverable diagnostics remain bounded and sanitized without logging every retry', async t => {
  quickRetries(t);
  const logs = t.mock.method(console, 'warn', () => {});
  const bytes = ogg();
  const fixture = await server(t, (request, response) => send(request, response, bytes));
  let requests = 0;
  const input = await createPersistentInput(track().audioUrl, signal(), audioUrl, async (...args) => {
    if (++requests <= 2) {
      throw Object.assign(new Error('Temporary failure https://private.test/?signature=synthetic-private'), { code: 'ECONNRESET' });
    }
    return fixture.request(...args);
  });
  t.after(() => input.close());
  assert.deepEqual((await read(input.url)).bytes, bytes);
  assert.equal(requests, 3);
  assert.equal(logs.mock.callCount(), 1);
  assert.match(logs.mock.calls[0].arguments[0], /Source transport interrupted.*byte=0/);
  assert.doesNotMatch(logs.mock.calls[0].arguments[0], /private\.test|synthetic-private|signature/);
});

for (const responseKind of ['unavailable', 'headers and bytes']) {
  test(`five recovery attempts without consumed audio fail after ${responseKind}`, async t => {
    quickRetries(t);
    t.mock.method(console, 'warn', () => {});
    const bytes = ogg(2000);
    const fixture = await server(t, (request, response) => {
      if (responseKind === 'unavailable') response.writeHead(503, { Connection: 'close' }).end();
      else send(request, response, bytes, { cut: range(request, bytes).start + 4096 });
    });
    const input = await createPersistentInput(track().audioUrl, signal(), audioUrl, fixture.request);
    t.after(() => input.close());
    await assert.rejects(read(input.url));
    assert.ok(input.failure instanceof SourceRecoveryError);
    assert.equal(input.failure.attempts, SOURCE_RECOVERY_FAILURE_LIMIT);
    assert.equal(fixture.requests.length, 1 + SOURCE_RECOVERY_FAILURE_LIMIT);
    if (responseKind === 'headers and bytes') {
      assert.ok(fixture.requests.some(request => Number(/^bytes=(\d+)-/.exec(request.range)[1]) > 0));
    }
  });
}

test('acknowledged audio resets consecutive failures rather than imposing a per-song retry cap', async t => {
  t.mock.method(console, 'warn', () => {});
  let input;
  quickRetries(t, waits => { if (waits === 5) input.markAudioProgress(); });
  const bytes = ogg();
  let requests = 0;
  const fixture = await server(t, (request, response) => {
    if (++requests < 10) response.writeHead(503, { Connection: 'close' }).end();
    else send(request, response, bytes);
  });
  input = await createPersistentInput(track().audioUrl, signal(), audioUrl, fixture.request);
  t.after(() => input.close());
  assert.deepEqual((await read(input.url)).bytes, bytes);
  assert.equal(requests, 10);
  assert.equal(input.failure, undefined);
});

test('pause freezes consecutive recovery failures without erasing the failures before it', async t => {
  t.mock.method(console, 'warn', () => {});
  let input;
  quickRetries(t, waits => {
    if (waits === 5) input.setPaused(true);
    if (waits === 10) input.setPaused(false);
  });
  const fixture = await server(t, (_request, response) => response.writeHead(503, { Connection: 'close' }).end());
  input = await createPersistentInput(track().audioUrl, signal(), audioUrl, fixture.request);
  t.after(() => input.close());
  await assert.rejects(read(input.url));
  assert.ok(input.failure instanceof SourceRecoveryError);
  assert.equal(input.failure.attempts, 5);
  assert.equal(fixture.requests.length, 11);
});

test('cancellation aborts pending recovery and removes its server/listeners without inventing exhaustion', async t => {
  t.mock.method(console, 'warn', () => {});
  const controller = new AbortController();
  quickRetries(t, waits => { if (waits === 3) controller.abort(); });
  const fixture = await server(t, (_request, response) => response.writeHead(503, { Connection: 'close' }).end());
  const input = await createPersistentInput(track().audioUrl, controller.signal, audioUrl, fixture.request);
  t.after(() => input.close());
  await assert.rejects(read(input.url));
  assert.equal(input.failure, undefined);
  await input.close();
  assert.equal(fixture.requests.length, 3);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  await assert.rejects(read(input.url), { code: 'ECONNREFUSED' });
});

test('persistent cancellation closes the source before its first frame is consumed', async t => {
  quickRetries(t);
  t.mock.method(console, 'warn', () => {});
  const fixture = await server(t, (_request, response) => response.writeHead(503, { Connection: 'close' }).end());
  const children = decoder(t, relay);
  const controller = new AbortController();
  const stream = await new YouTubeSource(tools, { request: fixture.request })
    .open(track(), controller.signal, { mode: 'persistent', progress: 'playback' });
  t.after(() => stream.close());
  await until(() => fixture.requests.length > 0);
  controller.abort();
  await until(() => children[0].child.exitCode !== null || children[0].child.signalCode !== null);
  await stream.close();
  await assert.rejects(read(children[0].args[children[0].args.indexOf('-i') + 1]), { code: 'ECONNREFUSED' });
  await assert.rejects(stream.frames[Symbol.asyncIterator]().next(), { code: 'cancelled' });
});

test('a bounded stalled body read is aborted and resumed at its forwarded byte offset', async t => {
  quickRetries(t);
  t.mock.method(console, 'warn', () => {});
  const originalTimeout = global.setTimeout;
  let expired = 0;
  t.mock.method(global, 'setTimeout', (callback, ms, ...args) => ms === 15000
    ? originalTimeout(() => { expired++; callback(...args); }, 100)
    : originalTimeout(callback, ms, ...args));
  const bytes = ogg(1000);
  let requests = 0;
  const fixture = await server(t, (request, response) => {
    if (++requests > 1) { send(request, response, bytes); return; }
    response.writeHead(206, { 'Content-Length': bytes.length,
      'Content-Range': `bytes 0-${bytes.length - 1}/${bytes.length}`, ETag: '"synthetic-v1"', Connection: 'close' });
    response.write(bytes.subarray(0, 4096));
  });
  const input = await createPersistentInput(track().audioUrl, signal(), audioUrl, fixture.request);
  t.after(() => input.close());
  assert.deepEqual((await read(input.url)).bytes, bytes);
  assert.ok(expired >= 1);
  assert.equal(fixture.requests.length, 2);
  assert.equal(fixture.requests[1].range, `bytes=4096-${bytes.length - 1}`);
  assert.equal(input.failure, undefined);
});
