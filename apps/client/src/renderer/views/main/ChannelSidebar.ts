import { MessageType, Permission, type ChannelSummary, type ClientMessageArgs } from '@monky/shared';
import { categoryModal } from '../CategoryModal';
import '../channelCategories.css';
import { html, trustedHtml } from '../../utils/html';
import { activityIconSrc } from '../../utils/activityIcon';
import { appEvents } from '../../core/EventBus';
import { networkClient } from '../../core/NetworkClient';
import { sessionManager } from '../../core/SessionManager';
import { participantManager, type ParticipantViewModel } from '../../core/ParticipantManager';
import { markChannelsRead } from '../../core/readState';
import { isViewingCallServer } from '../../core/voiceControls';
import { serverStore } from '../../stores/serverStore';
import { voiceStore } from '../../stores/voiceStore';
import { chatStore } from '../../stores/chatStore';
import { settingsStore, type ChatSoundMode } from '../../stores/settingsStore';
import { createChannelModal } from '../CreateChannelModal';
import { editChannelModal } from '../EditChannelModal';
import { showInfoToast } from '../CopyToast';
import { errorMessage, reportError } from '../../utils/feedback';
import { contextMenu, type ContextMenuEntry } from '../ContextMenu';
import { showConfirm } from '../Dialog';
import { showVoicePermissionDenied, warnIfMoveBlocked } from '../../utils/channelAccess';
import { afkChannelIdOf, renderVoiceUserLimitBadge, voiceUserLimitOf } from '../../utils/voiceRooms';
import { renderChannelIcon } from '../channelIcon';
import { renderKeyedList, type KeyedItem } from '../../utils/keyedList';
import { followPointerReorder, onPrimaryPress } from '../../utils/pointerReorder';
import { preserveViewState } from '../../utils/preserveViewState';
import { userContextMenu } from '../UserContextMenu';
import { getAvatarUrl } from '../../utils/avatar';
import { peerFailureTooltip } from '../../utils/peerFailureHint';
import { isParticipantSpeaking, participantConnectionIndicators } from '../../utils/voiceConnection';
import { renderPresenceTag } from '../../utils/presenceTag';
import { renderAudioMuteIndicators } from '../AudioStateIcon';
import { t } from '../../i18n';

/** A loose channel or a category, the two kinds of entries at the sidebar root. */
type ChannelTreeTarget = { kind: 'channel' | 'category'; id: string };

/** Where a dragged channel would land, and what shows it. */
type ChannelDrop = {
  categoryId: string | null;
  target: ChannelTreeTarget | null;
  after: boolean;
  targetRow: HTMLElement | null;
  dropzone: HTMLElement | null;
};

/** What the channel list needs from the screen around it. */
export interface ChannelSidebarHost {
  /** The layout of the server on screen. */
  readonly root: HTMLElement;
  /** Whether the center shows a conversation or the voice stage. */
  contentView(): 'chat' | 'stage';
  /** The stage on screen shows this room of the server on screen. */
  isViewingVoiceRoom(channelId: string): boolean;
  /** The member's permissions arrived; until then nothing is shown as denied. */
  permissionsResolved(): boolean;
  openTextChannel(channelId: string): void;
  /** Joins a voice room from its row and shows its stage once admitted. */
  enterVoiceChannel(channelId: string): Promise<void>;
  openVoiceChat(channelId: string): void;
  /** Someone's broadcast, after asking. */
  watchLive(sessionId: string): Promise<void>;
}

/**
 * The channel tree of the server on screen: categories, text and voice rooms
 * with who is in them, their menus, reordering by drag and the drags that end
 * on a room (people to move, files to send).
 */
export class ChannelSidebar {
  /** Delegated listeners of the tree, bound once per list element. */
  private delegated: { list: HTMLElement; controller: AbortController } | null = null;
  /** The channel or category being dragged to reorder the tree. */
  private draggedTreeEntry: ChannelTreeTarget | null = null;
  /** The voice room shown with a spinner while it is joined (#48). */
  private joiningVoiceChannelId: string | null = null;
  private textChannelDragHoverTimer: number | null = null;
  private textChannelDragHoverId: string | null = null;

  constructor(private readonly host: ChannelSidebarHost) {}

  /** Listeners outside the tree: the drop that ends a file drag anywhere, and live speaking. */
  public bind(): () => void {
    const controller = new AbortController();
    const clear = (): void => this.clearTextChannelDragHover();
    document.addEventListener('drop', clear, { signal: controller.signal });
    document.addEventListener('dragend', clear, { signal: controller.signal });
    const unbind = [
      appEvents.on('participants.speaking_changed', (data: { sessionId: string; speaking: boolean }) => {
        this.updateSpeaking(data.sessionId);
      }),
      () => controller.abort(),
    ];
    return () => unbind.forEach(off => off());
  }

  /** Drops the tree's delegated listeners; the next render binds them again. */
  public unbindList(): void {
    this.delegated?.controller.abort();
    this.delegated = null;
  }

  public destroy(): void {
    this.clearTextChannelDragHover();
    this.unbindList();
  }

  /** Binds a list's delegated events the first time it is drawn; its rows then come and go freely. */
  private delegateOnce(list: HTMLElement): void {
    if (this.delegated?.list === list) return;
    this.unbindList();
    const controller = new AbortController();
    this.delegated = { list, controller };
    this.bindChannelListEvents(list, controller.signal);
  }

  private isFileDrag(event: DragEvent): boolean {
    const types = event.dataTransfer?.types;
    return !!types && Array.from(types).includes('Files');
  }

  public clearTextChannelDragHover(): void {
    if (this.textChannelDragHoverTimer !== null) {
      window.clearTimeout(this.textChannelDragHoverTimer);
      this.textChannelDragHoverTimer = null;
    }

    if (this.textChannelDragHoverId) {
      const previousItem = this.host.root.querySelector<HTMLElement>(
        `.channel-item[data-channel-id="${this.textChannelDragHoverId}"][data-channel-type="TEXT"]`
      );
      previousItem?.classList.remove('drag-hover');
    }

    this.textChannelDragHoverId = null;
  }

  private scheduleTextChannelAutoSwitch(item: HTMLElement, channelId: string): void {
    if (this.textChannelDragHoverId !== channelId) {
      this.clearTextChannelDragHover();
      this.textChannelDragHoverId = channelId;
      item.classList.add('drag-hover');
    }

    if (this.textChannelDragHoverTimer !== null) return;

    this.textChannelDragHoverTimer = window.setTimeout(() => {
      this.textChannelDragHoverTimer = null;
      if (this.textChannelDragHoverId !== channelId) return;
      if (serverStore.activeTextChannelId === channelId && this.host.contentView() === 'chat') return;
      this.host.openTextChannel(channelId);
    }, 500);
  }

