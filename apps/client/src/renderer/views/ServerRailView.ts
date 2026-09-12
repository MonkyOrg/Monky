import { escapeHtml } from '../utils/html';
import { sessionManager, sessionKeyFor } from '../core/SessionManager';
import {
  assertServerBrowseAvailable, captureServerBrowseIntent, getServerSessionForAddress, openServerSession, showServerSession,
} from '../core/serverConnection';
import { ensureHostedServerStarted, findOwnedServer } from '../core/hostedServerStart';
import { voiceStore } from '../stores/voiceStore';
import {
  connectionStore,
  SavedServer,
  RailFolderNode,
  RailNode,
} from '../stores/connectionStore';
import { audioProcessor } from '../core/AudioProcessor';
import { webRtcManager } from '../core/WebRtcManager';
import { showConfirm, showAlert } from './Dialog';
import { checkServerOnline, fetchServerPreview } from '../utils/serverStatus';
import {
  captureHostedServerLeaveState,
  promptShutdownAfterLeave,
} from '../utils/hostedServer';
import { soundEffects } from '../core/SoundEffects';
import { toAbsoluteServerIconUrl } from '../utils/avatar';
import { t } from '../i18n';
import { contextMenu } from './ContextMenu';

type DraggedRailItem =
  | { type: 'server'; host: string; port: number }
  | { type: 'folder'; folderId: string };

export class ServerRailView {
  /**
   * Server the user is currently connecting to, as `host:port`. Kept on the view
   * (instead of poked straight into the DOM) because `render()` runs again on
   * network events and would wipe any attribute set by hand (#332).
   */
  private connectingKey: string | null = null;
  private draggedRailItem: DraggedRailItem | null = null;
  private skipNextFolderToggle = false;
  private lastProbeTime = 0;
  private probeDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly PROBE_INTERVAL_MS = 15000;

  private static keyOf(host: string, port: number): string {
    return `${host.trim().replace(/^wss?:\/\//, '')}:${port}`;
  }

  public render(): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;

    contextMenu.close();

    // The active key (not the proxied client) is what identifies the server on
    // screen: during a background event the proxy points elsewhere (#400).
    const currentUrl = sessionManager.getActiveKey();
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
      <button class="server-rail-home" id="server-rail-home" title="${t('main.homeTitle')}" ${busy ? 'disabled' : ''}>
        <span class="material-symbols-outlined md-22">home</span>
      </button>
      <div class="server-rail-divider"></div>
      <div class="server-rail-list">
        ${nodesHtml}
        ${this.renderRootDropZone(layout.length)}
      </div>
    `;

    railEl.querySelector('#server-rail-home')?.addEventListener('click', async () => {
      const confirmed = await showConfirm({
        title: t('main.backHomeTitle'),
        message: t('main.backHomeMessage'),
        confirmLabel: t('main.backHomeTitle'),
        variant: 'warning',
      });
      if (!confirmed) return;
      // Captured before the socket closes: afterwards there is no way to tell
      // whether this user was hosting the server they just left (#334).
      const leaveState = await captureHostedServerLeaveState();
      soundEffects.play('leave_voice');
      audioProcessor.stopMicrophone();
      webRtcManager.closeAllPeers();
      // Going home means leaving everything, including servers kept alive in
      // the background for an ongoing call (#400).
      sessionManager.removeAll();
      if (leaveState) await promptShutdownAfterLeave(leaveState);
    });

    this.bindServerClicks();
    this.bindFolderToggles();
    this.bindDragAndDrop();
    this.bindContextMenus();

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
          draggable="${busy ? 'false' : 'true'}"
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
      ? `<span class="server-rail-badge" data-kind="call" title="${escapeHtml(t('main.callHereTooltip'))}"><span class="material-symbols-outlined md-14">graphic_eq</span></span>`
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
        draggable="${busy ? 'false' : 'true'}"
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
          ${iconUrl ? `<img src="${escapeHtml(iconUrl)}" data-fallback="initial" data-fallback-initial="${escapeHtml(initial)}" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit; display: block;">` : `<span>${escapeHtml(initial)}</span>`}
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
        if (this.skipNextFolderToggle) return;
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

