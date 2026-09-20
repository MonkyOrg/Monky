import { isReceivingBotVoice, type VoiceParticipantState } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';

type AudioIcon = 'mic' | 'mic_off' | 'keyboard_voice' | 'headphones' | 'headset_off';
type IconSize = 12 | 14 | 18 | 24;

export function renderAudioStateIcon(icon: AudioIcon, blocked = false, size: IconSize = 18, label?: string): string {
  return `<span class="audio-state-icon${blocked ? ' audio-state-icon--blocked' : ''}${label ? ' audio-state-icon--status' : ''}" style="font-size: ${size}px;" ${label ? `role="img" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"` : 'aria-hidden="true"'}>
    <span class="material-symbols-outlined" data-audio-icon aria-hidden="true">${icon}</span>
    <span class="material-symbols-outlined audio-state-block" data-audio-block aria-hidden="true" ${blocked ? '' : 'hidden'}>block</span>
  </span>`;
}

export function updateAudioStateIcon(container: HTMLElement, icon: AudioIcon, blocked: boolean): void {
  container.querySelector('.audio-state-icon')?.classList.toggle('audio-state-icon--blocked', blocked);
  const base = container.querySelector('[data-audio-icon]');
  if (base && base.textContent !== icon) base.textContent = icon;
  const badge = container.querySelector<HTMLElement>('[data-audio-block]');
  if (badge) badge.hidden = !blocked;
}

export function renderAudioMuteIndicators(state: {
  isMuted: boolean;
  isDeafened: boolean;
  serverMuted?: boolean;
  serverDeafened?: boolean;
  receivesVoice?: boolean;
  botVoicePermissions?: VoiceParticipantState['botVoicePermissions'];
}, { size = 14, showMicrophone = true }: { size?: IconSize; showMicrophone?: boolean } = {}): string {
  const permissions = state.botVoicePermissions;
  const publishDenied = permissions?.publishRequested === true && !permissions.publish;
  const receiveDenied = permissions?.receiveRequested === true && !permissions.receive;
  const micBlocked = !!(state.serverMuted || state.serverDeafened || publishDenied);
  const micMuted = state.isMuted || state.isDeafened || micBlocked;
  const audioBlocked = !!(state.serverDeafened || receiveDenied);
  const audioMuted = state.isDeafened || audioBlocked;
  const micLabel = publishDenied ? t('botVoice.publishDenied') : state.serverDeafened ? t('permissions.serverDeafened')
    : state.serverMuted ? t('permissions.serverMuted') : t('main.micMuted');
  const audioLabel = receiveDenied ? t('botVoice.receiveDenied')
    : t(state.serverDeafened ? 'permissions.serverDeafened' : 'main.audioMuted');
  return (showMicrophone && micMuted ? renderAudioStateIcon(micBlocked ? 'mic' : 'mic_off', micBlocked, size, micLabel) : '')
    + (audioMuted ? renderAudioStateIcon(audioBlocked ? 'headphones' : 'headset_off', audioBlocked, size, audioLabel) : '')
    + (permissions?.receive === true && isReceivingBotVoice(state)
      ? `<span class="bot-voice-listening" role="status" title="${escapeHtml(t('botVoice.listeningDescription'))}"><span class="material-symbols-outlined md-${size}" aria-hidden="true">hearing</span><span>${escapeHtml(t('botVoice.listening'))}</span></span>`
      : '');
}
