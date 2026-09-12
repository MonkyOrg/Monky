import { ConnectionStatus } from '../core/NetworkClient';
import { appEvents } from '../core/EventBus';
import { clientLog } from '../core/ClientLogService';
import { VoiceMode } from '@monky/shared';
import { favoritesStore } from './favoritesStore';

export interface SavedServer {
  host: string;
  port: number;
  name: string;
  lastConnected: number;
  password?: string;
  iconUrl?: string;
}

export interface RailServerNode {
  type: 'server';
  host: string;
  port: number;
}

export interface RailFolderNode {
  type: 'folder';
  id: string;
  name: string;
  collapsed: boolean;
  children: RailServerNode[];
}

export type RailNode = RailServerNode | RailFolderNode;

export interface CreatedServer {
  id: string;
  name: string;
  port: number;
  password?: string;
  voiceChannel: string;
  textChannel: string;
  createdAt: number;
  lastStarted: number;
  /** Member cap picked on creation; 0/undefined means no limit (#403). */
  maxUsers?: number;
  /** Voice mode ('p2p' | 'sfu') picked on creation (#515). */
  voiceMode?: VoiceMode;
}

export class ConnectionStore {
  private static readonly SAVED_SERVERS_STORAGE_KEY = 'monky_saved_servers';
  private static readonly RAIL_LAYOUT_STORAGE_KEY = 'monky_rail_layout';

  public status: ConnectionStatus = 'DISCONNECTED';
  public clientId: string = '';
  public publicKey: string = '';
  public hasIdentity: boolean = false;
  public lastError: string | null = null;
  public savedServers: SavedServer[] = [];
  public railLayout: RailNode[] = [];
  public createdServers: CreatedServer[] = [];
  public savedNickname: string = '';
  public savedAvatarBase64: string = '';

  constructor() {
    this.loadSavedServers();
    this.loadRailLayout();
    this.loadCreatedServers();
    this.loadUserProfile();
  }

  public loadUserProfile(): void {
    try {
      this.savedNickname = localStorage.getItem('monky_nickname') || '';
      this.savedAvatarBase64 = localStorage.getItem('monky_avatar') || '';
    } catch (e) {
      this.savedNickname = '';
      this.savedAvatarBase64 = '';
    }
  }

  public saveUserProfile(nickname: string, avatarBase64?: string | null): void {
    if (nickname) {
      this.savedNickname = nickname;
      try {
        localStorage.setItem('monky_nickname', nickname);
      } catch (e) {}
    }
    if (avatarBase64 !== undefined) {
      this.savedAvatarBase64 = avatarBase64 || '';
      try {
        if (avatarBase64) {
          localStorage.setItem('monky_avatar', avatarBase64);
        } else {
          localStorage.removeItem('monky_avatar');
        }
      } catch (e) {}
    }
  }

  public loadSavedServers(): void {
    this.savedServers = [];
    try {
      const raw = localStorage.getItem(ConnectionStore.SAVED_SERVERS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        this.savedServers = Array.isArray(parsed)
          ? parsed.filter((server): server is SavedServer => (
            !!server &&
            typeof server.host === 'string' &&
            typeof server.port === 'number' &&
            typeof server.name === 'string' &&
            typeof server.lastConnected === 'number' &&
            (server.password === undefined || typeof server.password === 'string') &&
            (server.iconUrl === undefined || typeof server.iconUrl === 'string')
          ))
          : [];
      }
    } catch (e) {
      this.savedServers = [];
    }
    this.savedServers.sort((a, b) => b.lastConnected - a.lastConnected);
    this.savedServers = this.savedServers.slice(0, 15);
    this.syncSavedServerFavorites();
  }

  public addSavedServer(server: SavedServer): void {
    clientLog.info('STORE', `Saving server: ${server.host}:${server.port}`, { name: server.name });
    const existingIdx = this.savedServers.findIndex(
      (s) => s.host === server.host && s.port === server.port
    );
    if (existingIdx >= 0) {
      // Preserve existing fields if new values are default/empty
      const existing = this.savedServers[existingIdx];
      if (!server.name && existing.name) {
        server.name = existing.name;
      }
      if (!server.iconUrl && existing.iconUrl) {
        server.iconUrl = existing.iconUrl;
      }
      this.savedServers[existingIdx] = server;
    } else {
      this.savedServers.unshift(server);
    }
    // Sort by lastConnected descending
    this.savedServers.sort((a, b) => b.lastConnected - a.lastConnected);
    // Keep max 15
    this.savedServers = this.savedServers.slice(0, 15);
    this.syncSavedServerFavorites();
    this.syncRailLayoutWithSavedServers();
    this.saveSavedServers();
    appEvents.emit('connection.saved_servers_changed');
  }

