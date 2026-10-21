import type { HostedBotUpdateWarning } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';

export function showUpdateCompatibility(
  warnings: HostedBotUpdateWarning[],
): Promise<'install' | 'retry' | 'cancel'> {
  return new Promise(resolve => {
    const incompatible = warnings.some(server => server.bots.some(bot => bot.status === 'incompatible'));
    const unknown = warnings.some(server => server.bots.some(bot => bot.status === 'unknown'));
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card update-compatibility-card" role="dialog" aria-modal="true"
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
      </div>`;
    let settled = false;
    const settle = (action: 'install' | 'retry' | 'cancel'): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', keydown, true);
      exitModal(backdrop);
      resolve(action);
    };
    const keydown = (event: KeyboardEvent): void => {
      if (!handlesModalKey(backdrop, event)) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        settle('cancel');
      } else if (event.key === 'Tab') {
        const controls = [...backdrop.querySelectorAll<HTMLButtonElement>('button')];
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    for (const button of backdrop.querySelectorAll<HTMLButtonElement>('button')) {
      button.addEventListener('click', () => {
        const action = button.dataset.action;
        if (action === 'install' || action === 'retry' || action === 'cancel') settle(action);
      });
    }
    backdrop.addEventListener('mousedown', event => { if (event.target === backdrop) settle('cancel'); });
    document.addEventListener('keydown', keydown, true);
    document.body.appendChild(backdrop);
    enterModal(backdrop);
    backdrop.querySelector<HTMLButtonElement>('.modal-footer [data-action="cancel"]')?.focus();
  });
}
