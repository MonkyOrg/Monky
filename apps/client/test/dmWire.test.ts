import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { DM_MAX_ATTACHMENTS, DM_MAX_MESSAGE_LENGTH } from '@monky/shared';
import { newDmId } from '../src/main/dm/dmCrypto';
import { editedAtWins, messageFingerprint, type StoredMessage } from '../src/main/dm/dmModel';
import { parseWireMessage, storedMessage, toWireMessage } from '../src/main/dm/dmWire';

function identityKey(): string {
  return generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('hex');
}

const me = identityKey();
const peer = identityKey();
const stranger = identityKey();
const limit = 2_000_000;
const scope = { me, peer, limit };

function message(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: newDmId(),
    author: me,
    content: 'olá',
    createdAt: 1_000,
    editedAt: null,
    deleted: false,
    replyTo: null,
    reactions: {},
    attachments: [],
    delivery: 'delivered',
    forwarded: null,
    ...overrides,
  };
}

function file(name: string) {
  return { fileId: newDmId(), name, size: 10, mime: 'image/png', sha256: 'a'.repeat(64) };
}

test('a message leaves with what it says and is read back the same', () => {
  const attachment = file('foto.png');
  const original = message({
    content: 'editada',
    editedAt: 1_500,
    contentAt: 1_600,
    replyTo: newDmId(),
    reactions: { '👍': { [peer]: { on: true, ts: 1_200 } } },
    attachments: [{ ...attachment, state: 'local', receivedBytes: 10 }],
    forwarded: { source: '#geral', createdAt: 900 },
  });
  const wire = toWireMessage(original);
  assert.deepEqual(wire.attachments, [attachment], 'How this device holds a file stays here');
  assert.equal('delivery' in wire, false);
  const parsed = parseWireMessage(JSON.parse(JSON.stringify(wire)), scope);
  assert.ok(parsed);
  assert.deepEqual(storedMessage(parsed, false, original.attachments, me), original);
});

test('the text clock and the forward marker only travel when they tell something', () => {
  const plain = toWireMessage(message({ editedAt: 1_500, contentAt: 1_500 }));
  assert.equal('contentAt' in plain, false);
  assert.equal('forwarded' in plain, false);
  // Devices before #490 send no text clock: the edit time stands for it.
  assert.equal(parseWireMessage(plain, scope)?.contentAt, 1_500);
  assert.equal(parseWireMessage(toWireMessage(message()), scope)?.contentAt, null);
});

test('only messages and reactions of the two people in the conversation are read, within the time limit', () => {
  const valid = toWireMessage(message({ author: peer }));
  for (const raw of [null, 'msg', [], { ...valid, id: 'curto' }, { ...valid, author: stranger }, { ...valid, author: 'x' }]) {
    assert.equal(parseWireMessage(raw, scope), null, JSON.stringify(raw));
  }
  const parsed = parseWireMessage({
    ...valid,
    author: peer.toUpperCase(),
    content: 'x'.repeat(DM_MAX_MESSAGE_LENGTH + 10),
    createdAt: limit * 10,
    editedAt: 'ontem',
    contentAt: 'agora',
    replyTo: 'não-é-um-id',
    deleted: 'sim',
    reactions: {
      '  👍  ': { [peer]: { on: true, ts: limit * 3 }, [stranger]: { on: true, ts: 1 } },
      '🔥': null,
      '❤️': { [me]: null },
      '🎉': { [me]: { on: true, ts: 'ontem' } },
      '   ': { [me]: { on: true, ts: 1 } },
    },
    attachments: [...Array.from({ length: DM_MAX_ATTACHMENTS + 2 }, (_, index) => file(`${index}.png`)), { fileId: 'x' }],
    forwarded: { source: 42 },
  }, scope);
  assert.ok(parsed);
  assert.equal(parsed.author, peer);
  assert.equal(parsed.content.length, DM_MAX_MESSAGE_LENGTH);
  assert.equal(parsed.createdAt, limit, 'A time ahead of the limit is brought back to it');
  assert.equal(parsed.editedAt, null);
  assert.equal(parsed.contentAt, null);
  assert.equal(parsed.replyTo, null);
  assert.equal(parsed.deleted, false);
  assert.deepEqual(parsed.reactions, { '👍': { [peer]: { on: true, ts: limit } } });
  assert.equal(parsed.attachments.length, DM_MAX_ATTACHMENTS);
  assert.equal(parsed.forwarded, null);
});

test('a deleted message keeps nothing of what it said, only the edit mark devices compare it by', () => {
  const original = message({
    content: 'segredo',
    editedAt: 1_500,
    contentAt: 1_600,
    reactions: { '👍': { [peer]: { on: true, ts: 1_200 } } },
    forwarded: { source: null, createdAt: 900 },
  });
  const parsed = parseWireMessage(toWireMessage(original), scope);
  assert.ok(parsed);
  const deleted = storedMessage(parsed, true, [{ ...file('a.png'), state: 'ready', receivedBytes: 10 }], me);
  assert.deepEqual(deleted, {
    id: original.id,
    author: me,
    content: '',
    createdAt: original.createdAt,
    editedAt: 1_500,
    contentAt: undefined,
    deleted: true,
    replyTo: null,
    reactions: {},
    attachments: [],
    delivery: 'delivered',
    forwarded: null,
  });
  // The device where the delete happened keeps the mark too: both hold the same version of it.
  const deletedHere: StoredMessage = { ...original, content: '', reactions: {}, attachments: [], forwarded: null, deleted: true };
  assert.equal(messageFingerprint(deleted), messageFingerprint(deletedHere));
});

test('the newest edit mark wins on every copy, deleted or not, and no mark never replaces one', () => {
  for (const deleted of [false, true]) {
    assert.equal(editedAtWins(2_000, message({ deleted, editedAt: 1_000 })), true);
    assert.equal(editedAtWins(2_000, message({ deleted, editedAt: null })), true);
    assert.equal(editedAtWins(1_000, message({ deleted, editedAt: 2_000 })), false);
    assert.equal(editedAtWins(2_000, message({ deleted, editedAt: 2_000 })), false);
    assert.equal(editedAtWins(null, message({ deleted, editedAt: 2_000 })), false);
    assert.equal(editedAtWins(null, message({ deleted, editedAt: null })), false);
  }
});
