import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  botMessageLocalizationsSchema, botMessagePreviewLocalizations, getMessageText, normalizeBotMessageContent,
} from '../src/botMessages';
import { commandResponseSchema } from '../src/botInteractions';
import { botChatMessageSchema } from '../src/reactions';
import { LIMITS } from '../src/constants';

const translated = { content: 'Default', localizations: { 'pt-BR': 'Olá, **pessoa**!', en: 'Hello, **reader**!' } };

test('each reader selects a bot-authored variant without modifying the original', () => {
  const message = { ...translated, isBot: true };
  assert.equal(getMessageText(message, 'pt-BR'), translated.localizations['pt-BR']);
  assert.equal(getMessageText(message, 'en-US'), translated.localizations.en);
  assert.equal(message.content, 'Default');
  assert.equal(getMessageText({ ...message, isBot: false }, 'pt-BR'), 'Default');
  assert.equal(getMessageText({ ...message, deletedAt: 1 }, 'en'), '');
  assert.equal(getMessageText({ content: 'Legacy', isBot: true }, 'en'), 'Legacy');
  assert.equal(getMessageText({ content: 'Fallback', isBot: true, localizations: { en: 'English' } }, 'pt-BR'), 'Fallback');
});

test('plain text remains supported; variants and fallback are individually bounded and strict', () => {
  assert.deepEqual(normalizeBotMessageContent(' Plain text '), { content: 'Plain text' });
  assert.deepEqual(normalizeBotMessageContent(translated), translated);
  for (const localizations of [{}, { en: '' }, { en: ' '.repeat(10) }, { fr: 'Bonjour' },
    { en: 'x'.repeat(LIMITS.WS_MAX_PAYLOAD_BYTES + 1) }, { en: 42 }]) {
    assert.equal(botMessageLocalizationsSchema.safeParse(localizations).success, false);
    assert.equal(commandResponseSchema.safeParse({ invocationId: 'i', content: 'Fallback', localizations }).success, false);
  }
  const maximum = { en: 'x'.repeat(LIMITS.MAX_MESSAGE_LENGTH), 'pt-BR': 'y'.repeat(LIMITS.MAX_MESSAGE_LENGTH) };
  assert.equal(botMessageLocalizationsSchema.safeParse(maximum).success, true);
  assert.deepEqual(botMessagePreviewLocalizations(maximum), { en: 'x'.repeat(200), 'pt-BR': 'y'.repeat(200) });
  assert.equal(botMessageLocalizationsSchema.safeParse({ en: 'x'.repeat(16001) }).success, true,
    'the wire schema allows larger messages; the service applies each server limit');
});

test('command replies and durable acknowledgements retain variants and localized references', () => {
  assert.deepEqual(commandResponseSchema.parse({ invocationId: 'i', ...translated }),
    { invocationId: 'i', ...translated });
  const message = {
    id: 'm', channelId: 'c', userId: 'b', userNickname: 'Bot', createdAt: 1, isBot: true, ...translated,
    reply: { messageId: 'original', userNickname: 'Bot', ...translated, isBot: true, deleted: false, hasAttachments: false },
  };
  assert.deepEqual(botChatMessageSchema.parse(message), message);
});
