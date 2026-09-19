import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServerInviteAppLink, createServerInviteLink, type ServerInvite } from '@monky/shared';
import { ServerInviteInbox } from '../src/main/serverInvites';

const first: ServerInvite = { v: 1, host: 'localhost', port: 3000, name: 'First invitation' };
const second: ServerInvite = { v: 1, host: '127.0.0.1', port: 3001, name: 'Second invitation' };

test('cold-start arguments retain an invitation until the renderer and identity are ready', () => {
  const inbox = new ServerInviteInbox();
  assert.equal(inbox.take(), null);
  assert.equal(inbox.receiveArguments(['Monky.exe', '--some-flag', createServerInviteAppLink(first)]), true);
  assert.deepEqual(inbox.take(), { ok: true, invite: first });
  assert.equal(inbox.take(), null, 'consuming cannot reopen the same invitation');
});

test('open-url and second-instance delivery keep only the latest pending invitation', () => {
  const inbox = new ServerInviteInbox();
  assert.equal(inbox.receive(createServerInviteAppLink(first)), true);
  assert.equal(inbox.receiveArguments(['Monky.exe', createServerInviteAppLink(second)]), true);
  assert.deepEqual(inbox.take(), { ok: true, invite: second });
  assert.equal(inbox.receive(createServerInviteAppLink(first)), true);
  assert.deepEqual(inbox.take(), { ok: true, invite: first });
});

test('unrelated arguments do not replace an invitation, but malformed native links surface explicitly', () => {
  const inbox = new ServerInviteInbox();
  inbox.receive(createServerInviteAppLink(first));
  assert.equal(inbox.receiveArguments(['--inspect', createServerInviteLink(second), 'https://example.org']), false);
  assert.deepEqual(inbox.take(), { ok: true, invite: first });
  assert.equal(inbox.receive('monky://#~not-a-valid-invitation'), true);
  assert.deepEqual(inbox.take(), { ok: false, reason: 'invalid' });
});