  /**
   * The channel tree. Rows are reconciled by key: a voice, presence or unread
   * event rebuilds only the rows whose markup changed, so focus, an opened
   * menu's button and a drag in progress survive it, and the list's events are
   * delegated once instead of being bound again on every row (R-SHELL-11).
   */
  public render(): void {
    const details = serverStore.serverDetails;
    const categoryList = this.host.root.querySelector<HTMLElement>('#channel-categories-list');
    if (!details || !categoryList) return;
    this.delegateOnce(categoryList);
    const canManageChannels = serverStore.hasPermission(Permission.MANAGE_CHANNELS);
    const canMoveMembers = serverStore.hasPermission(Permission.MOVE_MEMBERS);
    const permissionsResolved = this.host.permissionsResolved();
    const afkChannelId = afkChannelIdOf(details);
    const activeForumId = serverStore.getChannel(serverStore.activeTextChannelId ?? '')?.forumId;
    const rows = new Map<string, KeyedItem>();
    for (const channel of details.channels) {
      if ((channel.type === 'TEXT' || channel.type === 'FORUM') && !channel.forumId) {
        const active = (channel.id === serverStore.activeTextChannelId || channel.id === activeForumId) && this.host.contentView() === 'chat';
        rows.set(channel.id, this.textChannelRow(channel, active, canManageChannels));
      } else if (channel.type === 'VOICE') {
        rows.set(channel.id, this.voiceChannelRow(channel, {
          canManage: canManageChannels, canMove: canMoveMembers, permissionsResolved,
          afk: channel.id === afkChannelId, userLimit: voiceUserLimitOf(details, channel),
        }));
      }
    }

    const categories = details.categories ?? [];
    const channelsById = new Map(details.channels.map((channel) => [channel.id, channel]));
    const treeOrder = serverStore.hasChannelTreeOrder;
    // The root interleaves categories with runs of loose channels. Older
    // servers keep every loose channel in one group above the categories,
    // which stays mounted even when empty so channels can be dropped there.
    const groups: Array<{ id: string; name: string; channels: ChannelSummary[] }> = treeOrder ? [] : [
      { id: '', name: t('categories.uncategorized'), channels: [] },
    ];
    for (const item of serverStore.getChannelTreeRoot()) {
      if (item.kind === 'category') {
        const category = categories.find((entry) => entry.id === item.id);
        if (category) {
          groups.push({ id: category.id, name: category.name, channels: details.channels
            .filter((channel) => channel.categoryId === category.id) });
        }
        continue;
      }
      const channel = channelsById.get(item.id);
      if (!channel) continue;
      const run = treeOrder ? groups.at(-1) : groups[0];
      if (run && !run.id) run.channels.push(channel);
      else groups.push({ id: '', name: t('categories.uncategorized'), channels: [channel] });
    }
    // While a channel is dragged, the space before a category with no loose
    // channel above it, and the end of the list, become slots outside every
    // category. Elsewhere the loose channels themselves mark the position.
    const placesAtRoot = treeOrder && canManageChannels;
    const items: KeyedItem[] = [];
    let looseRuns = 0;
    groups.forEach((group, index) => {
      const previous = groups[index - 1];
      if (placesAtRoot && group.id && (!previous || previous.id)) items.push(this.rootGap(group.id));
      items.push({
        key: group.id ? `category:${group.id}` : `loose:${looseRuns++}`,
        // Collapsing is applied in place (applyCategoryCollapse): the markup stays the same either way.
        html: html`<section class="channel-category${group.id ? '' : ' channel-category--uncategorized'}${group.channels.length ? '' : ' channel-category--empty'}" data-category-id="${group.id}">
          ${group.id ? html`<div class="category-title${canManageChannels ? ' category-reorder-handle' : ''}" data-category-dropzone="${group.id}">
            <button class="category-collapse-btn" data-collapse-category="${group.id}" aria-expanded="true">
              <span class="material-symbols-outlined md-16">expand_more</span>
              <span>${group.name}</span>
            </button>
            ${canManageChannels ? html`<button class="category-add-btn" data-add-category="${group.id}" title="${t('categories.addChannel')}">
              <span class="material-symbols-outlined md-14">add</span></button>` : ''}
          </div>` : canManageChannels && !treeOrder ? html`<div class="category-uncategorized-dropzone" data-category-dropzone="">
            <span class="material-symbols-outlined md-16">drive_file_move</span>
            <span>${group.name}</span>
          </div>` : ''}
          <div class="category-channels" data-category-channels="${group.id}"></div>
        </section>`,
        list: { selector: ':scope > .category-channels', items: group.channels.flatMap((channel) => rows.get(channel.id) ?? []) },
      });
    });
    if (placesAtRoot) items.push(this.rootGap(''));

    preserveViewState(categoryList, () => renderKeyedList(categoryList, items), {
      scroller: null,
      itemKeys: ['data-session-id', 'data-channel-id', 'data-category-id'],
      fallback: () => categoryList.closest<HTMLElement>('.channels-list-container'),
    });
    this.applyCategoryCollapse(categoryList);
    this.updateSpeaking();
    this.markDraggedTreeEntry(categoryList);
  }

  private textChannelRow(channel: ChannelSummary, active: boolean, canManage: boolean): KeyedItem {
    const badge = chatStore.hasMention(channel.id)
      ? html`<span class="channel-mention-badge" title="${t('main.mentionBadge')}">@</span>`
      : chatStore.hasUnread(channel.id) ? html`<span class="channel-unread-dot" title="${t('main.unreadBadge')}"></span>` : '';
    return {
      key: channel.id,
      // A row is dragged to reorder it; it has no title of its own to lose to the hint.
      html: html`
        <div class="channel-item${canManage ? ' channel-reorder-handle' : ''} ${active ? 'active' : ''}" data-channel-id="${channel.id}" data-channel-type="${channel.type}"${canManage ? html` title="${t('main.channelReorderHint')}"` : ''}>
          ${trustedHtml(renderChannelIcon(channel.type === 'FORUM' ? 'FORUM' : 'TEXT', { isPrivate: channel.isPrivate, color: 'var(--text-muted)' }))}
          <span class="channel-name">${channel.name}</span>
          ${badge}
          <button class="channel-menu-btn" data-menu-channel="${channel.id}" title="${t('common.moreOptions')}">
            <span class="material-symbols-outlined md-16">more_vert</span>
          </button>
        </div>`,
    };
  }

