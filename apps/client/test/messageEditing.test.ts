import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatMessage, SlashCommand } from '@monky/shared';
import { appEvents, EventBus } from '../src/renderer/core/EventBus';
import { createChatStore } from '../src/renderer/stores/chatStore';

const message: ChatMessage = {
  id: 'original', channelId: 'chat', userId: 'author', userNickname: 'Author',
  content: '\nOriginal line\nSecond line', createdAt: 1, isSystem: false,
};

function createStore() {
  const store = createChatStore();
  store.bus = new EventBus();
  store.setHistory(message.channelId, [message]);
  return store;
}

test('restoration revisions refresh replies and cannot be rolled back by late edits or history', () => {
  const store = createStore();
  const original = { ...message, revision: 0 };
  store.setHistory('chat', [original, { ...message, id: 'reply', reply: store.messageReply(original) }]);
  store.setReplyDraft('chat', original);
  const deleted = { ...original, content: '', deletedAt: 100, revision: 1, deletedByUserId: 'author', deleteUndoUntil: 60100 };
  store.updateMessage(deleted);
  assert.equal(store.getReplyDraft('chat')?.deleted, true);
  const restored = { ...original, revision: 2, deletedAt: null };
  store.updateMessage(restored);
  assert.equal(store.getMessages('chat')[0].content, original.content);
  assert.equal(store.getReplyDraft('chat')?.deleted, false);
  assert.equal(store.getMessages('chat').find(entry => entry.id === 'reply')?.reply?.deleted, false);
  store.updateMessage(deleted);
  store.setHistory('chat', [deleted]);
  assert.equal(store.getMessages('chat')[0].revision, 2);
  store.updateMessage({ ...deleted, revision: 3 });
  store.updateMessage(restored);
  assert.equal(store.getMessages('chat')[0].deletedAt, 100);
});

test('outgoing messages survive failures/history and reconcile exactly once, including late acknowledgements', () => {
  const store = createStore();
  const pending = { ...message, id: 'outgoing', createdAt: 200, content: 'Unconfirmed' };
  const payload = { clientMessageId: pending.id, channelId: pending.channelId, content: pending.content, attachmentIds: ['file'] };
  const outgoing = store.enqueueMessage(payload, pending);
  payload.attachmentIds.push('not-sent');
  pending.content = 'Not in the queued snapshot';
  assert.deepEqual(outgoing.payload.attachmentIds, ['file']);
  assert.equal(outgoing.message.content, 'Unconfirmed');
  store.failOutgoing(outgoing, 'Connection interrupted');
  store.setHistory('chat', [message]);
  assert.equal(store.getMessages('chat').filter(entry => entry.id === outgoing.message.id).length, 1);
  assert.equal(store.getOutgoing('outgoing')?.status, 'failed');
  assert.equal(store.retryOutgoing('outgoing'), outgoing);
  assert.equal(store.retryOutgoing('outgoing'), undefined, 'Double-clicking retry cannot start another attempt');
  store.addMessage({ ...outgoing.message, createdAt: 210 });
  store.failOutgoing(outgoing, 'Late timeout');
  store.addMessage({ ...outgoing.message, createdAt: 210 });
  assert.equal(store.getOutgoing('outgoing'), undefined);
  assert.equal(store.getMessages('chat').filter(entry => entry.id === 'outgoing').length, 1);
});

test('outbox recovery is scoped to authenticated endpoint, server and user, and history can acknowledge it', () => {
  const scope = { sessionKey: 'delivery-fixture', serverId: 'delivery-server', userId: message.userId };
  const store = createStore();
  store.setComposerScope(scope);
  store.enqueueMessage({ clientMessageId: 'recover-send', channelId: 'chat', content: 'Recover' },
    { ...message, id: 'recover-send', content: 'Recover' });
  store.clear();
  const unrelated = createStore();
  unrelated.setComposerScope({ ...scope, userId: 'other-user' });
  assert.equal(unrelated.getOutgoing('recover-send'), undefined);
  const recovered = createStore();
  recovered.setComposerScope(scope);
  assert.equal(recovered.getOutgoing('recover-send')?.status, 'failed');
  const pending = recovered.getOutgoing('recover-send');
  assert.ok(pending);
  recovered.setHistory('chat', [message, { ...pending.message, createdAt: 300 }]);
  assert.equal(recovered.getOutgoing('recover-send'), undefined);
  assert.equal(recovered.getMessages('chat').filter(entry => entry.id === 'recover-send').length, 1);
  recovered.clear();
});

