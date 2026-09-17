import type { BotCapability, BotInstallPreview } from '@monky/shared';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { enableBackdropClose } from '../utils/modal';
import { readBotPermissionChange, renderBotPermissionControls, syncBotPermissionControls } from './botPermissionControls';

export function showBotPermissionReview(preview: BotInstallPreview, signal: AbortSignal): Promise<BotCapability[] | null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const root = document.createElement('div');
    root.className = 'modal-backdrop bot-permission-review';
    const requested = preview.manifest.requestedCapabilities;
    let granted: BotCapability[] = [];
    let settled = false;
    root.innerHTML = `<div class="modal-card bot-permission-review-card" role="dialog" aria-modal="true" aria-labelledby="bot-permission-review-title">
      <div class="modal-header"><h2 id="bot-permission-review-title" class="modal-title">${escapeHtml(t('botPermissions.reviewTitle', { name: preview.manifest.name }))}</h2></div>
      <div class="bot-permission-review-body">
        ${preview.manifest.description ? `<p>${escapeHtml(preview.manifest.description)}</p>` : ''}
        ${renderBotPermissionControls(requested, granted, 'bot-install')}
      </div>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-review-cancel>${t('common.cancel')}</button>
        <button type="button" class="btn btn-primary" data-review-confirm>${t('botPermissions.confirmInstall')}</button>
      </div>
    </div>`;
    const close = (result: BotCapability[] | null): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      signal.removeEventListener('abort', onAbort);
      root.remove();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(result);
    };
    const onAbort = () => close(null);
    const onKeyDown = (event: KeyboardEvent): void => {
      if ([...document.querySelectorAll('.modal-backdrop')].at(-1) !== root) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation(); close(null);
      } else if (event.key === 'Tab') {
        const controls = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    root.addEventListener('change', (event) => {
      const next = readBotPermissionChange(event.target, requested, granted);
      if (!next) return;
      granted = next;
      syncBotPermissionControls(root, requested, granted);
    });
    root.querySelector('[data-review-cancel]')?.addEventListener('click', () => close(null));
    root.querySelector('[data-review-confirm]')?.addEventListener('click', () => close(granted.slice()));
    enableBackdropClose(root, () => close(null));
    document.addEventListener('keydown', onKeyDown, true);
    signal.addEventListener('abort', onAbort, { once: true });
    document.body.append(root);
    if (signal.aborted) close(null);
    else root.querySelector<HTMLElement>('[data-review-cancel]')?.focus();
  });
}