  /** A voice room: its header and its participants are reconciled apart, so people coming and going keep the header's focus. */
  private voiceChannelRow(channel: ChannelSummary, room: {
    canManage: boolean; canMove: boolean; permissionsResolved: boolean; afk: boolean; userLimit: number | null;
  }): KeyedItem {
    const inVoice = participantManager.getInVoiceChannel(channel.id);
    const isActive = isViewingCallServer() && channel.id === voiceStore.currentVoiceChannelId;
    const isViewing = this.host.isViewingVoiceRoom(channel.id);
    const showRestrictedIcon = room.permissionsResolved && !serverStore.hasPermission(Permission.VIEW_CHANNEL, channel.id);
    const isRestricted = showRestrictedIcon && !isActive;
    const hasMention = chatStore.hasMention(channel.id);
    const hasUnread = chatStore.hasUnread(channel.id);
    const joining = this.joiningVoiceChannelId === channel.id;
    const header: KeyedItem = {
      key: 'header',
      html: html`
        <div class="channel-item${room.canManage ? ' channel-reorder-handle' : ''} ${isViewing ? 'active' : ''} ${isRestricted ? 'restricted' : ''}${joining ? ' joining' : ''}" data-channel-id="${channel.id}" data-channel-type="VOICE"${room.afk ? trustedHtml(' data-afk-channel') : ''}${room.canManage ? html` title="${t('main.channelReorderHint')}"` : ''}>
          ${trustedHtml(renderChannelIcon('VOICE', { isPrivate: channel.isPrivate, afk: room.afk, color: isActive ? 'var(--success)' : 'var(--text-muted)', loading: joining }))}
          <span class="channel-name">${channel.name}</span>
          ${showRestrictedIcon ? html`<span class="material-symbols-outlined md-16 channel-restricted-icon" title="${t('main.voiceChannelRestricted')}">lock</span>` : ''}
          <span class="voice-channel-trailing">
            ${room.userLimit !== null ? trustedHtml(renderVoiceUserLimitBadge(inVoice.length, room.userLimit)) : ''}
            <span class="voice-channel-actions">
              ${serverStore.hasPermission(Permission.READ_MESSAGES, channel.id) ? html`<button type="button" class="voice-chat-btn ${hasMention ? 'has-mention' : hasUnread ? 'has-unread' : ''}"
                data-voice-chat-channel="${channel.id}" title="${t('voiceChat.open')}" aria-label="${t('voiceChat.open')}">
                <span class="material-symbols-outlined md-16" aria-hidden="true">chat_bubble</span>
              </button>` : ''}
              <button class="channel-menu-btn" data-menu-channel="${channel.id}" title="${t('common.moreOptions')}">
                <span class="material-symbols-outlined md-16">more_vert</span>
              </button>
            </span>
          </span>
        </div>`,
    };
    const parts: KeyedItem[] = [header];
    if (inVoice.length) {
      parts.push({
        key: 'participants',
        html: '<div class="voice-participants-sublist"></div>',
        list: { items: inVoice.map((participant) => this.voiceParticipantRow(participant, room.canMove)) },
      });
    }
    return {
      key: channel.id,
      html: html`<div class="voice-channel-group" data-channel-id="${channel.id}" style="display: flex; flex-direction: column;"></div>`,
      list: { items: parts },
    };
  }

  /** Someone in a voice room. Speaking is applied in place (updateParticipantSpeaking): it is not part of the markup. */
  private voiceParticipantRow(p: ParticipantViewModel, canMove: boolean): KeyedItem {
    const sessionId = p.user.sessionId || p.user.id;
    const isLocal = serverStore.isMySession(p.user.sessionId);
    const isLocalCall = isLocal && isViewingCallServer() && !!voiceStore.currentVoiceChannelId;
    const isServerDeafened = isLocalCall ? voiceStore.serverDeafened : (p.voiceState?.serverDeafened ?? false);
    const isServerMuted = isLocalCall ? voiceStore.serverMuted : (p.voiceState?.serverMuted ?? false);
    const isPermissionMuted = isLocalCall ? voiceStore.permissionMuted : (p.voiceState?.permissionMuted ?? false);
    const isSelfDeafened = isLocalCall ? voiceStore.isDeafened : (p.voiceState?.isDeafened ?? false);
    const isSelfMuted = isLocalCall ? voiceStore.isMuted : (p.voiceState?.isMuted ?? false);
    const avatar = getAvatarUrl(p.user.avatarUrl);
    const displayName = participantManager.displayName(p);
    const isSfu = serverStore.serverDetails?.voiceMode === 'sfu';
    const { isPeerFailed, isConnecting, isRelayed } = participantConnectionIndicators(p, isSfu, isLocal);
    const activity = p.user.activity;
    const activityIcon = activity ? activityIconSrc(activity.iconBase64) : null;
    const watchLabel = t('main.watchLiveAria', { name: displayName });
    return {
      key: sessionId,
      html: html`
        <div id="voice-mini-user-${sessionId}" class="voice-participant-mini" data-session-id="${sessionId}"${canMove ? trustedHtml(' draggable="true"') : ''} title="${displayName} (${t(isLocal ? 'common.you' : 'main.rightClickVolumeShort')})">
          <img class="voice-mini-avatar" src="${avatar}" data-fallback="avatar">
          <span class="voice-mini-name">${displayName}</span>
          ${trustedHtml(renderPresenceTag(p.user))}
          ${isPeerFailed ? html`<span class="material-symbols-outlined md-14 voice-mini-icon peer-failed" title="${isSfu ? t('main.sfuConnectionFailed') : peerFailureTooltip('main.peerConnectionFailed')}">link_off</span>` : ''}
          ${isConnecting ? html`<span class="material-symbols-outlined md-14 voice-mini-icon peer-connecting" title="${t(isSfu ? 'main.sfuConnecting' : 'main.peerConnecting')}">sync</span>` : ''}
          ${isRelayed ? html`<span class="material-symbols-outlined md-14 voice-mini-icon relayed" title="${t('main.peerRelayed')}">swap_horiz</span>` : ''}
          ${trustedHtml(renderAudioMuteIndicators({ ...p.voiceState, isMuted: isSelfMuted, isDeafened: isSelfDeafened, serverMuted: isServerMuted, serverDeafened: isServerDeafened, permissionMuted: isPermissionMuted }))}
          ${p.voiceState?.isScreenSharing ? (isLocal
            ? html`<span class="material-symbols-outlined md-14 voice-mini-icon live" title="${t('main.sharingScreen')}">screen_share</span>`
            : html`<button type="button" class="voice-mini-icon live voice-mini-watch" data-watch-live="${sessionId}"
                title="${watchLabel}" aria-label="${watchLabel}">
                <span class="material-symbols-outlined md-14" aria-hidden="true">screen_share</span>
              </button>`) : ''}
          ${p.voiceState?.isCameraOn ? html`<span class="material-symbols-outlined md-14 voice-mini-icon" title="${t('main.cameraOn')}">videocam</span>` : ''}
          ${activity ? (activityIcon
            ? html`<img class="voice-mini-art" src="${activityIcon}" alt="" title="${t('main.playingGame', { game: activity.name })}">`
            : html`<span class="material-symbols-outlined md-18 voice-mini-icon" title="${t('main.playingGame', { game: activity.name })}">sports_esports</span>`) : ''}
        </div>`,
    };
  }

