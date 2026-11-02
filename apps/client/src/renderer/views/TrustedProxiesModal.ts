import { parseTrustedProxies, type TrustedProxyProblem } from '@monky/shared';
import { t } from '../i18n';
import { connectionStore, type CreatedServer } from '../stores/connectionStore';
import { escapeHtml } from '../utils/html';
import { openModal, type ModalShell } from '../utils/modalShell';
import { renderSwitch } from '../utils/formControls';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { reportError } from '../utils/feedback';

function describeProblem(problem: TrustedProxyProblem): string {
  switch (problem.code) {
    case 'invalid': return t('trustedProxies.invalid', { entry: problem.entry });
    case 'everyone': return t('trustedProxies.everyone', { entry: problem.entry });
    case 'too-many': return t('trustedProxies.tooMany', { max: String(problem.max) });
  }
}

/**
 * Trusted reverse proxies of a server hosted by this app (#829). Off by
 * default; the list is checked by the same rule as the CLI and the server and
 * reaches the server when it is next started.
 */
export class TrustedProxiesModal {
  private shell: ModalShell | null = null;

  public open(serverId: string, returnFocus?: HTMLElement | null): void {
    const server = connectionStore.createdServers.find(item => item.id === serverId);
    if (!server) return;
    this.close();
    const enabled = !!server.trustedProxies?.length;
    const shell = openModal({
      card: `<div class="modal-card trusted-proxies-modal" aria-labelledby="trusted-proxies-title">
      <div class="modal-header">
        <div class="modal-title" id="trusted-proxies-title">${t('trustedProxies.title')}</div>
        <button type="button" class="modal-close-btn" data-modal-close aria-label="${escapeHtml(t('common.close'))}">&times;</button>
      </div>
      <form class="trusted-proxies-form" novalidate>
        <p class="trusted-proxies-intro">${t('trustedProxies.intro')}</p>
        <div class="form-group">
          <div class="channel-privacy-row">
            <div class="channel-privacy-info">
              <span class="channel-privacy-title" id="trusted-proxies-enable-title">${t('trustedProxies.enable')}</span>
              <span class="channel-privacy-desc" id="trusted-proxies-enable-desc">${t('trustedProxies.enableDesc')}</span>
            </div>
            ${renderSwitch({ id: 'trusted-proxies-enabled', labelledBy: 'trusted-proxies-enable-title',
              describedBy: 'trusted-proxies-enable-desc', checked: enabled })}
          </div>
        </div>
        <div class="form-group" id="trusted-proxies-list-group" ${enabled ? '' : 'hidden'}>
          <label for="trusted-proxies-list">${t('trustedProxies.listLabel')}</label>
          <textarea id="trusted-proxies-list" rows="3" spellcheck="false" autocomplete="off"
            aria-describedby="trusted-proxies-list-hint" placeholder="127.0.0.1">${escapeHtml(server.trustedProxies?.join('\n') ?? '')}</textarea>
          <small class="dialog-option-hint" id="trusted-proxies-list-hint">${t('trustedProxies.listHint')}</small>
        </div>
        <p class="dialog-option-hint">${t('trustedProxies.appliesOnStart')}</p>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-modal-close>${t('common.cancel')}</button>
          <button type="submit" class="btn btn-primary" data-trusted-proxies-save>${t('common.save')}</button>
        </div>
      </form>
    </div>`,
      returnFocus: returnFocus ?? document.activeElement,
      initialFocus: '#trusted-proxies-enabled',
      onClose: () => {
        if (this.shell === shell) this.shell = null;
      },
    });
    this.shell = shell;
    const root = shell.card;
    const toggle = root.querySelector<HTMLInputElement>('#trusted-proxies-enabled')!;
    const group = root.querySelector<HTMLElement>('#trusted-proxies-list-group')!;
    const list = root.querySelector<HTMLTextAreaElement>('#trusted-proxies-list')!;
    toggle.addEventListener('change', () => {
      setSurfaceVisible(group, toggle.checked);
      if (toggle.checked) list.focus({ preventScroll: true });
    }, { signal: shell.signal });
    root.querySelector('form')!.addEventListener('submit', (event) => {
      event.preventDefault();
      this.save(server.id, toggle.checked, list);
    }, { signal: shell.signal });
  }

  public close(): void {
    this.shell?.close('api');
  }

  private save(serverId: string, enabled: boolean, list: HTMLTextAreaElement): void {
    const current = connectionStore.createdServers.find(item => item.id === serverId);
    if (!current) {
      this.close();
      return;
    }
    let trustedProxies: string[] | undefined;
    if (enabled) {
      const parsed = parseTrustedProxies(list.value);
      if (!parsed.ok) {
        reportError(describeProblem(parsed.problem), { field: list, focus: true });
        return;
      }
      if (parsed.entries.length === 0) {
        reportError(t('trustedProxies.empty'), { field: list, focus: true });
        return;
      }
      trustedProxies = parsed.entries;
    }
    const next: CreatedServer = { ...current, trustedProxies };
    connectionStore.saveCreatedServer(next);
    this.close();
  }
}

export const trustedProxiesModal = new TrustedProxiesModal();
