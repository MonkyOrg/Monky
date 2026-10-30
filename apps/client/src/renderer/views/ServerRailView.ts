import { escapeHtml } from '../utils/html';
import { sessionManager, sessionKeyFor } from '../core/SessionManager';
import {
  assertServerBrowseAvailable, captureServerBrowseIntent, getServerSessionForAddress, openServerSession, showHome, showServerSession,
} from '../core/serverConnection';
import { ensureHostedServerStarted, findOwnedServer } from '../core/hostedServerStart';
import { voiceStore } from '../stores/voiceStore';
import { settingsStore } from '../stores/settingsStore';
import { favoritesStore } from '../stores/favoritesStore';
import {
  connectionStore,
  CreatedServer,
  DEFAULT_FOLDER_COLOR,
  SavedServer,
  RailFolderNode,
  RailNode,
} from '../stores/connectionStore';
import { showConfirm, showAlert, showTextForm } from './Dialog';
import { checkServerOnline, fetchServerPreview } from '../utils/serverStatus';
import {
  confirmStopHostedServer,
} from '../utils/hostedServer';
import { resolveImageUrl, toAbsoluteServerIconUrl } from '../utils/avatar';
import { serverAddressKey } from '../utils/serverAddress';
import { initialImageState } from '../utils/imageFallback';
import { followPointerReorder, onPrimaryPress } from '../utils/pointerReorder';
import { t } from '../i18n';
import { contextMenu, type ContextMenuEntry } from './ContextMenu';
import { appEvents } from '../core/EventBus';
import { addServerModal } from './addServer/AddServerModal';
import { serverMonitorModal } from './ServerMonitorModal';
import { folderSettingsModal } from './FolderSettingsModal';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { animateEnter } from '../utils/surfaceMotion';
import { markSessionRead } from '../core/readState';
import { dmStore } from '../stores/dmStore';
import type { ChatSoundMode } from '../stores/settingsStore';
import type { HostServerStatus } from '@monky/shared';
import { showErrorToast } from './CopyToast';

type RailUnread = 'mention' | 'unread' | null;

const NOTIFICATION_MODES: ReadonlyArray<{ mode: ChatSoundMode; label: 'chatSound.inheritGeneral' | 'chatSound.all' | 'chatSound.mentions' | 'chatSound.none' }> = [
  { mode: 'inherit', label: 'chatSound.inheritGeneral' },
  { mode: 'all', label: 'chatSound.all' },
  { mode: 'mentions', label: 'chatSound.mentions' },
  { mode: 'none', label: 'chatSound.none' },
];

type DraggedRailItem =
  | { type: 'server'; host: string; port: number }
  | { type: 'folder'; folderId: string };

export function serverRailCallIcon(
  events: readonly { status: string; location: { kind: string; channelId?: string } }[] | undefined,
  channelId: string | null,
): 'calendar_month' | 'volume_up' {
  return channelId && events?.some(event => event.status === 'active' && event.location.kind === 'voice'
    && event.location.channelId === channelId) ? 'calendar_month' : 'volume_up';
}

export class ServerRailView {
  /**
   * Server the user is currently connecting to, as its address key. Kept on the view
   * (instead of poked straight into the DOM) because `render()` runs again on
   * network events and would wipe any attribute set by hand (#332).
   */
  private connectingKey: string | null = null;
  /** The server or folder being dragged to reorder the rail; null when nothing is. */
  private draggedRailItem: DraggedRailItem | null = null;
  private lastProbeTime = 0;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * What the last HTTP probe saw of each saved server that no session vouches
   * for, by address key. The dots are painted from it after every render and
   * every probe (applyStatuses): a probe written only into the DOM outlived the
   * state it described, once an unchanged rail stopped being rebuilt.
   */
  private readonly probedOnline = new Map<string, boolean>();
  private homeBadgeCount = 0;
  /** Ports of the servers this app is hosting right now, pushed by the main process. */
  private hostedPorts = new Set<number>();
  /**
   * Folders toggled by the user, animated by the next render: toggling saves
   * the layout and repaints the whole rail, so the motion is applied to the
   * fresh element (true = opening).
   */
  private pendingFolderMotion = new Map<string, boolean>();
  /** Folders painted by the previous render; null before the first one. */
  private renderedFolderIds: Set<string> | null = null;
  /** Rail element and markup painted last: an unchanged rail is not rebuilt. */
  private renderedRail: HTMLElement | null = null;
  private renderedMarkup = '';
  private hostedStatusBound = false;
  private static readonly PROBE_INTERVAL_MS = 15000;
  /** Share of a server's height, at each edge, that places instead of grouping. */
  private static readonly COMBINE_EDGE = 0.25;

  constructor() {
    appEvents.on('community.updated', () => this.render());
  }

  private bindHostedStatus(): void {
    if (this.hostedStatusBound || !window.api?.hostServerStatus) return;
    this.hostedStatusBound = true;
    const apply = (status: HostServerStatus) => {
      this.hostedPorts = new Set(status.servers.map((server) => server.port));
    };
    window.api.onHostServerStatusChanged?.(apply);
    void window.api.hostServerStatus().then(apply, () => {});
  }

  private static keyOf(host: string, port: number): string {
    return serverAddressKey({ host, port });
  }

  /** Logical server id used by the per-server notification preference. */
  private static serverIdOf(server: SavedServer): string | undefined {
    return getServerSessionForAddress(server.host, server.port)?.serverStore.serverDetails?.id ?? server.serverId;
  }

  /**
   * Unread state shown on the rail. Only servers kept connected in the
   * background count: the one on screen already shows it in its channel list.
   */
  private static unreadOf(server: SavedServer, currentUrl: string | null): RailUnread {
    const live = getServerSessionForAddress(server.host, server.port);
    if (!live || live.key === currentUrl || live.client.getStatus() !== 'CONNECTED') return null;
    if (live.chatStore.hasAnyMention()) return 'mention';
    return live.chatStore.hasAnyUnread() ? 'unread' : null;
  }

  /** Live sessions of the given servers that still hold something unread. */
  private static unreadSessions(servers: readonly SavedServer[]) {
    return servers.flatMap((server) => {
      const live = getServerSessionForAddress(server.host, server.port);
      return live?.chatStore.hasAnyUnread() ? [live] : [];
    });
  }

