import assert from 'node:assert/strict';
import test from 'node:test';
import { renderAudioMuteIndicators } from '../src/renderer/views/AudioStateIcon';
import { getLanguage, setLanguage, t } from '../src/renderer/i18n';
import { renderBotPermissionControls } from '../src/renderer/views/botPermissionControls';

test('bot listening and denied directions are visible, localized, and distinct from personal mute', (context) => {
  const previous = getLanguage();
  context.after(() => setLanguage(previous));
  for (const language of ['pt-BR', 'en'] as const) {
    setLanguage(language);
    const state = { isMuted: false, isDeafened: false, receivesVoice: true,
      botVoicePermissions: { publish: true, receive: true, publishRequested: true, receiveRequested: true } };
    const listening = renderAudioMuteIndicators(state);
    assert.match(listening, /bot-voice-listening/);
    assert.ok(listening.includes(t('botVoice.listening')));
    assert.doesNotMatch(listening, /audio-state-icon--blocked/);
    const receiveOnly = renderAudioMuteIndicators({ ...state, botVoicePermissions: { ...state.botVoicePermissions, publish: false } });
    assert.ok(receiveOnly.includes(t('botVoice.publishDenied')));
    assert.match(receiveOnly, /audio-state-icon--blocked/);
    assert.match(receiveOnly, />mic</);
    assert.match(receiveOnly, /bot-voice-listening/);
    const noGrants = renderAudioMuteIndicators({ ...state,
      botVoicePermissions: { ...state.botVoicePermissions, publish: false, receive: false } });
    assert.equal(noGrants.match(/audio-state-icon--blocked/g)?.length, 2);
    assert.ok(noGrants.includes(t('botVoice.publishDenied')));
    assert.ok(noGrants.includes(t('botVoice.receiveDenied')));
    assert.match(noGrants, />headphones</);
    assert.doesNotMatch(noGrants, /bot-voice-listening/);
    for (const restricted of [
      { ...state, receivesVoice: false }, { ...state, isDeafened: true }, { ...state, serverDeafened: true },
    ]) assert.doesNotMatch(renderAudioMuteIndicators(restricted), /bot-voice-listening/);
    assert.match(renderAudioMuteIndicators({ ...state, isMuted: true }), /bot-voice-listening/);
    assert.match(renderAudioMuteIndicators({ ...state, serverMuted: true }), /bot-voice-listening/);
    assert.equal(renderAudioMuteIndicators({ isMuted: false, isDeafened: false }), '');
    const controls = renderBotPermissionControls(['publish_voice', 'receive_voice'], [], 'test');
    assert.match(controls, /role="switch" data-bot-capability="receive_voice"/);
    assert.doesNotMatch(controls, / checked/);
    assert.ok(controls.includes(t('botPermissions.receive_voice.description')));
  }
});

test('unrequested voice capabilities do not look denied, without implying authorization', (context) => {
  const previous = getLanguage();
  context.after(() => setLanguage(previous));
  for (const language of ['pt-BR', 'en'] as const) {
    setLanguage(language);
    for (const permissions of [
      { publish: false, receive: true, publishRequested: false, receiveRequested: true },
      { publish: true, receive: false, publishRequested: true, receiveRequested: false },
      { publish: false, receive: false, publishRequested: false, receiveRequested: false },
    ]) {
      const html = renderAudioMuteIndicators({
        isMuted: false, isDeafened: false, receivesVoice: true, botVoicePermissions: permissions,
      });
      assert.doesNotMatch(html, /audio-state-icon--blocked/);
      assert.equal(html.includes(t('botVoice.publishDenied')), false);
      assert.equal(html.includes(t('botVoice.receiveDenied')), false);
      assert.equal(html.includes('bot-voice-listening'), permissions.receive);
    }
  }
});

test('administrative restrictions override granted directions without becoming capability denials', (context) => {
  const previous = getLanguage();
  context.after(() => setLanguage(previous));
  for (const language of ['pt-BR', 'en'] as const) {
    setLanguage(language);
    const state = { isMuted: false, isDeafened: false, receivesVoice: true,
      botVoicePermissions: { publish: true, receive: true, publishRequested: true, receiveRequested: true } };
    const muted = renderAudioMuteIndicators({ ...state, serverMuted: true });
    assert.equal(muted.match(/audio-state-icon--blocked/g)?.length, 1);
    assert.match(muted, />mic</);
    assert.ok(muted.includes(t('permissions.serverMuted')));
    assert.match(muted, /bot-voice-listening/);
    const deafened = renderAudioMuteIndicators({ ...state, serverDeafened: true });
    assert.equal(deafened.match(/audio-state-icon--blocked/g)?.length, 2);
    assert.ok(deafened.includes(t('permissions.serverDeafened')));
    assert.doesNotMatch(deafened, /bot-voice-listening/);
    for (const html of [muted, deafened]) {
      assert.equal(html.includes(t('botVoice.publishDenied')), false);
      assert.equal(html.includes(t('botVoice.receiveDenied')), false);
    }
    for (const personal of [{ isMuted: true }, { isDeafened: true }]) {
      assert.doesNotMatch(renderAudioMuteIndicators({ ...state, ...personal }), /audio-state-icon--blocked/);
    }
    assert.doesNotMatch(renderAudioMuteIndicators(state), /audio-state-icon--blocked/);
    const unrequestedPublication = renderAudioMuteIndicators({ ...state, serverMuted: true,
      botVoicePermissions: { ...state.botVoicePermissions, publish: false, publishRequested: false } });
    assert.match(unrequestedPublication, /audio-state-icon--blocked/);
    assert.ok(unrequestedPublication.includes(t('permissions.serverMuted')));
  }
});
