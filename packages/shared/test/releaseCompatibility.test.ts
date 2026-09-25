import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchReleaseCompatibility,
  isReleaseVersion,
  parseBotCompatibility,
  parseReleaseCompatibility,
  releaseRequiresProtocolUpdate,
} from '../src/releaseCompatibility.js';

const version = '18.0.0-beta';
const manifest = { schemaVersion: 1, version, protocolVersion: 16, botSdkVersion: version } as const;

test('release warnings follow the affected protocol floor, not every additive bump', () => {
  const additive = parseReleaseCompatibility({ ...manifest, protocolVersion: 28, minimumClientProtocol: 27, minimumBotProtocol: 24 }, version);
  assert.ok(additive);
  assert.equal(releaseRequiresProtocolUpdate(additive, 'client'), false);
  assert.equal(releaseRequiresProtocolUpdate(additive, 'bot'), false);
  assert.equal(releaseRequiresProtocolUpdate({ ...additive, minimumBotProtocol: 28 }, 'bot'), true);
  assert.equal(releaseRequiresProtocolUpdate({ ...additive, minimumBotProtocol: 28 }, 'client'), false);
  assert.equal(releaseRequiresProtocolUpdate({ ...additive, minimumClientProtocol: 28 }, 'client'), true);
  assert.equal(releaseRequiresProtocolUpdate({ ...additive, minimumClientProtocol: 28 }, 'bot'), false);
  for (const floor of [0, -1, 29, 1.2, '24', null]) {
    assert.equal(parseReleaseCompatibility({ ...additive, minimumBotProtocol: floor }, version), null);
  }
});

test('message restoration protocol 27 rejects old client contracts without requiring bot updates', () => {
  for (const protocolVersion of [24, 25, 26]) {
    const old = parseReleaseCompatibility({ ...manifest, protocolVersion, minimumClientProtocol: 24, minimumBotProtocol: 24 }, version);
    assert.ok(old);
    assert.equal(releaseRequiresProtocolUpdate(old, 'client'), true);
    assert.equal(releaseRequiresProtocolUpdate(old, 'bot'), false);
    assert.equal(releaseRequiresProtocolUpdate({ ...manifest, protocolVersion }, 'client'), true);
  }
  const current = parseReleaseCompatibility({ ...manifest, protocolVersion: 27, minimumClientProtocol: 27, minimumBotProtocol: 24 }, version);
  assert.ok(current);
  assert.equal(releaseRequiresProtocolUpdate(current, 'client'), false);
  assert.equal(releaseRequiresProtocolUpdate(current, 'bot'), false);
});

test('release compatibility validates exact release, SDK and protocol rather than assuming a SemVer change', () => {
  assert.deepEqual(parseReleaseCompatibility(manifest, version), manifest);
  assert.equal(parseReleaseCompatibility({ ...manifest, version: '18.0.1-beta' }, version), null);
  assert.equal(parseReleaseCompatibility({ ...manifest, botSdkVersion: '17.0.3-beta' }, version), null);
  for (const protocolVersion of [0, -1, 1.5, NaN, Infinity, '16', undefined]) {
    assert.equal(parseReleaseCompatibility({ ...manifest, protocolVersion }, version), null);
  }
  for (const value of ['18.0.0\n', '../18.0.0', 'v18.0.0', '18.0', '18.0.0?x=1']) {
    assert.equal(isReleaseVersion(value), false);
  }
  assert.equal(isReleaseVersion('3.1.0-beta001'), true);
  assert.equal(isReleaseVersion('3.1.0-beta.1'), true);
});

test('persistent bot compatibility summary rejects invalid counts and distinguishes unchecked bots', () => {
  const summary = { protocolVersion: 16, incompatibleBots: 1, uncheckedBots: 2 };
  assert.deepEqual(parseBotCompatibility(summary), summary);
  assert.equal(parseBotCompatibility({ ...summary, incompatibleBots: -1 }), null);
  assert.equal(parseBotCompatibility({ ...summary, uncheckedBots: '2' }), null);
  assert.equal(parseBotCompatibility({ ...summary, protocolVersion: 0 }), null);
  assert.equal(parseBotCompatibility(null), null);
});

test('metadata retrieval stays on trusted release hosts and validates the requested version', async () => {
  const calls: string[] = [];
  const request: typeof fetch = async (url, init) => {
    calls.push(String(url));
    assert.equal(init?.redirect, 'manual');
    assert.ok(init?.signal);
    return calls.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } })
      : new Response(JSON.stringify(manifest));
  };
  assert.deepEqual(await fetchReleaseCompatibility(version, request), { status: 'available', manifest });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /\/v18\.0\.0-beta\/monky-compatibility-18\.0\.0-beta\.json$/);
  let rejectedCalls = 0;
  const redirect: typeof fetch = async () => {
    rejectedCalls++;
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  };
  assert.equal((await fetchReleaseCompatibility(version, redirect)).status, 'unavailable');
  assert.equal(rejectedCalls, 1);
});

test('missing, malformed, oversized and failed metadata is explicitly unavailable, never compatible', async () => {
  const responses = [
    () => new Response(null, { status: 404 }),
    () => new Response('{invalid'),
    () => new Response(JSON.stringify({ ...manifest, version: 'other' })),
    () => new Response(' '.repeat(16 * 1024 + 1)),
  ];
  for (const response of responses) {
    assert.equal((await fetchReleaseCompatibility(version, async () => response())).status, 'unavailable');
  }
  assert.equal((await fetchReleaseCompatibility(version, async () => { throw new TypeError('network'); })).status, 'unavailable');
});
