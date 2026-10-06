'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..');
const inputs = path.join(root, 'src', 'rtc');
const pins = require('../src/rtc/level6-upstream.json');
const sha256 = text => crypto.createHash('sha256').update(text).digest('hex');

test('the maintained WebRTC Level6 overlay differs from its pinned upstream only at the enum and level tables', () => {
  const header = fs.readFileSync(path.join(inputs, 'inputs', 'sdk', ...pins.files[0].path.split('/')), 'utf8').replaceAll('\r\n', '\n');
  const implementation = fs.readFileSync(path.join(inputs, 'inputs', 'sdk', ...pins.files[1].path.split('/')), 'utf8').replaceAll('\r\n', '\n');
  assert.equal(sha256(header.replace('kLevel5_2 = 52,\n  kLevel6 = 60', 'kLevel5_2 = 52')), pins.files[0].sha256);
  assert.equal(sha256(implementation
    .replace('// ITU-T H.264 Table A-1. Monky adds Level 6 for explicitly negotiated 4K120.',
      '// This is from ITU-T H.264 (02/2016) Table A-1 \u2013 Level limits.')
    .replace('    {4177920, 139264, H264Level::kLevel6},\n', '')
    .replace('    case H264Level::kLevel6:\n', '')), pins.files[1].sha256);
  const build = fs.readFileSync(path.join(root, 'scripts', 'buildRtc.cjs'), 'utf8');
  assert.match(build, /level6-upstream\.json/u);
  assert.match(build, /digest\(fs\.readFileSync\(path\.join\(sdk, \.\.\.file\.path\.split\('\/'\)\)\)\), file\.sha256/u);
  assert.match(build, /const overlayHash = digest\(JSON\.stringify\(overlayFiles\)/u);
  const packaging = fs.readFileSync(path.join(root, 'scripts', 'packSources.cjs'), 'utf8');
  assert.match(packaging, /SOURCE-PATCHES/u);
  assert.match(packaging, /h264-profile-level-id\+2\.3\.3\.patch/u);
});

for (const consumer of ['mediasoup', 'mediasoup-client']) {
  test(`${consumer} uses the maintained Level6 dependency without inventing remote support`, () => {
    const requireDependency = createRequire(require.resolve(consumer));
    const h264 = requireDependency('h264-profile-level-id');
    const main6 = { 'profile-level-id': '4d003c' };
    const main52 = { 'profile-level-id': '4d0034' };
    assert.equal(h264.parseProfileLevelId('4d003c').level, 60);
    assert.equal(h264.profileLevelIdToString(h264.parseProfileLevelId('4d003c')), '4d003c');
    assert.equal(h264.levelToString(h264.Level.L6), '6');
    assert.equal(h264.supportedLevel(139264 * 256, 30), 60);
    assert.equal(h264.supportedLevel(139264 * 256, 29), 51);
    assert.equal(h264.generateProfileLevelIdStringForAnswer(main6, main6), '4d003c');
    assert.equal(h264.generateProfileLevelIdStringForAnswer(main6, main52), '4d0034');
    for (const unsupported of ['4d0035', '4d003b', '4d003d', '4d003e'])
      assert.equal(h264.parseProfileLevelId(unsupported), undefined);
  });
}

test('mediasoup router and client capability matching retain honest Main6 metadata', () => {
  const serverOrtc = require(path.join(path.dirname(require.resolve('mediasoup')), 'ortc.js'));
  const clientOrtc = require(path.join(path.dirname(require.resolve('mediasoup-client')), 'ortc.js'));
  const router = serverOrtc.generateRouterRtpCapabilities([{
    kind: 'video', mimeType: 'video/H264', clockRate: 90000,
    parameters: { 'profile-level-id': '4d003c', 'packetization-mode': 1, 'level-asymmetry-allowed': 1 },
  }]);
  const codec = router.codecs.find(value => value.mimeType.toLowerCase() === 'video/h264');
  assert.equal(codec.parameters['profile-level-id'], '4d003c');
  const extended = clientOrtc.getExtendedRtpCapabilities(structuredClone(router), structuredClone(router));
  assert.equal(extended.codecs.find(value => value.mimeType.toLowerCase() === 'video/h264')
    .remoteParameters['profile-level-id'], '4d003c');
});
