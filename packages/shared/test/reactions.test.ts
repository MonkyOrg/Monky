import assert from 'node:assert/strict';
import test from 'node:test';
import { botChatMessageSchema, chatReactionSchema, reactionEmojiSchema } from '../src/reactions.js';
import { chatHistoryRequestSchema, messageReferenceSchema } from '../src/validators.js';

test('reply references and historical navigation validate IDs without requiring replies on ordinary bot messages', () => {
  for (const value of ['', null, 12, {}, 'x'.repeat(129)]) assert.equal(messageReferenceSchema.safeParse(value).success, false);
  assert.equal(messageReferenceSchema.safeParse('message').success, true);
  assert.equal(chatHistoryRequestSchema.safeParse({ channelId: 'text', aroundMessageId: 'message', limit: 1 }).success, true);
  for (const value of [NaN, Infinity, -1, 1.5]) assert.equal(chatHistoryRequestSchema.safeParse({ channelId: 'text', limit: value }).success, false);
  const message = { id: 'message', channelId: 'text', userId: 'bot', userNickname: 'Bot', content: 'Answer', createdAt: 1 };
  assert.equal(botChatMessageSchema.safeParse(message).success, true);
  const reply = { messageId: 'original', userNickname: 'Alice', content: 'Question', deleted: false, hasAttachments: false };
  assert.deepEqual(botChatMessageSchema.parse({ ...message, reply }).reply, reply);
});

test('reactions accept one Unicode emoji and reject malformed or oversized payloads', () => {
  for (const emoji of ['👍', '👍🏽', '❤️', '👨‍👩‍👧‍👦', '🇧🇷', '1️⃣', '🏴󠁧󠁢󠁥󠁮󠁧󠁿']) {
    assert.equal(reactionEmojiSchema.safeParse(emoji).success, true, emoji);
  }
  for (const emoji of ['', 'a', '<script>', '👍👍', '👍 text', '🇧', '1', '\u200d', '😀'.repeat(100)]) {
    assert.equal(reactionEmojiSchema.safeParse(emoji).success, false, emoji);
  }
  const valid = { channelId: 'channel', messageId: 'message', emoji: '👍' };
  assert.equal(chatReactionSchema.safeParse(valid).success, true);
  assert.equal(chatReactionSchema.safeParse({ ...valid, userId: 'impersonated' }).success, false);
  assert.equal(chatReactionSchema.safeParse({ ...valid, channelId: 'x'.repeat(129) }).success, false);
});
