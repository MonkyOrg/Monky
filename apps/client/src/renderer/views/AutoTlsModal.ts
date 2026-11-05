import { AUTO_TLS_LOW_PORT_COMMAND, AUTO_TLS_VALIDATION_PORT, type AutoTlsErrorCode, type AutoTlsStatus } from '@monky/shared';
import { getLanguage, t, type TranslationKey } from '../i18n';
import { escapeHtml } from '../utils/html';
import { openModal, type ModalShell } from '../utils/modalShell';
import { renderSwitch } from '../utils/formControls';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { reportError } from '../utils/feedback';
import { showConfirm } from './Dialog';

const ERROR_KEYS: Record<AutoTlsErrorCode, TranslationKey> = {
  'no-public-ip': 'autoTls.error.noPublicIp',
  'address-not-public': 'autoTls.error.addressNotPublic',
  'port-in-use': 'autoTls.error.portInUse',
  'port-permission': 'autoTls.error.portPermission',
  'privilege-unavailable': 'autoTls.error.privilegeUnavailable',
  unreachable: 'autoTls.error.unreachable',
  'rate-limited': 'autoTls.error.rateLimited',
  rejected: 'autoTls.error.rejected',
  network: 'autoTls.error.network',
  storage: 'autoTls.error.storage',
};

export function describeAutoTlsError(code: AutoTlsErrorCode): string {
  return t(ERROR_KEYS[code], { port: AUTO_TLS_VALIDATION_PORT, command: AUTO_TLS_LOW_PORT_COMMAND });
}

function formatInstant(timestamp: number | null): string {
  return timestamp ? new Date(timestamp).toLocaleString(getLanguage()) : '—';
}

/**
 * Automatic secure connection of a server this app hosts (#860): a short-lived
 * Let's Encrypt certificate for the public IP, so `wss://` works without a
 * domain or a proxy. Turning it on proves first that the CA reaches the host,
 * and stays off when it does not.
 */
export class AutoTlsModal {
  private shell: ModalShell | null = null;

  public async open(port: number, returnFocus?: HTMLElement | null): Promise<void> {
    this.close();
    const status = await window.api.hostServerAutoTlsStatus(port);
    if (!status) {
      reportError(t('autoTls.notRunning'));
      return;
    }
    const shell = openModal({
      card: `<div class="modal-card auto-tls-modal" aria-labelledby="auto-tls-title">
      <div class="modal-header">
        <div class="modal-title" id="auto-tls-title">${t('autoTls.title')}</div>
        <button type="button" class="modal-close-btn" data-modal-close aria-label="${escapeHtml(t('common.close'))}">&times;</button>
      </div>
      <p class="auto-tls-intro">${t('autoTls.intro', { port: AUTO_TLS_VALIDATION_PORT })}</p>
      <div class="form-group">
        <div class="channel-privacy-row">
          <div class="channel-privacy-info">
            <span class="channel-privacy-title" id="auto-tls-enable-title">${t('autoTls.enable')}</span>
            <span class="channel-privacy-desc" id="auto-tls-enable-desc">${t('autoTls.enableDesc')}</span>
          </div>
          ${renderSwitch({ id: 'auto-tls-enabled', labelledBy: 'auto-tls-enable-title',
            describedBy: 'auto-tls-enable-desc', checked: status.enabled })}
        </div>
      </div>
      <p class="auto-tls-busy" id="auto-tls-busy" role="status" aria-live="polite" hidden></p>
      <dl class="auto-tls-details" id="auto-tls-details" ${status.enabled ? '' : 'hidden'}>
        <dt>${t('autoTls.address')}</dt><dd data-auto-tls="address"></dd>
        <dt>${t('autoTls.validUntil')}</dt><dd data-auto-tls="valid-until"></dd>
        <dt>${t('autoTls.nextRenewal')}</dt><dd data-auto-tls="next-renewal"></dd>
        <dt data-auto-tls="error-label">${t('autoTls.lastError')}</dt><dd data-auto-tls="error"></dd>
      </dl>
      <p class="dialog-option-hint">${t('autoTls.limits')}</p>
      <div class="modal-footer">
        <button type="button" class="btn btn-secondary" data-modal-close>${t('common.close')}</button>
      </div>
    </div>`,
      returnFocus: returnFocus ?? document.activeElement,
      initialFocus: '#auto-tls-enabled',
      onClose: () => {
        if (this.shell === shell) this.shell = null;
      },
    });
    this.shell = shell;
    this.render(shell, status, port);
    const toggle = shell.card.querySelector<HTMLInputElement>('#auto-tls-enabled')!;
    toggle.addEventListener('change', () => {
      void this.apply(shell, port, toggle.checked);
    }, { signal: shell.signal });
  }

