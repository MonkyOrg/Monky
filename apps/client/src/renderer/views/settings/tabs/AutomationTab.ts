import {
  AUTOMATION_CAPABILITIES, type AutomationConnection, type AutomationMutation,
  type AutomationMutationResult, type AutomationSnapshot,
} from '@monky/shared';
import { sessionManager } from '../../../core/SessionManager';
import { connectionStore } from '../../../stores/connectionStore';
import { t } from '../../../i18n';
import { html } from '../../../utils/html';
import { renderSwitch } from '../../../utils/formControls';
import { copyText, reportError } from '../../../utils/feedback';
import { openModal } from '../../../utils/modalShell';
import { preserveViewState } from '../../../utils/preserveViewState';
import '../automation.css';

export class AutomationTab {
  private lifetime = new AbortController();
  private unsubscribe: (() => void) | null = null;
  private root: HTMLElement | null = null;
  private snapshot: AutomationSnapshot | null = null;
  private updateVersion = 0;

  renderHtml(): string {
    return html`<section class="automation-panel" data-settings-section="automation" data-settings-label="${t('automation.title')}">
      <p>${t('automation.description')}</p>
      <div class="automation-row"><span>${t('automation.enabled')}</span>${renderSwitch({ id: 'automation-enabled', label: t('automation.enabled'), checked: false })}</div>
      <div><span data-automation-status role="status"></span><br><code data-automation-url></code></div>
      <div class="automation-actions"><button class="btn btn-secondary" data-action="change_port">${t('automation.newPort')}</button>
        <button class="btn btn-primary" data-action="add">${t('automation.add')}</button></div>
      <div class="automation-list" data-automation-connections></div>
      <h3>${t('automation.history')}</h3><div class="automation-list" data-automation-history></div>
    </section>`.toString();
  }

