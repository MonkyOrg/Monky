import { Permission, type UserSummary } from '@monky/shared';
import { html, trustedHtml } from '../../utils/html';
import { participantManager } from '../../core/ParticipantManager';
import { isViewingCallServer } from '../../core/voiceControls';
import { serverStore } from '../../stores/serverStore';
import { voiceStore } from '../../stores/voiceStore';
import { renderKeyedList, type KeyedItem } from '../../utils/keyedList';
import { preserveViewState } from '../../utils/preserveViewState';
import { getAvatarUrl } from '../../utils/avatar';
import { customStatusDotStyle, renderPresenceTag, visibleCustomStatus } from '../../utils/presenceTag';
import { LivePulseClock } from '../../utils/livePulse';
import { renderRoleTags } from '../../utils/roleTags';
import { renderAudioMuteIndicators } from '../AudioStateIcon';
import { userContextMenu } from '../UserContextMenu';
import { t } from '../../i18n';

/** Role tags in the narrow member sidebar before the rest collapse into "+N". */
const SIDEBAR_ROLE_TAGS = 2;

export interface MemberListHost {
  /** The layout of the server on screen. */
  readonly root: HTMLElement;
  /** Someone's broadcast, after asking. */
  watchLive(sessionId: string): Promise<void>;
}

/** Who is in the server on screen, online and offline, with their voice and status. */
export class MemberList {
  private readonly livePulse = new LivePulseClock();
  /** Delegated listeners of the list, bound once per list element. */
  private delegated: { list: HTMLElement; controller: AbortController } | null = null;

  constructor(private readonly host: MemberListHost) {}

  /** Drops the list's delegated listeners; the next render binds them again. */
  public unbindList(): void {
    this.delegated?.controller.abort();
    this.delegated = null;
  }

  private delegateOnce(list: HTMLElement): void {
    if (this.delegated?.list === list) return;
    this.unbindList();
    const controller = new AbortController();
    this.delegated = { list, controller };
    this.bindMemberListEvents(list, controller.signal);
  }

