import fs from 'fs';
import path from 'path';
import type { ServerShutdownKind } from '@monky/shared';

/**
 * How the CLI tells the running server that the restart about to happen is an
 * update, so the goodbye it sends says "back in a moment" instead of "the host
 * closed the server" (#558).
 *
 * A file rather than a request to the server: the process is about to be killed
 * by PM2 and has no chance to answer anything, and this keeps the update path
 * from depending on the HTTP port being reachable.
 */
const MARKER_FILE = 'restart-intent.json';

/**
 * How long a marker is believed.
 *
 * A process killed with SIGKILL never reads its marker, which would then sit in
 * the data directory and mislabel the *next* shutdown as an update. The window
 * is generous enough for a slow `npm install` plus the PM2 restart, and short
 * enough that a leftover cannot survive to a later session.
 */
const MARKER_TTL_MS = 5 * 60 * 1000;

interface RestartMarker {
  kind: ServerShutdownKind;
  at: number;
}

function markerPath(dataDir: string): string {
  return path.join(dataDir, MARKER_FILE);
}

/**
 * Records that the next shutdown of the server in `dataDir` is an update.
 *
 * Best-effort on purpose: failing to write a nicety must never abort an update.
 */
export function markUpdateRestart(dataDir: string): void {
  const marker: RestartMarker = { kind: 'update', at: Date.now() };
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(markerPath(dataDir), JSON.stringify(marker), 'utf8');
  } catch {
    // The shutdown notice falls back to the plain wording.
  }
}

/** Removes the marker, ignoring the common case of it not being there. */
export function clearRestartMarker(dataDir: string): void {
  try {
    fs.rmSync(markerPath(dataDir), { force: true });
  } catch {
    // Nothing to do: a stale marker is discarded by its TTL anyway.
  }
}

/**
 * Reads why the server is stopping and consumes the marker.
 *
 * Synchronous because it runs inside the shutdown path, which is already racing
 * PM2's kill timeout — an await here would risk the process dying before the
 * clients are told anything.
 */
export function consumeRestartKind(dataDir: string): ServerShutdownKind {
  try {
    const raw = fs.readFileSync(markerPath(dataDir), 'utf8');
    clearRestartMarker(dataDir);
    const marker = JSON.parse(raw) as Partial<RestartMarker>;
    if (marker?.kind !== 'update') return 'shutdown';
    if (typeof marker.at !== 'number' || Date.now() - marker.at > MARKER_TTL_MS) return 'shutdown';
    return 'update';
  } catch {
    return 'shutdown';
  }
}