  public removeSavedServer(host: string, port: number): void {
    clientLog.info('STORE', `Removing saved server: ${host}:${port}`);
    this.savedServers = this.savedServers.filter((s) => !(s.host === host && s.port === port));
    this.syncSavedServerFavorites();
    this.syncRailLayoutWithSavedServers();
    this.saveSavedServers();
    appEvents.emit('connection.saved_servers_changed');
  }

  /**
   * Applies a rename or an icon change to the saved entry. The Home list and the
   * sidebar rail read the name from here, not from the live connection, so a
   * rename that was not written back kept showing the old name until the next
   * time you connected (#85).
   */
  public updateSavedServerMeta(host: string, port: number, meta: { name?: string; iconUrl?: string | null }): void {
    const srv = this.savedServers.find((s) => s.host === host && s.port === port);
    if (!srv) return;
    if (meta.name) srv.name = meta.name;
    if (meta.iconUrl !== undefined) srv.iconUrl = meta.iconUrl || undefined;
    this.saveSavedServers();
    appEvents.emit('connection.saved_servers_changed');
  }

  /** Updates the icon for the currently connected server in the saved list. */
  public updateSavedServerIcon(host: string, port: number, iconUrl: string | null): void {
    this.updateSavedServerMeta(host, port, { iconUrl });
  }

  /**
   * Keeps "Meus Servidores" in step when the owner renames a server they host
   * from the app: that list has its own copy of the name (#85).
   */
  public renameCreatedServerByPort(port: number, name: string): void {
    if (!name) return;
    const server = this.createdServers.find((s) => s.port === port);
    if (!server || server.name === name) return;
    server.name = name;
    try {
      localStorage.setItem('monky_created_servers', JSON.stringify(this.createdServers));
    } catch (e) {}
  }

