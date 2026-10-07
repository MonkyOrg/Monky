import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';
import { LIMITS, UserActivity } from '@monky/shared';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 10_000;
const REGISTRY_KEY = 'HKCU\\Software\\Valve\\Steam';
/** Refuses oversized files before reading them into memory at all. */
const MAX_ICON_BYTES = 24 * 1024;
/** Steam names the cached icon after its own content hash. */
const ICON_FILE = /^[0-9a-f]{40}\.jpg$/;

/**
 * Reads what the local Steam client is running (#675).
 *
 * Steam already publishes both halves of the answer on disk, so there is no
 * curated executable-to-game catalogue to maintain and no Web API key to ask
 * the user for: `RunningAppID` in the registry says *which* app is up, and the
 * app's own manifest in `steamapps` says what it is called.
 *
 * Only the app id and the title ever leave this module. The process list and
 * executable paths stay here — they are the sensitive part, and nothing
 * downstream needs them.
 */
export class SteamPresence {
  private timer?: NodeJS.Timeout;
  private enabled = false;
  private current: UserActivity | null = null;
  /** Titles keyed by app id: manifests only need reading once per game. */
  private readonly names = new Map<number, string>();
  /** Icons keyed by app id; `null` records "looked and there is none". */
  private readonly icons = new Map<number, string | null>();
  private steamPath?: string | null;
  private polling = false;

  constructor(private readonly onChange: (activity: UserActivity | null) => void) {}

  public isEnabled(): boolean {
    return this.enabled;
  }

  public getCurrent(): UserActivity | null {
    return this.enabled ? this.current : null;
  }

