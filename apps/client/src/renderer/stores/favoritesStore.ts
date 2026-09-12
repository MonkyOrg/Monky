import { clientLog } from '../core/ClientLogService';

export type FavoriteKind = 'sounds' | 'servers';
type FavoriteStorage = Pick<Storage, 'getItem' | 'setItem'>;
interface ServerAddress {
  host: string;
  port: number;
}

export const FAVORITES_STORAGE_KEY = 'monky_favorites';

export function soundFavoriteKey(filePath: string): string {
  // Windows paths are case-insensitive; Unix paths must keep their casing.
  return /^[a-z]:[\\/]/i.test(filePath) || filePath.startsWith('\\\\')
    ? filePath.replace(/\//g, '\\').toLowerCase()
    : filePath;
}

export function savedServerFavoriteKey(server: ServerAddress): string {
  const host = server.host.trim().replace(/^wss?:\/\//i, '').replace(/^\[(.+)\]$/, '$1').toLowerCase();
  return JSON.stringify([host, server.port]);
}

function stringKeys(value: unknown): Set<string> {
  return new Set(Array.isArray(value)
    ? value.filter((key): key is string => typeof key === 'string' && key.length > 0)
    : []);
}

export class FavoritesStore {
  private sounds = new Set<string>();
  private servers = new Set<string>();
  private listeners = new Set<(kind: FavoriteKind) => void>();

  constructor(private readonly storage?: FavoriteStorage) {
    this.load();
  }

  private getStorage(): FavoriteStorage | null {
    return this.storage ?? (typeof localStorage === 'undefined' ? null : localStorage);
  }

  public load(): void {
    try {
      const raw = this.getStorage()?.getItem(FAVORITES_STORAGE_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object' && 'version' in parsed && parsed.version === 1) {
        this.sounds = new Set([...stringKeys('sounds' in parsed ? parsed.sounds : null)].map(soundFavoriteKey));
        this.servers = stringKeys('servers' in parsed ? parsed.servers : null);
      } else {
        this.sounds.clear();
        this.servers.clear();
      }
    } catch (error: unknown) {
      this.sounds.clear();
      this.servers.clear();
      clientLog.warn('STORE', 'Could not load local favorites', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  public subscribe(listener: (kind: FavoriteKind) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  public isSoundFavorite(filePath: string): boolean {
    return this.sounds.has(soundFavoriteKey(filePath));
  }

  public isServerFavorite(server: ServerAddress): boolean {
    return this.servers.has(savedServerFavoriteKey(server));
  }

  public toggleSound(filePath: string): boolean {
    return this.toggle('sounds', soundFavoriteKey(filePath));
  }

  public toggleServer(server: ServerAddress): boolean {
    return this.toggle('servers', savedServerFavoriteKey(server));
  }

  private toggle(kind: FavoriteKind, key: string): boolean {
    const next = new Set(this[kind]);
    const favorite = !next.delete(key);
    if (favorite) next.add(key);
    this.commit(kind, next);
    return favorite;
  }

  public moveServer(previous: ServerAddress, next: ServerAddress): void {
    const previousKey = savedServerFavoriteKey(previous);
    const nextKey = savedServerFavoriteKey(next);
    if (previousKey === nextKey || !this.servers.has(previousKey)) return;
    const servers = new Set(this.servers);
    servers.delete(previousKey);
    servers.add(nextKey);
    this.commit('servers', servers);
  }

  /** Deletion, the saved-list cap and imports must not leave favorite ghosts. */
  public retainSavedServers(servers: readonly ServerAddress[]): void {
    const available = new Set(servers.map(savedServerFavoriteKey));
    const retained = new Set([...this.servers].filter(key => available.has(key)));
    if (retained.size !== this.servers.size) this.commit('servers', retained);
  }

  private commit(kind: FavoriteKind, next: Set<string>): void {
    const storage = this.getStorage();
    if (!storage) throw new Error('Local favorites storage is unavailable');
    // Commit before publishing: a failed write must not display a saved star.
    storage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify({
      version: 1,
      sounds: [...(kind === 'sounds' ? next : this.sounds)],
      servers: [...(kind === 'servers' ? next : this.servers)],
    }));
    this[kind] = next;
    for (const listener of this.listeners) listener(kind);
  }
}

export const favoritesStore = new FavoritesStore();