  private rootGap(beforeCategoryId: string): KeyedItem {
    return {
      key: `gap:${beforeCategoryId}`,
      html: html`<div class="channel-tree-gap${beforeCategoryId ? '' : ' channel-tree-end-dropzone'}" data-root-gap="${beforeCategoryId}" aria-hidden="true">
            <span class="channel-tree-gap-label">
              <span class="material-symbols-outlined md-16">drive_file_move</span>
              <span>${t('categories.uncategorized')}</span>
            </span>
          </div>`,
    };
  }

  /** Collapsed categories are applied in place, so toggling one rebuilds nothing. */
  private applyCategoryCollapse(list: HTMLElement): void {
    for (const button of list.querySelectorAll<HTMLButtonElement>('[data-collapse-category]')) {
      const collapsed = serverStore.isCategoryCollapsed(button.dataset.collapseCategory ?? '');
      const expanded = String(!collapsed);
      if (button.getAttribute('aria-expanded') !== expanded) button.setAttribute('aria-expanded', expanded);
      const icon = button.querySelector('.material-symbols-outlined');
      const glyph = collapsed ? 'chevron_right' : 'expand_more';
      if (icon && icon.textContent !== glyph) icon.textContent = glyph;
      const channels = button.closest('.channel-category')?.querySelector<HTMLElement>(':scope > .category-channels');
      if (channels && channels.hidden !== collapsed) channels.hidden = collapsed;
    }
  }

  /** A row rebuilt while it is being dragged goes on showing it. */
  private markDraggedTreeEntry(list: HTMLElement): void {
    const dragged = this.draggedTreeEntry;
    if (!dragged) return;
    const id = CSS.escape(dragged.id);
    if (dragged.kind === 'channel') list.querySelector(`[data-category-channels] > [data-channel-id="${id}"]`)?.classList.add('channel-dragging');
    else list.querySelector(`.channel-category[data-category-id="${id}"]`)?.classList.add('category-dragging');
  }

