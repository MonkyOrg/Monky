import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LIMITS, ProtocolErrorCode } from '@monky/shared';
import { setLanguage, t } from '../src/renderer/i18n';
import { translateProtocolError } from '../src/renderer/i18n/protocolErrors';
import { nicknameError } from '../src/renderer/utils/nickname';

test('nickname problems are explained in the app language before anything is saved or sent (#567)', () => {
  try {
    for (const [language, tooShort, tooLong, characters] of [
      ['pt-BR', /pelo menos 2/, /no máximo 32/, /invisíveis/],
      ['en', /at least 2/, /at most 32/, /invisible/],
    ] as const) {
      setLanguage(language);
      for (const accepted of ['João', ' Ângela 🐒 ', "D'Ávila", '👨‍👩‍👧']) assert.equal(nicknameError(accepted), null, accepted);
      const messages = [
        [nicknameError('J'), tooShort],
        [nicknameError('J'.repeat(LIMITS.MAX_NICKNAME_LENGTH + 1)), tooLong],
        [nicknameError('Ad\u200Bmin'), characters],
        [nicknameError('\u3164\u3164'), characters],
        [nicknameError('<3 Ana'), characters],
      ] as const;
      for (const [message, expected] of messages) {
        assert.match(message ?? '', expected, `${language}: ${message}`);
        assert.doesNotMatch(message ?? '', /[{}]/, 'every placeholder is filled');
      }
    }
  } finally {
    setLanguage('pt-BR');
  }
});

test('an outdated server refusing accents says so instead of blaming the nickname (#567)', () => {
  // The exact text servers released before #567 answer with.
  const legacy = 'Nickname contém caracteres inválidos';
  try {
    setLanguage('en');
    const english = translateProtocolError(ProtocolErrorCode.BAD_REQUEST, legacy);
    assert.equal(english, t('protocolError.nicknameServerOutdated'));
    assert.match(english, /update Monky/);
    assert.equal(translateProtocolError(ProtocolErrorCode.NICKNAME_INVALID, legacy), english, 'renaming is refused with the same text');
    assert.equal(translateProtocolError(ProtocolErrorCode.BAD_REQUEST, 'Other server error'), 'Other server error');
    assert.equal(translateProtocolError(ProtocolErrorCode.NICKNAME_INVALID, 'Other server error'), t('protocolError.nicknameInvalid'));
    setLanguage('pt-BR');
    assert.match(translateProtocolError(ProtocolErrorCode.BAD_REQUEST, legacy), /atualizar o Monky/);
  } finally {
    setLanguage('pt-BR');
  }
});
