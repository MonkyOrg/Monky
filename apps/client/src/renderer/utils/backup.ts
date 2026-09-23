import { connectionStore } from '../stores/connectionStore';
import { settingsStore } from '../stores/settingsStore';
import { clientLog } from '../core/ClientLogService';

/**
 * Export/import of everything that is not the identity itself (#472).
 *
 * All of this lives in the renderer's localStorage, so the backup is assembled
 * and applied here; the main process only sees an opaque string when it writes
 * the file or ships the data inside the encrypted identity envelope.
 */

export type BackupScope = 'servers' | 'settings';

export const BACKUP_FILE_EXTENSION = 'monkybackup';

interface ServersBackup {
  saved: unknown;
  created: unknown;
  railLayout: unknown;
}

interface SettingsBackup {
  settings: unknown;
  nickname: string;
  avatar: string;
}

export interface MonkyBackup {
  kind: 'monky-backup';
  version: 1;
  createdAt: number;
  servers?: ServersBackup;
  settings?: SettingsBackup;
}

/**
 * Device ids only mean something on the machine that produced them, so they are
 * dropped on the way in: a restored backup falls back to the system default
 * instead of pointing at a microphone that does not exist here.
 */
const MACHINE_SPECIFIC_SETTINGS = ['selectedMicrophoneId', 'selectedSpeakerId', 'selectedCameraId', 'audioOutputDevices'] as const;

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function collectBackup(scopes: BackupScope[]): MonkyBackup {
  const backup: MonkyBackup = {
    kind: 'monky-backup',
    version: 1,
    createdAt: Date.now(),
  };

  if (scopes.includes('servers')) {
    backup.servers = {
      saved: readJson('monky_saved_servers') ?? [],
      created: readJson('monky_created_servers') ?? [],
      railLayout: readJson('monky_rail_layout') ?? [],
    };
  }

  if (scopes.includes('settings')) {
    backup.settings = {
      settings: readJson('monky_settings') ?? {},
      nickname: localStorage.getItem('monky_nickname') || '',
      avatar: localStorage.getItem('monky_avatar') || '',
    };
  }

  return backup;
}

/** Rejects anything that is not one of our backups before it reaches storage. */
export function parseBackup(raw: string): MonkyBackup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('invalid-json');
  }

  const candidate = parsed as Partial<MonkyBackup> | null;
  if (!candidate || candidate.kind !== 'monky-backup' || candidate.version !== 1) {
    throw new Error('invalid-backup');
  }
  if (!candidate.servers && !candidate.settings) {
    throw new Error('empty-backup');
  }

  return candidate as MonkyBackup;
}

/** Which scopes a given backup actually carries, to drive the import checkboxes. */
export function scopesInBackup(backup: MonkyBackup): BackupScope[] {
  const scopes: BackupScope[] = [];
  if (backup.servers) scopes.push('servers');
  if (backup.settings) scopes.push('settings');
  return scopes;
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value ?? null));
  } catch (error) {
    clientLog.warn('STORE', `Could not write ${key} while importing a backup`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Overwrites the chosen scopes and reloads the stores that read them. Returns
 * the scopes that were actually applied so the caller can report back.
 */
export function applyBackup(backup: MonkyBackup, scopes: BackupScope[]): BackupScope[] {
  const applied: BackupScope[] = [];

  if (scopes.includes('servers') && backup.servers) {
    writeJson('monky_saved_servers', backup.servers.saved ?? []);
    writeJson('monky_created_servers', backup.servers.created ?? []);
    writeJson('monky_rail_layout', backup.servers.railLayout ?? []);
    connectionStore.loadSavedServers();
    connectionStore.loadCreatedServers();
    connectionStore.loadRailLayout();
    applied.push('servers');
  }

  if (scopes.includes('settings') && backup.settings) {
    const incoming = { ...(backup.settings.settings as Record<string, unknown> | null ?? {}) };
    for (const key of MACHINE_SPECIFIC_SETTINGS) delete incoming[key];
    writeJson('monky_settings', incoming);

    try {
      if (backup.settings.nickname) localStorage.setItem('monky_nickname', backup.settings.nickname);
      if (backup.settings.avatar) localStorage.setItem('monky_avatar', backup.settings.avatar);
    } catch (error) {
      clientLog.warn('STORE', 'Could not restore the saved profile', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    settingsStore.load();
    connectionStore.loadUserProfile();
    applied.push('settings');
  }

  return applied;
}
