import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeScreenSourceSchema, screenShareAudienceSchema } from '../src/screenSharing.js';

const source = {
  shareId: 'screen', instanceId: 'de8c9593-0393-4d27-a1b2-5902c7b6ccfe', audio: true,
  video: { width: 1920, height: 1080, fps: 60, maxBitrateKbps: 12000 },
};

test('private screen audience is explicit, bounded and never defaults an empty selection to public', () => {
  assert.equal(nativeScreenSourceSchema.safeParse(source).success, true);
  for (const audience of [
    { userIds: ['user'], roleIds: [] }, { userIds: [], roleIds: ['role'] },
    { userIds: ['user'], roleIds: ['role'] },
  ]) assert.deepEqual(nativeScreenSourceSchema.parse({ ...source, audience }).audience, audience);
  for (const audience of [
    null, {}, { userIds: [], roleIds: [] }, { userIds: [''], roleIds: [] },
    { userIds: ['user\0'], roleIds: [] }, { userIds: [], roleIds: ['é'.repeat(128)] },
    { userIds: Array(257).fill('user'), roleIds: [] }, { userIds: [], roleIds: Array(129).fill('role') },
    { userIds: ['user'], roleIds: [], administrators: true },
  ]) {
    assert.equal(screenShareAudienceSchema.safeParse(audience).success, false);
    assert.equal(nativeScreenSourceSchema.safeParse({ ...source, audience }).success, false);
  }
});
