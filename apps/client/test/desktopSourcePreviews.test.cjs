'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const shared = require('@monky/shared');
const filename = path.resolve(__dirname, '..', 'src', 'main', 'desktopSourcePreviews.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const loaded = { exports: {} };
vm.runInThisContext(`(function(module, exports) { ${compiled}\n})`, { filename })(loaded, loaded.exports);
const { DesktopSourcePreviews } = loaded.exports;
const source = (id = 'window:1:identity', type = 'window') => ({
  id, type, name: 'Owned synthetic source', thumbnailDataUrl: 'data:image/png;base64,cHJldmlldw==', appIconDataUrl: null,
});
const request = (...sourceIds) => ({ type: 'window', sourceIds });
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

test('preview IPC validates bounded unique identities and rejects unknown options', () => {
  assert.deepEqual(shared.desktopSourcesOptionsSchema.parse({ metadataOnly: true, refresh: true }),
    { metadataOnly: true, refresh: true });
  for (const invalid of [null, true, { metadataOnly: 'true' }, { unknown: true }])
    assert.equal(shared.desktopSourcesOptionsSchema.safeParse(invalid).success, false);
  assert.ok(shared.desktopSourcePreviewsRequestSchema.safeParse(request('window:1:identity')).success);
  for (const invalid of [null, { type: 'game', sourceIds: [] }, request('same', 'same'),
    request(''), request('x'.repeat(513)), request(...Array.from({ length: 257 }, (_, i) => `window:${i}:identity`)),
    { ...request('window:1:identity'), extra: true }])
    assert.equal(shared.desktopSourcePreviewsRequestSchema.safeParse(invalid).success, false);
});

test('cold load coalesces requests, cache returns copies and expires after ten seconds', async () => {
  const job = deferred(), a = source(), b = source('window:2:identity');
  let now = 100, calls = 0;
  const previews = new DesktopSourcePreviews(async () => { calls++; return job.promise; }, () => now);
  const first = previews.get(request(a.id)), second = previews.get(request(b.id));
  assert.equal(calls, 1);
  job.resolve([a, b]);
  assert.equal((await first)[0].id, a.id);
  assert.equal((await second)[0].id, b.id);
  const cached = await previews.get(request(a.id));
  cached[0].thumbnailDataUrl = 'modified';
  assert.equal(previews.cached(a.id).thumbnailDataUrl, a.thumbnailDataUrl);
  assert.equal(calls, 1);
  now += 10_000;
  assert.equal(previews.cached(a.id), undefined);
  await previews.get(request(a.id));
  assert.equal(calls, 2);
});

test('screens and windows load independently and absent identities are never substituted', async () => {
  const windows = deferred(), screens = deferred(), a = source(), b = source('native-monitor:one', 'screen');
  const previews = new DesktopSourcePreviews(type => type === 'window' ? windows.promise : screens.promise);
  const windowResult = previews.get(request(a.id, 'window:999:reused'));
  const screenResult = previews.get({ type: 'screen', sourceIds: [b.id] });
  screens.resolve([b]);
  assert.equal((await screenResult)[0].id, b.id);
  assert.equal(previews.cached(a.id), undefined);
  windows.resolve([a]);
  assert.deepEqual((await windowResult).map(row => row.id), [a.id]);
});

test('refresh clears cache and an older in-flight result cannot repopulate it', async () => {
  let calls = 0;
  const job = deferred(), a = source();
  const previews = new DesktopSourcePreviews(async () => { calls++; return job.promise; });
  const pending = previews.get(request(a.id));
  previews.clear();
  job.resolve([a]);
  await pending;
  assert.equal(previews.cached(a.id), undefined);
  await previews.get(request(a.id));
  assert.equal(calls, 2);
  previews.clear();
  assert.equal(previews.cached(a.id), undefined);
});

test('failed previews reject explicitly and a retry can load them', async () => {
  let calls = 0;
  const a = source();
  const previews = new DesktopSourcePreviews(async () => {
    if (++calls === 1) throw new Error('Capture unavailable');
    return [a];
  });
  await assert.rejects(previews.get(request(a.id)), /Capture unavailable/);
  assert.equal(previews.cached(a.id), undefined);
  assert.equal((await previews.get(request(a.id)))[0].id, a.id);
});

test('unavailable previews remain retryable, entry count and image bytes stay bounded', async () => {
  const sources = Array.from({ length: 300 }, (_, i) => source(`window:${i}:identity`));
  sources.push({ ...source('window:big:identity'), thumbnailDataUrl: 'x'.repeat(4 * 1024 * 1024) });
  const previews = new DesktopSourcePreviews(async () => sources);
  await previews.get(request(sources[0].id));
  assert.equal(previews.cached(sources[0].id), undefined);
  assert.ok(previews.cached(sources[299].id));
  assert.equal(previews.cached(sources[300].id), undefined);
  let calls = 0;
  const unavailable = new DesktopSourcePreviews(async () => { calls++; return [{ ...source(), thumbnailDataUrl: '' }]; });
  await unavailable.get(request(source().id));
  assert.equal((await unavailable.get(request(source().id)))[0].thumbnailDataUrl, '');
  assert.equal(calls, 2);
  assert.deepEqual(await unavailable.get(request()), []);
  assert.equal(calls, 2);
});

test('timeout does not launch overlapping replacement captures for an unfinished native request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const job = deferred(), a = source();
  const previews = new DesktopSourcePreviews(async () => { calls++; return job.promise; });
  const timed = assert.rejects(previews.get(request(a.id)), /timed out/);
  t.mock.timers.tick(15_000);
  await timed;
  const retry = previews.get(request(a.id));
  assert.equal(calls, 1);
  job.resolve([a]);
  assert.equal((await retry)[0].id, a.id);
});