  private markServersRead(servers: readonly SavedServer[]): void {
    ServerRailView.unreadSessions(servers).forEach(markSessionRead);
    this.render();
  }

  private folderServers(folder: RailFolderNode): SavedServer[] {
    return folder.children.flatMap((child) => connectionStore.findSavedServer(child) ?? []);
  }

  private setServerNotifications(serverId: string, mode: ChatSoundMode): void {
    try {
      settingsStore.setServerChatSoundOverride(serverId, mode);
    } catch (error) {
      console.warn('[ServerRailView] Could not save server notifications', error);
      showErrorToast(t('serverRail.notificationsSaveFailed'));
    }
    this.render();
  }

  public setHomeBadge(count: number): void {
    const next = Math.max(0, Math.min(99, Math.trunc(count)));
    if (this.homeBadgeCount === next) return;
    this.homeBadgeCount = next;
    this.render();
  }

  public render(): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;

    this.bindHostedStatus();

    // The active key (not the proxied client) is what identifies the server on
    // screen: during a background event the proxy points elsewhere (#400).
    const currentUrl = sessionManager.isHome() ? null : sessionManager.getActiveKey();
    const busy = this.connectingKey !== null;
    const savedByKey = new Map(
      (connectionStore.savedServers || []).map((server) => [ServerRailView.keyOf(server.host, server.port), server])
    );
    // A server removed, or moved to another address, starts over from "checking" if it comes back.
    for (const key of this.probedOnline.keys()) if (!savedByKey.has(key)) this.probedOnline.delete(key);
    const layout = connectionStore.railLayout || [];

    const nodesHtml = layout.map((node, index) => {
      const nodeHtml = this.renderRailNode(node, index, currentUrl, savedByKey, busy);
      if (!nodeHtml) return '';
      return `${this.renderRootDropZone(index)}${nodeHtml}`;
    }).join('');

    const markup = `
      <button class="server-rail-home" id="server-rail-home" title="${t('main.homeTitle')}" aria-current="${sessionManager.isHome() ? 'page' : 'false'}" ${busy ? 'disabled' : ''}>
        <span class="material-symbols-outlined md-22">home</span>
        ${this.homeBadgeCount > 0 ? `<span class="server-rail-home-badge">${this.homeBadgeCount}</span>` : ''}
      </button>
      <div class="server-rail-divider"></div>
      <div class="server-rail-list">
        ${nodesHtml}
        ${this.renderRootDropZone(layout.length)}
        ${this.renderAddServerButton(busy)}
      </div>
    `;
    // Messages of background servers, community updates and saved-server writes
    // ask for a render far more often than the rail changes. Rebuilding the same
    // markup would close the rail's menus and drop the marks of a drag in progress.
    if (railEl === this.renderedRail && markup === this.renderedMarkup && !this.pendingFolderMotion.size) {
      this.applyStatuses(railEl);
      this.scheduleStatusRefresh();
      return;
    }
    // Only a menu opened from the rail loses its anchor here; the menus of
    // messages, channels, DMs or the status stay open.
    if (contextMenu.isOpenWithin(railEl)) contextMenu.close();
    railEl.innerHTML = markup;
    this.renderedRail = railEl;
    this.renderedMarkup = markup;

    railEl.querySelector('#server-rail-home')?.addEventListener('click', showHome);
    railEl.querySelector('#server-rail-add')?.addEventListener('click', () => addServerModal.open());

    this.bindServerClicks();
    this.bindFolderToggles();
    this.bindDragAndDrop();
    this.bindContextMenus();
    this.queueNewFolderMotion();
    this.playFolderMotion(railEl);
    // Background events may repaint the rail while something is being dragged.
    if (this.draggedRailItem) this.markDragging(this.draggedRailItem);