  public close(): void {
    this.shell?.close('api');
  }

  private async apply(shell: ModalShell, port: number, enable: boolean): Promise<void> {
    const toggle = shell.card.querySelector<HTMLInputElement>('#auto-tls-enabled')!;
    const busy = shell.card.querySelector<HTMLElement>('#auto-tls-busy')!;
    toggle.disabled = true;
    busy.textContent = t(enable ? 'autoTls.checking' : 'autoTls.disabling', { port: AUTO_TLS_VALIDATION_PORT });
    setSurfaceVisible(busy, true);
    try {
      if (!enable) {
        const status = await window.api.hostServerAutoTlsDisable(port);
        if (shell.closed) return;
        if (status) this.render(shell, status, port);
        return;
      }
      let result = await window.api.hostServerAutoTlsEnable(port, false);
      if (shell.closed) return;
      if (!result.ok && result.code === 'port-permission') {
        const consent = await showConfirm({
          title: t('autoTls.grantTitle', { port: AUTO_TLS_VALIDATION_PORT }),
          message: t('autoTls.grantMessage', { port: AUTO_TLS_VALIDATION_PORT, command: AUTO_TLS_LOW_PORT_COMMAND }),
          confirmLabel: t('autoTls.grantConfirm'),
          variant: 'warning',
        });
        if (shell.closed) return;
        if (consent) result = await window.api.hostServerAutoTlsEnable(port, true);
        if (shell.closed) return;
      }
      if (result.ok) {
        this.render(shell, result.status, port);
        return;
      }
      toggle.checked = false;
      reportError(`${t('autoTls.notEnabled')} ${describeAutoTlsError(result.code)}`);
    } catch (error) {
      if (shell.closed) return;
      toggle.checked = !enable;
      reportError(t('autoTls.failed'), { log: 'APP', error });
    } finally {
      if (!shell.closed) {
        toggle.disabled = false;
        setSurfaceVisible(busy, false);
      }
    }
  }

  private render(shell: ModalShell, status: AutoTlsStatus, port: number): void {
    const card = shell.card;
    const toggle = card.querySelector<HTMLInputElement>('#auto-tls-enabled')!;
    toggle.checked = status.enabled;
    const set = (name: string, value: string) => {
      const element = card.querySelector<HTMLElement>(`[data-auto-tls="${name}"]`);
      if (element) element.textContent = value;
    };
    set('address', status.active && status.ip ? `wss://${status.ip}:${port}` : t('autoTls.inactive'));
    set('valid-until', formatInstant(status.validUntil));
    set('next-renewal', formatInstant(status.nextRenewalAt));
    const error = status.lastError;
    set('error', error ? `${describeAutoTlsError(error.code)} (${formatInstant(error.at)})` : '');
    for (const name of ['error', 'error-label']) {
      const element = card.querySelector<HTMLElement>(`[data-auto-tls="${name}"]`);
      if (element) element.hidden = !error;
    }
    setSurfaceVisible(card.querySelector<HTMLElement>('#auto-tls-details')!, status.enabled);
  }
}

export const autoTlsModal = new AutoTlsModal();
