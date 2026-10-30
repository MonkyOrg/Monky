import { randomUUID } from 'node:crypto';
import { realpath as pathWalkingRealpath } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export type MediaFolderPurpose = 'soundboard' | 'stickers';

/** Result of checking a folder the renderer asked to read. */
export type MediaFolderCheck =
  | { status: 'allowed'; folder: string }
  /** Nothing to list there right now: a deleted folder, or a drive that is not mounted. */
  | { status: 'missing' }
  /** An existing folder this profile never confirmed, for example one restored from a backup. */
  | { status: 'unconfirmed'; folder: string }
  /** Not a path that can be checked at all. */
  | { status: 'denied' };

/** Asks the person, natively, whether a folder they did not choose on this computer may be read. */
export type ConfirmMediaFolder = (folder: string) => Promise<boolean>;

type Realpath = (target: string) => Promise<string>;

interface MediaFolderState {
  adopted: boolean;
  soundboard: string[];
  stickers: string[];
}

const PURPOSES: readonly MediaFolderPurpose[] = ['soundboard', 'stickers'];
/** Each folder keeps its chosen and canonical paths; a few recent ones let the user switch back without a dialog. */
const MAX_ENTRIES = 16;
const MAX_FILE_BYTES = 64 * 1024;
const walkLinks: Realpath = promisify(pathWalkingRealpath);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function samePath(left: string, right: string): boolean {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function absolutePath(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f]/.test(value)
    && path.isAbsolute(value) ? path.resolve(value) : null;
}

function remember(current: readonly string[], added: readonly string[]): string[] {
  const kept: string[] = [];
  for (const entry of [...added, ...current]) {
    if (!kept.some(existing => samePath(existing, entry))) kept.push(entry);
  }
  return kept.slice(0, MAX_ENTRIES);
}

function savedFolders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return remember([], value.map(absolutePath).filter((entry): entry is string => entry !== null));
}

/**
 * Folders whose sounds and stickers the renderer may list and read (D4, E-MAIN-9).
 *
 * The renderer shows remote chat content, so a path it sends is not consent:
 * only a folder chosen in the system dialog, created by Main, or confirmed in a
 * native dialog the person answered is readable. Folders configured before this
 * rule existed are adopted once per profile, from what the main window's
 * preload finds in the saved settings before any page script runs. Writing
 * keeps its own, stricter confirmations.
 */
export class MediaFolderAccess {
  private loading: Promise<MediaFolderState> | null = null;
  private changes: Promise<unknown> = Promise.resolve();
  /** The native confirmation on screen, if any: one at a time, never stacked. */
  private prompt: { purpose: MediaFolderPurpose; folder: string; answer: Promise<boolean> } | null = null;

  /** `nativeRealpath` is only replaced by tests, to reproduce volumes where it fails. */
  constructor(private readonly file: string, private readonly nativeRealpath: Realpath = fs.realpath) {}

  /** Remembers a folder confirmed natively and resolves to its canonical path. */
  public allow(purpose: MediaFolderPurpose, folder: unknown): Promise<string> {
    return this.change(async (state) => {
      const resolved = absolutePath(folder);
      if (!resolved) throw new Error('A confirmed media folder must be an absolute path.');
      const canonical = await this.canonical(resolved);
      if (!canonical || !(await fs.stat(canonical)).isDirectory()) {
        throw new Error('A confirmed media folder must be an existing directory.');
      }
      state[purpose] = remember(state[purpose], [canonical, resolved]);
      return canonical;
    });
  }

  /**
   * Adopts the folders the renderer had configured, on the first report of the
   * profile only. Resolves to whether this report was the one adopted.
   */
  public adoptConfigured(input: unknown): Promise<boolean> {
    return this.change(async (state) => {
      if (state.adopted) return false;
      state.adopted = true;
      for (const purpose of PURPOSES) {
        const resolved = absolutePath(record(input) ? input[purpose] : undefined);
        if (!resolved) continue;
        // A drive that is not mounted right now keeps working once it is back.
        const canonical = await this.canonical(resolved);
        state[purpose] = remember(state[purpose], canonical ? [canonical, resolved] : [resolved]);
      }
      return true;
    });
  }

  /**
   * Checks a folder the renderer asked to list. Where nothing exists there is
   * nothing to list, as before D4; an existing folder must have been confirmed
   * by this profile.
   */
  public async checkFolder(purpose: MediaFolderPurpose, requested: unknown): Promise<MediaFolderCheck> {
    const entries = (await this.settled())[purpose];
    const resolved = absolutePath(requested);
    if (!resolved) return { status: 'denied' };
    const canonical = await this.canonical(resolved);
    if (!canonical) return { status: 'missing' };
    if (entries.some(entry => samePath(entry, resolved) || samePath(entry, canonical))) {
      return { status: 'allowed', folder: canonical };
    }
    // Only a real folder is ever offered for confirmation.
    const stat = await fs.stat(canonical).catch(() => null);
    return stat?.isDirectory() ? { status: 'unconfirmed', folder: canonical } : { status: 'missing' };
  }

