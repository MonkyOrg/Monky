import { MessageType, Permission, UserSummary } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { avatarFileExtension, getAvatarUrl } from '../utils/avatar';
import { renderRoleOption } from '../utils/roleOption';
import { settingsStore } from '../stores/settingsStore';
import { serverStore } from '../stores/serverStore';
import { connectionStore } from '../stores/connectionStore';
import { webRtcManager } from '../core/WebRtcManager';
import { appEvents } from '../core/EventBus';
import { participantManager, ParticipantViewModel } from '../core/ParticipantManager';
import { networkClient } from '../core/NetworkClient';
import { ContextMenuItem } from './ContextMenu';
import { showAlert } from './Dialog';
import { downloadLightboxFile, lightboxModal } from './LightboxModal';
import { warnIfMoveBlocked } from '../utils/channelAccess';
import { t } from '../i18n';

export class UserContextMenu {
  private menuEl: HTMLElement | null = null;
  private unbindGlobalListeners: Array<() => void> = [];
  private static readonly SUBMENU_GAP_PX = 2;
  private static readonly SUBMENU_MIN_WIDTH_PX = 192;

  constructor() {
    appEvents.on('network.disconnected', () => this.close());
    appEvents.on('voice.channel_changed', () => this.close());
  }

  /**
   * @param messageActions Actions that belong to the message the menu was
   * opened from, rendered above the person's own options (#516).
   *
   * They live here because right-clicking a message row opens *this* menu when
   * the author is someone else. Offering them only in the separate message menu
   * would mean the most common case — copying what another person wrote — had
   * nowhere to be.
   */
  public open(x: number, y: number, user: UserSummary, messageActions: ContextMenuItem[] = []): void {
    if (
      user.id === serverStore.currentUser?.id ||
      user.clientId === connectionStore.clientId ||
      user.clientId === serverStore.currentUser?.clientId
    ) {
      return;
    }

    this.close();

    const volumeSessionId = this.resolveVolumeTarget(user);
    const currentVol = settingsStore.getUserVolume(volumeSessionId, user.clientId);
    const avatarSrc = getAvatarUrl(user.avatarUrl);
    // Sem foto o que se abriria é o logo padrão, então o olho não aparece (#406).
    const hasAvatar = !!user.avatarUrl;
    // Voice moderation addresses a connection, not a person: prefer the exact
    // session the menu was opened from, else any session of theirs in voice (#309).
    const targetState = this.resolveVoiceTarget(user)?.voiceState;
    const voiceChannels = (serverStore.serverDetails?.channels ?? []).filter((channel) => channel.type === 'VOICE');
    const roleIds = new Set(serverStore.getUserRoleIds(user.id));
    const manageableRoles = serverStore.roles
      .filter((role) => !role.isDefault && !serverStore.isAdminRole(role))
      .sort((a, b) => b.position - a.position);

    const canMuteMembers = !!targetState && serverStore.hasPermission(Permission.MUTE_MEMBERS);
    const canDeafenMembers = !!targetState && serverStore.hasPermission(Permission.DEAFEN_MEMBERS);
    const canKickMembers = !!targetState && serverStore.hasPermission(Permission.KICK_MEMBERS);
    const canMoveMembers = !!targetState && serverStore.hasPermission(Permission.MOVE_MEMBERS) && voiceChannels.length > 0;
    const canManageRoles = serverStore.hasPermission(Permission.MANAGE_ROLES) && manageableRoles.length > 0;
    // Promoting/demoting admins is also available straight from the member list (#273).
    const adminRole = serverStore.getAdminRole();
    const isTargetAdmin = !!adminRole && roleIds.has(adminRole.id);
    const canManageAdmin =
      !!adminRole &&
      user.id !== serverStore.ownerId &&
      serverStore.hasPermission(Permission.MANAGE_ROLES);
    const showAdminSection = canMuteMembers || canDeafenMembers || canKickMembers || canMoveMembers || canManageRoles || canManageAdmin;

    this.menuEl = document.createElement('div');
    this.menuEl.className = 'user-context-menu';
    this.menuEl.innerHTML = `
      <div class="context-menu-header">
        ${hasAvatar ? `
          <button type="button" id="ctx-view-avatar" class="context-menu-avatar-button" title="${t('userMenu.viewAvatar')}" aria-label="${t('userMenu.viewAvatar')}">
            <img class="context-menu-avatar" src="${avatarSrc}" alt="" data-fallback="avatar">
            <span class="context-menu-avatar-overlay">
              <span class="material-symbols-outlined md-18">visibility</span>
            </span>
          </button>
        ` : `<img class="context-menu-avatar" src="${avatarSrc}" alt="" data-fallback="avatar">`}
        <div class="context-menu-user-info">
          <span class="context-menu-nickname">${escapeHtml(user.nickname)}</span>
          <span class="context-menu-subtext">${t('userMenu.audioSettings')}</span>
        </div>
      </div>

      ${messageActions.length ? `
      <div class="context-menu-divider"></div>
      <div class="context-menu-message-actions">
        ${messageActions.map((action, index) => `
          <button type="button" class="btn btn-secondary${action.danger ? ' btn-danger' : ''}" data-action="message-action" data-index="${index}">
            <span style="display: inline-flex; align-items: center; gap: 8px; width: 100%;">
              ${action.icon ? `<span class="material-symbols-outlined md-16">${escapeHtml(action.icon)}</span>` : ''}
              <span>${escapeHtml(action.label)}</span>
            </span>
          </button>
        `).join('')}
      </div>
      ` : ''}

      <div class="context-menu-divider"></div>

      <div class="context-menu-volume-section">
        <div class="context-menu-volume-header">
          <div class="context-menu-volume-title">
            <span id="ctx-volume-icon" class="material-symbols-outlined md-18" style="color: var(--accent-primary);">
              ${this.getVolumeIcon(currentVol)}
            </span>
            <span>${t('userMenu.voiceVolume')}</span>
          </div>
          <span id="ctx-volume-badge" class="context-menu-volume-badge">${currentVol}%</span>
        </div>

        <div class="context-menu-slider-container">
          <input
            id="ctx-volume-slider"
            class="user-volume-slider"
            type="range"
            min="0"
            max="200"
            value="${currentVol}"
            step="1"
            style="--slider-fill: ${(currentVol / 200) * 100}%;"
          >
        </div>

        <div class="context-menu-quick-btns">
          <button id="ctx-vol-0" class="btn-ctx-quick" title="${t('userMenu.muteUserTitle')}">${t('userMenu.volumeMuted')}</button>
          <button id="ctx-vol-100" class="btn-ctx-quick" title="${t('userMenu.restoreVolume')}">100%</button>
          <button id="ctx-vol-200" class="btn-ctx-quick" title="200%">200%</button>
        </div>
      </div>

      ${showAdminSection ? `
      <div class="context-menu-divider"></div>
      <div style="display: flex; flex-direction: column; gap: 8px;">
        <div style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.6px;">
          ${t('userMenu.adminActions')}
        </div>
        ${canMuteMembers ? `<button type="button" class="btn btn-secondary" data-action="server-mute">${targetState?.serverMuted ? t('userMenu.serverUnmute') : t('userMenu.serverMute')}</button>` : ''}
        ${canDeafenMembers ? `<button type="button" class="btn btn-secondary" data-action="server-deafen">${targetState?.serverDeafened ? t('userMenu.serverUndeafen') : t('userMenu.serverDeafen')}</button>` : ''}
        ${canKickMembers ? `<button type="button" class="btn btn-secondary" data-action="kick-voice">${t('userMenu.kickFromVoice')}</button>` : ''}
        ${canMoveMembers ? `
          <div class="ctx-submenu-wrap">
            <button type="button" class="btn btn-secondary ctx-submenu-trigger">
              <span style="display: inline-flex; align-items: center; gap: 8px; width: 100%;">
                <span class="material-symbols-outlined md-16">move_down</span>
                <span>${t('userMenu.moveToChannel')}</span>
                <span class="material-symbols-outlined md-16" style="margin-left: auto;">chevron_right</span>
              </span>
            </button>
            <div class="ctx-submenu">
              ${voiceChannels.map((channel) => `
                <button type="button" class="ctx-submenu-item" data-action="move-user" data-channel-id="${channel.id}">
                  <span class="material-symbols-outlined md-16">volume_up</span>
                  <span>${escapeHtml(channel.name)}</span>
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}
        ${canManageRoles ? `
          <div class="ctx-submenu-wrap">
            <button type="button" class="btn btn-secondary ctx-submenu-trigger">
              <span style="display: inline-flex; align-items: center; gap: 8px; width: 100%;">
                <span class="material-symbols-outlined md-16">admin_panel_settings</span>
                <span>${t('userMenu.manageRoles')}</span>
                <span class="material-symbols-outlined md-16" style="margin-left: auto;">chevron_right</span>
              </span>
            </button>
            <div class="ctx-submenu">
              ${manageableRoles.map((role) => `
                <button type="button" class="ctx-submenu-item" data-action="toggle-role" data-role-id="${role.id}">
                  ${renderRoleOption(role, roleIds.has(role.id))}
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}
        ${canManageAdmin ? `
          <button type="button" class="btn btn-secondary" data-action="toggle-admin" data-role-id="${adminRole!.id}">
            <span style="display: inline-flex; align-items: center; gap: 8px; width: 100%;">
              <span class="material-symbols-outlined md-16">${isTargetAdmin ? 'remove_moderator' : 'shield_person'}</span>
              <span>${isTargetAdmin ? t('userMenu.removeAdmin') : t('userMenu.promoteToAdmin')}</span>
            </span>
          </button>
        ` : ''}
      </div>
      ` : ''}
    `;

    document.body.appendChild(this.menuEl);

    this.updateSliderTrackFill(currentVol);
    this.updateActiveQuickButton(currentVol);

    const rect = this.menuEl.getBoundingClientRect();
    let posX = x;
    let posY = y;

    if (posX + rect.width > window.innerWidth - 12) posX = window.innerWidth - rect.width - 12;
    if (posY + rect.height > window.innerHeight - 12) posY = window.innerHeight - rect.height - 12;
    if (posX < 12) posX = 12;
    if (posY < 12) posY = 12;

    this.menuEl.style.left = `${posX}px`;
    this.menuEl.style.top = `${posY}px`;

    this.syncSubmenuPlacement();
    this.attachEvents(user);
    this.attachMessageActions(messageActions);
  }