  public setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) {
      this.stop();
      // Emitted even when nothing was running: turning the setting off has to
      // clear what everyone else still sees, not merely stop refreshing it.
      if (this.current !== null) {
        this.current = null;
      }
      this.onChange(null);
      return;
    }
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_INTERVAL_MS);
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private async poll(): Promise<void> {
    // A slow registry or disk read must not stack pollers on top of each other.
    if (this.polling || !this.enabled) return;
    this.polling = true;
    try {
      const appId = await this.readRunningAppId();
      const next = appId === null ? null : await this.buildActivity(appId);
      if (!this.enabled) return;
      if (sameActivity(this.current, next)) return;
      this.current = next;
      this.onChange(next);
    } catch {
      // Steam missing, closed or unreadable is the normal case, not an error.
    } finally {
      this.polling = false;
    }
  }

  private async buildActivity(appId: number): Promise<UserActivity | null> {
    const name = await this.resolveGameName(appId);
    if (!name) return null;
    // The same game across polls keeps its original stamp: re-reading the
    // registry every ten seconds is not a new match, and restamping here would
    // reset the counter on everyone else's screen.
    const startedAt = this.current?.appId === appId ? this.current.startedAt : Date.now();
    const iconBase64 = await this.resolveIcon(appId);
    return iconBase64
      ? { source: 'steam', appId, name, startedAt, iconBase64 }
      : { source: 'steam', appId, name, startedAt };
  }

  /**
   * The app id Steam is running, or `null` when it is idle or absent.
   *
   * Windows only for now, which is what the client ships as. On Linux the same
   * value lives in `registry.vdf`, but it has read 0 since Steam's new UI, so
   * there is nothing to fall back to yet.
   */
  private async readRunningAppId(): Promise<number | null> {
    if (process.platform !== 'win32') return null;
    const value = await this.readRegistryValue('RunningAppID');
    if (!value) return null;
    // REG_DWORD comes back as 0x0 / 0x4ab1a2.
    const parsed = Number.parseInt(value, value.startsWith('0x') ? 16 : 10);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
    return parsed;
  }

  private async readRegistryValue(name: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('reg', ['query', REGISTRY_KEY, '/v', name], {
        windowsHide: true,
      });
      const match = stdout.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`, 'i'));
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
  }

  private async resolveGameName(appId: number): Promise<string | null> {
    const cached = this.names.get(appId);
    if (cached) return cached;

    for (const library of await this.listLibraries()) {
      const manifest = path.join(library, `appmanifest_${appId}.acf`);
      const name = readManifestName(manifest);
      if (name) {
        this.names.set(appId, name);
        return name;
      }
    }
    return null;
  }

  private async resolveSteamPath(): Promise<string | null> {
    if (this.steamPath === undefined) {
      const value = await this.readRegistryValue('SteamPath');
      this.steamPath = value ? value.replace(/\//g, path.sep) : null;
    }
    return this.steamPath;
  }

  /**
   * The icon Steam already downloaded for its own library view (#675).
   *
   * Read from the local cache rather than from Valve's CDN: the file is
   * already there, it costs no request, and it works offline. The layout is
   * undocumented and has changed between Steam versions, so every failure path
   * ends in `null` — a game with no icon still shows up, just generically.
   */
  private async resolveIcon(appId: number): Promise<string | undefined> {
    const cached = this.icons.get(appId);
    if (cached !== undefined) return cached ?? undefined;

    const icon = await this.readIcon(appId);
    this.icons.set(appId, icon ?? null);
    return icon;
  }

  private async readIcon(appId: number): Promise<string | undefined> {
    const steamPath = await this.resolveSteamPath();
    if (!steamPath) return undefined;
    const dir = path.join(steamPath, 'appcache', 'librarycache', String(appId));
    try {
      const file = fs.readdirSync(dir).find((entry) => ICON_FILE.test(entry));
      if (!file) return undefined;
      const full = path.join(dir, file);
      if (fs.statSync(full).size > MAX_ICON_BYTES) return undefined;
      const buffer = fs.readFileSync(full);
      // Trust the bytes, not the extension: what leaves here is declared a JPEG.
      if (buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return undefined;
      const encoded = buffer.toString('base64');
      return encoded.length <= LIMITS.MAX_ACTIVITY_ICON_LENGTH ? encoded : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every `steamapps` folder Steam knows about, main install included. */
  private async listLibraries(): Promise<string[]> {
    const steamPath = await this.resolveSteamPath();
    if (!steamPath) return [];

    const root = path.join(steamPath, 'steamapps');
    const libraries = [root];
    try {
      const parsed = parseVdf(fs.readFileSync(path.join(root, 'libraryfolders.vdf'), 'utf8'));
      const folders = parsed.libraryfolders;
      if (isVdfObject(folders)) {
        for (const entry of Object.values(folders)) {
          const entryPath = isVdfObject(entry) ? entry.path : undefined;
          if (typeof entryPath === 'string' && entryPath) {
            libraries.push(path.join(entryPath, 'steamapps'));
          }
        }
      }
    } catch {
      // A missing or malformed libraryfolders.vdf just means the main install.
    }
    return libraries;
  }
}

/** `startedAt` is deliberately not compared: it is when *this* game began. */
function sameActivity(a: UserActivity | null, b: UserActivity | null): boolean {
  if (a === null || b === null) return a === b;
  return a.appId === b.appId && a.name === b.name;
}

function readManifestName(manifestPath: string): string | null {
  try {
    const parsed = parseVdf(fs.readFileSync(manifestPath, 'utf8'));
    const state = parsed.AppState;
    const name = isVdfObject(state) ? state.name : undefined;
    if (typeof name !== 'string') return null;
    const trimmed = name.trim();
    if (!trimmed) return null;
    return trimmed.slice(0, LIMITS.MAX_ACTIVITY_NAME_LENGTH);
  } catch {
    return null;
  }
}

type VdfValue = string | { [key: string]: VdfValue };

function isVdfObject(value: VdfValue | undefined): value is { [key: string]: VdfValue } {
  return typeof value === 'object' && value !== null;
}

/**
 * Minimal reader for Valve's key-value format, which is what `.acf` and
 * `.vdf` files are: quoted keys followed by a quoted value or a nested block.
 * Only the shape Steam actually writes is supported — no macros, no includes.
 */
function parseVdf(text: string): { [key: string]: VdfValue } {
  const root: { [key: string]: VdfValue } = {};
  const stack: Array<{ [key: string]: VdfValue }> = [root];
  const tokens = text.match(/"(?:[^"\\]|\\.)*"|\{|\}/g) ?? [];

  let pendingKey: string | null = null;
  for (const token of tokens) {
    if (token === '{') {
      if (pendingKey === null) continue;
      const child: { [key: string]: VdfValue } = {};
      stack[stack.length - 1][pendingKey] = child;
      stack.push(child);
      pendingKey = null;
      continue;
    }
    if (token === '}') {
      if (stack.length > 1) stack.pop();
      pendingKey = null;
      continue;
    }

    const value = token.slice(1, -1).replace(/\\(.)/g, '$1');
    if (pendingKey === null) {
      pendingKey = value;
    } else {
      stack[stack.length - 1][pendingKey] = value;
      pendingKey = null;
    }
  }
  return root;
}

