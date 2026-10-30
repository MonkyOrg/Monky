import type { BotCapability, BotInstallPreview } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { openModal } from '../utils/modalShell';
import { readBotPermissionChange, renderBotPermissionControls, syncBotPermissionControls } from './botPermissionControls';

export function showBotPermissionReview(preview: BotInstallPreview, signal: AbortSignal): Promise<BotCapability[] | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const requested = preview.manifest.requestedCapabilities;
    let granted: BotCapability[] = [];
    let result: BotCapability[] | null = null;
    const shell = openModal({
      backdropClass: 'bot-permission-review',
      card: `<div class="modal-card bot-permission-review-card" aria-labelledby="bot-permission-review-title">
      <div class="modal-header"><h2 id="bot-permission-review-title" class="modal-title">${escapeHtml(t('botPermissions.reviewTitle', { name: preview.manifest.name }))}</h2></div>
      <div class="bot-permission-review-body">
        ${preview.manifest.description ? `<p>${escapeHtml(preview.manifest.description)}</p>` : ''}
        ${renderBotPermissionControls(requested, granted, 'bot-install')}
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-review-cancel data-modal-close>${escapeHtml(t('common.cancel'))}</button>
        <button type="button" class="btn btn-primary" data-review-confirm>${escapeHtml(t('botPermissions.confirmInstall'))}</button>
      </div>
    </div>`,
      signal,
      initialFocus: '[data-review-cancel]',
      onClose: () => resolve(result),
    });
    shell.card.addEventListener('change', (event) => {
      const next = readBotPermissionChange(event.target, requested, granted);
      if (!next) return;
      granted = next;
      syncBotPermissionControls(shell.card, requested, granted);
    }, { signal: shell.signal });
    shell.card.querySelector('[data-review-confirm]')?.addEventListener('click', () => {
      result = granted.slice();
      shell.close('button');
    }, { signal: shell.signal });
  });
}
