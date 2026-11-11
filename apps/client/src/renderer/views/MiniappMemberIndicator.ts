import type { BotScreen } from '@monky/shared';
import { sessionManager } from '../core/SessionManager';
import { t } from '../i18n';
import { getBotVoiceContext } from '../utils/botVoice';
import { html } from '../utils/html';

function memberScreens(userId: string, channelId: string): BotScreen[] {
  const voice = getBotVoiceContext();
  if (!voice || voice.session !== sessionManager.getActive() || voice.channelId !== channelId) return [];
  return voice.session.botScreenStore.list(channelId)
    .filter((screen) => (screen.creatorUserId ?? screen.botId) === userId);
}

export function renderMiniappMemberIndicators(userId: string, channelId: string): string {
  return memberScreens(userId, channelId).map((screen) => {
    const label = t('botScreen.open', { title: screen.title });
    return html`<button type="button" class="voice-mini-icon live voice-mini-watch"
      data-member-miniapp="${screen.id}" data-miniapp-instance="${screen.instanceId}"
      data-miniapp-member="${userId}" data-miniapp-channel="${channelId}"
      title="${label}" aria-label="${label}">
      <span class="material-symbols-outlined md-14" aria-hidden="true">apps</span>
    </button>`;
  }).join('');
}

/** An old row must not open a replacement instance or a miniapp from another server. */
export function openMemberMiniapp(button: HTMLButtonElement, open: (id: string) => void): void {
  const screen = memberScreens(button.dataset.miniappMember ?? '', button.dataset.miniappChannel ?? '')
    .find((entry) => entry.id === button.dataset.memberMiniapp && entry.instanceId === button.dataset.miniappInstance);
  if (screen) open(screen.id);
}