test('editing keeps the exact original text and the independent new-message and reply drafts', () => {
  const store = createStore();
  const draft = '\nUnsent message\nwith multiple lines';
  store.setDraft('chat', draft);
  store.setReplyDraft('chat', message);
  const reply = store.getReplyDraft('chat');
  const edit = store.beginMessageEdit(message);
  assert.ok(edit);
  assert.equal(edit.content, message.content);
  store.setMessageEditContent('chat', 'Edited\ntext');
  assert.equal(edit.content, 'Edited\ntext');
  assert.equal(store.getDraft('chat'), draft);
  assert.equal(store.getReplyDraft('chat'), reply);
  assert.equal(store.getMessages('chat')[0].content, message.content);
  store.finishMessageEdit('chat', edit);
  assert.equal(store.getMessageEdit('chat'), undefined);
  assert.equal(store.getDraft('chat'), draft);
  assert.equal(store.getReplyDraft('chat'), reply);
});

test('noneditable messages and a second edit cannot replace an unfinished edit', () => {
  const store = createStore();
  assert.equal(store.beginMessageEdit({ ...message, isSystem: true }), undefined);
  assert.equal(store.beginMessageEdit({ ...message, isEphemeral: true }), undefined);
  assert.equal(store.beginMessageEdit({ ...message, deletedAt: 2 }), undefined);
  const edit = store.beginMessageEdit(message);
  assert.ok(edit);
  store.setMessageEditContent('chat', 'Never discard this');
  assert.equal(store.beginMessageEdit({ ...message, id: 'second' }), edit);
  assert.equal(edit.message.id, 'original');
  assert.equal(edit.content, 'Never discard this');
});

test('edit state and late acknowledgements are isolated by channel, session and draft identity', () => {
  const first = createStore();
  const second = createStore();
  first.setDraft('chat', 'First session draft');
  second.setDraft('chat', 'Second session draft');
  const edit = first.beginMessageEdit(message);
  const otherChannel = first.beginMessageEdit({ ...message, id: 'other', channelId: 'other' });
  const otherSession = second.beginMessageEdit(message);
  assert.ok(edit && otherChannel && otherSession);
  first.setMessageEditPending('chat', edit, true);
  first.setMessageEditContent('chat', 'Cannot change a submitted request');
  assert.equal(edit.content, message.content);
  first.setMessageEditPending('chat', edit, false, 'failed');
  assert.equal(edit.error, 'failed');
  first.setMessageEditContent('chat', 'Retry text');
  assert.equal(edit.error, undefined);
  first.finishMessageEdit('chat', edit);
  const replacement = first.beginMessageEdit(message);
  assert.ok(replacement);
  first.setMessageEditPending('chat', edit, false, 'failed');
  first.finishMessageEdit('chat', edit);
  assert.equal(first.getMessageEdit('chat'), replacement);
  assert.equal(first.getMessageEdit('other'), otherChannel);
  assert.equal(second.getMessageEdit('chat'), otherSession);
  assert.equal(first.getDraft('chat'), 'First session draft');
  assert.equal(second.getDraft('chat'), 'Second session draft');
});

test('edit notifications use the captured store bus rather than the foreground bus', () => {
  const store = createStore();
  let scoped = 0;
  let foreground = 0;
  const offScoped = store.bus.on('chat.message_edit_updated', () => { scoped++; });
  const offForeground = appEvents.on('chat.message_edit_updated', () => { foreground++; });
  try {
    const edit = store.beginMessageEdit(message);
    assert.ok(edit);
    store.setMessageEditContent('chat', 'Changed');
    store.setMessageEditPending('chat', edit, true);
    store.setMessageEditPending('chat', edit, false, 'failed');
    store.updateMessage({ ...message, deletedAt: 2 });
    store.finishMessageEdit('chat', edit);
    assert.equal(scoped, 6);
    assert.equal(foreground, 0);
  } finally {
    offScoped();
    offForeground();
  }
});

test('edits survive history replacement and track deleted originals even outside the history window', () => {
  const store = createStore();
  const edit = store.beginMessageEdit(message);
  assert.ok(edit);
  store.setDraft('chat', 'New-message draft');
  store.setMessageEditContent('chat', 'Unsaved edit');
  store.setHistory('chat', [{ ...message, content: 'Updated on another device', editedAt: 19 }]);
  assert.equal(edit.message.content, 'Updated on another device');
  assert.equal(edit.content, 'Unsaved edit');
  store.setHistory('chat', [{ ...message, id: 'newer', createdAt: 20 }], 'newer');
  assert.equal(store.getMessageEdit('chat'), edit);
  assert.equal(edit.content, 'Unsaved edit');
  store.updateMessage({ ...message, content: '', deletedAt: 21 });
  assert.equal(edit.message.deletedAt, 21);
  assert.equal(edit.content, 'Unsaved edit');
  assert.equal(store.getDraft('chat'), 'New-message draft');
  assert.equal(store.getMessages('chat').length, 1);
  store.setHistory('chat', [{ ...message, content: 'A stale history response', editedAt: 20 }]);
  assert.equal(edit.message.deletedAt, 21);
  assert.equal(store.getMessages('chat').find(entry => entry.id === message.id)?.deletedAt, 21);
  assert.equal(edit.content, 'Unsaved edit');
});

