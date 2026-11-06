import { serverStore } from '../../../stores/serverStore';
import { sessionManager, type ServerSession } from '../../../core/SessionManager';
import { findOwnedServer, knownServerPassword } from '../../../core/hostedServerStart';
import { connectionStore } from '../../../stores/connectionStore';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import { copyText, reportError, validationMessage } from '../../../utils/feedback';
import { setSurfaceVisible } from '../../../utils/surfaceVisibility';
import type { ServerSettingsContext } from '../ServerSettingsContext';
import { serverSettingsValidationError } from '../serverSettingsValidation';

/** Fixed length, so the hidden password does not reveal how long it is. */
const MASK = '••••••••';

/** Applies a password change through the modal's queue; resolves whether the server acknowledged it. */
export type ApplyPassword = (password: string | null) => Promise<boolean>;

/**
 * The server only says whether it has a password (`hasPassword`), never which
 * one. "Show" and "Copy" use the password this device already knows: the one
 * it connected with, or the one its own hosted server was created with.
 */
export class ServerSecurityTab {
  private revealed = false;

  public renderHtml(): string {
    if (!serverStore.serverDetails) return '';
    this.revealed = false;
    const button = (id: string, icon: string, label: string, extra = '') => `
      <button type="button" id="${id}" class="btn btn-secondary server-password-action" ${extra}>
        <span class="material-symbols-outlined md-16" aria-hidden="true">${icon}</span><span data-label>${escapeHtml(label)}</span>
      </button>`;
    return `
      <div data-settings-section="server-password" data-settings-label="${escapeHtml(t('serverSettings.passwordSection'))}">
        <div id="server-password-card" class="server-password-card" data-state="off">
          <div class="server-password-head">
            <span id="password-status-icon" class="material-symbols-outlined server-password-icon" aria-hidden="true">lock_open</span>
            <div class="server-password-text">
              <div id="password-status-title" class="server-password-title"></div>
              <div id="password-status-desc" class="server-password-desc"></div>
            </div>
          </div>
          <div id="server-password-value-row" class="server-password-value-row" hidden>
            <code id="server-password-value" class="server-password-value">${MASK}</code>
          </div>
          <div id="server-password-unknown" class="server-password-hint" hidden>${escapeHtml(t('serverSettings.passwordUnknown'))}</div>
          <div class="server-password-actions">
            ${button('btn-password-reveal', 'visibility', t('serverSettings.passwordShow'), 'aria-pressed="false" aria-controls="server-password-value"')}
            ${button('btn-password-copy', 'content_copy', t('serverSettings.passwordCopy'))}
            ${button('btn-password-change', 'edit', t('serverSettings.passwordChange'), 'aria-expanded="false" aria-controls="server-password-form"')}
            ${button('btn-password-remove', 'delete', t('common.remove'), 'data-danger')}
            <button type="button" id="btn-password-set" class="btn btn-primary server-password-action" aria-expanded="false" aria-controls="server-password-form">
              <span class="material-symbols-outlined md-16" aria-hidden="true">key</span><span>${escapeHtml(t('serverSettings.passwordSet'))}</span>
            </button>
          </div>
        </div>
        <div id="server-password-form" class="server-password-form" hidden>
          <div class="form-group">
            <label for="input-server-pass">${escapeHtml(t('serverSettings.passwordNew'))}</label>
            <input id="input-server-pass" type="password" autocomplete="new-password" required>
          </div>
          <div class="form-group">
            <label for="input-server-pass-confirm">${escapeHtml(t('serverSettings.passwordConfirm'))}</label>
            <input id="input-server-pass-confirm" type="password" autocomplete="new-password" required>
          </div>
          <div class="server-password-form-actions">
            <button type="button" id="btn-password-cancel" class="btn btn-secondary">${escapeHtml(t('common.cancel'))}</button>
            <button type="button" id="btn-password-save" class="btn btn-primary">${escapeHtml(t('serverSettings.passwordSave'))}</button>
          </div>
        </div>
      </div>
    `;
  }

