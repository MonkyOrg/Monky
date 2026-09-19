import { LIMITS, serverInviteSchema, type ServerInvite } from '@monky/shared';
import { getServerSessionForAddress, openServerSession, updateSessionAvatar } from '../core/serverConnection';
import { connectionStore } from '../stores/connectionStore';
import { clientLog } from '../core/ClientLogService';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { enableBackdropClose } from '../utils/modal';

export class JoinInviteModal {
  private completion: Promise<boolean> | null = null;
  private closeCurrent: ((joined: boolean, force?: boolean) => void) | null = null;

  public waitUntilClosed(): Promise<boolean> {
    return this.completion ?? Promise.resolve(false);
  }

  public async open(value: ServerInvite): Promise<boolean> {
    const invite = serverInviteSchema.parse(value);
    while (this.completion) await this.completion;
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    const previousFocus = document.activeElement;
    let connecting = false;
    let closed = false;
    modal.innerHTML = `
      <form class="modal-card" id="join-invite-form" role="dialog" aria-modal="true" aria-labelledby="join-invite-title" style="max-width: 520px;">
        <div class="modal-header">
          <div class="modal-title" id="join-invite-title">${t('invite.joinTitle')}</div>
          <button type="button" class="modal-close-btn" data-invite-cancel aria-label="${t('common.close')}">&times;</button>
        </div>
        <p>${escapeHtml(t('invite.review', { name: invite.name ?? 'Monky' }))}</p>
        <dl style="display: grid; grid-template-columns: auto 1fr; gap: 8px; margin: 0;">
          <dt>${t('connection.hostLabel')}</dt><dd style="overflow-wrap: anywhere; margin: 0;" data-invite-host>${escapeHtml(invite.host)}</dd>
          <dt>${t('connection.portLabel')}</dt><dd style="margin: 0;" data-invite-port>${invite.port}</dd>
        </dl>
        <p style="font-size: 12px; color: var(--text-muted);">${t('invite.reviewNotice')}</p>
        <div data-invite-nickname></div>
        <div class="form-group">
          <label for="invite-join-password">${t('connection.passwordLabel')}</label>
          <input id="invite-join-password" type="password" autocomplete="off">
          <small>${t(invite.password ? 'invite.passwordIncluded' : 'invite.passwordOnEntry')}</small>
        </div>
        <p data-invite-error role="alert" hidden style="color: var(--danger);"></p>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-invite-cancel>${t('common.cancel')}</button>
          <button type="submit" class="btn btn-primary" data-invite-join>${t('connection.join')}</button>
        </div>
      </form>
    `;
    const form = modal.querySelector<HTMLFormElement>('#join-invite-form');
    const nicknameSlot = modal.querySelector<HTMLElement>('[data-invite-nickname]');
    const password = modal.querySelector<HTMLInputElement>('#invite-join-password');
    const errorNotice = modal.querySelector<HTMLElement>('[data-invite-error]');
    const join = modal.querySelector<HTMLButtonElement>('[data-invite-join]');
    if (!form || !nicknameSlot || !password || !errorNotice || !join) throw new Error('Invitation dialog could not be created');
    password.value = invite.password ?? '';
    let nickname: HTMLInputElement | null = null;
    let displayedNickname: string | null | undefined;
    const clearNicknameValidity = () => nickname?.setCustomValidity('');
    const syncNickname = (): string | null => {
      const saved = connectionStore.savedNickname.trim();
      const name = connectionStore.hasIdentity && saved.length >= LIMITS.MIN_NICKNAME_LENGTH
        && saved.length <= LIMITS.MAX_NICKNAME_LENGTH ? saved : null;
      if (name !== displayedNickname) {
        nickname?.removeEventListener('input', clearNicknameValidity);
        nickname = null;
        nicknameSlot.innerHTML = name !== null
          ? `<p data-invite-identity>${escapeHtml(t('invite.identityNickname', { name }))}</p>`
          : `<div class="form-group">
              <label for="invite-join-nickname">${t('connection.nicknameLabel')}</label>
              <input id="invite-join-nickname" type="text" required minlength="${LIMITS.MIN_NICKNAME_LENGTH}" maxlength="${LIMITS.MAX_NICKNAME_LENGTH}"
                value="${escapeHtml(connectionStore.savedNickname)}" autocomplete="nickname">
              <small>${t('invite.nicknameSetupHint')}</small>
            </div>`;
        if (name === null) {
          nickname = nicknameSlot.querySelector<HTMLInputElement>('#invite-join-nickname');
          if (!nickname) throw new Error('Invitation nickname field could not be created');
          nickname.addEventListener('input', clearNicknameValidity);
        }
        displayedNickname = name;
      }
      return name;
    };
    syncNickname();

    this.completion = new Promise<boolean>((resolve) => {
      const close = (joined: boolean, force = false): void => {
        if (closed || (connecting && !force)) return;
        closed = true;
        document.removeEventListener('keydown', onKey, true);
        nickname?.removeEventListener('input', clearNicknameValidity);
        modal.remove();
        this.closeCurrent = null;
        this.completion = null;
        if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
        resolve(joined);
      };
      const onKey = (event: KeyboardEvent): void => {
        const backdrops = document.querySelectorAll('.modal-backdrop');
        if (backdrops[backdrops.length - 1] !== modal) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          close(false);
        } else if (event.key === 'Tab') {
          const controls = [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
          if (event.shiftKey && document.activeElement === controls[0]) {
            event.preventDefault();
            controls[controls.length - 1]?.focus();
          } else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) {
            event.preventDefault();
            controls[0]?.focus();
          }
        }
      };
      this.closeCurrent = close;
      document.addEventListener('keydown', onKey, true);
      modal.querySelectorAll<HTMLButtonElement>('[data-invite-cancel]').forEach(button =>
        button.addEventListener('click', () => close(false)));
      enableBackdropClose(modal, () => close(false));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (connecting || closed) return;
        const identityNickname = syncNickname();
        if (!form.reportValidity()) return;
        const previousNickname = connectionStore.savedNickname;
        const name = identityNickname ?? nickname?.value.trim() ?? '';
        if (name.length < LIMITS.MIN_NICKNAME_LENGTH || name.length > LIMITS.MAX_NICKNAME_LENGTH) {
          nickname?.setCustomValidity(t('invite.nicknameInvalid'));
          nickname?.reportValidity();
          nickname?.focus();
          return;
        }
        const serverPassword = password.value || undefined;
        const avatar = connectionStore.savedAvatarBase64 ?? '';
        connecting = true;
        errorNotice.hidden = true;
        form.setAttribute('aria-busy', 'true');
        modal.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = true; });
        join.textContent = t('main.connectingTo', { name: invite.name ?? invite.host });
        try {
          if (!window.api?.getIdentity) throw new Error(t('connection.connectError'));
          const identity = await window.api.getIdentity();
          if (closed) return;
          connectionStore.setIdentity(identity);
          const reused = getServerSessionForAddress(invite.host, invite.port)?.client.getStatus() === 'CONNECTED';
          const result = await openServerSession(invite.host, invite.port, identity, name, serverPassword);
          if (closed) return;
          if (!reused) {
            if (identityNickname === null && connectionStore.savedNickname === previousNickname) {
              connectionStore.saveUserProfile(name);
            }
            connectionStore.addSavedServer({
              host: invite.host, port: invite.port, name: result.server.name, serverId: result.server.id,
              password: serverPassword, lastConnected: Date.now(),
            });
            await updateSessionAvatar(invite.host, invite.port, avatar);
          }
          close(true, true);
          await window.api.maximize?.().catch(() => clientLog.warn('APP', 'Could not maximize after joining the invited server'));
        } catch (error: unknown) {
          clientLog.warn('CONNECTION', 'Could not join the invited server');
          if (!closed) {
            errorNotice.textContent = error instanceof Error ? error.message : t('connection.connectError');
            errorNotice.hidden = false;
          }
        } finally {
          connecting = false;
          if (!closed) {
            form.removeAttribute('aria-busy');
            modal.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = false; });
            syncNickname();
            join.textContent = t('connection.join');
          }
        }
      });
    });
    document.body.appendChild(modal);
    const nicknameToFocus = modal.querySelector<HTMLInputElement>('#invite-join-nickname');
    if (nicknameToFocus) nicknameToFocus.focus();
    else join.focus();
    return this.completion;
  }

  public close(): void {
    this.closeCurrent?.(false, true);
  }
}

export const joinInviteModal = new JoinInviteModal();
