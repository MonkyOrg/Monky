import { appEvents } from '../core/EventBus';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { getVoiceControlModeration } from '../core/voiceControls';
import { t } from '../i18n';
import { renderAudioStateIcon, updateAudioStateIcon } from './AudioStateIcon';

export function renderPttIndicator(): string {
  return `<div class="ptt-indicator" data-ptt-indicator hidden>
    <span class="material-symbols-outlined md-16" data-ptt-icon aria-hidden="true"></span>
    <span data-ptt-label></span>
    <kbd data-ptt-key></kbd>
  </div>`;
}

export function renderMicrophoneButton(): string {
  return `<button id="bar-btn-mic" class="btn btn-icon microphone-control" data-microphone-control type="button">
    ${renderAudioStateIcon('mic')}
    <span class="microphone-control-ptt" data-ptt-mode aria-hidden="true" hidden></span>
  </button>`;
}

export function bindPttIndicators(container: HTMLElement): () => void {
  const update = () => {
    const moderation = getVoiceControlModeration();
    const enabled = settingsStore.inputMode === 'push_to_talk';
    const state = !voiceStore.currentVoiceChannelId ? 'inactive'
      : voiceStore.getEffectiveMuted() ? 'muted'
      : voiceStore.microphoneOpen ? 'open' : 'closed';
    const label = `${t('ptt.enabled')} · ${t(`ptt.${state}`)}`;
    const key = settingsStore.pttKey.display;
    const describePttState = (value: typeof state) => `${t('ptt.enabled')} · ${t(`ptt.${value}`)}. ${t('ptt.holdToTalk', { key })} ${t(voiceStore.pttPressed ? 'ptt.pressed' : 'ptt.released')}`;
    const title = describePttState(state);
    container.querySelectorAll<HTMLButtonElement>('[data-microphone-control]').forEach((button) => {
      const muted = voiceStore.isMuted || voiceStore.isDeafened;
      const blocked = moderation.serverMuted || moderation.serverDeafened;
      const showPtt = enabled && !muted;
      const gateState = state === 'muted' ? 'closed' : state;
      const buttonState = muted ? 'muted' : enabled ? gateState : 'idle';
      const icon = muted ? 'mic_off' : enabled && gateState !== 'open' ? 'keyboard_voice' : 'mic';
      const muteReason = voiceStore.isDeafened ? t('ptt.deafened') : t('ptt.manualMuted');
      const action = t(voiceStore.isMuted ? 'main.unmute' : 'main.mute');
      const personalDescription = muted ? `${muteReason}. ${action}` : enabled ? `${describePttState(gateState)}. ${action}` : action;
      const description = [personalDescription, moderation.muteReason].filter(Boolean).join('. ');
      button.dataset.ptt = String(showPtt);
      button.dataset.state = buttonState;
      button.dataset.pressed = String(showPtt && voiceStore.pttPressed);
      button.classList.toggle('danger-active', muted);
      // Clicking controls manual mute; holding PTT only controls the audio gate.
      button.setAttribute('aria-pressed', String(voiceStore.isMuted));
      button.setAttribute('aria-label', description);
      button.title = description;
      updateAudioStateIcon(button, icon, blocked);
      const modeLabel = button.querySelector<HTMLElement>('[data-ptt-mode]');
      if (modeLabel) {
        modeLabel.hidden = !showPtt;
        modeLabel.textContent = t('ptt.enabled');
      }
    });
    container.querySelectorAll<HTMLElement>('[data-ptt-indicator]').forEach((indicator) => {
      indicator.hidden = !enabled;
      indicator.dataset.state = state;
      indicator.dataset.pressed = String(voiceStore.pttPressed);
      indicator.title = title;
      const values = [
        ['[data-ptt-icon]', state === 'open' ? 'mic' : 'mic_off'],
        ['[data-ptt-label]', label],
        ['[data-ptt-key]', key],
      ] as const;
      for (const [selector, text] of values) {
        const element = indicator.querySelector(selector);
        if (element && element.textContent !== text) element.textContent = text;
      }
    });
  };
  const unbind = ['voice.microphone_updated', 'voice.state_updated', 'voice.channel_changed', 'server.voice_restrictions_updated', 'settings.updated', 'i18n.language_changed']
    .map((event) => appEvents.on(event, update));
  update();
  return () => unbind.forEach((off) => off());
}
