'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

module.exports = ({ fixture, input, profile }) => {
  test('private source audience is renderer-only and survives native quality/reconnect replacements', async t => {
    const f = fixture(t);
    const audience = { userIds: ['alice'], roleIds: ['friends'] };
    const source = await f.local({ ...input, audience });
    assert.deepEqual(source.audience, audience);
    assert.ok(f.commands.filter(command => command.action === 'source-add').every(command => !('audience' in command)));
    await f.controller.applyQuality(profile());
    assert.deepEqual(f.captures.get(source.shareId).source.audience, audience);
    assert.notEqual(f.captures.get(source.shareId).source.instanceId, source.instanceId);
    const before = f.captures.get(source.shareId).source;
    await f.controller.close();
    await f.controller.sync();
    assert.deepEqual(f.captures.get(source.shareId).source.audience, audience);
    assert.notEqual(f.captures.get(source.shareId).source.instanceId, before.instanceId);
  });
};
