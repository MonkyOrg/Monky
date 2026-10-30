import type { HostedBotUpdateWarning } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { openModal } from '../utils/modalShell';

export function showUpdateCompatibility(
  warnings: HostedBotUpdateWarning[],
): Promise<'install' | 'retry' | 'cancel'> {
  return new Promise(resolve => {
    const incompatible = warnings.some(server => server.bots.some(bot => bot.status === 'incompatible'));
    const unknown = warnings.some(server => server.bots.some(bot => bot.status === 'unknown'));
    let action: 'install' | 'retry' | 'cancel' = 'cancel';
    const shell = openModal({
      card: `
      <div class="modal-card update-compatibility-card"
        aria-labelledby="update-compatibility-title" aria-describedby="update-compatibility-message">
        <div class="modal-header">
          <div class="modal-title" id="update-compatibility-title">
            <span class="material-symbols-outlined" aria-hidden="true">warning</span>
            ${escapeHtml(t(incompatible ? 'update.localBotsTitle' : 'update.localBotsUnknownTitle'))}
          </div>
          <button type="button" class="modal-close-btn" data-action="cancel" aria-label="${escapeHtml(t('common.close'))}">
            <span class="material-symbols-outlined" aria-hidden="true">close</span>
          </button>
        </div>
        <p class="dialog-message" id="update-compatibility-message">${escapeHtml(t(incompatible ? 'update.localBotsMessage' : 'update.localBotsUnknownMessage'))}</p>
        <div class="update-compatibility-servers">
          ${warnings.map(server => `<section class="update-compatibility-server">
            <strong>${escapeHtml(server.serverName)}</strong>
            <ul>${server.bots.map(bot => `<li><span>${escapeHtml(bot.name)}</span>
              <small>${escapeHtml(t(bot.status === 'incompatible' ? 'update.localBotIncompatible' : 'update.localBotUnknown'))}</small></li>`).join('')}</ul>
          </section>`).join('')}
        </div>
        <p class="dialog-note">${escapeHtml(t(incompatible ? 'update.localBotsNote' : 'update.localBotsUnknownNote'))}</p>
        <div class="modal-footer">
          ${unknown ? `<button type="button" class="btn btn-secondary" data-action="retry">${escapeHtml(t('common.retry'))}</button>` : ''}
          <button type="button" class="btn btn-secondary" data-action="install">${escapeHtml(t(incompatible ? 'update.installAnyway' : 'update.installUnchecked'))}</button>
          <button type="button" class="btn btn-primary" data-action="cancel">${escapeHtml(t('update.notNow'))}</button>
        </div>
      </div>`,
      initialFocus: '.modal-footer [data-action="cancel"]',
      onClose: () => resolve(action),
    });
    for (const button of shell.card.querySelectorAll<HTMLButtonElement>('button')) {
      button.addEventListener('click', () => {
        const chosen = button.dataset.action;
        if (chosen !== 'install' && chosen !== 'retry' && chosen !== 'cancel') return;
        action = chosen;
        shell.close('button');
      }, { signal: shell.signal });
    }
  });
}
