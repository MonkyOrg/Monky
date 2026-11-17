import type { AppIdentityResult, AppIdentityStatus, IdentityUnreadableReason } from '@monky/shared';
import logoUrl from '../assets/Logo.png';
import { clientLog } from '../core/ClientLogService';
import { t, type TranslationKey } from '../i18n';
import { setButtonLoading } from '../utils/buttonLoading';
import { html } from '../utils/html';
import { showErrorToast } from './CopyToast';
import { showConfirm, showConfirmWithText } from './Dialog';
import { nicknameError } from '../utils/nickname';
import { showIdentityExportDialog, showIdentityImportDialog } from './IdentityDialogs';
import { platformSupports } from '../platform/capabilities';

const UNREADABLE_MESSAGES: Record<IdentityUnreadableReason, TranslationKey> = {
  locked: 'identity.unreadableLocked',
  corrupt: 'identity.unreadableCorrupt',
  io: 'identity.unreadableIo',
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * In a browser, clearing the site's data deletes the identity with it (#858):
 * right after creating one, the person is urged to export a copy. The profile
 * step offers it inline; this dialog is for when that step is skipped.
 */
export async function offerWebBackup(clientId: string): Promise<void> {
  const exportNow = await showConfirm({
    title: t('identity.webBackupTitle'),
    message: t('identity.webBackupMessage'),
    confirmLabel: t('identity.webBackupNow'),
    cancelLabel: t('identity.webBackupLater'),
    variant: 'info',
  });
  if (exportNow) await showIdentityExportDialog(clientId);
}

export interface IdentityOnboardingResult {
  identity: AppIdentityResult;
  /** A new identity that lives only in this browser, which should be backed up now. */
  offerBackup: boolean;
}

/**
 * First screen while this computer has no usable identity: create or import
 * one. When the stored identity exists but could not be opened (#490), the
 * user first gets to try again; creating another identity then needs an
 * explicit confirmation, and the unreadable file is set aside, never deleted.
 *
 * Resolves with the identity the user ends up with, and whether it still needs
 * a backup. `onPainted` runs after the first paint, which lifts the
 * post-update splash (#498).
 */
export function showIdentityOnboarding(
  container: HTMLElement,
  initial: AppIdentityStatus,
  onPainted: () => void,
): Promise<IdentityOnboardingResult> {
  return new Promise((resolve) => {
    let status = initial;
    let busy = false;
    let created = false;

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
          resolve({ identity, offerBackup: created && !platformSupports('durableIdentity') });
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
      const identity = await window.api.createIdentity();
      created = true;
      return identity;
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
    const guest = async (): Promise<AppIdentityResult | null> => {
      const choice = await showConfirmWithText({
        title: t('identity.guestAction'), message: t('identity.guestHint'),
        confirmLabel: t('identity.guestAction'),
        textInput: { label: t('connection.nicknameLabel'), value: '', maxLength: 32, validate: value => nicknameError(value) ?? undefined },
        variant: 'info',
      });
      return choice.confirmed ? window.api.createGuestIdentity(choice.value) : null;
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
      on('btn-onboard-guest', 'identity.createFailed', guest);
    };

    const render = (): void => {
      if (status.state === 'unreadable') {
        container.innerHTML = html`
          <div class="identity-onboarding identity-profile-step identity-unreadable" data-reason="${status.reason}">
            <div class="identity-welcome-brand">
              <img src="${logoUrl}" alt="Monky" class="identity-profile-logo">
              <h1 id="identity-unreadable-title">${t('identity.unreadableTitle')}</h1>
              <p id="identity-unreadable-reason">${t(UNREADABLE_MESSAGES[status.reason])}</p>
              <p>${t('identity.unreadableKept')}</p>
            </div>
            <div class="identity-welcome-actions" role="group" aria-labelledby="identity-unreadable-title">
              <button type="button" id="btn-onboard-retry" class="btn btn-primary identity-welcome-action">
                <span class="material-symbols-outlined md-20" aria-hidden="true">refresh</span>
                ${t('identity.unreadableRetry')}
              </button>
              <button type="button" id="btn-onboard-import" class="btn btn-secondary identity-welcome-action">
                <span class="material-symbols-outlined md-20" aria-hidden="true">qr_code_scanner</span>
                ${t('identity.onboardingImport')}
              </button>
              <button type="button" id="btn-onboard-create" class="btn btn-secondary identity-welcome-action">
                <span class="material-symbols-outlined md-20" aria-hidden="true">add_circle</span>
                ${t('identity.onboardingCreate')}
              </button>
              <button type="button" id="btn-onboard-guest" class="btn btn-secondary identity-welcome-guest">${t('identity.guestAction')}</button>
            </div>
          </div>
        `.toString();
        bind();
        container.querySelector<HTMLButtonElement>('#btn-onboard-retry')?.focus({ preventScroll: true });
        return;
      }
      container.innerHTML = html`
        <div class="identity-onboarding identity-welcome">
          <div class="identity-welcome-brand">
            <img src="${logoUrl}" alt="Monky" class="identity-welcome-logo">
            <h1>Monky</h1>
            <p>${t('identity.onboardingDesc')}</p>
          </div>
          <div class="identity-welcome-actions">
            <button type="button" id="btn-onboard-create" class="btn btn-primary identity-welcome-action">
              <span class="material-symbols-outlined md-20" aria-hidden="true">add_circle</span>
              ${t('identity.onboardingCreate')}
            </button>
            <button type="button" id="btn-onboard-import" class="btn btn-secondary identity-welcome-action">
              <span class="material-symbols-outlined md-20" aria-hidden="true">qr_code_scanner</span>
              ${t('identity.onboardingImport')}
            </button>
            <button type="button" id="btn-onboard-guest" class="btn btn-secondary identity-welcome-guest">${t('identity.guestAction')}</button>
          </div>
        </div>
      `.toString();
      bind();
    };

    render();
    onPainted();
  });
}
