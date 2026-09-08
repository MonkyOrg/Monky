import assert from 'node:assert/strict';
import test from 'node:test';
import { chatReactionSchema, reactionEmojiSchema } from '../src/reactions.js';

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