  private bindChannelListEvents(list: HTMLElement, signal: AbortSignal): void {
    const target = (event: Event): Element | null => event.target instanceof Element ? event.target : null;
    list.addEventListener('click', event => {
      const element = target(event);
      const collapse = element?.closest<HTMLButtonElement>('[data-collapse-category]');
      if (collapse) {
        serverStore.toggleCategoryCollapsed(collapse.dataset.collapseCategory ?? '');
        this.applyCategoryCollapse(list);
        return;
      }
      const add = element?.closest<HTMLButtonElement>('[data-add-category]');
      if (add) {
        createChannelModal.open('TEXT', add.dataset.addCategory || null);
        return;
      }
      // Someone else's share icon opens their broadcast, after asking.
      const watch = element?.closest<HTMLButtonElement>('[data-watch-live]');
      if (watch) {
        event.stopPropagation();
        if (watch.dataset.watchLive) void this.host.watchLive(watch.dataset.watchLive);
        return;
      }
      const chat = element?.closest<HTMLButtonElement>('[data-voice-chat-channel]');
      if (chat) {
        event.stopPropagation();
        if (chat.dataset.voiceChatChannel) this.host.openVoiceChat(chat.dataset.voiceChatChannel);
        return;
      }
      // "More options" (#151): the same menu as right-clicking the channel.
      const menu = element?.closest<HTMLButtonElement>('.channel-menu-btn[data-menu-channel]');
      if (menu) {
        event.stopPropagation();
        const rect = menu.getBoundingClientRect();
        if (menu.dataset.menuChannel) this.openChannelMenu(menu.dataset.menuChannel, rect.left, rect.bottom + 4);
        return;
      }
      const item = element?.closest<HTMLElement>('.channel-item[data-channel-id]');
      if (item) void this.selectChannelItem(item);
    }, { signal });
    list.addEventListener('contextmenu', event => {
      const element = target(event);
      const participant = element?.closest<HTMLElement>('.voice-participant-mini[data-session-id]');
      if (participant) {
        event.preventDefault();
        const user = participantManager.get(participant.dataset.sessionId ?? '')?.user;
        if (user) userContextMenu.open(event.clientX, event.clientY, user);
        return;
      }
      const title = element?.closest<HTMLElement>('.category-title');
      if (title) {
        event.preventDefault();
        const categoryId = title.closest<HTMLElement>('.channel-category')?.dataset.categoryId;
        if (categoryId) this.openCategoryMenu(categoryId, event.clientX, event.clientY);
        return;
      }
      // Right-clicking a channel opens the same options menu as the ⋮ button (#151).
      const item = element?.closest<HTMLElement>('.channel-item[data-channel-id]');
      if (item?.dataset.channelId) {
        event.preventDefault();
        this.openChannelMenu(item.dataset.channelId, event.clientX, event.clientY);
      }
    }, { signal });
    onPrimaryPress(list, event => {
      if (!serverStore.hasPermission(Permission.MANAGE_CHANNELS)) return;
      const element = target(event);
      const handle = element?.closest<HTMLElement>('.channel-item.channel-reorder-handle[data-channel-id]');
      if (handle) {
        if (!element?.closest('button')) this.beginChannelReorder(handle, event, list, signal);
        return;
      }
      const title = element?.closest<HTMLElement>('.category-title.category-reorder-handle');
      if (title && !element?.closest('.category-add-btn')) this.beginCategoryReorder(title, event, list, signal);
    }, { signal });
    // Dragging people between voice rooms (#248). The AFK room is no destination:
    // nobody is brought there by hand (#357).
    list.addEventListener('dragstart', event => {
      const participant = target(event)?.closest<HTMLElement>('.voice-participant-mini[draggable="true"]');
      const sessionId = participant?.dataset.sessionId;
      if (!participant || !sessionId || !event.dataTransfer) return;
      event.dataTransfer.setData('text/monky-session-id', sessionId);
      event.dataTransfer.effectAllowed = 'move';
      participant.classList.add('dragging');
    }, { signal });
    list.addEventListener('dragend', event => {
      target(event)?.closest('.voice-participant-mini')?.classList.remove('dragging');
    }, { signal });
    // Files held over a text channel switch to it, so they can be dropped in its chat.
    const fileOver = (event: DragEvent): boolean => {
      const item = target(event)?.closest<HTMLElement>('.channel-item[data-channel-type="TEXT"][data-channel-id]');
      if (!item?.dataset.channelId || !this.isFileDrag(event)) return false;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      this.scheduleTextChannelAutoSwitch(item, item.dataset.channelId);
      return true;
    };
    list.addEventListener('dragenter', fileOver, { signal });
    list.addEventListener('dragover', event => {
      if (fileOver(event)) return;
      const room = this.voiceDropTarget(target(event));
      if (!room || !event.dataTransfer?.types.includes('text/monky-session-id')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      room.classList.add('drop-target');
    }, { signal });
    list.addEventListener('dragleave', event => {
      const element = target(event);
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      const item = element?.closest<HTMLElement>('.channel-item[data-channel-type="TEXT"][data-channel-id]');
      if (item && this.isFileDrag(event) && !(next && item.contains(next))
        && this.textChannelDragHoverId === item.dataset.channelId) this.clearTextChannelDragHover();
      const room = element?.closest<HTMLElement>('.voice-channel-group');
      if (room && !(next && room.contains(next))) room.classList.remove('drop-target');
    }, { signal });
    list.addEventListener('drop', event => {
      const element = target(event);
      if (element?.closest('.channel-item[data-channel-type="TEXT"]')) this.clearTextChannelDragHover();
      const room = this.voiceDropTarget(element);
      if (!room) return;
      event.preventDefault();
      room.classList.remove('drop-target');
      const sessionId = event.dataTransfer?.getData('text/monky-session-id');
      if (sessionId && room.dataset.channelId) this.moveParticipant(sessionId, room.dataset.channelId);
    }, { signal });
  }

  /** The voice room under a dragged person, when people may be moved there. */
  private voiceDropTarget(element: Element | null): HTMLElement | null {
    const room = element?.closest<HTMLElement>('.voice-channel-group[data-channel-id]');
    if (!room || !serverStore.hasPermission(Permission.MOVE_MEMBERS)) return null;
    return room.dataset.channelId === afkChannelIdOf(serverStore.serverDetails) ? null : room;
  }

  private moveParticipant(sessionId: string, channelId: string): void {
    const participant = participantManager.get(sessionId);
    const sourceId = participant?.voiceState?.channelId;
    if (sourceId === channelId || !sourceId || !serverStore.hasPermission(Permission.MOVE_MEMBERS)) return;
    const targetUser = participant?.user;
    if (targetUser && warnIfMoveBlocked(targetUser.id, targetUser.nickname, channelId)) return;
    void networkClient.sendRequest(MessageType.ADMIN_MOVE_USER, { targetSessionId: sessionId, channelId }).catch((err: unknown) => {
      reportError(errorMessage(err, t('userMenu.actionFailed')));
    });
  }

  /** A click on a channel row: a text channel opens; a voice room is joined and its stage shown. */
  private async selectChannelItem(item: HTMLElement): Promise<void> {
    const channelId = item.dataset.channelId;
    const type = item.dataset.channelType;
    if (!channelId) return;
    if (type === 'TEXT' || type === 'FORUM') {
      this.host.openTextChannel(channelId);
      return;
    }
    if (type !== 'VOICE') return;
    // Nobody enters the AFK room on purpose; whoever is already in it just opens its stage.
    if (item.hasAttribute('data-afk-channel') && !(channelId === voiceStore.currentVoiceChannelId
      && voiceStore.voiceSessionKey === sessionManager.getActiveKey())) {
      showInfoToast(t('afk.joinBlocked'), 5000);
      return;
    }
    if (channelId !== voiceStore.currentVoiceChannelId && this.host.permissionsResolved() && !serverStore.hasPermission(Permission.VIEW_CHANNEL, channelId)) {
      item.classList.add('restricted-feedback');
      window.setTimeout(() => item.classList.remove('restricted-feedback'), 600);
      showVoicePermissionDenied();
      return;
    }
    // The room shows a spinner while the voice join happens (#48).
    this.joiningVoiceChannelId = channelId;
    this.render();
    try {
      await this.host.enterVoiceChannel(channelId);
    } finally {
      if (this.joiningVoiceChannelId === channelId) this.joiningVoiceChannelId = null;
      this.render();
    }
  }

  /**
   * Channels are reordered by a pointer drag, so it mixes categories without
   * interfering with the native voice-member or attachment drags. A voice room
   * and its participants live in a wrapper: the direct child of the list moves.
   */
  private beginChannelReorder(handle: HTMLElement, press: PointerEvent, list: HTMLElement, signal: AbortSignal): void {
    const channelId = handle.dataset.channelId;
    if (!channelId) return;
    const settle = () => {
      this.draggedTreeEntry = null;
      list.querySelectorAll('.channel-dragging').forEach((element) => element.classList.remove('channel-dragging'));
      this.clearChannelDropTargets(list);
    };
    followPointerReorder(press, {
      capture: list,
      signal,
      onStart: () => {
        this.draggedTreeEntry = { kind: 'channel', id: channelId };
        this.markDraggedTreeEntry(list);
        list.classList.add('channel-reorder-active');
      },
      onMove: (x, y) => this.showChannelDropTarget(list, this.channelDropTarget(x, y)),
      onDrop: (x, y) => {
        // Measured before the drop surfaces fold away and move what is under the pointer.
        const target = this.channelDropTarget(x, y);
        settle();
        if (target && target.target?.id !== channelId) {
          void this.commitChannelOrder(target.categoryId, channelId, target.target, target.after);
        }
      },
      onCancel: settle,
    });
  }

  private clearChannelDropTargets(list: HTMLElement): void {
    list.classList.remove('channel-reorder-active');
    list.querySelectorAll('.channel-category-drop-target').forEach((element) => {
      element.classList.remove('channel-category-drop-target');
    });
    list.querySelectorAll('.channel-drop-before, .channel-drop-after').forEach((element) => {
      element.classList.remove('channel-drop-before', 'channel-drop-after');
    });
  }

  private showChannelDropTarget(list: HTMLElement, target: ChannelDrop | null): void {
    this.clearChannelDropTargets(list);
    list.classList.add('channel-reorder-active');
    if (!target) return;
    target.dropzone?.classList.add('channel-category-drop-target');
    target.targetRow?.classList.add(target.after ? 'channel-drop-after' : 'channel-drop-before');
  }

  /** Where a dragged channel would land, aimed through what is under the pointer. */
  private channelDropTarget(clientX: number, clientY: number): ChannelDrop | null {
    const element = document.elementFromPoint(clientX, clientY);
    const targetHandle = element?.closest<HTMLElement>('.channel-item[data-channel-id]');
    const targetList = targetHandle?.closest<HTMLElement>('[data-category-channels]');
    if (targetHandle && targetList) {
      let targetRow = targetHandle;
      while (targetRow.parentElement && targetRow.parentElement !== targetList) targetRow = targetRow.parentElement;
      const rect = targetRow.getBoundingClientRect();
      const targetId = targetHandle.dataset.channelId;
      return {
        categoryId: targetList.dataset.categoryChannels || null,
        target: targetId ? { kind: 'channel', id: targetId } : null,
        after: clientY > rect.top + rect.height / 2,
        targetRow,
        dropzone: null,
      };
    }
    // A slot outside every category: right above its category, or the end.
    const gap = element?.closest<HTMLElement>('[data-root-gap]');
    if (gap) {
      const beforeCategoryId = gap.dataset.rootGap;
      return {
        categoryId: null,
        target: beforeCategoryId ? { kind: 'category', id: beforeCategoryId } : null,
        after: false,
        targetRow: null,
        dropzone: gap,
      };
    }
    const dropzone = element?.closest<HTMLElement>('[data-category-dropzone]');
    if (dropzone) {
      return { categoryId: dropzone.dataset.categoryDropzone || null, target: null, after: true, targetRow: null, dropzone };
    }
    const list = element?.closest<HTMLElement>('[data-category-channels]');
    if (!element || !list) return null;
    // Over a row but off its handle (a voice channel's participants), or over
    // a gap: place next to that row, or after the list's last channel. A
    // root group is one of several, so its end is not the end of the root.
    const rows = Array.from(list.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
    const row = rows.find((candidate) => candidate.contains(element)) ??
      (serverStore.hasChannelTreeOrder && !list.dataset.categoryChannels ? rows.at(-1) : undefined);
    const rowHandle = row?.matches('.channel-item[data-channel-id]') ? row : row?.querySelector<HTMLElement>('.channel-item[data-channel-id]');
    const rowId = rowHandle?.dataset.channelId;
    if (row && rowId) {
      const rect = row.getBoundingClientRect();
      const after = !rows.some((candidate) => candidate.contains(element)) || clientY > rect.top + rect.height / 2;
      return { categoryId: list.dataset.categoryChannels || null, target: { kind: 'channel', id: rowId }, after, targetRow: row, dropzone: null };
    }
    return { categoryId: list.dataset.categoryChannels || null, target: null, after: true, targetRow: null, dropzone: null };
  }

  /** Categories are reordered the same way, by dragging their title. */
  private beginCategoryReorder(title: HTMLElement, press: PointerEvent, list: HTMLElement, signal: AbortSignal): void {
    const categoryId = title.closest<HTMLElement>('.channel-category[data-category-id]')?.dataset.categoryId;
    if (!categoryId) return;
    const clearIndicators = () => {
      list.querySelectorAll('.category-drop-before, .category-drop-after, .channel-drop-before, .channel-drop-after, .channel-category-drop-target')
        .forEach((element) => element.classList.remove('category-drop-before', 'category-drop-after', 'channel-drop-before',
          'channel-drop-after', 'channel-category-drop-target'));
    };
    const settle = () => {
      this.draggedTreeEntry = null;
      list.classList.remove('category-reorder-active');
      list.querySelectorAll('.category-dragging').forEach((element) => element.classList.remove('category-dragging'));
      clearIndicators();
    };
    followPointerReorder(press, {
      capture: list,
      signal,
      onStart: () => {
        this.draggedTreeEntry = { kind: 'category', id: categoryId };
        this.markDraggedTreeEntry(list);
        list.classList.add('category-reorder-active');
      },
      onMove: (x, y) => {
        clearIndicators();
        const target = this.categoryDropTarget(x, y);
        target?.indicator.classList.add(target.indicatorClass);
      },
      onDrop: (x, y) => {
        const target = this.categoryDropTarget(x, y);
        settle();
        if (target && target.target?.id !== categoryId) this.commitCategoryOrder(categoryId, target.target, target.after);
      },
      onCancel: settle,
    });
  }

  /**
   * Where a dragged category would land. Older servers only order categories among
   * themselves; with a shared root, loose channels and the end are targets too.
   */
  private categoryDropTarget(clientX: number, clientY: number): {
    target: ChannelTreeTarget | null; after: boolean; indicator: HTMLElement; indicatorClass: string;
  } | null {
    const treeOrder = serverStore.hasChannelTreeOrder;
    const element = document.elementFromPoint(clientX, clientY);
    const title = element?.closest<HTMLElement>('.category-title[data-category-dropzone]');
    const section = (title ?? (treeOrder ? element : null))
      ?.closest<HTMLElement>('.channel-category[data-category-id]:not(.channel-category--uncategorized)');
    const categoryId = section?.dataset.categoryId;
    if (section && categoryId) {
      const after = title ? clientY > title.getBoundingClientRect().top + title.getBoundingClientRect().height / 2 : true;
      return { target: { kind: 'category', id: categoryId }, after, indicator: section,
        indicatorClass: after ? 'category-drop-after' : 'category-drop-before' };
    }
    if (!treeOrder || !element) return null;
    const handle = element.closest<HTMLElement>('.channel-item[data-channel-id]');
    const list = handle?.closest<HTMLElement>('[data-category-channels=""]');
    if (handle?.dataset.channelId && list) {
      let row = handle;
      while (row.parentElement && row.parentElement !== list) row = row.parentElement;
      const rect = row.getBoundingClientRect();
      const after = clientY > rect.top + rect.height / 2;
      return { target: { kind: 'channel', id: handle.dataset.channelId }, after, indicator: row,
        indicatorClass: after ? 'channel-drop-after' : 'channel-drop-before' };
    }
    const end = element.closest<HTMLElement>('.channel-tree-end-dropzone');
    return end ? { target: null, after: true, indicator: end, indicatorClass: 'channel-category-drop-target' } : null;
  }

  /** The sidebar root with one entry moved next to `target`, or to the end without one. */
  private rootOrderWith(item: ChannelTreeTarget, target: ChannelTreeTarget | null, after: boolean): ChannelTreeTarget[] | null {
    const root: ChannelTreeTarget[] = serverStore.getChannelTreeRoot()
      .map(({ kind, id }) => ({ kind, id }))
      .filter((entry) => entry.kind !== item.kind || entry.id !== item.id);
    let index = root.length;
    if (target) {
      const at = root.findIndex((entry) => entry.kind === target.kind && entry.id === target.id);
      if (at < 0) return null;
      index = after ? at + 1 : at;
    }
    root.splice(index, 0, item);
    return root;
  }

  /**
   * Sends a new root order. Servers with a shared root take it whole; older
   * ones order loose channels and categories separately, so only the kind that
   * moved is sent and the other keeps its place.
   */
  private sendRootOrder(root: ChannelTreeTarget[], moved: ChannelTreeTarget['kind']): Promise<unknown> {
    if (serverStore.hasChannelTreeOrder) {
      return networkClient.sendRequest(MessageType.CHANNEL_REORDER, { categoryId: null, orderedIds: root.map((entry) => entry.id) });
    }
    const orderedIds = root.filter((entry) => entry.kind === moved).map((entry) => entry.id);
    return moved === 'category'
      ? networkClient.sendRequest(MessageType.CATEGORY_REORDER, { orderedIds })
      : networkClient.sendRequest(MessageType.CHANNEL_REORDER, { categoryId: null, orderedIds });
  }

  private commitCategoryOrder(draggedId: string, target: ChannelTreeTarget | null, after: boolean): void {
    const root = this.rootOrderWith({ kind: 'category', id: draggedId }, target, after);
    if (!root) return;
    void this.sendRootOrder(root, 'category').catch((error: unknown) => {
      reportError(errorMessage(error, t('categories.error')));
    });
  }

  /**
   * Sends the reordered list to the server (#471).
   *
   * Moving first preserves an override, or adopts the destination's ACL for
   * inherited channels. The server confirms each step before the next is sent.
   */
  private async commitChannelOrder(
    categoryId: string | null,
    draggedId: string,
    target: ChannelTreeTarget | null,
    after: boolean
  ): Promise<void> {
    const dragged = serverStore.getChannel(draggedId);
    if (!dragged) return;
    let reorder: () => Promise<unknown>;
    if (categoryId === null) {
      // Outside every category the channel takes a slot in the shared root.
      const root = this.rootOrderWith({ kind: 'channel', id: draggedId }, target, after);
      if (!root) return;
      reorder = () => this.sendRootOrder(root, 'channel');
    } else {
      const channels = serverStore.serverDetails?.channels.filter((c) =>
        !c.forumId && (c.categoryId ?? null) === categoryId) ?? [];
      const ids = channels.map((c) => c.id).filter((id) => id !== draggedId);
      let index = ids.length;
      if (target) {
        const at = target.kind === 'channel' ? ids.indexOf(target.id) : -1;
        if (at === -1) return;
        index = after ? at + 1 : at;
      }
      ids.splice(index, 0, draggedId);
      reorder = () => networkClient.sendRequest(MessageType.CHANNEL_REORDER, { categoryId, orderedIds: ids });
    }

    try {
      if ((dragged.categoryId ?? null) !== categoryId) {
        await networkClient.sendRequest(MessageType.CHANNEL_UPDATE, { channelId: draggedId, categoryId });
      }
      await reorder();
    } catch (err: unknown) {
      reportError(errorMessage(err, t('main.channelReorderFailed')));
      this.render();
    }
  }

  /** A forum's unread state lives in its posts, which are channels of their own. */
  private readableChannelIds(channelId: string): string[] {
    const channels = serverStore.serverDetails?.channels ?? [];
    const channel = channels.find((item) => item.id === channelId);
    if (!channel) return [];
    return channel.type === 'FORUM'
      ? [channel.id, ...channels.filter((item) => item.forumId === channel.id).map((item) => item.id)]
      : [channel.id];
  }

  private hasUnreadIn(channelIds: readonly string[]): boolean {
    return channelIds.some((id) => chatStore.hasUnread(id) || chatStore.hasMention(id));
  }

  /** Clears the unread dot and, on the server too, any pending mention (#263, #14). */
  private markChannelsRead(channelIds: readonly string[]): void {
    markChannelsRead({ chatStore, client: networkClient }, channelIds);
  }

  /**
   * Mark as read is offered to everyone; arranging the category stays with
   * whoever can manage channels.
   */
  private openCategoryMenu(categoryId: string, x: number, y: number): void {
    const categories = serverStore.serverDetails?.categories ?? [];
    const category = categories.find((item) => item.id === categoryId);
    if (!category) return;
    const inCategory = (serverStore.serverDetails?.channels ?? [])
      .filter((item) => item.categoryId === categoryId && !item.forumId)
      .flatMap((item) => this.readableChannelIds(item.id));
    const markRead: ContextMenuEntry = {
      label: t('categories.markAsRead'), icon: 'mark_chat_read',
      disabled: !this.hasUnreadIn(inCategory),
      onClick: () => this.markChannelsRead(inCategory),
    };
    if (!serverStore.hasPermission(Permission.MANAGE_CHANNELS)) {
      contextMenu.open(x, y, [markRead]);
      return;
    }
    // A category steps past its root neighbour, loose channels included when
    // the server shares one root order.
    const siblings = serverStore.getChannelTreeRoot()
      .filter((item) => serverStore.hasChannelTreeOrder || item.kind === 'category');
    const position = siblings.findIndex((item) => item.kind === 'category' && item.id === categoryId);
    const move = (delta: number) => {
      const neighbor = siblings[position + delta];
      if (neighbor) this.commitCategoryOrder(categoryId, { kind: neighbor.kind, id: neighbor.id }, delta > 0);
    };
    contextMenu.open(x, y, [
      markRead,
      { label: t('categories.addChannel'), icon: 'add', onClick: () => createChannelModal.open('TEXT', categoryId) },
      { label: t('categories.edit'), icon: 'settings', onClick: () => categoryModal.open(category) },
      { label: t('categories.moveUp'), icon: 'arrow_upward', disabled: position <= 0 || !serverStore.hasPermission(Permission.MANAGE_CHANNELS), onClick: () => move(-1) },
      { label: t('categories.moveDown'), icon: 'arrow_downward', disabled: position < 0 || position === siblings.length - 1 || !serverStore.hasPermission(Permission.MANAGE_CHANNELS), onClick: () => move(1) },
      {
        label: t('categories.delete'), icon: 'delete', danger: true, onClick: () => {
          void showConfirm({ title: t('categories.delete'), message: t('categories.deleteConfirm'), variant: 'danger' })
            .then((confirmed) => { if (confirmed) this.requestCategoryChange(MessageType.CATEGORY_DELETE, { categoryId }); });
        },
      },
    ]);
  }

  private requestCategoryChange(...message: ClientMessageArgs): void {
    void networkClient.sendRequest(...message).catch((error: unknown) => {
      reportError(errorMessage(error, t('categories.error')));
    });
  }

  /** Opens the per-channel options menu at the given screen coordinates (#151). */
  public openChannelMenu(channelId: string, x: number, y: number): void {
    const channel = serverStore.serverDetails?.channels.find((c) => c.id === channelId);
    const items: ContextMenuEntry[] = [];

    // Always listed first, as in Discord, and disabled when there is nothing
    // to clear; hiding it made the option look missing (#263).
    if (channel?.type === 'TEXT' || channel?.type === 'VOICE' || channel?.type === 'FORUM') {
      const readable = this.readableChannelIds(channelId);
      items.push({
        label: t('channelMenu.markAsRead'),
        icon: 'mark_chat_read',
        disabled: !this.hasUnreadIn(readable),
        onClick: () => this.markChannelsRead(readable),
      });
    }

    // Notification controls apply to every channel that carries messages.
    if (channel?.type === 'TEXT' || channel?.type === 'VOICE') {
      items.push({
        label: t('channelMenu.notifications'),
        icon: 'notifications',
        onClick: () => this.openChannelNotificationMenu(channelId, x, y),
      });
    }

    if (serverStore.hasPermission(Permission.MANAGE_CHANNELS)) {
      if (channel && serverStore.hasPermission(Permission.MANAGE_CHANNELS)) {
        const categoryId = channel.categoryId && serverStore.serverDetails?.categories?.some((item) => item.id === channel.categoryId)
          ? channel.categoryId : null;
        // Inside a category a channel moves among its siblings; at the root it
        // steps past loose channels and, with a shared root, categories too.
        const siblings: ChannelTreeTarget[] = categoryId
          ? (serverStore.serverDetails?.channels ?? []).filter((item) => !item.forumId && item.categoryId === categoryId)
            .map((item) => ({ kind: 'channel', id: item.id }))
          : serverStore.getChannelTreeRoot().filter((item) => serverStore.hasChannelTreeOrder || item.kind === 'channel')
            .map(({ kind, id }) => ({ kind, id }));
        const at = siblings.findIndex((item) => item.kind === 'channel' && item.id === channelId);
        items.push({
          label: t('categories.moveTo'), icon: 'drive_file_move',
          submenu: [
            { id: null, name: t('categories.uncategorized') },
            ...(serverStore.serverDetails?.categories ?? []),
          ].map((category) => ({
            label: category.name,
            disabled: category.id === categoryId,
            onClick: () => { void this.commitChannelOrder(category.id, channelId, null, true); },
          })),
        });
        items.push(
          { label: t('categories.moveUp'), icon: 'arrow_upward', disabled: at <= 0, onClick: () => { void this.commitChannelOrder(categoryId, channelId, siblings[at - 1] ?? null, false); } },
          { label: t('categories.moveDown'), icon: 'arrow_downward', disabled: at < 0 || at >= siblings.length - 1, onClick: () => { void this.commitChannelOrder(categoryId, channelId, siblings[at + 1] ?? null, true); } },
        );
      }
      items.push({
        label: t('main.editChannel'),
        icon: 'settings',
        onClick: () => {
          editChannelModal.open(channelId);
        },
      });
      // The AFK room is removed by turning it off in the server settings.
      items.push(channelId === afkChannelIdOf(serverStore.serverDetails) ? {
        label: t('afk.deleteDisabled'),
        icon: 'delete',
        disabled: true,
        onClick: () => undefined,
      } : {
        label: t('main.deleteChannel'),
        icon: 'delete',
        danger: true,
        onClick: () => {
          void this.deleteChannel(channelId);
        },
      });
    }

    contextMenu.open(x, y, items);
  }

  /** Submenu to pick the per-channel chat-sound mode, overriding server/global (#153). */
  private openChannelNotificationMenu(channelId: string, x: number, y: number): void {
    const current = settingsStore.getChannelChatSoundOverride(channelId);
    const item = (mode: ChatSoundMode, label: string) => ({
      label,
      icon: current === mode ? 'check' : undefined,
      onClick: () => settingsStore.setChannelChatSoundOverride(channelId, mode),
    });
    contextMenu.open(x, y, [
      item('inherit', t('chatSound.inheritServer')),
      item('all', t('chatSound.all')),
      item('mentions', t('chatSound.mentions')),
      item('none', t('chatSound.none')),
    ]);
  }

  /**
   * Deletes a channel once the server agrees. Until then nothing changes here:
   * a refusal is explained and the call in a voice room goes on. On success the
   * server takes everyone out of the room and announces the deletion, which
   * updates this list and whatever the screen showed of it.
   */
  private async deleteChannel(channelId: string): Promise<void> {
    const session = sessionManager.getActive();
    const channel = serverStore.serverDetails?.channels.find((c) => c.id === channelId);
    if (!channel) return;

    const isText = channel.type === 'TEXT';
    const confirmed = await showConfirm({
      title: isText ? t('main.deleteTextChannelTitle') : t('main.deleteVoiceChannelTitle'),
      message: isText
        ? t('main.deleteTextChannelMessage', { name: channel.name })
        : t('main.deleteVoiceChannelMessage', { name: channel.name }),
      confirmLabel: t('main.delete'),
      variant: 'danger',
    });
    // The question may outlive the server it was about.
    if (!confirmed || sessionManager.getActive() !== session) return;
    try {
      await networkClient.sendRequest(MessageType.CHANNEL_DELETE, { channelId });
    } catch (error: unknown) {
      reportError(errorMessage(error, t('main.deleteChannelFailed')), { log: 'CONNECTION', error });
    }
  }

  public updateSpeaking(sessionId?: string): void {
    for (const row of this.host.root.querySelectorAll<HTMLElement>('.voice-participant-mini[data-session-id]')) {
      const id = row.dataset.sessionId;
      if (!id || (sessionId && id !== sessionId)) continue;
      row.classList.toggle('speaking', isParticipantSpeaking(participantManager.get(id)));
    }
  }

  /** The menu of the empty sidebar: creating a channel or a category, for whoever manages channels. */
  public bindBackgroundMenu(): () => void {
    const list = this.host.root.querySelector<HTMLElement>('.channels-list-container');
    if (!list) return () => {};
    const open = (event: MouseEvent) => {
      if (event.defaultPrevented || !(event.target instanceof Element) ||
          event.target.closest('.channel-item, .category-title, #server-community')) return;
      event.preventDefault();
      const items: ContextMenuEntry[] = [];
      if (serverStore.hasPermission(Permission.MANAGE_CHANNELS)) {
        items.push(
          { label: t('channelModal.title'), icon: 'add', onClick: () => createChannelModal.open('TEXT', null) },
          { label: t('categories.create'), icon: 'create_new_folder', onClick: () => categoryModal.open() },
        );
      }
      const rect = list.getBoundingClientRect();
      contextMenu.open(event.clientX || rect.left, event.clientY || rect.top, items, list);
    };
    list.addEventListener('contextmenu', open);
    return () => list.removeEventListener('contextmenu', open);
  }
}
