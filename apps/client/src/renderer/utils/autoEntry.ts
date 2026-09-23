import { savedServerFavoriteKey } from '../stores/favoritesStore';

export interface AutoEntryServerAddress {
  host: string;
  port: number;
}

const MAX_LEGACY_AUTO_ENTRY_SERVERS = 15;

export function autoEntryServerKey(server: AutoEntryServerAddress): string | null {
  if (typeof server.host !== 'string' || !Number.isSafeInteger(server.port)
    || server.port < 1 || server.port > 65535) return null;
  const host = server.host.trim().replace(/^wss?:\/\//i, '').replace(/^\[(.+)\]$/, '$1').toLowerCase();
  if (!host || host.length > 253 || /[\s/@?#\\]/.test(host)) return null;
  try {
    new URL(`ws://${host.includes(':') ? `[${host}]` : host}:${server.port}`);
    return savedServerFavoriteKey({ host, port: server.port });
  } catch {
    return null;
  }
}

export function restoreAutoEntryServerKeys(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_LEGACY_AUTO_ENTRY_SERVERS) return [];
  let latestKey: string | null = null;
  for (const item of value) {
    if (typeof item !== 'string' || item.length > 512) continue;
    try {
      const address: unknown = JSON.parse(item);
      if (!Array.isArray(address) || address.length !== 2
        || typeof address[0] !== 'string' || typeof address[1] !== 'number') continue;
      const key = autoEntryServerKey({ host: address[0], port: address[1] });
      if (key) latestKey = key;
    } catch {
      // Old settings never opted in; malformed entries must not opt in either.
    }
  }
  // Older versions appended each chosen server. Retain only the latest choice.
  return latestKey ? [latestKey] : [];
}
