import { toHttpBase } from './serverAddress';

/**
 * Checks whether a Monky server is online and joinable by hitting its
 * public HTTP `/preview` endpoint. A successful response means the server
 * process is actually running (more reliable than a raw TCP probe, which a
 * firewall can distort). Used for the online/offline indicators in the saved
 * servers list (home) and the server rail (sidebar) — #37.
 */
export interface ServerPreview {
  name?: string;
  hasPassword?: boolean;
  iconUrl?: string | null;
  userCount?: number;
  /** Registered members, which is what `maxUsers` caps (#403). */
  memberCount?: number;
  /** 0 means the owner set no membership limit (#403). */
  maxUsers?: number;
}

/**
 * Fetches a server's public `/preview` payload, or null when it is unreachable.
 * Lets the server rail show the icon of servers the user never connected to (#312).
 */
export async function fetchServerPreview(
  host: string,
  port: number,
  timeoutMs = 2500
): Promise<ServerPreview | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${toHttpBase({ host, port })}/preview`, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    return (await res.json()) as ServerPreview;
  } catch {
    return null;
  }
}

export async function checkServerOnline(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${toHttpBase({ host, port })}/preview`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}