  /** The member list, reconciled by member like the channel tree (R-SHELL-11). */
  public render(): void {
    if (!serverStore.serverDetails) return;

    const listEl = this.host.root.querySelector<HTMLElement>('#members-list-items');
    const countEl = this.host.root.querySelector<HTMLElement>('#members-count-label');

    const allMembers = serverStore.getAllMembersInDisplayOrder();
    const onlineMembers = allMembers.filter((m) => m.status !== 'DISCONNECTED');
    const offlineMembers = allMembers.filter((m) => m.status === 'DISCONNECTED');

    // For private channel visibility: determine which voice channels the local
    // user can see, so members in invisible private channels appear as offline.
    const visibleChannelIds = new Set(
      (serverStore.serverDetails.channels ?? [])
        .filter((ch) => serverStore.hasPermission(Permission.VIEW_CHANNEL, ch.id))
        .map((ch) => ch.id)
    );

    if (countEl) {
      const count = t('main.membersCount', { count: allMembers.length });
      if (countEl.textContent !== count) countEl.textContent = count;
    }

    // With public badges off, a role tag is only rendered for members who hold
    // that same role — except for admins, who moderate the server and therefore
    // always see every badge (#530).
    const badgesArePublic = serverStore.serverDetails.showRoleBadgesToEveryone !== false;
    const canSeeAllBadges = badgesArePublic || serverStore.hasPermission(Permission.ADMINISTRATOR);
    const myRoleIds = canSeeAllBadges ? [] : serverStore.getUserRoleIds(serverStore.currentUser?.id || '');
    const liveMembers = new Set<string>();
    const renderMemberItem = (m: UserSummary, isOffline: boolean): KeyedItem => {
      const isLocal = m.id === serverStore.currentUser?.id;
      const isLocalCall = isLocal && isViewingCallServer() && !!voiceStore.currentVoiceChannelId;
      const vm = participantManager.getByUserId(m.id);
      const voiceState = vm?.voiceState;
      // If the member is in a private channel the local user cannot access,
      // mask them as offline so their presence is not leaked (#401).
      const inPrivateHiddenChannel = voiceState && !visibleChannelIds.has(voiceState.channelId);
      const effectiveOffline = isOffline || inPrivateHiddenChannel;
      const inVoice = !!voiceState && !inPrivateHiddenChannel;
      const isReconnecting = !effectiveOffline && participantManager.isUserReconnecting(m.id);
      const avatar = getAvatarUrl(m.avatarUrl);
      const isServerDeafened = !effectiveOffline && (isLocalCall ? voiceStore.serverDeafened : (voiceState?.serverDeafened ?? false));
      const isServerMuted = !effectiveOffline && (isLocalCall ? voiceStore.serverMuted : (voiceState?.serverMuted ?? false));
      const isPermissionMuted = !effectiveOffline && (isLocalCall ? voiceStore.permissionMuted : (voiceState?.permissionMuted ?? false));
      const isSelfDeafened = !effectiveOffline && (isLocalCall ? voiceStore.isDeafened : (voiceState?.isDeafened ?? false));
      const isSelfMuted = !effectiveOffline && (isLocalCall ? voiceStore.isMuted : (voiceState?.isMuted ?? false));

      const isLive = !effectiveOffline && !!voiceState?.isScreenSharing;
      if (isLive) liveMembers.add(m.id);
      const livePulseStyle = isLive ? html` style="animation-delay: ${this.livePulse.delay(m.id)}"` : '';
      const isBrb = !effectiveOffline && !m.invisible && m.brb === true;
      const customStatus = effectiveOffline ? null : visibleCustomStatus(m);
      const statusClass = m.invisible ? 'invisible' : (isReconnecting ? 'reconnecting' : (isBrb ? 'brb' : customStatus ? 'custom'
        : (inVoice ? 'voice' : (effectiveOffline ? 'offline' : 'online'))));
      const statusText = m.invisible ? t('main.statusInvisible') : isReconnecting
        ? t('main.reconnecting')
        : (isBrb ? t('main.statusBrb') : customStatus?.text ?? (inVoice ? t('main.inVoiceChannel')
          : (effectiveOffline ? t('main.statusOffline') : t('main.statusOnline'))));
      const userRoles = serverStore
        .getUserRoles(m.id)
        .filter((r) => !r.isDefault && (canSeeAllBadges || myRoleIds.includes(r.id)));
      const watchLabel = t('main.watchLiveAria', { name: m.nickname });

      return {
        key: `member:${m.id}`,
        html: html`
        <div class="member-item ${effectiveOffline ? 'member-offline' : ''} ${isReconnecting ? 'reconnecting' : ''}" data-user-id="${m.id}" title="${m.nickname} (${t(isLocal ? 'common.you' : 'main.rightClickVolume')})">
          <div class="member-avatar-wrapper">
            <img class="member-avatar-img" src="${avatar}" data-fallback="avatar">
            <span class="status-indicator ${statusClass}"${customStatus && statusClass === 'custom' ? html` style="${customStatusDotStyle(customStatus)}"` : ''} role="img" aria-label="${statusText}"></span>
          </div>
          <div class="member-info">
            <div class="member-name-row">
              <span class="member-name">${m.nickname}</span>
              ${effectiveOffline ? '' : trustedHtml(renderPresenceTag(m))}
              ${isLocal ? html`<span class="member-badge-you">${t('common.you')}</span>` : ''}
              ${m.id === serverStore.ownerId ? html`<span class="member-badge-you">${t('roles.ownerBadge')}</span>` : ''}
              ${m.isBot ? html`<span class="member-badge-bot" title="Bot">BOT</span>` : ''}
              ${isReconnecting ? html`<span class="member-reconnecting-badge" title="${t('main.reconnectingTitle')}"><span class="material-symbols-outlined md-14 spin">sync</span></span>` : ''}
              ${isLive ? (isLocal || !vm
                ? html`<span class="member-live-badge"${livePulseStyle} title="${t('main.sharingScreen')}">LIVE</span>`
                : html`<button type="button" class="member-live-badge"${livePulseStyle} data-watch-live="${vm.user.sessionId || vm.user.id}"
                    title="${watchLabel}" aria-label="${watchLabel}">LIVE</button>`) : ''}
              ${(!effectiveOffline && voiceState?.isCameraOn) ? html`<span class="material-symbols-outlined md-14 member-cam-icon" title="${t('main.cameraOn')}">videocam</span>` : ''}
              ${trustedHtml(renderAudioMuteIndicators({ ...voiceState, isMuted: isSelfMuted, isDeafened: isSelfDeafened, serverMuted: isServerMuted, serverDeafened: isServerDeafened, permissionMuted: isPermissionMuted }, { showMicrophone: inVoice || isServerMuted || isPermissionMuted }))}
            </div>
            ${trustedHtml(renderRoleTags(userRoles, SIDEBAR_ROLE_TAGS))}
            <span class="member-subtext"${customStatus?.text ? html` title="${customStatus.text}"` : ''}>${statusText}</span>
          </div>
        </div>`,
      };
    };

    if (listEl) {
      this.delegateOnce(listEl);
      const items: KeyedItem[] = [];
      if (onlineMembers.length > 0) {
        items.push({ key: 'online', html: html`<div class="member-section-header">${t('main.membersOnline')} — ${onlineMembers.length}</div>` });
        for (const member of onlineMembers) items.push(renderMemberItem(member, false));
      }
      if (offlineMembers.length > 0) {
        items.push({ key: 'offline', html: html`<div class="member-section-header">${t('main.membersOffline')} — ${offlineMembers.length}</div>` });
        for (const member of offlineMembers) items.push(renderMemberItem(member, true));
      }
      preserveViewState(listEl, () => renderKeyedList(listEl, items), {
        scroller: null,
        itemKeys: ['data-user-id'],
        fallback: () => listEl,
      });
      this.livePulse.retain(liveMembers);
    }
  }

  private bindMemberListEvents(list: HTMLElement, signal: AbortSignal): void {
    list.addEventListener('contextmenu', (event) => {
      const item = event.target instanceof Element ? event.target.closest<HTMLElement>('.member-item[data-user-id]') : null;
      if (!item) return;
      event.preventDefault();
      const userId = item.dataset.userId;
      if (!userId) return;
      const member = serverStore.knownMembers.get(userId) ?? serverStore.serverDetails?.members.find((u) => u.id === userId);
      if (member) userContextMenu.open(event.clientX, event.clientY, member);
    }, { signal });
    list.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-watch-live]') : null;
      if (!button) return;
      event.stopPropagation();
      if (button.dataset.watchLive) void this.host.watchLive(button.dataset.watchLive);
    }, { signal });
  }}
