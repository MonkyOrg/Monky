import { appEvents } from '../core/EventBus';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
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
    const enabled = settingsStore.inputMode === 'push_to_talk';
    const state = !voiceStore.currentVoiceChannelId ? 'inactive'
      : voiceStore.getEffectiveMuted() ? 'muted'
      : voiceStore.microphoneOpen ? 'open' : 'closed';
    const label = `${t('ptt.enabled')} · ${t(`ptt.${state}`)}`;
    const key = settingsStore.pttKey.display;
    const title = `${label}. ${t('ptt.holdToTalk', { key })} ${t(voiceStore.pttPressed ? 'ptt.pressed' : 'ptt.released')}`;
    container.querySelectorAll<HTMLButtonElement>('[data-microphone-control]').forEach((button) => {
      const muted = voiceStore.getEffectiveMuted();
      const blocked = voiceStore.serverMuted || voiceStore.serverDeafened;
      const showPtt = enabled && !muted;
      const buttonState = muted ? 'muted' : enabled ? state : 'idle';
      const icon = blocked ? 'mic' : muted ? 'mic_off' : enabled && state !== 'open' ? 'keyboard_voice' : 'mic';
      const muteReason = voiceStore.serverDeafened ? t('permissions.serverDeafened')
        : voiceStore.serverMuted ? t('permissions.serverMuted')
        : voiceStore.isDeafened ? t('ptt.deafened') : t('ptt.manualMuted');
      const action = t(voiceStore.isMuted ? 'main.unmute' : 'main.mute');
      const description = muted ? `${muteReason}. ${action}` : enabled ? `${title}. ${action}` : action;
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
  const unbind = ['voice.microphone_updated', 'voice.state_updated', 'voice.channel_changed', 'settings.updated', 'i18n.language_changed']
    .map((event) => appEvents.on(event, update));
  update();
  return () => unbind.forEach((off) => off());
}
