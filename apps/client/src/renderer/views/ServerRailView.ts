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
  SavedServer,
  RailFolderNode,
  RailNode,
} from '../stores/connectionStore';
import { showConfirm, showAlert, showTextForm } from './Dialog';
import { checkServerOnline, fetchServerPreview } from '../utils/serverStatus';
import {
  confirmStopHostedServer,
} from '../utils/hostedServer';
import { toAbsoluteServerIconUrl } from '../utils/avatar';
import { t } from '../i18n';
import { contextMenu, type ContextMenuEntry } from './ContextMenu';
import { appEvents } from '../core/EventBus';
import { addServerModal } from './addServer/AddServerModal';
import { serverMonitorModal } from './ServerMonitorModal';

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
   * Server the user is currently connecting to, as `host:port`. Kept on the view
   * (instead of poked straight into the DOM) because `render()` runs again on
   * network events and would wipe any attribute set by hand (#332).
   */
  private connectingKey: string | null = null;
  private draggedRailItem: DraggedRailItem | null = null;
  /**
   * Rail reordering follows the pointer instead of native drag-and-drop: a
   * native drag started on a server icon carries the image itself, so the
   * connected server (the one that always has an icon) could not be moved.
   */
  private pointerDrag: { item: DraggedRailItem; startX: number; startY: number; active: boolean } | null = null;
  private suppressRailClick = false;
  private lastProbeTime = 0;
  private probeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private homeBadgeCount = 0;
  private static readonly PROBE_INTERVAL_MS = 15000;

  constructor() {
    appEvents.on('community.updated', () => this.render());
  }

  private static keyOf(host: string, port: number): string {
    return `${host.trim().replace(/^wss?:\/\//, '')}:${port}`;
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

    contextMenu.close();

    // The active key (not the proxied client) is what identifies the server on
    // screen: during a background event the proxy points elsewhere (#400).
    const currentUrl = sessionManager.isHome() ? null : sessionManager.getActiveKey();
    const busy = this.connectingKey !== null;
    const savedByKey = new Map(
      (connectionStore.savedServers || []).map((server) => [ServerRailView.keyOf(server.host, server.port), server])
    );
    const layout = connectionStore.railLayout || [];

    const nodesHtml = layout.map((node, index) => {
      const nodeHtml = this.renderRailNode(node, index, currentUrl, savedByKey, busy);
      if (!nodeHtml) return '';
      return `${this.renderRootDropZone(index)}${nodeHtml}`;
    }).join('');

    railEl.innerHTML = `
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

    railEl.querySelector('#server-rail-home')?.addEventListener('click', showHome);
    railEl.querySelector('#server-rail-add')?.addEventListener('click', () => addServerModal.open());

    this.bindServerClicks();
    this.bindFolderToggles();
    this.bindDragAndDrop();
    this.bindContextMenus();
    // Background events may repaint the rail while something is being dragged.
    if (this.pointerDrag?.active) this.markDragging(this.pointerDrag.item);

    this.scheduleStatusRefresh();
  }

  private scheduleStatusRefresh(): void {
    const now = Date.now();
    if (now - this.lastProbeTime < ServerRailView.PROBE_INTERVAL_MS) {
      return;
    }

    if (this.probeDebounceTimer) {
      clearTimeout(this.probeDebounceTimer);
    }

    this.probeDebounceTimer = setTimeout(() => {
      this.probeDebounceTimer = null;
      this.lastProbeTime = Date.now();
      void this.refreshServerRailStatuses();
    }, 1000);
  }

  public async refreshServerRailStatuses(): Promise<void> {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;
    const dots = Array.from(
      railEl.querySelectorAll('.server-rail-avatar')
    ) as HTMLElement[];

    await Promise.all(
      dots.map(async (btn) => {
        const dot = btn.querySelector('.server-rail-status-dot') as HTMLElement | null;
        if (!dot || dot.getAttribute('data-status') === 'online') return;
        // Leave the button being connected to alone: its dot is hidden behind the
        // spinner and rewriting the title would clobber the progress text (#332).
        if (btn.getAttribute('aria-busy') === 'true') return;
        const host = btn.getAttribute('data-host');
        const port = parseInt(btn.getAttribute('data-port') || '0', 10);
        if (!host || !port) return;
        const preview = await fetchServerPreview(host, port);
        const online = preview !== null;
        dot.setAttribute('data-status', online ? 'online' : 'offline');
        const baseTitle = btn.getAttribute('title')?.split(' • ')[0] || '';
        btn.title = `${baseTitle} • ${online ? t('main.statusOnline') : t('main.statusOffline')}`;
        if (online) {
          const saved = (connectionStore.savedServers || []).find((s) => s.host === host && s.port === port);
          if (saved) appEvents.emit('connection.saved_server_online', saved);
        }

        // Pick up the icon of servers the user never connected to (#312). Only
        // persist on change, otherwise the resulting re-render loops forever.
        if (!preview) return;
        const absolute = toAbsoluteServerIconUrl(host, port, preview.iconUrl);
        const saved = (connectionStore.savedServers || []).find(
          (s) => s.host === host && s.port === port
        );
        if (saved && absolute && absolute !== saved.iconUrl) {
          connectionStore.updateSavedServerIcon(host, port, absolute);
        }
      })
    );
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

    return `
      <div class="server-rail-folder ${folder.collapsed ? 'collapsed' : ''}" data-folder-id="${escapeHtml(folder.id)}">
        <div
          class="server-rail-folder-header"
          data-node-type="folder"
          data-folder-id="${escapeHtml(folder.id)}"
          data-root-index="${rootIndex}"
          draggable="false"
          data-rail-draggable="${busy ? 'false' : 'true'}"
          title="${escapeHtml(folder.name)}"
        >
          <button
            type="button"
            class="server-rail-folder-toggle"
            data-folder-toggle="${escapeHtml(folder.id)}"
            aria-label="${escapeHtml(folder.name)}"
            title="${escapeHtml(folder.name)}"
            draggable="false"
          >
            <span class="server-rail-folder-arrow" aria-hidden="true">${folder.collapsed ? '▸' : '▾'}</span>
          </button>
          <span class="material-symbols-outlined md-16 server-rail-folder-icon" aria-hidden="true">
            ${folder.collapsed ? 'folder' : 'folder_open'}
          </span>
          <span class="server-rail-folder-name">${escapeHtml(folder.name)}</span>
        </div>
        <div class="server-rail-folder-children">
          ${childrenHtml}
          ${this.renderFolderChildDropZone(folder.id, folder.children.length)}
        </div>
      </div>
    `;
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
    // Servers kept connected while the user looks elsewhere (#400): they may
    // be hosting the call or have collected messages meanwhile. A session that
    // is merely retrying does not count as online.
    const background = !isCurrent && live?.client.getStatus() === 'CONNECTED' ? live : undefined;
    const hasCall = voiceStore.voiceSessionKey === url;
    const callIcon = serverRailCallIcon(live?.community.snapshot?.events, voiceStore.currentVoiceChannelId);
    // A mention outranks a plain unread, so the row shows the red dot instead
    // of the white one when both are pending (#479).
    const hasMention = !!background?.chatStore.hasAnyMention();
    const hasUnread = !hasMention && !!background?.chatStore.hasAnyUnread();
    const initial = (srv.name || srv.host || '?').trim().charAt(0).toUpperCase();
    // Read from the session that owns this row, never from the proxied store:
    // a render triggered inside a background event would otherwise paint that
    // server's icon on whichever row is current (#400). Relative paths are
    // resolved against that same session's host, never the visible one (#312).
    const liveIcon = live?.serverStore.serverDetails?.iconUrl;
    const liveBase = live?.client.getHttpBaseUrl();
    const resolvedLiveIcon = liveIcon?.startsWith('/') ? (liveBase ? `${liveBase}${liveIcon}` : null) : liveIcon;
    const iconUrl = resolvedLiveIcon || srv.iconUrl;
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
        class="server-rail-item ${isCurrent ? 'active' : ''} ${folderId ? 'server-rail-item--nested' : ''}"
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
          ${isConnecting ? 'data-loading="1" aria-busy="true"' : ''}
          ${busy ? 'disabled' : ''}
          style="padding: 0;"
        >
          ${iconUrl ? `<img src="${escapeHtml(iconUrl)}" alt="" draggable="false" data-fallback="initial" data-fallback-initial="${escapeHtml(initial)}" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit; display: block;">` : `<span>${escapeHtml(initial)}</span>`}
          <span class="server-rail-status-dot" data-status="${isCurrent || background ? 'online' : 'checking'}"></span>
          ${badge}
        </button>
      </div>
    `;
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
        if (this.connectingKey || this.suppressRailClick) return;
        const host = btn.getAttribute('data-host');
        const port = parseInt(btn.getAttribute('data-port') || '0', 10);
        if (!host || !port) return;
        const target = (connectionStore.savedServers || []).find((s) => s.host === host && s.port === port);
        if (target) void this.connectToSavedServer(target);
      });
    });
  }

  private bindFolderToggles(): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;

    railEl.querySelectorAll('.server-rail-folder-toggle').forEach((button) => {
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const folderId = button.getAttribute('data-folder-toggle');
        if (folderId) connectionStore.toggleFolderCollapsed(folderId);
      });
    });

    railEl.querySelectorAll('.server-rail-folder-header').forEach((header) => {
      header.addEventListener('click', () => {
        if (this.suppressRailClick) return;
        const folderId = header.getAttribute('data-folder-id');
        if (folderId) connectionStore.toggleFolderCollapsed(folderId);
      });
    });
  }

  private bindContextMenus(): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;

    railEl.querySelector('.server-rail-list')?.addEventListener('contextmenu', (event) => {
      const mouseEvent = event as MouseEvent;
      const target = event.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.server-rail-avatar, .server-rail-folder-header')) return;
      event.preventDefault();
      contextMenu.open(mouseEvent.clientX, mouseEvent.clientY, [
        {
          label: t('main.createFolder'),
          icon: 'create_new_folder',
          onClick: () => {
            const name = this.promptFolderName();
            if (name) connectionStore.createFolder(name);
          },
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
        const server = connectionStore.savedServers.find(item => item.host === host && item.port === port);
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
        contextMenu.open(mouseEvent.clientX, mouseEvent.clientY, [
          {
            label: t('main.renameFolder'),
            icon: 'edit',
            onClick: () => {
              const name = this.promptFolderName(folder.name);
              if (name) connectionStore.renameFolder(folderId, name);
            },
          },
          {
            label: t('main.deleteFolder'),
            icon: 'delete',
            danger: true,
            onClick: () => connectionStore.deleteFolder(folderId),
          },
        ]);
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

    if (owned) {
      entries.push(
        {
          label: t('connection.start'),
          icon: 'play_arrow',
          onClick: () => { void this.startOwnedServer(owned); },
        },
        {
          label: t('connection.stop'),
          icon: 'stop',
          onClick: () => { void this.stopOwnedServer(); },
        },
        {
          label: t('serverMonitor.title'),
          icon: 'monitoring',
          onClick: () => { void serverMonitorModal.openLocal(); },
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

  private async stopOwnedServer(): Promise<void> {
    if (!window.api?.hostServerStop) return;
    if (!(await confirmStopHostedServer())) return;
    const result = await window.api.hostServerStop();
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
      if (status?.isRunning && (status.serverId === server.id || status.port === server.port)) {
        await this.stopOwnedServer();
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

  private bindDragAndDrop(): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;

    const draggableNodes = Array.from(
      railEl.querySelectorAll('.server-rail-item[data-node-type="server"], .server-rail-folder-header[data-node-type="folder"]')
    ) as HTMLElement[];

    for (const element of draggableNodes) {
      element.addEventListener('mousedown', (event) => {
        if (event.button !== 0 || this.connectingKey || this.pointerDrag) return;
        if ((event.target as Element | null)?.closest('.server-rail-folder-toggle')) return;
        const item = this.railItemOf(element);
        if (!item) return;
        this.pointerDrag = { item, startX: event.clientX, startY: event.clientY, active: false };
        window.addEventListener('mousemove', this.movePointer);
        window.addEventListener('mouseup', this.releasePointer);
        window.addEventListener('blur', this.cancelPointer);
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

  private readonly movePointer = (event: MouseEvent): void => {
    const drag = this.pointerDrag;
    if (!drag) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
      drag.active = true;
      this.draggedRailItem = drag.item;
      contextMenu.close();
      this.markDragging(drag.item);
    }
    event.preventDefault();
    const target = this.pointerTarget(event.clientX, event.clientY);
    if (target?.zone) this.activateDropZone(target.zone);
    else if (target?.header) this.activateFolderHeader(target.header);
    else this.clearDropIndicators();
  };

  private readonly releasePointer = (event: MouseEvent): void => this.finishPointer(event, true);

  private readonly cancelPointer = (): void => this.finishPointer(null, false);

  private finishPointer(event: MouseEvent | null, commit: boolean): void {
    const drag = this.pointerDrag;
    if (!drag) return;
    window.removeEventListener('mousemove', this.movePointer);
    window.removeEventListener('mouseup', this.releasePointer);
    window.removeEventListener('blur', this.cancelPointer);
    const target = commit && drag.active && event ? this.pointerTarget(event.clientX, event.clientY) : null;
    this.pointerDrag = null;
    this.clearDragState();
    if (!drag.active) return;
    // The release lands on a server or folder, whose click must not connect or toggle.
    this.suppressRailClick = true;
    setTimeout(() => { this.suppressRailClick = false; }, 0);
    if (!target) return;
    if (target.zone) {
      const dropKind = target.zone.dataset.dropKind;
      if (dropKind === 'root') {
        const rootIndex = parseInt(target.zone.dataset.rootIndex || '-1', 10);
        if (rootIndex >= 0) this.applyRootDrop(drag.item, rootIndex);
      } else if (dropKind === 'folder-child' && drag.item.type === 'server') {
        const folderId = target.zone.dataset.folderId;
        const childIndex = parseInt(target.zone.dataset.childIndex || '-1', 10);
        if (folderId && childIndex >= 0) {
          connectionStore.moveServerToFolder(drag.item.host, drag.item.port, folderId, childIndex);
        }
      }
    } else if (target.header && drag.item.type === 'server') {
      const folderId = target.header.dataset.folderId;
      if (folderId) connectionStore.moveServerToFolder(drag.item.host, drag.item.port, folderId);
    }
  }

  /**
   * Where a release would land. The thin drop zones are hard to hit, so
   * hovering a server or folder also counts, before or after it by half.
   */
  private pointerTarget(clientX: number, clientY: number): { zone?: HTMLElement; header?: HTMLElement } | null {
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
    const header = element.closest<HTMLElement>('.server-rail-folder-header');
    if (header) return draggingFolder ? around(header.closest('.server-rail-folder')) : { header };
    const server = element.closest<HTMLElement>('.server-rail-item');
    if (!server) return null;
    return around(draggingFolder ? server.closest('.server-rail-folder') ?? server : server);
  }

  private clearDropIndicators(): void {
    const railEl = document.getElementById('server-rail');
    railEl?.querySelectorAll('.server-rail-drop-zone.active').forEach((item) => item.classList.remove('active'));
    railEl?.querySelectorAll('.server-rail-folder-header.drag-over').forEach((item) => item.classList.remove('drag-over'));
  }
  private activateDropZone(zone: HTMLElement): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;
    railEl.querySelectorAll('.server-rail-drop-zone.active').forEach((item) => {
      if (item !== zone) item.classList.remove('active');
    });
    railEl.querySelectorAll('.server-rail-folder-header.drag-over').forEach((item) => {
      item.classList.remove('drag-over');
    });
    zone.classList.add('active');
  }

  private activateFolderHeader(header: HTMLElement): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;
    railEl.querySelectorAll('.server-rail-drop-zone.active').forEach((item) => {
      item.classList.remove('active');
    });
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
    railEl.querySelectorAll('.server-rail-folder-header.drag-over, .dragging').forEach((item) => {
      item.classList.remove('drag-over', 'dragging');
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

  private promptFolderName(initialValue: string = ''): string | null {
    const value = window.prompt(t('main.folderNamePrompt'), initialValue);
    if (value === null) return null;
    const trimmed = value.trim();
    return trimmed || null;
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