  public attach(root: HTMLElement, context: ServerSettingsContext, apply: ApplyPassword, signal: AbortSignal): void {
    const form = root.querySelector<HTMLElement>('#server-password-form');
    const next = root.querySelector<HTMLInputElement>('#input-server-pass');
    const confirm = root.querySelector<HTMLInputElement>('#input-server-pass-confirm');
    if (!form || !next || !confirm) return;
    const options = { signal };
    const triggers = () => [...root.querySelectorAll<HTMLButtonElement>('#btn-password-change, #btn-password-set')];
    const setFormOpen = (open: boolean) => {
      if (!open) {
        next.value = '';
        confirm.value = '';
        next.removeAttribute('aria-invalid');
        confirm.removeAttribute('aria-invalid');
      }
      for (const trigger of triggers()) trigger.setAttribute('aria-expanded', String(open));
      setSurfaceVisible(form, open);
      if (open) next.focus({ preventScroll: true });
    };
    const save = async () => {
      if (context.operations.isPending('password')) return;
      const details = context.store.serverDetails;
      if (!details) return;
      if (!next.value) {
        reportError(validationMessage(next), { field: next, focus: true });
        return;
      }
      const invalid = serverSettingsValidationError({ password: next.value }, details);
      if (invalid) {
        reportError(t(invalid), { field: next, focus: true });
        return;
      }
      if (confirm.value !== next.value) {
        reportError(t('serverSettings.passwordMismatch'), { field: confirm, focus: true });
        return;
      }
      const password = next.value;
      const session = this.requestSession(context);
      if (!await apply(password)) return;
      this.remember(context, session, password);
      if (signal.aborted) return;
      setFormOpen(false);
      root.querySelector<HTMLButtonElement>('#btn-password-change')?.focus({ preventScroll: true });
      this.refreshState(root, context);
    };

    root.querySelector('#btn-password-reveal')?.addEventListener('click', () => {
      this.revealed = !this.revealed;
      this.refreshState(root, context);
    }, options);
    root.querySelector('#btn-password-copy')?.addEventListener('click', () => {
      const password = this.knownPassword(context);
      if (password) void copyText(password, { copied: t('serverSettings.passwordCopied'), failed: t('serverSettings.passwordCopyFailed') });
    }, options);
    for (const trigger of triggers()) {
      trigger.addEventListener('click', () => setFormOpen(form.hidden || form.hasAttribute('data-ui-closing')), options);
    }
    root.querySelector('#btn-password-cancel')?.addEventListener('click', () => {
      setFormOpen(false);
      triggers().find((trigger) => !trigger.hidden)?.focus({ preventScroll: true });
    }, options);
    root.querySelector('#btn-password-save')?.addEventListener('click', () => { void save(); }, options);
    for (const input of [next, confirm]) {
      // Enter saves this form instead of submitting the settings form around it.
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        void save();
      }, options);
    }
    root.querySelector('#btn-password-remove')?.addEventListener('click', () => {
      const session = this.requestSession(context);
      void apply(null).then((removed) => {
        if (!removed || context.store.serverDetails?.hasPassword) return;
        this.remember(context, session, undefined);
        if (signal.aborted) return;
        setFormOpen(false);
        this.refreshState(root, context);
      });
    }, options);
  }

  public refreshState(root: HTMLElement, context: ServerSettingsContext): void {
    const hasPassword = Boolean(context.store.serverDetails?.hasPassword);
    if (!hasPassword) this.revealed = false;
    const known = this.knownPassword(context);
    const pending = context.operations.isPending('password');
    const card = root.querySelector<HTMLElement>('#server-password-card');
    card?.setAttribute('data-state', hasPassword ? 'on' : 'off');
    card?.setAttribute('aria-busy', String(pending));
    const icon = root.querySelector('#password-status-icon');
    if (icon) icon.textContent = hasPassword ? 'lock' : 'lock_open';
    const title = root.querySelector('#password-status-title');
    if (title) title.textContent = t(hasPassword ? 'serverSettings.statusProtected' : 'serverSettings.statusOpen');
    const description = root.querySelector('#password-status-desc');
    if (description) description.textContent = t(hasPassword ? 'serverSettings.statusProtectedDesc' : 'serverSettings.statusOpenDesc');
    const valueRow = root.querySelector<HTMLElement>('#server-password-value-row');
    if (valueRow) valueRow.hidden = !hasPassword;
    const value = root.querySelector('#server-password-value');
    if (value) value.textContent = this.revealed && known ? known : MASK;
    const unknown = root.querySelector<HTMLElement>('#server-password-unknown');
    if (unknown) unknown.hidden = !hasPassword || Boolean(known);
    const reveal = root.querySelector<HTMLButtonElement>('#btn-password-reveal');
    if (reveal) {
      reveal.setAttribute('aria-pressed', String(this.revealed && Boolean(known)));
      const revealIcon = reveal.querySelector('.material-symbols-outlined');
      if (revealIcon) revealIcon.textContent = this.revealed ? 'visibility_off' : 'visibility';
      const label = reveal.querySelector('[data-label]');
      if (label) label.textContent = t(this.revealed ? 'serverSettings.passwordHide' : 'serverSettings.passwordShow');
    }
    for (const [id, visible, disabled] of [
      ['#btn-password-reveal', hasPassword, !known],
      ['#btn-password-copy', hasPassword, !known],
      ['#btn-password-change', hasPassword, pending],
      ['#btn-password-remove', hasPassword, pending],
      ['#btn-password-set', !hasPassword, pending],
      ['#btn-password-save', true, pending],
    ] as const) {
      const button = root.querySelector<HTMLButtonElement>(id);
      if (!button) continue;
      button.hidden = !visible;
      button.disabled = disabled;
    }
  }

  private knownPassword(context: ServerSettingsContext): string | undefined {
    if (!context.store.serverDetails?.hasPassword) return undefined;
    const session = sessionManager.getActive();
    return session?.client === context.client ? knownServerPassword(session) : undefined;
  }

  /** The session this request was made through, captured before it is sent. */
  private requestSession(context: ServerSettingsContext): ServerSession | undefined {
    const session = sessionManager.getActive();
    return session?.client === context.client ? session : undefined;
  }

  /**
   * The server checks the password on every sign-in, and reconnects after a
   * restart use the saved entries. Once acknowledged, the session, the saved
   * server and this device's hosted server all keep the new password (or none),
   * or the next start would sign in with the old one and be refused (#881).
   * A session that no longer talks to this connection is left alone.
   */
  private remember(context: ServerSettingsContext, session: ServerSession | undefined, password: string | undefined): void {
    if (!session || session.client !== context.client) return;
    session.password = password;
    const owned = findOwnedServer(session.host, session.port);
    if (owned && owned.password !== password) connectionStore.saveCreatedServer({ ...owned, password });
    const saved = connectionStore.findSavedServer(session);
    if (saved && saved.password !== password) connectionStore.addSavedServer({ ...saved, password });
  }
}