  /**
   * `checkFolder`, except that an existing folder this profile never confirmed
   * (restored from a backup, or chosen in another version of Monky) can be
   * confirmed through `confirm` instead of staying blocked. Main passes it only
   * for a direct user action, so loading never raises a dialog by itself.
   */
  public async requestFolder(
    purpose: MediaFolderPurpose, requested: unknown, confirm?: ConfirmMediaFolder,
  ): Promise<MediaFolderCheck> {
    const access = await this.checkFolder(purpose, requested);
    if (access.status !== 'unconfirmed') return access;
    let prompt = this.prompt;
    // Another folder is being confirmed: a second dialog is never stacked on it.
    if (prompt && (prompt.purpose !== purpose || !samePath(prompt.folder, access.folder))) return access;
    if (!prompt) {
      if (!confirm) return access;
      prompt = this.startPrompt(purpose, access.folder, confirm);
    }
    return await prompt.answer ? this.checkFolder(purpose, requested) : access;
  }

  /**
   * Canonical path of a file directly inside an allowed folder, or null. A link
   * that leads out of the folder is refused like any other outside file.
   */
  public async resolveFile(purpose: MediaFolderPurpose, requested: unknown): Promise<string | null> {
    const resolved = absolutePath(requested);
    if (!resolved) return null;
    const folder = await this.checkFolder(purpose, path.dirname(resolved));
    if (folder.status !== 'allowed') return null;
    const canonical = await this.canonical(resolved);
    return canonical && samePath(path.dirname(canonical), folder.folder) ? canonical : null;
  }

  private startPrompt(purpose: MediaFolderPurpose, folder: string, confirm: ConfirmMediaFolder) {
    const prompt = { purpose, folder, answer: Promise.resolve(false) };
    // Asked on a later turn, so the dialog is registered before it can settle.
    prompt.answer = Promise.resolve()
      .then(() => confirm(folder))
      .then(async (accepted) => {
        if (!accepted) return false;
        await this.allow(purpose, folder);
        return true;
      })
      .catch((error: unknown) => {
        console.warn(`[MediaFolders] Could not confirm the ${purpose} folder:`, error);
        return false;
      })
      .finally(() => {
        if (this.prompt === prompt) this.prompt = null;
      });
    this.prompt = prompt;
    return prompt;
  }

  /**
   * Canonical path of what exists at `target`, or null when nothing does.
   *
   * The native realpath asks Windows for the final path of an open handle,
   * which some virtual volumes cannot answer (ImDisk RAM disks, WinFsp or Dokan
   * mounts fail with EISDIR) even though listing and reading them work. Node's
   * path-walking realpath, which resolves each link with readlink, gives the
   * same answer there, so those folders work instead of looking empty.
   */
  private async canonical(target: string): Promise<string | null> {
    try {
      return await this.nativeRealpath(target);
    } catch {
      return await walkLinks(target).catch(() => null);
    }
  }

  /** Reads wait for adoptions and confirmations already requested, never for later ones. */
  private settled(): Promise<MediaFolderState> {
    return this.changes.then(() => this.load());
  }

  private change<T>(operation: (state: MediaFolderState) => Promise<T>): Promise<T> {
    const result = this.changes.then(async () => {
      const state = await this.load();
      const before = JSON.stringify(state);
      const value = await operation(state);
      if (JSON.stringify(state) !== before) await this.persist(state);
      return value;
    });
    this.changes = result.catch(() => undefined);
    return result;
  }

  private load(): Promise<MediaFolderState> {
    return this.loading ??= (async () => {
      try {
        const text = await fs.readFile(this.file, 'utf8');
        const saved: unknown = text.length <= MAX_FILE_BYTES ? JSON.parse(text) : null;
        if (record(saved) && saved.version === 1) {
          return { adopted: saved.adopted === true, soundboard: savedFolders(saved.soundboard), stickers: savedFolders(saved.stickers) };
        }
        console.warn('[MediaFolders] Unrecognized folder record; adopting the configured folders again.');
      } catch (error) {
        if (!(record(error) && error.code === 'ENOENT')) {
          // Only Main writes this file, so adopting again cannot be forced by the renderer.
          console.warn('[MediaFolders] Could not read the folder record; adopting the configured folders again.', error);
        }
      }
      return { adopted: false, soundboard: [], stickers: [] };
    })();
  }

  private async persist(state: MediaFolderState): Promise<void> {
    const staging = `${this.file}.${randomUUID()}.writing`;
    const handle = await fs.open(staging, 'wx');
    try {
      await handle.writeFile(JSON.stringify({ version: 1, ...state }));
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await fs.rename(staging, this.file);
    } catch (error) {
      await fs.unlink(staging).catch(() => undefined);
      throw error;
    }
  }
}
