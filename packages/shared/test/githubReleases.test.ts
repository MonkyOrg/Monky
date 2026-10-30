import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MONKY_RELEASE_HOSTS, TrustedFetchError, compareReleaseVersions, fetchTrusted, isPrereleaseVersion,
  parseSha256Manifest, pickNewestRelease, readLimitedText,
} from '../src/githubReleases.js';

test('release versions follow SemVer and a positive result always means the first one is newer', () => {
  const ascending = [
    '1.0.0-build.2', '1.0.0-build.3', '1.0.0', '2.4.0-beta.2', '2.4.0-beta.9', '2.4.0-beta.15', '2.4.0',
    '3.0.0-beta001', '3.0.0-beta009', '3.0.0-beta010', '3.0.0', '3.1.1-beta001', '3.1.2-beta', '3.1.2', '10.0.1-beta', '10.0.1',
  ];
  for (let index = 1; index < ascending.length; index++) {
    const older = ascending[index - 1];
    const newer = ascending[index];
    assert.ok(compareReleaseVersions(newer, older) > 0, `${newer} > ${older}`);
    assert.ok(compareReleaseVersions(older, newer) < 0, `${older} < ${newer}`);
  }
  assert.equal(compareReleaseVersions('v3.0.0-beta007', '3.0.0-beta007'), 0, 'the tag prefix is ignored');
  assert.equal(compareReleaseVersions('2.0.0+build-a', '2.0.0+build-b'), 0, 'build metadata is ignored');
  assert.ok(compareReleaseVersions('2.4.0-beta016', '2.4.0-beta.15') > 0);
  assert.ok(compareReleaseVersions('2.0.0-alpha-2', '2.0.0-alpha-1') > 0);
  assert.ok(compareReleaseVersions('2.0.0-Beta', '2.0.0-alpha') < 0, 'alphanumeric identifiers compare in ASCII order');
  assert.ok(compareReleaseVersions('2.0.0-1', '2.0.0-alpha') < 0, 'numeric identifiers rank below alphanumeric ones');
  assert.ok(compareReleaseVersions('2.0.0-beta.1.1', '2.0.0-beta.1') > 0, 'more identifiers rank higher');
  assert.ok(compareReleaseVersions('2.0.0-9007199254740993', '2.0.0-9007199254740992') > 0, 'numbers beyond 2^53 keep their order');
  assert.ok(compareReleaseVersions('12345678901234567890.0.0', '9.0.0') > 0);
  assert.equal(isPrereleaseVersion('3.1.2-beta'), true);
  assert.equal(isPrereleaseVersion('v3.1.2'), false);
  assert.equal(isPrereleaseVersion('3.1.2+build-1'), false);
});

test('the newest release is chosen by version, skipping drafts and untagged entries', () => {
  const listing = [{ tag_name: 'v2.4.0-beta.9' }, { tag_name: 'v2.4.0-beta.15' }, { tag_name: 'v2.4.0-beta.14' }];
  assert.equal(pickNewestRelease(listing)?.tag_name, 'v2.4.0-beta.15');
  assert.equal(pickNewestRelease([{ tag_name: 'v9.9.9', draft: true }, { tag_name: 'v3.0.0' }])?.tag_name, 'v3.0.0');
  assert.equal(pickNewestRelease([{ tag_name: 'v3.0.0-beta005' }, { tag_name: 'v3.0.0' }])?.tag_name, 'v3.0.0');
  assert.equal(pickNewestRelease([null, { draft: false }, { tag_name: '' }]), null);
  assert.equal(pickNewestRelease([]), null);
});