  async attachEvents(root: HTMLElement): Promise<void> {
    this.cleanup();
    this.lifetime = new AbortController();
    const signal = this.lifetime.signal;
    this.root = root;
    root.addEventListener('change', event => {
      if (event.target instanceof HTMLInputElement && event.target.id === 'automation-enabled') {
        void this.mutate({ action: 'enable', enabled: event.target.checked });
      }
    }, { signal });
    root.addEventListener('click', event => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-action]') : null;
      if (!button || button.disabled) return;
      const connection = this.snapshot?.connections.find(item => item.id === button.dataset.connection);
      switch (button.dataset.action) {
        case 'add': this.edit(); break;
        case 'edit': if (connection) this.edit(connection); break;
        case 'change_port': void this.mutate({ action: 'change_port' }); break;
        case 'revoke': if (connection) void this.mutate({ action: 'revoke', id: connection.id }); break;
        case 'rotate': {
          if (!this.snapshot?.url) { reportError(t('automation.enableFirst')); break; }
          if (connection) void this.mutate({ action: 'rotate', id: connection.id }).then(result => {
            if (result?.credential && !signal.aborted) this.showCredential(result);
          });
          break;
        }
      }
    }, { signal });
    this.unsubscribe = window.api.onAutomationChanged(snapshot => {
      if (!signal.aborted) { this.updateVersion++; this.snapshot = snapshot; this.render(); }
    });
    const version = this.updateVersion;
    try {
      const snapshot = await window.api.getAutomationSnapshot();
      if (signal.aborted) return;
      if (version === this.updateVersion) this.snapshot = snapshot;
      this.render();
      if (snapshot.error) reportError(t(`automation.error.${snapshot.error}`));
    } catch { if (!signal.aborted) reportError(t('automation.error.failed')); }
  }

  private render(): void {
    const root = this.root;
    const snapshot = this.snapshot;
    if (!root || !snapshot) return;
    const enabled = root.querySelector<HTMLInputElement>('#automation-enabled');
    if (enabled) enabled.checked = snapshot.enabled;
    const status = root.querySelector('[data-automation-status]');
    if (status) status.textContent = t(snapshot.error ? 'automation.unavailable' : snapshot.url ? 'automation.running' : 'automation.stopped');
    const url = root.querySelector('[data-automation-url]');
    if (url) url.textContent = snapshot.url ?? '';
    const list = root.querySelector<HTMLElement>('[data-automation-connections]');
    if (list) preserveViewState(list, () => {
      list.innerHTML = html`${snapshot.connections.length ? snapshot.connections.map(connection => html`
        <article data-connection="${connection.id}"><strong>${connection.name}</strong>
          <p>${connection.capabilities.map(scope => t(`automation.scope.${scope}`)).join(' · ')}</p>
          <div class="automation-actions">
            <button class="btn btn-secondary" data-action="edit" data-connection="${connection.id}">${t('common.edit')}</button>
            <button class="btn btn-secondary" data-action="rotate" data-connection="${connection.id}">${t('automation.rotate')}</button>
            <button class="btn btn-secondary" data-action="revoke" data-connection="${connection.id}">${t('automation.revoke')}</button>
          </div></article>`) : html`<p>${t('automation.noConnections')}</p>`}`.toString();
    }, { itemKeys: ['data-connection'], fallback: () => root.querySelector('[data-action=add]') });
    const history = root.querySelector<HTMLElement>('[data-automation-history]');
    if (history) history.innerHTML = html`${snapshot.audit.length ? [...snapshot.audit].reverse().map(entry => html`
      <article><strong>${entry.connection} · ${t(`automation.tool.${entry.tool}`)}</strong>
        <span>${new Date(entry.timestamp).toLocaleString()} · ${t(`automation.${entry.result}`)}</span>
        ${entry.destination ? html`<small>${entry.destination}</small>` : null}</article>`)
      : html`<p>${t('automation.noHistory')}</p>`}`.toString();
  }

  private async mutate(input: AutomationMutation): Promise<AutomationMutationResult | null> {
    const signal = this.lifetime.signal;
    const version = this.updateVersion;
    try {
      const result = await window.api.mutateAutomation(input);
      if (signal.aborted) return null;
      if (version === this.updateVersion) this.snapshot = result.snapshot;
      this.render();
      const error = result.error ?? result.snapshot.error;
      if (error) { reportError(t(`automation.error.${error}`)); return null; }
      return result;
    } catch { if (!signal.aborted) reportError(t('automation.error.failed')); return null; }
  }

  private edit(connection?: AutomationConnection): void {
    if (!this.snapshot?.url) { reportError(t('automation.enableFirst')); return; }
    const servers = new Map<string, string>();
    for (const server of connectionStore.savedServers) if (server.serverId) servers.set(server.serverId, server.name);
    for (const session of sessionManager.getAll()) {
      const server = session.serverStore.serverDetails;
      if (server) servers.set(server.id, server.name);
    }
    for (const id of connection?.serverIds ?? []) if (!servers.has(id)) servers.set(id, id);
    let busy = false;
    const modal = openModal({
      signal: this.lifetime.signal, label: t('automation.add'), canClose: () => !busy,
      card: html`<div class="modal-card"><div class="modal-header"><h2>${t(connection ? 'common.edit' : 'automation.add')}</h2></div>
        <div class="modal-body automation-editor">
          <label>${t('automation.name')}<input type="text" name="assistant" maxlength="80" value="${connection?.name ?? ''}"></label>
          <fieldset><legend>${t('automation.servers')}</legend>${servers.size ? [...servers].map(([id, name]) => html`
            <div class="automation-row"><span>${name}</span>${renderSwitch({ label: name, checked: connection?.serverIds.includes(id) ?? false, attributes: html`data-server="${id}"` })}</div>`)
            : html`<p>${t('automation.noServers')}</p>`}</fieldset>
          <fieldset><legend>${t('automation.actions')}</legend>${AUTOMATION_CAPABILITIES.map(scope => html`
            <div class="automation-row"><span>${t(`automation.scope.${scope}`)}</span>${renderSwitch({ label: t(`automation.scope.${scope}`), checked: connection?.capabilities.includes(scope) ?? false, attributes: html`data-scope="${scope}"` })}</div>`)}</fieldset>
        </div><div class="modal-footer"><button class="btn btn-secondary" data-modal-close>${t('common.cancel')}</button>
          <button class="btn btn-primary" data-save>${t('common.save')}</button></div></div>`,
    });
    const save = modal.card.querySelector<HTMLButtonElement>('[data-save]');
    save?.addEventListener('click', () => {
      const name = modal.card.querySelector<HTMLInputElement>('[name=assistant]')?.value.trim() ?? '';
      const serverIds = [...modal.card.querySelectorAll<HTMLInputElement>('[data-server]:checked')].flatMap(input => input.dataset.server ? [input.dataset.server] : []);
      const capabilities = AUTOMATION_CAPABILITIES.filter(scope => modal.card.querySelector<HTMLInputElement>(`[data-scope="${scope}"]`)?.checked);
      if (!name || !serverIds.length || !capabilities.length) { reportError(t('automation.error.invalid_input')); return; }
      busy = true;
      if (save) save.disabled = true;
      void this.mutate({ action: 'save', connection: { id: connection?.id, name, serverIds, capabilities } }).then(result => {
        busy = false;
        if (save) save.disabled = false;
        if (!result || modal.signal.aborted) return;
        modal.close();
        if (result.credential) this.showCredential(result);
      });
    }, { signal: modal.signal });
  }

  private showCredential(result: AutomationMutationResult): void {
    const credential = result.credential;
    const url = result.snapshot.url;
    if (!credential || !url) return;
    const suffix = credential.id.replaceAll('-', '').slice(0, 12);
    const variable = `MONKY_MCP_${suffix.toUpperCase()}`;
    const assign = window.api.platform === 'win32' ? `$env:${variable} = '${credential.token}'` : `export ${variable}='${credential.token}'`;
    const commands = `${assign}\ncodex mcp add monky-${suffix} --url "${url}" --bearer-token-env-var ${variable}`;
    const modal = openModal({ signal: this.lifetime.signal, label: t('automation.setup'),
      card: html`<div class="modal-card automation-setup"><div class="modal-header"><h2>${t('automation.setup')}</h2></div>
        <div class="modal-body"><p>${t('automation.setupDescription')}</p><pre>${commands}</pre></div>
        <div class="modal-footer"><button class="btn btn-secondary" data-modal-close>${t('common.close')}</button>
          <button class="btn btn-primary" data-copy>${t('automation.copy')}</button></div></div>`,
    });
    modal.card.querySelector('[data-copy]')?.addEventListener('click', () => {
      void copyText(commands, { copied: t('automation.copied'), failed: t('automation.copyFailed') });
    }, { signal: modal.signal });
  }

  cleanup(): void {
    this.lifetime.abort();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.root = null;
    this.snapshot = null;
  }
}