test('a stale successful edit update cannot undo deletion or discard the recovery text', () => {
  const store = createStore();
  const edit = store.beginMessageEdit(message);
  assert.ok(edit);
  store.setDraft('chat', 'Original draft');
  store.setMessageEditContent('chat', 'Submitted edit');
  store.setMessageEditPending('chat', edit, true);
  store.updateMessage({ ...message, content: '', deletedAt: 40 });
  store.updateMessage({ ...message, content: 'Submitted edit', editedAt: 30 });
  assert.equal(edit.message.deletedAt, 40);
  assert.equal(store.getMessages('chat')[0].deletedAt, 40);
  assert.equal(edit.content, 'Submitted edit');
  assert.equal(store.getDraft('chat'), 'Original draft');
});

test('command drafts are suspended during message editing, not discarded or replaced by slash text', () => {
  const store = createStore();
  const command: SlashCommand = {
    botId: 'bot', botName: 'Bot', name: 'play', description: 'Play',
    options: [{ name: 'track', description: 'Track', type: 'string', required: true }],
  };
  store.selectCommand('chat', command, 'Original arguments');
  const commandDraft = store.getCommandDraft('chat');
  assert.ok(commandDraft);
  store.setDraft('chat', 'Normal draft');
  const edit = store.beginMessageEdit(message);
  assert.ok(edit);
  assert.equal(store.getCommandDraft('chat'), undefined);
  store.setMessageEditContent('chat', '/play this is message text');
  store.selectCommand('chat', { ...command, name: 'other' }, 'Must not replace anything');
  assert.equal(store.getDraft('chat'), 'Normal draft');
  assert.equal(store.getMessageEdit('chat')?.content, '/play this is message text');
  store.finishMessageEdit('chat', edit);
  assert.equal(store.getCommandDraft('chat'), commandDraft);
  assert.equal(commandDraft.values.track, 'Original arguments');
});

test('terminal disconnect recovery keeps both texts and replies only for the same endpoint, server and user', () => {
  const scope = { sessionKey: 'ws://recovery-fixture:1', serverId: 'recovery-server', userId: 'author' };
  const original = createStore();
  original.setComposerScope(scope);
  original.setDraft('chat', '\nDraft before editing');
  original.setReplyDraft('chat', message);
  const edit = original.beginMessageEdit(message);
  assert.ok(edit);
  original.setMessageEditContent('chat', 'Unacknowledged edit');
  original.setMessageEditPending('chat', edit, true);
  original.clear();
  assert.equal(original.getMessageEdit('chat'), undefined);
  assert.equal(original.getDraft('chat'), '');

  for (const changedScope of [
    { ...scope, sessionKey: 'ws://another-endpoint:1' },
    { ...scope, serverId: 'another-server' },
    { ...scope, userId: 'another-user' },
  ]) {
    const unrelated = createStore();
    unrelated.setComposerScope(changedScope);
    assert.equal(unrelated.getMessageEdit('chat'), undefined);
    assert.equal(unrelated.getDraft('chat'), '');
  }
  const recovered = createStore();
  recovered.setComposerScope(scope);
  const recoveredEdit = recovered.getMessageEdit('chat');
  assert.ok(recoveredEdit);
  assert.notEqual(recoveredEdit, edit);
  assert.equal(recoveredEdit.content, 'Unacknowledged edit');
  assert.equal(recoveredEdit.pending, false);
  assert.equal(recoveredEdit.error, 'failed');
  assert.equal(recovered.getDraft('chat'), '\nDraft before editing');
  assert.equal(recovered.getReplyDraft('chat')?.messageId, message.id);
  original.finishMessageEdit('chat', edit);
  assert.equal(recovered.getMessageEdit('chat'), recoveredEdit);
  const secondRecovery = createStore();
  secondRecovery.setComposerScope(scope);
  assert.equal(secondRecovery.getMessageEdit('chat'), undefined);
  recovered.finishMessageEdit('chat', recoveredEdit);
});

test('changing authenticated composer scope never exposes an old identity edit in a reused store', () => {
  const store = createStore();
  const first = { sessionKey: 'identity-fixture', serverId: 'identity-server', userId: 'first' };
  store.setComposerScope(first);
  store.setDraft('chat', 'Private original draft');
  store.beginMessageEdit(message);
  store.setMessageEditContent('chat', 'Private edited draft');
  store.setComposerScope({ ...first, userId: 'second' });
  assert.equal(store.getDraft('chat'), '');
  assert.equal(store.getMessageEdit('chat'), undefined);
  store.setComposerScope(first);
  assert.equal(store.getDraft('chat'), 'Private original draft');
  assert.equal(store.getMessageEdit('chat')?.content, 'Private edited draft');
});