    this.applyStatuses(railEl);
    this.scheduleStatusRefresh();
  }

  /**
   * Probes the saved servers at most once per PROBE_INTERVAL_MS (#440): a
   * second after the rail is drawn, then on every interval while it stays on
   * screen. Renders are no clock, since an unchanged rail is not redrawn, and a
   * server that comes back must still be noticed (and reconnected) while
   * nothing else happens.
   */
  private scheduleStatusRefresh(): void {
    if (this.probeTimer) return;
    const delay = Math.max(1000, this.lastProbeTime + ServerRailView.PROBE_INTERVAL_MS - Date.now());
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      if (!document.getElementById('server-rail')) return;
      this.lastProbeTime = Date.now();
      void this.refreshServerRailStatuses().finally(() => this.scheduleStatusRefresh());
    }, delay);
  }

  /**
   * Asks every saved server that no session vouches for whether it is up. Each
   * positive answer counts, not just the first: a background connection that
   * failed is attempted again after the next probe (AutoEntryService). The
   * answers are painted in place, never by rebuilding the rail.
   */
  public async refreshServerRailStatuses(): Promise<void> {
    if (!document.getElementById('server-rail')) return;
    const currentUrl = sessionManager.isHome() ? null : sessionManager.getActiveKey();
    await Promise.all(connectionStore.savedServers.map(async (server) => {
      const key = ServerRailView.keyOf(server.host, server.port);
      // The server on screen and the ones kept connected show their own
      // session; the one being connected to hides its dot behind the spinner (#332).
      const live = getServerSessionForAddress(server.host, server.port);
      if (this.connectingKey === key || (live && (live.key === currentUrl || live.client.getStatus() === 'CONNECTED'))) return;
      const preview = await fetchServerPreview(server.host, server.port);
      const saved = connectionStore.findSavedServer(server);
      if (!saved) return;
      this.probedOnline.set(key, preview !== null);
      if (!preview) return;
      appEvents.emit('connection.saved_server_online', saved);

      // Pick up the icon of servers the user never connected to (#312). Only
      // persist on change, otherwise the resulting re-render loops forever.
      const absolute = toAbsoluteServerIconUrl(saved.host, saved.port, preview.iconUrl);
      if (absolute && absolute !== saved.iconUrl) {
        connectionStore.updateSavedServerIcon(saved.host, saved.port, absolute);
      }
    }));
    const railEl = document.getElementById('server-rail');
    if (railEl) this.applyStatuses(railEl);
  }

  /**
   * Paints each server's status dot, and the online/offline note of its title,
   * in place. A session vouches for the server on screen and the ones kept
   * connected in the background (#400), not for one merely retrying; the
   * others show the last probe. Statuses change far more often than the rail,
   * and rebuilding it for one would drop a drag in progress and close a menu
   * opened from it.
   */
  private applyStatuses(railEl: HTMLElement): void {
    const currentUrl = sessionManager.isHome() ? null : sessionManager.getActiveKey();
    for (const button of railEl.querySelectorAll<HTMLElement>('.server-rail-avatar')) {
      const host = button.dataset.host;
      const port = Number(button.dataset.port);
      if (!host || !port) continue;
      const key = ServerRailView.keyOf(host, port);
      const live = getServerSessionForAddress(host, port);
      const vouched = !!live && (live.key === currentUrl || live.client.getStatus() === 'CONNECTED');
      // A probe older than the session is forgotten: a server that drops starts again from "checking".
      if (vouched) this.probedOnline.delete(key);
      const probed = this.probedOnline.get(key);
      const status = vouched || probed === true ? 'online' : probed === false ? 'offline' : 'checking';
      const dot = button.querySelector<HTMLElement>('.server-rail-status-dot');
      if (dot && dot.dataset.status !== status) dot.dataset.status = status;
      // The button being connected to keeps its progress text as the title (#332).
      if (button.getAttribute('aria-busy') === 'true') continue;
      const base = button.dataset.railTitle ?? '';
      const title = probed === undefined ? base : `${base} • ${t(probed ? 'main.statusOnline' : 'main.statusOffline')}`;
      if (button.title !== title) button.title = title;
    }
  }

  /** Flags the rail as busy and repaints it, so the click has a visible effect (#332). */
  private setConnecting(key: string | null): void {
    if (this.connectingKey === key) return;
    this.connectingKey = key;
    this.render();
  }

  private renderRailNode(
    node: RailNode,
    rootIndex: number,
    currentUrl: string | null,
    savedByKey: Map<string, SavedServer>,
    busy: boolean
  ): string {
    if (node.type === 'server') {
      const server = savedByKey.get(ServerRailView.keyOf(node.host, node.port));
      if (!server) return '';
      return this.renderServerItem(server, currentUrl, busy);
    }

    return this.renderFolder(node, rootIndex, currentUrl, savedByKey, busy);
  }

  private renderFolder(
    folder: RailFolderNode,
    rootIndex: number,
    currentUrl: string | null,
    savedByKey: Map<string, SavedServer>,
    busy: boolean
  ): string {
    const childrenHtml = folder.children.map((child, childIndex) => {
      const server = savedByKey.get(ServerRailView.keyOf(child.host, child.port));
      if (!server) return '';
      return `${this.renderFolderChildDropZone(folder.id, childIndex)}${this.renderServerItem(
        server,
        currentUrl,
        busy,
        folder.id
      )}`;
    }).join('');

    const servers = folder.children.flatMap((child) => savedByKey.get(ServerRailView.keyOf(child.host, child.port)) ?? []);
    const label = folder.name || servers.map((server) => server.name || server.host).join(', ');
    const color = folder.color ?? DEFAULT_FOLDER_COLOR;
    const holdsCurrent = servers.some((server) => {
      const live = getServerSessionForAddress(server.host, server.port);
      return (live?.key ?? sessionKeyFor(server.host, server.port)) === currentUrl;
    });
    const folderUnread = servers.reduce<RailUnread>((state, server) => {
      if (state === 'mention') return state;
      return ServerRailView.unreadOf(server, currentUrl) || state;
    }, null);
    // Collapsed, the folder summarizes what is inside; open, each server shows its own.
    const folderBadge = folder.collapsed && folderUnread
      ? `<span class="server-rail-folder-badge" data-kind="${folderUnread}" title="${escapeHtml(t(folderUnread === 'mention' ? 'serverRail.folderMentionTooltip' : 'serverRail.folderUnreadTooltip'))}"></span>`
      : '';
    const preview = folder.collapsed
      ? `<span class="server-rail-folder-grid" aria-hidden="true">${servers.slice(0, 4).map((server) => {
        const { iconUrl, initial } = this.iconOf(server);
        return `<span class="server-rail-folder-mini">${this.renderServerIcon(iconUrl, initial)}</span>`;
      }).join('')}</span>`
      : '<span class="material-symbols-outlined md-24 server-rail-folder-icon" aria-hidden="true">folder</span>';
    const classes = [
      'server-rail-folder',
      folder.collapsed ? 'collapsed' : '',
      holdsCurrent ? 'has-active' : '',
      folder.collapsed && folderUnread ? 'has-unread' : '',
    ].filter(Boolean).join(' ');

    return `
      <div class="${classes}" data-folder-id="${escapeHtml(folder.id)}" style="--folder-color: ${color}">
        <div class="server-rail-folder-shell">
          <div class="server-rail-folder-row">
            <span class="server-rail-pill" aria-hidden="true"></span>
            <button
              type="button"
              class="server-rail-folder-header"
              data-node-type="folder"
              data-folder-id="${escapeHtml(folder.id)}"
              data-root-index="${rootIndex}"
              draggable="false"
              data-rail-draggable="${busy ? 'false' : 'true'}"
              title="${escapeHtml(label)}"
              aria-label="${escapeHtml(label)}"
              aria-expanded="${folder.collapsed ? 'false' : 'true'}"
            >
              ${preview}
              ${folderBadge}
            </button>
          </div>
          <div class="server-rail-folder-children" ${folder.collapsed ? 'hidden' : ''}>
            ${childrenHtml}
            ${this.renderFolderChildDropZone(folder.id, folder.children.length)}
          </div>
        </div>
      </div>
    `;
  }

  /**
   * Icon shown for a saved server. Read from the session that owns this row,
   * never from the proxied store: a render triggered inside a background event
   * would otherwise paint that server's icon on whichever row is current
   * (#400). Relative paths are resolved against that same session's host,
   * never the visible one (#312).
   */
  private iconOf(srv: SavedServer): { iconUrl: string | null | undefined; initial: string } {
    const live = getServerSessionForAddress(srv.host, srv.port);
    const liveIcon = resolveImageUrl(live?.serverStore.serverDetails?.iconUrl, live?.client.getHttpBaseUrl() ?? '');
    return {
      iconUrl: liveIcon || srv.iconUrl,
      initial: (srv.name || srv.host || '?').trim().charAt(0).toUpperCase(),
    };
  }
  private renderServerItem(
    srv: SavedServer,
    currentUrl: string | null,
    busy: boolean,
    folderId?: string
  ): string {
    const live = getServerSessionForAddress(srv.host, srv.port);
    const url = live?.key ?? sessionKeyFor(srv.host, srv.port);
    const isCurrent = url === currentUrl;
    const isConnecting = this.connectingKey === ServerRailView.keyOf(srv.host, srv.port);
    const hasCall = voiceStore.voiceSessionKey === url;
    const callIcon = serverRailCallIcon(live?.community.snapshot?.events, voiceStore.currentVoiceChannelId);
    // A mention outranks a plain unread, so the row shows the red dot instead
    // of the white one when both are pending (#479).
    const unread = ServerRailView.unreadOf(srv, currentUrl);
    const hasMention = unread === 'mention';
    const hasUnread = unread === 'unread';
    const muted = settingsStore.getServerChatSoundOverride(ServerRailView.serverIdOf(srv)) === 'none';
    const { iconUrl, initial } = this.iconOf(srv);
    const label = srv.name || `${srv.host}:${srv.port}`;
    const title = isConnecting
      ? t('main.connectingTo', { name: label })
      : hasCall && !isCurrent
        ? t('main.serverHostingCall', { name: label })
        : label;
    const badge = hasCall
      ? `<span class="server-rail-badge" data-kind="call" title="${escapeHtml(t('main.callHereTooltip'))}"><span class="material-symbols-outlined md-14">${callIcon}</span></span>`
      : hasMention
        ? `<span class="server-rail-badge" data-kind="mention" title="${escapeHtml(t('main.mentionHereTooltip'))}"></span>`
        : hasUnread
          ? `<span class="server-rail-badge" data-kind="unread" title="${escapeHtml(t('main.unreadHereTooltip'))}"></span>`
          : '';

    return `
      <div
        class="server-rail-item ${isCurrent ? 'active' : ''} ${folderId ? 'server-rail-item--nested' : ''} ${unread ? 'server-rail-item--unread' : ''}"
        data-node-type="server"
        data-host="${escapeHtml(srv.host)}"
        data-port="${srv.port}"
        ${folderId ? `data-folder-id="${escapeHtml(folderId)}"` : ''}
        draggable="false"
        data-rail-draggable="${busy ? 'false' : 'true'}"
      >
        <span class="server-rail-pill" aria-hidden="true"></span>
        <button
          class="server-rail-avatar ${isCurrent ? 'active' : ''}"
          data-host="${escapeHtml(srv.host)}"
          data-port="${srv.port}"
          ${folderId ? `data-folder-id="${escapeHtml(folderId)}"` : ''}
          title="${escapeHtml(title)}"
          data-rail-title="${escapeHtml(title)}"
          ${isConnecting ? 'data-loading="1" aria-busy="true"' : ''}
          ${busy ? 'disabled' : ''}
          style="padding: 0;"
        >
          ${this.renderServerIcon(iconUrl, initial)}
          <span class="server-rail-status-dot" data-status="checking"></span>
          ${muted ? `<span class="server-rail-muted" title="${escapeHtml(t('serverRail.mutedTooltip'))}"><span class="material-symbols-outlined md-12" aria-hidden="true">notifications_off</span></span>` : ''}
          ${badge}
        </button>
      </div>
    `;
  }

  /**
   * The initial is always painted, and the picture covers it only once it has
   * loaded. A server that is offline or slow keeps its letter instead of an
   * empty circle, even when the rail redraws before the request settles.
   */
  private renderServerIcon(iconUrl: string | null | undefined, initial: string): string {
    const letter = `<span class="server-rail-initial" data-fallback-initial-slot>${escapeHtml(initial)}</span>`;
    const state = iconUrl ? initialImageState(iconUrl) : 'failed';
    if (!iconUrl || state === 'failed') return letter;
    return `${letter}<img class="server-rail-icon" src="${escapeHtml(iconUrl)}" alt="" draggable="false" data-fallback="initial" data-fallback-initial="${escapeHtml(initial)}"${state === 'loaded' ? ' data-loaded="1"' : ''}>`;
  }

  private renderRootDropZone(index: number): string {
    return `
      <div
        class="server-rail-drop-zone"
        data-drop-kind="root"
        data-root-index="${index}"
        aria-hidden="true"
      ></div>
    `;
  }

  private renderAddServerButton(busy: boolean): string {
    const highlighted = sessionManager.isHome() && connectionStore.savedServers.length === 0;
    return `
      <button type="button" class="server-rail-add ${highlighted ? 'server-rail-add--highlight' : ''}"
        id="server-rail-add" title="${t('addServer.title')}" aria-label="${t('addServer.title')}" ${busy ? 'disabled' : ''}>
        <span class="material-symbols-outlined md-24" aria-hidden="true">add</span>
      </button>
    `;
  }

  private renderFolderChildDropZone(folderId: string, index: number): string {
    return `
      <div
        class="server-rail-drop-zone server-rail-drop-zone--nested"
        data-drop-kind="folder-child"
        data-folder-id="${escapeHtml(folderId)}"
        data-child-index="${index}"
        aria-hidden="true"
      ></div>
    `;
  }

  private bindServerClicks(): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;

    railEl.querySelectorAll('.server-rail-avatar').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (this.connectingKey) return;
        const host = btn.getAttribute('data-host');
        const port = parseInt(btn.getAttribute('data-port') || '0', 10);
        if (!host || !port) return;
        const target = connectionStore.findSavedServer({ host, port });
        if (target) void this.connectToSavedServer(target);
      });
    });
  }

  private bindFolderToggles(): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;

    railEl.querySelectorAll('.server-rail-folder-header').forEach((header) => {
      header.addEventListener('click', () => {
        const folderId = header.getAttribute('data-folder-id');
        const folder = folderId ? connectionStore.findFolder(folderId) : undefined;
        if (!folder) return;
        this.pendingFolderMotion.set(folder.id, folder.collapsed);
        connectionStore.toggleFolderCollapsed(folder.id);
      });
    });
  }

  /**
   * A folder that did not exist on the previous render was just created by
   * grouping servers: it opens with the same motion as a click, instead of
   * popping in. The first render (app start) never animates.
   */
  private queueNewFolderMotion(): void {
    const folders = connectionStore.railLayout.filter((node): node is RailFolderNode => node.type === 'folder');
    const previous = this.renderedFolderIds;
    this.renderedFolderIds = new Set(folders.map((folder) => folder.id));
    if (!previous) return;
    for (const folder of folders) {
      if (!previous.has(folder.id) && !folder.collapsed && !this.pendingFolderMotion.has(folder.id)) {
        this.pendingFolderMotion.set(folder.id, true);
      }
    }
  }

  private collapseAllFolders(): void {
    for (const node of connectionStore.railLayout) {
      if (node.type === 'folder' && !node.collapsed) this.pendingFolderMotion.set(node.id, false);
    }
    connectionStore.collapseAllFolders();
  }

  /**
   * Slides a folder's servers in or out. The fresh render already reflects the
   * new state, so the list is put back where it was and then animated by the
   * shared expansion helper (which also honours reduced motion).
   */
  private playFolderMotion(railEl: HTMLElement): void {
    if (!this.pendingFolderMotion.size) return;
    const pending = [...this.pendingFolderMotion];
    this.pendingFolderMotion.clear();
    for (const [folderId, opening] of pending) {
      const folder = Array.from(railEl.querySelectorAll<HTMLElement>('.server-rail-folder'))
        .find((node) => node.dataset.folderId === folderId);
      const children = folder?.querySelector<HTMLElement>(':scope > .server-rail-folder-shell > .server-rail-folder-children');
      const header = folder?.querySelector<HTMLElement>('.server-rail-folder-header > :first-child');
      if (!folder || !children) continue;
      children.hidden = opening;
      if (opening) {
        // Start from the collapsed look so the tint fades in with the list.
        folder.classList.add('server-rail-folder--opening');
        requestAnimationFrame(() => folder.classList.remove('server-rail-folder--opening'));
        setSurfaceVisible(children, true, 'panel');
      } else {
        // Keep the tint around the servers while they slide away.
        folder.classList.add('server-rail-folder--closing');
        setSurfaceVisible(children, false, 'panel', undefined, () => folder.classList.remove('server-rail-folder--closing'));
      }
      if (header) animateEnter(header, 'view');
    }
  }

  private bindContextMenus(): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;

    railEl.querySelector('#server-rail-home')?.addEventListener('contextmenu', (event) => {
      const mouseEvent = event as MouseEvent;
      event.preventDefault();
      contextMenu.open(mouseEvent.clientX, mouseEvent.clientY, [{
        label: t('serverRail.markAllDmsRead'),
        icon: 'mark_chat_read',
        disabled: dmStore.unreadTotal() === 0,
        onClick: () => { void dmStore.markAllRead(); },
      }], event.currentTarget as HTMLElement);
    });

    railEl.querySelector('.server-rail-list')?.addEventListener('contextmenu', (event) => {
      const mouseEvent = event as MouseEvent;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.server-rail-avatar, .server-rail-folder-header')) return;
      event.preventDefault();
      contextMenu.open(mouseEvent.clientX, mouseEvent.clientY, [
        {
          label: t('serverRail.markAllServersRead'),
          icon: 'mark_chat_read',
          disabled: !ServerRailView.unreadSessions(connectionStore.savedServers).length,
          onClick: () => this.markServersRead(connectionStore.savedServers),
        },
        {
          label: t('serverRail.closeAllFolders'),
          icon: 'folder',
          disabled: !connectionStore.railLayout.some((node) => node.type === 'folder' && !node.collapsed),
          onClick: () => this.collapseAllFolders(),
        },
      ]);
    });

    railEl.querySelectorAll('.server-rail-avatar').forEach((btn) => {
      btn.addEventListener('contextmenu', (event) => {
        const mouseEvent = event as MouseEvent;
        event.preventDefault();
        event.stopPropagation();
        const host = btn.getAttribute('data-host');
        const port = parseInt(btn.getAttribute('data-port') || '0', 10);
        if (!host || !port) return;
        const folderId = btn.getAttribute('data-folder-id');
        const server = connectionStore.findSavedServer({ host, port });
        if (!server) return;
        contextMenu.open(mouseEvent.clientX, mouseEvent.clientY, this.getServerContextEntries(server, folderId), btn as HTMLElement);
      });
    });

    railEl.querySelectorAll('.server-rail-folder-header').forEach((header) => {
      header.addEventListener('contextmenu', (event) => {
        const mouseEvent = event as MouseEvent;
        event.preventDefault();
        event.stopPropagation();
        const folderId = header.getAttribute('data-folder-id');
        if (!folderId) return;
        const folder = connectionStore.railLayout.find(
          (node): node is RailFolderNode => node.type === 'folder' && node.id === folderId
        );
        if (!folder) return;
        const folderServers = this.folderServers(folder);
        contextMenu.open(mouseEvent.clientX, mouseEvent.clientY, [
          {
            label: t('serverRail.markFolderRead'),
            icon: 'mark_chat_read',
            disabled: !ServerRailView.unreadSessions(folderServers).length,
            onClick: () => this.markServersRead(folderServers),
          },
          {
            label: t('serverRail.folderSettings'),
            icon: 'settings',
            onClick: () => folderSettingsModal.open(folderId, header as HTMLElement),
          },
          {
            label: t('serverRail.closeAllFolders'),
            icon: 'folder',
            disabled: !connectionStore.railLayout.some((node) => node.type === 'folder' && !node.collapsed),
            onClick: () => this.collapseAllFolders(),
          },
          {
            label: t('serverRail.ungroupFolder'),
            icon: 'folder_off',
            onClick: () => connectionStore.deleteFolder(folderId),
          },
        ], header as HTMLElement);
      });
    });
  }

  private getServerContextEntries(server: SavedServer, folderId: string | null): ContextMenuEntry[] {
    const owned = findOwnedServer(server.host, server.port);
    const favorite = favoritesStore.isServerFavorite(server);
    const autoEntry = settingsStore.isServerAutoEntryEnabled(server);
    const entries: ContextMenuEntry[] = [
      {
        label: t('connection.join'),
        icon: 'login',
        onClick: () => { void this.connectToSavedServer(server); },
      },
    ];

    const live = getServerSessionForAddress(server.host, server.port);
    entries.push({
      label: t('serverRail.markServerRead'),
      icon: 'mark_chat_read',
      disabled: !live?.chatStore.hasAnyUnread(),
      onClick: () => this.markServersRead([server]),
    });

    const serverId = ServerRailView.serverIdOf(server);
    if (serverId) {
      const mode = settingsStore.getServerChatSoundOverride(serverId);
      entries.push(
        {
          label: t(mode === 'none' ? 'serverRail.unmute' : 'serverRail.mute'),
          icon: mode === 'none' ? 'notifications_active' : 'notifications_off',
          onClick: () => this.setServerNotifications(serverId, mode === 'none' ? 'inherit' : 'none'),
        },
        {
          label: t('serverRail.notifications'),
          icon: 'notifications',
          submenu: NOTIFICATION_MODES.map((option) => ({
            label: t(option.label),
            checked: option.mode === mode,
            onClick: () => this.setServerNotifications(serverId, option.mode),
          })),
        },
      );
    }
    if (owned) {
      const running = this.hostedPorts.has(owned.port);
      entries.push(
        running
          ? {
            label: t('connection.stop'),
            icon: 'stop',
            onClick: () => { void this.stopOwnedServer(owned.port); },
          }
          : {
            label: t('connection.start'),
            icon: 'play_arrow',
            onClick: () => { void this.startOwnedServer(owned); },
          },
        {
          label: t('serverMonitor.title'),
          icon: 'monitoring',
          disabled: !running,
          onClick: () => { void serverMonitorModal.openLocal(owned.port); },
        },
        {
          label: t('connection.deleteSavedServer'),
          icon: 'delete',
          danger: true,
          onClick: () => { void this.deleteOwnedServer(owned); },
        },
      );
    }

    entries.push(
      {
        label: t('connection.editSavedServer'),
        icon: 'edit',
        onClick: () => { void this.editSavedServer(server); },
      },
      {
        label: t(favorite ? 'favorites.removeShort' : 'favorites.addShort'),
        icon: favorite ? 'star' : 'star_border',
        onClick: () => { void this.toggleFavorite(server); },
      },
      {
        label: t(autoEntry ? 'autoEntry.disableShort' : 'autoEntry.enableShort'),
        icon: autoEntry ? 'home_pin' : 'not_started',
        onClick: () => { void this.toggleAutoEntry(server, !autoEntry); },
      },
    );

    if (folderId) {
      entries.push({
        label: t('main.removeFromFolder'),
        icon: 'drive_file_move',
        onClick: () => connectionStore.moveServerToFolder(server.host, server.port, null),
      });
    }

    entries.push({
      label: t('connection.removeFromSaved'),
      icon: 'close',
      danger: !owned,
      onClick: () => {
        appEvents.emit('connection.manual_disconnect', { key: sessionKeyFor(server.host, server.port) });
        connectionStore.removeSavedServer(server.host, server.port);
      },
    });
    return entries;
  }

  private async startOwnedServer(server: CreatedServer): Promise<void> {
    try {
      await ensureHostedServerStarted(server);
      this.render();
    } catch (error: unknown) {
      await showAlert({
        title: t('main.serverStartFailedTitle'),
        message: error instanceof Error && error.message ? error.message : t('main.serverStartFailedMessage'),
        variant: 'danger',
      });
    }
  }

  private async stopOwnedServer(port: number): Promise<void> {
    if (!window.api?.hostServerStop) return;
    if (!(await confirmStopHostedServer(port))) return;
    const result = await window.api.hostServerStop(port);
    if (!result.success) {
      await showAlert({ title: t('common.error'), message: t('connection.stopServerError'), variant: 'danger' });
    }
    this.render();
  }

  private async deleteOwnedServer(server: CreatedServer): Promise<void> {
    const confirmed = await showConfirm({
      title: t('connection.deleteSavedServer'),
      message: t('connection.deleteServerMessage', { name: server.name }),
      confirmLabel: t('common.delete'),
      cancelLabel: t('common.cancel'),
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      const status = await window.api?.hostServerStatus?.();
      const running = status?.servers.find((item) => item.serverId === server.id || item.port === server.port);
      if (running) {
        await this.stopOwnedServer(running.port);
      }
      const deleted = await window.api?.hostServerDeleteData?.(server.id);
      connectionStore.removeCreatedServer(server.id);
      connectionStore.removeSavedServer('127.0.0.1', server.port);
      if (deleted && !deleted.success) {
        await showAlert({ title: t('common.error'), message: deleted.error || t('connection.deleteServerError'), variant: 'danger' });
      }
    } catch (error: unknown) {
      await showAlert({
        title: t('common.error'),
        message: error instanceof Error && error.message ? error.message : t('connection.deleteServerError'),
        variant: 'danger',
      });
    }
  }

  private async editSavedServer(server: SavedServer): Promise<void> {
    const values = await showTextForm({
      title: t('connection.editSavedServer'),
      fields: [
        { label: t('connection.serverNameLabel'), value: server.name || '' },
        { label: t('connection.hostLabel'), value: server.host, validate: value => value.trim() ? undefined : t('connection.hostLabel') },
        { label: t('connection.portLabel'), value: String(server.port), validate: value => {
          const port = Number(value);
          return Number.isInteger(port) && port >= 1024 && port <= 65535 ? undefined : t('connection.portLabel');
        } },
        { label: t('connection.passwordLabel'), value: server.password || '' },
      ],
      focusInput: 0,
    });
    if (!values) return;
    const [name, host, portText, password] = values;
    const port = Number(portText);
    connectionStore.updateSavedServer(server.host, server.port, {
      host: host.trim(),
      port,
      name: name.trim() || server.name,
      password: password || undefined,
      iconUrl: server.iconUrl,
      lastConnected: server.lastConnected || Date.now(),
    });
  }

  private async toggleFavorite(server: SavedServer): Promise<void> {
    try {
      favoritesStore.toggleServer(server);
      this.render();
    } catch (error: unknown) {
      await showAlert({ title: t('common.error'), message: t('favorites.saveFailed'), variant: 'danger' });
    }
  }

  private async toggleAutoEntry(server: SavedServer, enabled: boolean): Promise<void> {
    try {
      settingsStore.setServerAutoEntry(server, enabled);
      this.render();
    } catch (error: unknown) {
      await showAlert({ title: t('autoEntry.section'), message: t('autoEntry.saveFailed'), variant: 'danger' });
    }
  }

  /**
   * Rail reordering follows the pointer instead of native drag-and-drop: a
   * native drag started on a server icon carries the image itself, so the
   * connected server (the one that always has an icon) could not be moved.
   */
  private bindDragAndDrop(): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;

    const draggableNodes = Array.from(railEl.querySelectorAll<HTMLElement>(
      '.server-rail-item[data-node-type="server"], .server-rail-folder-header[data-node-type="folder"]'));

    for (const element of draggableNodes) {
      onPrimaryPress(element, (event) => {
        // Touch scrolls the rail, as it always has; the mouse and the pen reorder it.
        if (event.pointerType === 'touch' || this.connectingKey || this.draggedRailItem) return;
        const item = this.railItemOf(element);
        if (!item) return;
        // The rail outlives the repaints that replace its items mid-drag; it keeps the pointer.
        followPointerReorder(event, {
          capture: railEl,
          onStart: () => {
            this.draggedRailItem = item;
            contextMenu.close();
            this.markDragging(item);
          },
          onMove: (x, y) => {
            const target = this.pointerTarget(x, y);
            if (target?.zone) this.activateDropZone(target.zone);
            else if (target?.header) this.activateFolderHeader(target.header);
            else if (target?.combine) this.activateCombine(target.combine);
            else this.clearDropIndicators();
          },
          onDrop: (x, y) => {
            const target = this.pointerTarget(x, y);
            this.clearDragState();
            if (target) this.dropRailItem(item, target);
          },
          onCancel: () => this.clearDragState(),
        });
      });
    }
  }

  private railItemOf(element: HTMLElement): DraggedRailItem | null {
    if (element.dataset.nodeType === 'folder') {
      const folderId = element.dataset.folderId;
      return folderId ? { type: 'folder', folderId } : null;
    }
    const host = element.dataset.host;
    const port = parseInt(element.dataset.port || '0', 10);
    return host && port ? { type: 'server', host, port } : null;
  }

  private markDragging(item: DraggedRailItem): void {
    const railEl = document.getElementById('server-rail');
    railEl?.classList.add('server-rail--dragging');
    const element = Array.from(railEl?.querySelectorAll<HTMLElement>('[data-node-type]') ?? []).find((node) => {
      const candidate = this.railItemOf(node);
      return candidate?.type === item.type && (candidate.type === 'folder'
        ? item.type === 'folder' && candidate.folderId === item.folderId
        : item.type === 'server' && candidate.host === item.host && candidate.port === item.port);
    });
    element?.classList.add('dragging');
  }

  private dropRailItem(item: DraggedRailItem, target: { zone?: HTMLElement; header?: HTMLElement; combine?: HTMLElement }): void {
    if (target.zone) {
      const dropKind = target.zone.dataset.dropKind;
      if (dropKind === 'root') {
        const rootIndex = parseInt(target.zone.dataset.rootIndex || '-1', 10);
        if (rootIndex >= 0) this.applyRootDrop(item, rootIndex);
      } else if (dropKind === 'folder-child' && item.type === 'server') {
        const folderId = target.zone.dataset.folderId;
        const childIndex = parseInt(target.zone.dataset.childIndex || '-1', 10);
        if (folderId && childIndex >= 0) {
          connectionStore.moveServerToFolder(item.host, item.port, folderId, childIndex);
        }
      }
    } else if (target.header && item.type === 'server') {
      const folderId = target.header.dataset.folderId;
      if (folderId) connectionStore.moveServerToFolder(item.host, item.port, folderId);
    } else if (target.combine && item.type === 'server') {
      const host = target.combine.dataset.host;
      const port = parseInt(target.combine.dataset.port || '0', 10);
      if (host && port) connectionStore.groupServers({ host, port }, item);
    }
  }

  /**
   * Where a release would land. The thin drop zones are hard to hit, so
   * hovering a server or folder also counts. Like Discord, a server dragged
   * over the middle of another server groups them in a folder (or joins the
   * folder that one is in), and over the middle of a folder joins it; near
   * the top or bottom edge it is placed before or after instead.
   */
  private pointerTarget(clientX: number, clientY: number): { zone?: HTMLElement; header?: HTMLElement; combine?: HTMLElement } | null {
    const railEl = document.getElementById('server-rail');
    const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
    if (!railEl || !element || !railEl.contains(element) || !this.draggedRailItem) return null;
    const draggingFolder = this.draggedRailItem.type === 'folder';
    const around = (node: Element | null) => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const zone = clientY < rect.top + rect.height / 2 ? node.previousElementSibling : node.nextElementSibling;
      return zone instanceof HTMLElement && zone.matches('.server-rail-drop-zone') && this.canDropOnZone(zone) ? { zone } : null;
    };
    const zone = element.closest<HTMLElement>('.server-rail-drop-zone');
    if (zone) return this.canDropOnZone(zone) ? { zone } : null;
    const middle = (node: Element): boolean => {
      const rect = node.getBoundingClientRect();
      const edge = rect.height * ServerRailView.COMBINE_EDGE;
      return clientY > rect.top + edge && clientY < rect.bottom - edge;
    };
    const header = element.closest<HTMLElement>('.server-rail-folder-header');
    if (header) {
      const folder = header.closest('.server-rail-folder');
      return draggingFolder || !middle(header) ? around(folder) : { header };
    }
    const server = element.closest<HTMLElement>('.server-rail-item');
    if (!server) return null;
    if (draggingFolder) return around(server.closest('.server-rail-folder') ?? server);
    const dragged = this.draggedRailItem;
    const isSelf = dragged.type === 'server' && server.dataset.host === dragged.host
      && server.dataset.port === String(dragged.port);
    if (!isSelf && middle(server)) return { combine: server };
    return around(server);
  }

  private activateCombine(server: HTMLElement): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;
    railEl.querySelectorAll('.server-rail-drop-zone.active').forEach((item) => item.classList.remove('active'));
    railEl.querySelectorAll('.server-rail-folder-header.drag-over').forEach((item) => item.classList.remove('drag-over'));
    railEl.querySelectorAll('.server-rail-item.combine-target').forEach((item) => {
      if (item !== server) item.classList.remove('combine-target');
    });
    server.classList.add('combine-target');
  }

  private clearDropIndicators(): void {
    const railEl = document.getElementById('server-rail');
    railEl?.querySelectorAll('.server-rail-drop-zone.active').forEach((item) => item.classList.remove('active'));
    railEl?.querySelectorAll('.server-rail-folder-header.drag-over').forEach((item) => item.classList.remove('drag-over'));
    railEl?.querySelectorAll('.server-rail-item.combine-target').forEach((item) => item.classList.remove('combine-target'));
  }
  private activateDropZone(zone: HTMLElement): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;
    railEl.querySelectorAll('.server-rail-drop-zone.active').forEach((item) => {
      if (item !== zone) item.classList.remove('active');
    });
    railEl.querySelectorAll('.server-rail-folder-header.drag-over, .server-rail-item.combine-target').forEach((item) => {
      item.classList.remove('drag-over', 'combine-target');
    });
    zone.classList.add('active');
  }

  private activateFolderHeader(header: HTMLElement): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;
    railEl.querySelectorAll('.server-rail-drop-zone.active').forEach((item) => {
      item.classList.remove('active');
    });
    railEl.querySelectorAll('.server-rail-item.combine-target').forEach((item) => item.classList.remove('combine-target'));
    railEl.querySelectorAll('.server-rail-folder-header.drag-over').forEach((item) => {
      if (item !== header) item.classList.remove('drag-over');
    });
    header.classList.add('drag-over');
  }

  private clearDragState(): void {
    this.draggedRailItem = null;
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;
    railEl.classList.remove('server-rail--dragging');
    railEl.querySelectorAll('.server-rail-drop-zone.active').forEach((item) => {
      item.classList.remove('active');
    });
    railEl.querySelectorAll('.server-rail-folder-header.drag-over, .server-rail-item.combine-target, .dragging').forEach((item) => {
      item.classList.remove('drag-over', 'combine-target', 'dragging');
    });
  }

  private canDropOnZone(zone: HTMLElement): boolean {
    if (!this.draggedRailItem) return false;
    const dropKind = zone.getAttribute('data-drop-kind');
    if (dropKind === 'root') return true;
    return dropKind === 'folder-child' && this.draggedRailItem.type === 'server';
  }

  private applyRootDrop(dragged: DraggedRailItem, rootIndex: number): void {
    if (dragged.type === 'folder') {
      const fromIndex = connectionStore.railLayout.findIndex(
        (node) => node.type === 'folder' && node.id === dragged.folderId
      );
      if (fromIndex >= 0) connectionStore.moveRailNode(fromIndex, rootIndex);
      return;
    }

    connectionStore.moveServerToFolder(dragged.host, dragged.port, null, rootIndex);
  }

  private async connectToSavedServer(server: SavedServer): Promise<void> {
    const targetUrl = getServerSessionForAddress(server.host, server.port)?.key ?? sessionKeyFor(server.host, server.port);
    if (this.connectingKey) return;

    // Already connected in the background: switching back is just repointing
    // the views at the state that was kept alive (#400). No probe, no
    // confirmation, no reconnection.
    if (showServerSession(targetUrl)) return;

    // Everything below is async and used to happen with no feedback at all: the
    // online probe alone can hang for 2.5s before the confirmation even shows up
    // (#332). Hold the busy state for the whole attempt and always clear it.
    const isCurrent = captureServerBrowseIntent();
    this.setConnecting(ServerRailView.keyOf(server.host, server.port));
    try {
      await this.runConnectToSavedServer(server, isCurrent);
    } catch (error: unknown) {
      await showAlert({
        title: t('main.serverOfflineTitle'),
        message: error instanceof Error && error.message ? error.message : t('connection.connectError'),
        variant: 'danger',
      });
    } finally {
      this.setConnecting(null);
    }
  }

  private async runConnectToSavedServer(server: SavedServer, isCurrent: () => boolean): Promise<void> {
    assertServerBrowseAvailable(server.host, server.port);
    // Probe without changing the visible session or the ongoing call.
    const online = await checkServerOnline(server.host, server.port);
    if (!isCurrent()) return;
    const mine = findOwnedServer(server.host, server.port);
    const label = server.name || server.host;

    if (!online && !mine) {
      await showAlert({
        title: t('main.serverOfflineTitle'),
        message: t('main.serverOfflineMessage', { name: label }),
      });
      return;
    }

    // Starting is independent of both browsing and the current voice session.
    if (!online && mine) {
      const confirmed = await showConfirm({
        title: t('main.serverOfflineStartTitle'),
        message: t('main.serverOfflineStartMessage', { name: label }),
        confirmLabel: t('main.serverOfflineStartConfirm'),
        variant: 'warning',
      });
      if (!confirmed || !isCurrent()) return;

      try {
        await ensureHostedServerStarted(mine);
        if (!isCurrent()) return;
      } catch (error: unknown) {
        await showAlert({
          title: t('main.serverStartFailedTitle'),
          message: error instanceof Error && error.message ? error.message : t('main.serverStartFailedMessage'),
          variant: 'danger',
        });
        return;
      }
    }

    try {
      const identity = connectionStore.hasIdentity && connectionStore.clientId && connectionStore.publicKey
        ? { clientId: connectionStore.clientId, publicKey: connectionStore.publicKey }
        : await window.api.getIdentity();
      if (!isCurrent()) return;
      connectionStore.setIdentity(identity);
      const nickname = connectionStore.savedNickname || t('connection.unknownUser');
      const res = await openServerSession(server.host, server.port, identity, nickname, server.password);
      connectionStore.addSavedServer({
        host: server.host,
        port: server.port,
        name: res.server.name,
        password: server.password,
        lastConnected: Date.now(),
      });
    } catch (err: unknown) {
      const message = err instanceof Error && err.message
        ? err.message
        : t('main.serverOfflineMessage', { name: server.name || server.host });
      // The failed session was already dropped and the previous server restored
      // by `openServerSession`. Emitting a global disconnect here would tear
      // down that still-healthy server and dump the user on the home screen
      // (#400) — showing the error is enough.
      await showAlert({
        title: t('main.serverOfflineTitle'),
        message,
      });
    }
  }
}

export const serverRailView = new ServerRailView();