test('SHA-256 manifests yield one digest per name and refuse ambiguity', () => {
  const digest = 'A'.repeat(64);
  assert.equal(parseSha256Manifest(`${digest}  monky.tgz\n`, 'monky.tgz'), 'a'.repeat(64));
  assert.equal(parseSha256Manifest(`${'b'.repeat(64)} *./monky.tgz\r\n`, 'monky.tgz'), 'b'.repeat(64));
  assert.equal(parseSha256Manifest(`${'c'.repeat(64)}  other.tgz\n`, 'monky.tgz'), null);
  assert.equal(parseSha256Manifest(`${'c'.repeat(64)}  monky.tgz\n${'d'.repeat(64)}  monky.tgz\n`, 'monky.tgz'), null);
  assert.equal(parseSha256Manifest(`${'e'.repeat(63)}  monky.tgz\n`, 'monky.tgz'), null);
});

test('trusted downloads check every hop before requesting it and stop after five redirects', async () => {
  const calls: string[] = [];
  const hop = (location: string | null): Response => new Response(null, {
    status: 302, headers: location === null ? {} : { location },
  });
  const request = (responses: (() => Response)[]): typeof fetch => async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, 'manual');
    return responses[calls.length - 1]();
  };
  const fetchRelease = (responses: (() => Response)[]) => {
    calls.length = 0;
    return fetchTrusted('https://github.com/MonkyOrg/Monky/releases/download/v1.0.0/a.tgz', {
      hosts: MONKY_RELEASE_HOSTS, request: request(responses),
    });
  };
  const failure = (name: string, status?: number) => (error: unknown) =>
    error instanceof TrustedFetchError && error.failure === name && error.status === status;

  const response = await fetchRelease([() => hop('https://release-assets.githubusercontent.com/a'), () => new Response('ok')]);
  assert.equal(await response.text(), 'ok');
  assert.deepEqual(calls, ['https://github.com/MonkyOrg/Monky/releases/download/v1.0.0/a.tgz', 'https://release-assets.githubusercontent.com/a']);

  for (const location of ['https://attacker.invalid/a', 'http://github.com/a', 'https://github.com:8443/a',
    'https://user:pass@github.com/a', 'https://github.com/a#fragment', 'http://[']) {
    await assert.rejects(fetchRelease([() => hop(location)]), failure('untrusted'), location);
    assert.equal(calls.length, 1, `${location} is never requested`);
  }
  await assert.rejects(fetchRelease([() => hop(null)]), failure('redirect-missing'));
  await assert.rejects(fetchRelease(Array.from({ length: 7 }, () => () => hop('/again'))), failure('redirects'));
  assert.equal(calls.length, 6, 'the initial request plus five redirects');
  await assert.rejects(fetchRelease([() => new Response('missing', { status: 404 })]), failure('http', 404));
  await assert.rejects(fetchRelease([() => new Response(null, { status: 200 })]), failure('http', 200));
  await assert.rejects(fetchTrusted('https://example.com/a', { hosts: MONKY_RELEASE_HOSTS, request: request([]) }),
    failure('untrusted'));

  calls.length = 0;
  const head = await fetchTrusted('https://github.com/a', {
    hosts: MONKY_RELEASE_HOSTS, method: 'HEAD',
    request: async (url, init) => {
      calls.push(String(url));
      assert.equal(init?.method, 'HEAD');
      return new Response(null, { status: 200, headers: { 'content-length': '5' } });
    },
  });
  assert.equal(head.headers.get('content-length'), '5');

  const cancelled = new AbortController();
  cancelled.abort(new Error('stopped'));
  calls.length = 0;
  await assert.rejects(fetchTrusted('https://github.com/a', {
    hosts: MONKY_RELEASE_HOSTS, signal: cancelled.signal, request: request([]),
  }), /stopped/);
  assert.equal(calls.length, 0);
});

test('bounded reads return the text and refuse a body past the limit', async () => {
  assert.equal(await readLimitedText(new Response('olá'), 4), 'olá');
  await assert.rejects(readLimitedText(new Response('olá!'), 4), (error: unknown) =>
    error instanceof TrustedFetchError && error.failure === 'too-large');
  assert.equal(await readLimitedText(new Response(null), 4), '');
  const cancelled = new AbortController();
  cancelled.abort(new Error('stopped'));
  await assert.rejects(readLimitedText(new Response('text'), 100, cancelled.signal), /stopped/);
});
