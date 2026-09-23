import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchVersionReleaseNotes } from '../src/main/releaseNotes';
import { parseClientReleaseNotes } from '../src/renderer/utils/clientReleaseNotes';

const note = { 'pt-BR': 'Copie sua versão com um clique!', en: 'Copy your version with a click!' };
const payload = { schemaVersion: 1, groups: { novidades: [note], correcoes: [], outros: [] } };
const wrap = (value: unknown): string => `<!-- monky-client-notes:v1\n${JSON.stringify(value)}\n-->`;
const technical = '### Changelog\n#### ✨ Novidades\n- #617: feat(ui): bind navigator.clipboard.writeText\n';

test('client notes select the explicit bilingual payload, never technical commit subjects', () => {
  assert.deepEqual(parseClientReleaseNotes(`${wrap(payload)}\n${technical}`), { kind: 'curated', groups: payload.groups });
  assert.deepEqual(parseClientReleaseNotes(wrap(payload).replace(/\n/g, '\r\n')), { kind: 'curated', groups: payload.groups });
  assert.deepEqual(parseClientReleaseNotes(wrap({ ...payload, groups: { novidades: [], correcoes: [], outros: [] } }) + technical),
    { kind: 'empty' }, 'an explicit empty payload must not be filled with raw commits');
});

test('malformed, oversized, unlocalized or technical payloads fail closed', () => {
  const invalid = [
    wrap(null), wrap([]), wrap({ ...payload, schemaVersion: 2 }),
    wrap({ ...payload, groups: { novidades: [note] } }),
    wrap({ ...payload, groups: { ...payload.groups, private: [note] } }),
    wrap({ ...payload, groups: { ...payload.groups, novidades: [{ 'pt-BR': note['pt-BR'] }] } }),
    wrap({ ...payload, groups: { ...payload.groups, novidades: [{ ...note, en: '<img src=x onerror=boom()>' }] } }),
    wrap({ ...payload, groups: { ...payload.groups, novidades: [{ ...note, en: 'Fix #617: `clipboard`' }] } }),
    wrap({ ...payload, groups: { ...payload.groups, novidades: [{ ...note, en: 'x'.repeat(281) }] } }),
    wrap({ ...payload, groups: { ...payload.groups, novidades: Array.from({ length: 101 }, () => note) } }),
    '<!-- monky-client-notes:v1\n{bad}\n-->',
    wrap(payload).replace('v1', 'v2'),
    wrap(payload).replace('-->', ''),
    wrap(payload) + wrap(payload),
    'x'.repeat(200_001),
  ];
  for (const body of invalid) assert.deepEqual(parseClientReleaseNotes(body + technical), { kind: 'invalid' });
});

test('published releases get honest grouped counts, not untranslated prose or download boilerplate', () => {
  const legacy = [
    '### Downloads', '- monky.exe', technical,
    '#### 🐛 Correções', '- #5: fix SDP', '- #6: fix ICE', '- #6: fix ICE',
    '  - nested implementation detail', '#### 🔧 Outros', '- refactor(network): internals',
    '```js', '- fake code item', '```',
    '**Comparação completa**: https://github.com/MonkyOrg/Monky/compare/v1...v2',
    '### Contributors', '- another unrelated bullet',
  ].join('\n');
  assert.deepEqual(parseClientReleaseNotes(legacy),
    { kind: 'legacy', counts: { novidades: 1, correcoes: 2, outros: 1 } });
  assert.deepEqual(parseClientReleaseNotes('### Changelog\n- Old ungrouped note'),
    { kind: 'legacy', counts: { novidades: 0, correcoes: 0, outros: 1 } });
  assert.deepEqual(parseClientReleaseNotes('### Downloads\n- app.exe'), { kind: 'empty' });
  assert.deepEqual(parseClientReleaseNotes('### Changelog\n#### ✨ Novidades'), { kind: 'empty' });
  assert.deepEqual(parseClientReleaseNotes('### Changelog\n#### Other changes\n- Something recorded'),
    { kind: 'legacy', counts: { novidades: 0, correcoes: 0, outros: 1 } });
});

test('GitHub retrieval uses installed tag, including beta, and canonical page URL', async (context) => {
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  context.mock.method(globalThis, 'fetch', async (input: string | URL | Request, options?: RequestInit) => {
    requests.push({ url: String(input), options });
    return new Response(JSON.stringify({ tag_name: 'v8.2.8-beta', body: wrap(payload), html_url: 'https://example.com/untrusted' }));
  });
  const result = await fetchVersionReleaseNotes('8.2.8-beta');
  assert.equal(result.ok, true);
  assert.equal(result.version, '8.2.8-beta');
  assert.equal(result.url, 'https://github.com/MonkyOrg/Monky/releases/tag/v8.2.8-beta');
  assert.equal(requests[0].url, 'https://api.github.com/repos/MonkyOrg/Monky/releases/tags/v8.2.8-beta');
  assert.ok(requests[0].options?.signal instanceof AbortSignal, 'network wait is bounded');
  assert.deepEqual(requests[0].options?.headers, { Accept: 'application/vnd.github+json', 'User-Agent': 'Monky-App' });
  await fetchVersionReleaseNotes('1.0.0', '8.2.8-beta');
  assert.equal(requests[1].url, requests[0].url, 'explicit tags retain existing IPC semantics');
});

test('retrieval validates tags before I/O and distinguishes HTTP, content and network failures', async (context) => {
  let calls = 0;
  let reply: Response | Error = new Response('', { status: 404 });
  context.mock.method(globalThis, 'fetch', async () => {
    calls++;
    if (reply instanceof Error) throw reply;
    return reply;
  });
  for (const tag of ['../../latest', 'https://example.com', '-bad', 'v1.0.0?anything']) {
    assert.equal((await fetchVersionReleaseNotes('1.0.0', tag)).ok, false);
  }
  assert.equal(calls, 0);
  const missing = await fetchVersionReleaseNotes('8.2.8-beta');
  assert.equal(missing.ok, false);
  assert.equal(missing.error, 'HTTP 404');
  assert.equal(missing.version, '8.2.8-beta');
  assert.ok(missing.url?.endsWith('/tag/v8.2.8-beta'), 'errors still link to the requested version');
  reply = new Response('', { status: 429 });
  assert.equal((await fetchVersionReleaseNotes('1.0.0')).error, 'HTTP 429');
  for (const body of [null, [], { tag_name: 'v2.0.0', body: 'wrong version' },
    { tag_name: 'v1.0.0', body: 42 }, { tag_name: 'v1.0.0', body: 'x'.repeat(200_001) }]) {
    reply = new Response(JSON.stringify(body));
    assert.equal((await fetchVersionReleaseNotes('1.0.0')).ok, false);
  }
  reply = new Response(JSON.stringify({ tag_name: 'v1.0.0', body: null }));
  assert.deepEqual(await fetchVersionReleaseNotes('1.0.0'), {
    ok: true, version: '1.0.0', body: '', url: 'https://github.com/MonkyOrg/Monky/releases/tag/v1.0.0',
  });
  reply = new Response('not JSON');
  assert.equal((await fetchVersionReleaseNotes('1.0.0')).ok, false);
  reply = new Error('offline');
  assert.equal((await fetchVersionReleaseNotes('1.0.0')).error, 'offline');
});
