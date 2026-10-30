import { LIMITS, getNicknameIssue, normalizeNickname, serverInviteSchema, type ServerInvite } from '@monky/shared';
import { getServerSessionForAddress, openServerSession, updateSessionAvatar } from '../core/serverConnection';
import { connectionStore } from '../stores/connectionStore';
import { recordProfileChange } from '../core/profileSync';
import { clientLog } from '../core/ClientLogService';
import { t } from '../i18n';
import { openModal, type ModalCloseReason } from '../utils/modalShell';
import { escapeHtml } from '../utils/html';
import { errorMessage, reportError, validateForm } from '../utils/feedback';
import { nicknameError } from '../utils/nickname';

export class JoinInviteModal {
  private completion: Promise<boolean> | null = null;
  private closeCurrent: (() => void) | null = null;

  public waitUntilClosed(): Promise<boolean> {
    return this.completion ?? Promise.resolve(false);
  }

  public async open(value: ServerInvite): Promise<boolean> {
    const invite = serverInviteSchema.parse(value);
    while (this.completion) await this.completion;
    let connecting = false;
    let joined = false;
    let resolveCompletion: (value: boolean) => void = () => {};
    this.completion = new Promise<boolean>((resolve) => { resolveCompletion = resolve; });
    const completion = this.completion;
    // Whoever started the connection (or the app) decides; the person cannot dismiss it midway.
    const programmatic = (reason: ModalCloseReason) => reason === 'api' || reason === 'owner';
    const shell = openModal({
      card: `
      <form class="modal-card" id="join-invite-form" novalidate aria-labelledby="join-invite-title" style="max-width: 520px;">
        <div class="modal-header">
          <div class="modal-title" id="join-invite-title">${t('invite.joinTitle')}</div>
          <button type="button" class="modal-close-btn" data-invite-cancel data-modal-close aria-label="${t('common.close')}">&times;</button>
        </div>
        <p>${escapeHtml(t('invite.review', { name: invite.name ?? 'Monky' }))}</p>
        ${invite.eventId ? `<p>${escapeHtml(t('community.invitedEventHint'))}</p>` : ''}
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
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-invite-cancel data-modal-close>${t('common.cancel')}</button>
          <button type="submit" class="btn btn-primary" data-invite-join>${t('connection.join')}</button>
        </div>
      </form>
    `,
      initialFocus: false,
      canClose: (reason) => !connecting || programmatic(reason),
      onClose: () => {
        if (this.completion === completion) {
          this.closeCurrent = null;
          this.completion = null;
        }
        resolveCompletion(joined);
      },
    });
    const modal = shell.card;
    if (!(modal instanceof HTMLFormElement)) throw new Error('Invitation dialog could not be created');
    const form = modal;
    const nicknameSlot = modal.querySelector<HTMLElement>('[data-invite-nickname]');
    const password = modal.querySelector<HTMLInputElement>('#invite-join-password');
    const join = modal.querySelector<HTMLButtonElement>('[data-invite-join]');
    if (!nicknameSlot || !password || !join) throw new Error('Invitation dialog could not be created');
    password.value = invite.password ?? '';
    let nickname: HTMLInputElement | null = null;
    let displayedNickname: string | null | undefined;
    const syncNickname = (): string | null => {
      const saved = normalizeNickname(connectionStore.savedNickname);
      const name = connectionStore.hasIdentity && getNicknameIssue(saved) === null ? saved : null;
      if (name !== displayedNickname) {
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
        }
        displayedNickname = name;
      }
      return name;
    };
    syncNickname();
    this.closeCurrent = () => { shell.close('api'); };

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (connecting || shell.closed) return;
      const identityNickname = syncNickname();
      if (!validateForm(form)) return;
      const previousNickname = connectionStore.savedNickname;
      const name = identityNickname ?? normalizeNickname(nickname?.value ?? '');
      const error = nicknameError(name);
      if (error) {
        reportError(error, { field: nickname, focus: true });
        return;
      }
      const serverPassword = password.value || undefined;
      const avatar = connectionStore.savedAvatarBase64 ?? '';
      connecting = true;
      form.setAttribute('aria-busy', 'true');
      modal.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = true; });
      join.textContent = t('main.connectingTo', { name: invite.name ?? invite.host });
      try {
        if (!window.api?.getIdentity) throw new Error(t('connection.connectError'));
        const identity = await window.api.getIdentity();
        if (shell.closed) return;
        connectionStore.setIdentity(identity);
        const reused = getServerSessionForAddress(invite.host, invite.port)?.client.getStatus() === 'CONNECTED';
        const result = await openServerSession(invite.host, invite.port, identity, name, serverPassword);
        if (shell.closed) return;
        if (!reused) {
          if (identityNickname === null && connectionStore.savedNickname === previousNickname) {
            connectionStore.saveUserProfile(name);
            void recordProfileChange({ nickname: true });
          }
          connectionStore.addSavedServer({
            host: invite.host, port: invite.port, name: result.server.name, serverId: result.server.id,
            password: serverPassword, lastConnected: Date.now(),
          });
          await updateSessionAvatar(invite.host, invite.port, avatar);
        }
        const eventSession = invite.eventId ? getServerSessionForAddress(invite.host, invite.port) : undefined;
        if (invite.eventId && !eventSession) throw new Error(t('community.loadError'));
        joined = true;
        shell.close('api');
        if (invite.eventId && eventSession) eventSession.community.requestOpenEvent(invite.eventId);
        await window.api.maximize?.().catch(() => clientLog.warn('APP', 'Could not maximize after joining the invited server'));
      } catch (error: unknown) {
        clientLog.warn('CONNECTION', 'Could not join the invited server');
        if (!shell.closed) reportError(errorMessage(error, t('connection.connectError')));
      } finally {
        connecting = false;
        if (!shell.closed) {
          form.removeAttribute('aria-busy');
          modal.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button').forEach(control => { control.disabled = false; });
          syncNickname();
          join.textContent = t('connection.join');
        }
      }
    }, { signal: shell.signal });
    const nicknameToFocus = modal.querySelector<HTMLInputElement>('#invite-join-nickname');
    if (nicknameToFocus) nicknameToFocus.focus();
    else join.focus();
    return completion;
  }

  public close(): void {
    this.closeCurrent?.();
  }
}

export const joinInviteModal = new JoinInviteModal();