  public updateSavedServer(oldHost: string, oldPort: number, updated: SavedServer): void {
    const idx = this.savedServers.findIndex((s) => s.host === oldHost && s.port === oldPort);
    if (idx >= 0) {
      this.savedServers[idx] = updated;
      try {
        favoritesStore.moveServer({ host: oldHost, port: oldPort }, updated);
      } catch (error: unknown) {
        clientLog.warn('STORE', 'Could not move the saved server favorite after editing its address', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.syncSavedServerFavorites();
    this.replaceServerReference(oldHost, oldPort, updated.host, updated.port);
    this.syncRailLayoutWithSavedServers();
    this.saveSavedServers();
    appEvents.emit('connection.saved_servers_changed');
  }

  public loadRailLayout(): void {
    try {
      const raw = localStorage.getItem(ConnectionStore.RAIL_LAYOUT_STORAGE_KEY);
      if (!raw) {
        this.railLayout = [];
      } else {
        const parsed = JSON.parse(raw);
        this.railLayout = Array.isArray(parsed)
          ? parsed
            .map((node) => this.parseRailNode(node))
            .filter((node): node is RailNode => node !== null)
          : [];
      }
    } catch (e) {
      this.railLayout = [];
    }

    this.syncRailLayoutWithSavedServers();
  }

  public saveRailLayout(): void {
    try {
      localStorage.setItem(ConnectionStore.RAIL_LAYOUT_STORAGE_KEY, JSON.stringify(this.railLayout));
    } catch (e) {}
  }

  public moveRailNode(fromIndex: number, toIndex: number): void {
    if (fromIndex < 0 || fromIndex >= this.railLayout.length) return;
    const boundedTarget = Math.max(0, Math.min(toIndex, this.railLayout.length));
    const [node] = this.railLayout.splice(fromIndex, 1);
    if (!node) return;
    const adjustedTarget = fromIndex < boundedTarget ? boundedTarget - 1 : boundedTarget;
    this.railLayout.splice(adjustedTarget, 0, node);
    this.saveRailLayout();
    appEvents.emit('connection.saved_servers_changed');
  }

  public createFolder(name: string): string | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const id = `folder_${Date.now()}`;
    this.railLayout.push({
      type: 'folder',
      id,
      name: trimmed,
      collapsed: false,
      children: [],
    });
    this.saveRailLayout();
    appEvents.emit('connection.saved_servers_changed');
    return id;
  }

  public renameFolder(folderId: string, name: string): void {
    const folder = this.railLayout.find(
      (node): node is RailFolderNode => node.type === 'folder' && node.id === folderId
    );
    const trimmed = name.trim();
    if (!folder || !trimmed) return;
    folder.name = trimmed;
    this.saveRailLayout();
    appEvents.emit('connection.saved_servers_changed');
  }

  public deleteFolder(folderId: string): void {
    const folderIndex = this.railLayout.findIndex(
      (node) => node.type === 'folder' && node.id === folderId
    );
    if (folderIndex < 0) return;
    const folder = this.railLayout[folderIndex];
    if (!folder || folder.type !== 'folder') return;
    this.railLayout.splice(folderIndex, 1, ...folder.children);
    this.saveRailLayout();
    appEvents.emit('connection.saved_servers_changed');
  }

  public moveServerToFolder(host: string, port: number, folderId: string | null, index?: number): void {
    const server = this.savedServers.find((item) => item.host === host && item.port === port);
    if (!server) return;

    const removal = this.removeServerNode(host, port);
    const node: RailServerNode = removal?.node ?? { type: 'server', host, port };

    if (folderId === null) {
      let targetIndex = typeof index === 'number' ? index : this.railLayout.length;
      if (removal?.source === 'root' && removal.index < targetIndex) {
        targetIndex -= 1;
      }
      const boundedIndex = Math.max(0, Math.min(targetIndex, this.railLayout.length));
      this.railLayout.splice(boundedIndex, 0, node);
    } else {
      const folder = this.railLayout.find(
        (item): item is RailFolderNode => item.type === 'folder' && item.id === folderId
      );
      if (!folder) {
        this.syncRailLayoutWithSavedServers();
        appEvents.emit('connection.saved_servers_changed');
        return;
      }
      let targetIndex = typeof index === 'number' ? index : folder.children.length;
      if (
        removal?.source === 'folder' &&
        removal.folderId === folderId &&
        removal.index < targetIndex
      ) {
        targetIndex -= 1;
      }
      const boundedIndex = Math.max(0, Math.min(targetIndex, folder.children.length));
      folder.children.splice(boundedIndex, 0, node);
    }

    this.saveRailLayout();
    appEvents.emit('connection.saved_servers_changed');
  }

  public toggleFolderCollapsed(folderId: string): void {
    const folder = this.railLayout.find(
      (node): node is RailFolderNode => node.type === 'folder' && node.id === folderId
    );
    if (!folder) return;
    folder.collapsed = !folder.collapsed;
    this.saveRailLayout();
    appEvents.emit('connection.saved_servers_changed');
  }

  public getOrderedServers(): SavedServer[] {
    const byKey = new Map(this.savedServers.map((server) => [this.serverKey(server.host, server.port), server]));
    const ordered: SavedServer[] = [];

    for (const node of this.railLayout) {
      if (node.type === 'server') {
        const server = byKey.get(this.serverKey(node.host, node.port));
        if (server) ordered.push(server);
        continue;
      }

      for (const child of node.children) {
        const server = byKey.get(this.serverKey(child.host, child.port));
        if (server) ordered.push(server);
      }
    }

    return ordered;
  }

  public getFolderIdForServer(host: string, port: number): string | null {
    const key = this.serverKey(host, port);
    for (const node of this.railLayout) {
      if (node.type !== 'folder') continue;
      if (node.children.some((child) => this.serverKey(child.host, child.port) === key)) {
        return node.id;
      }
    }
    return null;
  }

  public loadCreatedServers(): void {
    try {
      const raw = localStorage.getItem('monky_created_servers');
      if (!raw) {
        this.createdServers = [];
        return;
      }

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        this.createdServers = [];
        return;
      }

      this.createdServers = parsed
        .filter((server): server is CreatedServer => (
          !!server &&
          typeof server.id === 'string' &&
          typeof server.name === 'string' &&
          typeof server.port === 'number' &&
          typeof server.voiceChannel === 'string' &&
          typeof server.textChannel === 'string' &&
          typeof server.createdAt === 'number' &&
          typeof server.lastStarted === 'number'
        ))
        .sort((a, b) => b.lastStarted - a.lastStarted)
        .slice(0, 10);
    } catch (e) {
      this.createdServers = [];
    }
  }

  public saveCreatedServer(server: CreatedServer): void {
    const existingIdx = this.createdServers.findIndex((s) => s.id === server.id);
    if (existingIdx >= 0) {
      const existing = this.createdServers[existingIdx];
      this.createdServers[existingIdx] = {
        ...existing,
        ...server,
        createdAt: existing.createdAt || server.createdAt,
      };
    } else {
      this.createdServers.unshift(server);
    }

    this.createdServers.sort((a, b) => b.lastStarted - a.lastStarted);
    this.createdServers = this.createdServers.slice(0, 10);

    try {
      localStorage.setItem('monky_created_servers', JSON.stringify(this.createdServers));
    } catch (e) {}
  }

  public removeCreatedServer(id: string): void {
    this.createdServers = this.createdServers.filter((s) => s.id !== id);
    try {
      localStorage.setItem('monky_created_servers', JSON.stringify(this.createdServers));
    } catch (e) {}
  }

  public setIdentity(identity: { publicKey: string; clientId: string } | null): void {
    clientLog.info('IDENTITY', `Identity ${identity ? 'set' : 'cleared'}`);
    this.publicKey = identity?.publicKey || '';
    this.clientId = identity?.clientId || '';
    this.hasIdentity = !!identity;
  }

  private saveSavedServers(): void {
    try {
      localStorage.setItem(ConnectionStore.SAVED_SERVERS_STORAGE_KEY, JSON.stringify(this.savedServers));
    } catch (e) {}
  }

  private syncSavedServerFavorites(): void {
    try {
      favoritesStore.retainSavedServers(this.savedServers);
    } catch (error: unknown) {
      clientLog.warn('STORE', 'Could not reconcile saved server favorites', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private parseRailNode(node: unknown): RailNode | null {
    if (!node || typeof node !== 'object') return null;
    const candidate = node as Partial<RailNode>;

    if (candidate.type === 'server' && typeof candidate.host === 'string' && typeof candidate.port === 'number') {
      return {
        type: 'server',
        host: candidate.host,
        port: candidate.port,
      };
    }

    if (
      candidate.type === 'folder' &&
      typeof candidate.id === 'string' &&
      typeof candidate.name === 'string' &&
      typeof candidate.collapsed === 'boolean' &&
      Array.isArray(candidate.children)
    ) {
      return {
        type: 'folder',
        id: candidate.id,
        name: candidate.name,
        collapsed: candidate.collapsed,
        children: candidate.children
          .map((child) => this.parseRailNode(child))
          .filter((child): child is RailServerNode => child !== null && child.type === 'server'),
      };
    }

    return null;
  }

  private syncRailLayoutWithSavedServers(persist: boolean = true): void {
    const savedByKey = new Map(
      this.savedServers.map((server) => [this.serverKey(server.host, server.port), server])
    );
    const seen = new Set<string>();
    const nextLayout: RailNode[] = [];

    for (const node of this.railLayout) {
      if (node.type === 'server') {
        const key = this.serverKey(node.host, node.port);
        if (!savedByKey.has(key) || seen.has(key)) continue;
        nextLayout.push({ type: 'server', host: node.host, port: node.port });
        seen.add(key);
        continue;
      }

      const nextChildren: RailServerNode[] = [];
      for (const child of node.children) {
        const key = this.serverKey(child.host, child.port);
        if (!savedByKey.has(key) || seen.has(key)) continue;
        nextChildren.push({ type: 'server', host: child.host, port: child.port });
        seen.add(key);
      }

      nextLayout.push({
        type: 'folder',
        id: node.id,
        name: node.name.trim() || 'Folder',
        collapsed: node.collapsed,
        children: nextChildren,
      });
    }

    for (const server of this.savedServers) {
      const key = this.serverKey(server.host, server.port);
      if (seen.has(key)) continue;
      nextLayout.push({ type: 'server', host: server.host, port: server.port });
    }

    this.railLayout = nextLayout;
    if (persist) this.saveRailLayout();
  }

  private replaceServerReference(oldHost: string, oldPort: number, newHost: string, newPort: number): void {
    const oldKey = this.serverKey(oldHost, oldPort);
    for (const node of this.railLayout) {
      if (node.type === 'server') {
        if (this.serverKey(node.host, node.port) !== oldKey) continue;
        node.host = newHost;
        node.port = newPort;
        continue;
      }

      for (const child of node.children) {
        if (this.serverKey(child.host, child.port) !== oldKey) continue;
        child.host = newHost;
        child.port = newPort;
      }
    }
  }

  private removeServerNode(host: string, port: number): {
    node: RailServerNode;
    source: 'root' | 'folder';
    index: number;
    folderId?: string;
  } | null {
    const key = this.serverKey(host, port);

    for (let i = 0; i < this.railLayout.length; i += 1) {
      const node = this.railLayout[i];
      if (node.type === 'server' && this.serverKey(node.host, node.port) === key) {
        const [removed] = this.railLayout.splice(i, 1);
        if (!removed || removed.type !== 'server') return null;
        return { node: removed, source: 'root', index: i };
      }

      if (node.type !== 'folder') continue;
      const childIndex = node.children.findIndex(
        (child) => this.serverKey(child.host, child.port) === key
      );
      if (childIndex < 0) continue;
      const [removed] = node.children.splice(childIndex, 1);
      if (!removed) return null;
      return { node: removed, source: 'folder', index: childIndex, folderId: node.id };
    }

    return null;
  }

  private serverKey(host: string, port: number): string {
    return `${host}:${port}`;
  }
}

export const connectionStore = new ConnectionStore();