  /**
   * Runs the message action the button stands for and closes the menu, the way
   * every other entry here behaves.
   */
  private attachMessageActions(messageActions: ContextMenuItem[]): void {
    if (!this.menuEl || messageActions.length === 0) return;
    this.menuEl.querySelectorAll<HTMLElement>('[data-action="message-action"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const index = Number(btn.getAttribute('data-index'));
        const action = messageActions[index];
        this.close();
        action?.onClick();
      });
    });
  }

  private syncSubmenuPlacement(): void {
    if (!this.menuEl) return;

    const submenuWraps = this.menuEl.querySelectorAll('.ctx-submenu-wrap');
    submenuWraps.forEach((wrapEl) => {
      const wrap = wrapEl as HTMLElement;
      wrap.classList.remove('flip-left');

      const wrapRect = wrap.getBoundingClientRect();
      const spaceRight = window.innerWidth - wrapRect.right;
      const spaceLeft = wrapRect.left;
      const needsFlip = spaceRight < UserContextMenu.SUBMENU_MIN_WIDTH_PX + UserContextMenu.SUBMENU_GAP_PX
        && spaceLeft > spaceRight;

      wrap.classList.toggle('flip-left', needsFlip);
    });
  }

  /**
   * Nudges an open submenu up when it would run past the bottom of the window,
   * which long voice-channel lists easily do (#258).
   */
  private syncSubmenuVerticalOffset(wrap: HTMLElement): void {
    const submenu = wrap.querySelector<HTMLElement>('.ctx-submenu');
    if (!submenu) return;

    submenu.style.top = '0px';
    const overflow = submenu.getBoundingClientRect().bottom - (window.innerHeight - 12);
    if (overflow > 0) submenu.style.top = `${-overflow}px`;
  }

  private getVolumeIcon(volume: number): string {
    if (volume === 0) return 'volume_off';
    if (volume <= 50) return 'volume_down';
    return 'volume_up';
  }

  private updateSliderTrackFill(volume: number): void {
    const slider = this.menuEl?.querySelector('#ctx-volume-slider') as HTMLInputElement | null;
    if (slider) {
      const percentage = Math.max(0, Math.min(100, (volume / 200) * 100));
      slider.style.setProperty('--slider-fill', `${percentage}%`);
      // Vermelho quando acima de 100% para indicar amplificação
      slider.style.setProperty('--slider-color', volume > 100 ? '#ed4245' : 'var(--accent-primary)');
    }
  }

  private updateActiveQuickButton(volume: number): void {
    if (!this.menuEl) return;
    const btns = this.menuEl.querySelectorAll('.btn-ctx-quick');
    btns.forEach((b) => b.classList.remove('active'));

    if (volume === 0) this.menuEl.querySelector('#ctx-vol-0')?.classList.add('active');
    else if (volume === 100) this.menuEl.querySelector('#ctx-vol-100')?.classList.add('active');
    else if (volume === 200) this.menuEl.querySelector('#ctx-vol-200')?.classList.add('active');
  }

  private applyVolume(user: UserSummary, volume: number): void {
    const clamped = Math.max(0, Math.min(200, Math.round(volume)));
    const badge = this.menuEl?.querySelector('#ctx-volume-badge');
    const icon = this.menuEl?.querySelector('#ctx-volume-icon');
    const slider = this.menuEl?.querySelector('#ctx-volume-slider') as HTMLInputElement | null;

    if (badge) badge.textContent = `${clamped}%`;
    if (icon) icon.textContent = this.getVolumeIcon(clamped);
    if (slider && parseInt(slider.value, 10) !== clamped) {
      slider.value = clamped.toString();
    }

    this.updateSliderTrackFill(clamped);
    this.updateActiveQuickButton(clamped);

    const sessionId = this.resolveVolumeTarget(user);
    settingsStore.setUserVolume(sessionId, clamped);
    webRtcManager.setPeerVolume(sessionId, clamped);
  }

  private async runAdminAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      this.close();
    } catch (err: any) {
      await showAlert({
        title: t('common.error'),
        message: err?.message || t('userMenu.actionFailed'),
        variant: 'danger',
      });
    }
  }

  /**
   * The connection a voice moderation action should target: the exact session
   * the menu was opened from, else any session of that person in voice (#309).
   */
  private resolveVoiceTarget(user: UserSummary): ParticipantViewModel | undefined {
    const exact = participantManager.get(user.sessionId || '');
    if (exact?.voiceState) return exact;
    return participantManager.getByUserId(user.id) ?? exact;
  }

  /**
   * The connection the volume slider applies to (#363). Volume is per device,
   * so it targets the exact session the menu was opened from; the voice-target
   * fallback covers menus opened from the member list, where the summary
   * describes the person rather than one of their connections.
   */
  private resolveVolumeTarget(user: UserSummary): string {
    return user.sessionId || this.resolveVoiceTarget(user)?.user.sessionId || '';
  }

  private attachEvents(user: UserSummary): void {
    if (!this.menuEl) return;

    const slider = this.menuEl.querySelector('#ctx-volume-slider') as HTMLInputElement | null;
    slider?.addEventListener('input', () => this.applyVolume(user, parseInt(slider.value, 10)));
    const avatarButton = this.menuEl.querySelector<HTMLButtonElement>('#ctx-view-avatar');
    avatarButton?.addEventListener('click', () => {
      const url = getAvatarUrl(user.avatarUrl);
      // O menu some ao abrir a foto: deixá-lo por cima do lightbox só atrapalha.
      this.close();
      lightboxModal.open(
        [{
          kind: 'image',
          url,
          fileName: `${user.nickname}.${avatarFileExtension(user.avatarUrl)}`,
          // O nome já aparece na legenda pelo nome do arquivo; repetir aqui só
          // duplicaria a informação na barra do visualizador.
          senderName: '',
          timestamp: '',
          // `source` só é lido no ramo de vídeo, para herdar o tempo e o volume
          // do player embutido; uma imagem não tem o que herdar.
          source: document.body,
        }],
        0,
        downloadLightboxFile
      );
    });

    this.menuEl.querySelector('#ctx-vol-0')?.addEventListener('click', () => this.applyVolume(user, 0));
    this.menuEl.querySelector('#ctx-vol-100')?.addEventListener('click', () => this.applyVolume(user, 100));
    this.menuEl.querySelector('#ctx-vol-200')?.addEventListener('click', () => this.applyVolume(user, 200));
    // Each submenu toggles on click and closes its siblings, so opening "Move"
    // never leaves "Roles" hanging open next to it (#258).
    this.menuEl.querySelectorAll<HTMLElement>('.ctx-submenu-wrap').forEach((wrap) => {
      const trigger = wrap.querySelector<HTMLButtonElement>('.ctx-submenu-trigger');
      trigger?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const willOpen = !wrap.classList.contains('open');
        this.menuEl?.querySelectorAll('.ctx-submenu-wrap').forEach((other) => other.classList.remove('open'));
        wrap.classList.toggle('open', willOpen);
        if (willOpen) this.syncSubmenuVerticalOffset(wrap);
      });
      wrap.addEventListener('mouseenter', () => this.syncSubmenuVerticalOffset(wrap));
    });

    this.menuEl.querySelector('[data-action="server-mute"]')?.addEventListener('click', () => {
      const target = this.resolveVoiceTarget(user);
      void this.runAdminAction(() => networkClient.sendRequest(MessageType.ADMIN_MUTE_USER, {
        targetSessionId: target?.user.sessionId || user.sessionId || user.id,
        muted: !(target?.voiceState?.serverMuted ?? false),
      }));
    });

    this.menuEl.querySelector('[data-action="server-deafen"]')?.addEventListener('click', () => {
      const target = this.resolveVoiceTarget(user);
      void this.runAdminAction(() => networkClient.sendRequest(MessageType.ADMIN_DEAFEN_USER, {
        targetSessionId: target?.user.sessionId || user.sessionId || user.id,
        deafened: !(target?.voiceState?.serverDeafened ?? false),
      }));
    });

    this.menuEl.querySelector('[data-action="kick-voice"]')?.addEventListener('click', () => {
      const target = this.resolveVoiceTarget(user);
      void this.runAdminAction(() => networkClient.sendRequest(MessageType.ADMIN_KICK_VOICE, {
        targetSessionId: target?.user.sessionId || user.sessionId || user.id,
      }));
    });

    this.menuEl.querySelectorAll('[data-action="move-user"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const channelId = btn.getAttribute('data-channel-id');
        if (!channelId) return;
        if (warnIfMoveBlocked(user.id, user.nickname, channelId)) {
          this.close();
          return;
        }
        const target = this.resolveVoiceTarget(user);
        void this.runAdminAction(() => networkClient.sendRequest(MessageType.ADMIN_MOVE_USER, {
          targetSessionId: target?.user.sessionId || user.sessionId || user.id,
          channelId,
        }));
      });
    });

    this.menuEl.querySelectorAll('[data-action="toggle-role"]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const roleId = btn.getAttribute('data-role-id');
        if (!roleId) return;
        const hasRole = serverStore.getUserRoleIds(user.id).includes(roleId);
        btn.querySelector('.role-option-check')?.classList.toggle('checked', !hasRole);
        void networkClient.sendRequest(
          hasRole ? MessageType.ROLE_UNASSIGN : MessageType.ROLE_ASSIGN,
          { userId: user.id, roleId }
        ).catch(() => {});
      });
    });

    const adminBtn = this.menuEl.querySelector('[data-action="toggle-admin"]');
    adminBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      const roleId = adminBtn.getAttribute('data-role-id');
      if (!roleId) return;
      const isAdmin = serverStore.getUserRoleIds(user.id).includes(roleId);
      void networkClient.sendRequest(
        isAdmin ? MessageType.ROLE_UNASSIGN : MessageType.ROLE_ASSIGN,
        { userId: user.id, roleId }
      ).catch(() => {});
      this.close();
    });

    const handleOutsideClick = (e: MouseEvent | PointerEvent) => {
      if (this.menuEl && !this.menuEl.contains(e.target as Node)) this.close();
    };
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') this.close(); };
    const handleWindowResize = () => this.close();

    setTimeout(() => {
      document.addEventListener('pointerdown', handleOutsideClick, true);
      document.addEventListener('contextmenu', handleOutsideClick, true);
      window.addEventListener('keydown', handleKeyDown, true);
      window.addEventListener('resize', handleWindowResize);
    }, 10);

    this.unbindGlobalListeners.push(() => {
      document.removeEventListener('pointerdown', handleOutsideClick, true);
      document.removeEventListener('contextmenu', handleOutsideClick, true);
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('resize', handleWindowResize);
    });
  }

  public close(): void {
    this.unbindGlobalListeners.forEach((u) => u());
    this.unbindGlobalListeners = [];
    if (this.menuEl) {
      this.menuEl.remove();
      this.menuEl = null;
    }
  }
}

export const userContextMenu = new UserContextMenu();