    railEl.querySelectorAll('.server-rail-avatar[data-folder-id]').forEach((btn) => {
      btn.addEventListener('contextmenu', (event) => {
        const mouseEvent = event as MouseEvent;
        event.preventDefault();
        event.stopPropagation();
        const host = btn.getAttribute('data-host');
        const port = parseInt(btn.getAttribute('data-port') || '0', 10);
        if (!host || !port) return;
        const folderId = btn.getAttribute('data-folder-id');
        if (!folderId) return;
        contextMenu.open(mouseEvent.clientX, mouseEvent.clientY, [
          {
            label: t('main.removeFromFolder'),
            icon: 'drive_file_move',
            onClick: () => connectionStore.moveServerToFolder(host, port, null),
          },
        ]);
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

  private bindDragAndDrop(): void {
    const railEl = document.getElementById('server-rail');
    if (!railEl) return;

    const draggableNodes = Array.from(
      railEl.querySelectorAll('.server-rail-item[data-node-type="server"], .server-rail-folder-header[data-node-type="folder"]')
    ) as HTMLElement[];

    draggableNodes.forEach((element) => {
      element.addEventListener('dragstart', (event) => {
        if (this.connectingKey) {
          event.preventDefault();
          return;
        }

        if (element.getAttribute('data-node-type') === 'folder') {
          const folderId = element.getAttribute('data-folder-id');
          if (!folderId) {
            event.preventDefault();
            return;
          }
          this.draggedRailItem = { type: 'folder', folderId };
          const transfer = (event as DragEvent).dataTransfer;
          if (transfer) {
            transfer.effectAllowed = 'move';
            transfer.setData('text/monky-rail-folder-id', folderId);
          }
        } else {
          const host = element.getAttribute('data-host');
          const port = parseInt(element.getAttribute('data-port') || '0', 10);
          if (!host || !port) {
            event.preventDefault();
            return;
          }
          this.draggedRailItem = { type: 'server', host, port };
          const transfer = (event as DragEvent).dataTransfer;
          if (transfer) {
            transfer.effectAllowed = 'move';
            transfer.setData('text/monky-rail-server', `${host}:${port}`);
          }
        }

        setTimeout(() => element.classList.add('dragging'), 0);
      });

      element.addEventListener('dragend', () => {
        element.classList.remove('dragging');
        if (element.getAttribute('data-node-type') === 'folder') {
          this.skipNextFolderToggle = true;
          setTimeout(() => { this.skipNextFolderToggle = false; }, 0);
        }
        this.clearDragState();
      });
    });

    const dropZones = Array.from(railEl.querySelectorAll('.server-rail-drop-zone')) as HTMLElement[];
    dropZones.forEach((zone) => {
      zone.addEventListener('dragover', (event) => {
        if (!this.draggedRailItem || !this.canDropOnZone(zone)) return;
        event.preventDefault();
        const transfer = (event as DragEvent).dataTransfer;
        if (transfer) transfer.dropEffect = 'move';
        this.activateDropZone(zone);
      });

      zone.addEventListener('drop', (event) => {
        if (!this.draggedRailItem || !this.canDropOnZone(zone)) return;
        event.preventDefault();
        const dragged = this.draggedRailItem;
        const dropKind = zone.getAttribute('data-drop-kind');
        if (dropKind === 'root') {
          const rootIndex = parseInt(zone.getAttribute('data-root-index') || '-1', 10);
          if (rootIndex >= 0) this.applyRootDrop(dragged, rootIndex);
        } else if (dropKind === 'folder-child' && dragged.type === 'server') {
          const folderId = zone.getAttribute('data-folder-id');
          const childIndex = parseInt(zone.getAttribute('data-child-index') || '-1', 10);
          if (folderId && childIndex >= 0) {
            connectionStore.moveServerToFolder(dragged.host, dragged.port, folderId, childIndex);
          }
        }
        this.clearDragState();
      });
    });

    const folderHeaders = Array.from(railEl.querySelectorAll('.server-rail-folder-header')) as HTMLElement[];
    folderHeaders.forEach((header) => {
      header.addEventListener('dragover', (event) => {
        if (!this.draggedRailItem || this.draggedRailItem.type !== 'server') return;
        const folderId = header.getAttribute('data-folder-id');
        if (!folderId) return;
        event.preventDefault();
        const transfer = (event as DragEvent).dataTransfer;
        if (transfer) transfer.dropEffect = 'move';
        this.activateFolderHeader(header);
      });

      header.addEventListener('dragleave', (event) => {
        const next = (event as DragEvent).relatedTarget as Node | null;
        if (next && header.contains(next)) return;
        header.classList.remove('drag-over');
      });

      header.addEventListener('drop', (event) => {
        if (!this.draggedRailItem || this.draggedRailItem.type !== 'server') return;
        const folderId = header.getAttribute('data-folder-id');
        if (!folderId) return;
        event.preventDefault();
        connectionStore.moveServerToFolder(
          this.draggedRailItem.host,
          this.draggedRailItem.port,
          folderId
        );
        this.clearDragState();
      });
    });
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
