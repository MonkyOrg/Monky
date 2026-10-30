import type { AppIdentityResult, AppIdentityStatus, IdentityUnreadableReason } from '@monky/shared';
import logoUrl from '../assets/Logo.png';
import { clientLog } from '../core/ClientLogService';
import { t, type TranslationKey } from '../i18n';
import { setButtonLoading } from '../utils/buttonLoading';
import { html } from '../utils/html';
import { showErrorToast } from './CopyToast';
import { showConfirm } from './Dialog';
import { showIdentityImportDialog } from './IdentityDialogs';

const UNREADABLE_MESSAGES: Record<IdentityUnreadableReason, TranslationKey> = {
  locked: 'identity.unreadableLocked',
  corrupt: 'identity.unreadableCorrupt',
  io: 'identity.unreadableIo',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * First screen while this computer has no usable identity: create or import
 * one. When the stored identity exists but could not be opened (#490), the
 * user first gets to try again; creating another identity then needs an
 * explicit confirmation, and the unreadable file is set aside, never deleted.
 *
 * Resolves with the identity the user ends up with. `onPainted` runs after the
 * first paint, which lifts the post-update splash (#498).
 */
export function showIdentityOnboarding(
  container: HTMLElement,
  initial: AppIdentityStatus,
  onPainted: () => void,
): Promise<AppIdentityResult> {
  return new Promise((resolve) => {
    let status = initial;
    let busy = false;

    /** One action at a time; whatever happens, the screen ends up matching the stored identity. */
    const run = async (
      button: HTMLButtonElement, failure: TranslationKey, action: () => Promise<AppIdentityResult | null>,
    ): Promise<void> => {
      if (busy) return;
      busy = true;
      setButtonLoading(button, true);
      try {
        const identity = await action();
        if (identity) {
          resolve(identity);
          return;
        }
      } catch (error) {
        clientLog.warn('IDENTITY', 'Identity onboarding action failed', { error: errorText(error) });
        showErrorToast(t(failure));
      } finally {
        busy = false;
        setButtonLoading(button, false);
      }
    };

    const create = async (): Promise<AppIdentityResult | null> => {
      if (status.state === 'unreadable') {
        const confirmed = await showConfirm({
          title: t('identity.replaceTitle'),
          message: t('identity.replaceMessage'),
          confirmLabel: t('identity.onboardingCreate'),
          variant: 'danger',
          focusCancel: true,
        });
        if (!confirmed) return null;
      }
      return window.api.createIdentity();
    };

    const retry = async (): Promise<AppIdentityResult | null> => {
      const next = await window.api.getIdentityStatus();
      if (next.state === 'ready') return window.api.getIdentity();
      const changed = next.state !== status.state || (next.state === 'unreadable' && status.state === 'unreadable' && next.reason !== status.reason);
      status = next;
      if (changed) render();
      if (next.state === 'unreadable') showErrorToast(t('identity.unreadableStill'));
      return null;
    };

    const bind = (): void => {
      const on = (id: string, failure: TranslationKey, action: () => Promise<AppIdentityResult | null>): void => {
        const button = container.querySelector<HTMLButtonElement>(`#${id}`);
        if (!button) return;
        button.addEventListener('click', () => { void run(button, failure, action); });
      };
      on('btn-onboard-create', 'identity.createFailed', create);
      on('btn-onboard-import', 'identity.importError', () => showIdentityImportDialog());
      on('btn-onboard-retry', 'identity.unreadableStill', retry);
    };

    const render = (): void => {
      if (status.state === 'unreadable') {
        container.innerHTML = html`
          <div class="identity-onboarding identity-profile-step identity-unreadable" data-reason="${status.reason}">
            <img src="${logoUrl}" alt="Monky" class="identity-profile-logo">
            <h1 id="identity-unreadable-title">${t('identity.unreadableTitle')}</h1>
            <p id="identity-unreadable-reason">${t(UNREADABLE_MESSAGES[status.reason])}</p>
            <p>${t('identity.unreadableKept')}</p>
            <div style="display: flex; flex-direction: column; gap: 12px; width: 280px;" role="group" aria-labelledby="identity-unreadable-title">
              <button type="button" id="btn-onboard-retry" class="btn btn-primary" style="padding: 14px 24px; font-size: 15px; font-weight: 600;">
                <span class="material-symbols-outlined md-20" style="margin-right: 8px;" aria-hidden="true">refresh</span>
                ${t('identity.unreadableRetry')}
              </button>
              <button type="button" id="btn-onboard-import" class="btn btn-secondary" style="padding: 14px 24px; font-size: 15px;">
                <span class="material-symbols-outlined md-20" style="margin-right: 8px;" aria-hidden="true">qr_code_scanner</span>
                ${t('identity.onboardingImport')}
              </button>
              <button type="button" id="btn-onboard-create" class="btn btn-secondary" style="padding: 14px 24px; font-size: 15px;">
                <span class="material-symbols-outlined md-20" style="margin-right: 8px;" aria-hidden="true">add_circle</span>
                ${t('identity.onboardingCreate')}
              </button>
            </div>
          </div>
        `.toString();
        bind();
        container.querySelector<HTMLButtonElement>('#btn-onboard-retry')?.focus({ preventScroll: true });
        return;
      }
      container.innerHTML = html`
        <div class="identity-onboarding">
          <img src="${logoUrl}" alt="Monky" style="width: 120px; height: 120px; object-fit: contain; margin-bottom: 16px; filter: drop-shadow(0 4px 16px rgba(88, 101, 242, 0.4));">
          <h1 style="font-size: 28px; font-weight: 700; margin: 0 0 8px; color: var(--text-primary);">Monky</h1>
          <p style="font-size: 14px; color: var(--text-secondary); margin: 0 0 32px; text-align: center; max-width: 360px; line-height: 1.5;">
            ${t('identity.onboardingDesc')}
          </p>
          <div style="display: flex; flex-direction: column; gap: 12px; width: 280px;">
            <button type="button" id="btn-onboard-create" class="btn btn-primary" style="padding: 14px 24px; font-size: 15px; font-weight: 600;">
              <span class="material-symbols-outlined md-20" style="margin-right: 8px;">add_circle</span>
              ${t('identity.onboardingCreate')}
            </button>
            <button type="button" id="btn-onboard-import" class="btn btn-secondary" style="padding: 14px 24px; font-size: 15px;">
              <span class="material-symbols-outlined md-20" style="margin-right: 8px;">qr_code_scanner</span>
              ${t('identity.onboardingImport')}
            </button>
          </div>
        </div>
      `.toString();
      bind();
    };

    render();
    onPainted();
  });
}
