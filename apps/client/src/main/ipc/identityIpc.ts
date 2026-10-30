import { app, dialog, type BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createIdentity, deleteIdentity, exportIdentity, getClientId, getIdentity, getIdentityStatus, importIdentity, signChallenge,
} from '../identityService';
import { exportDirectMessages, importDirectMessages, resetDirectMessages, wipeDirectMessages } from '../dm/dmIpc';
import { openBackup, sealBackup } from '../secretEnvelope';
import { mt } from '../i18n';
import type { IpcRegistry } from './registry';

export interface IdentityIpcDeps {
  window: BrowserWindow;
  sanitizeFileName: (name: string) => string;
  /** Graceful quit (leaves servers, stops the hosted server) used by logout. */
  quitApplication?: () => void;
}

const failure = (error: unknown): { success: false; error: string } =>
  ({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });

/** The identity that signs in to every server, and the encrypted backup of servers and settings (#472). */
export function registerIdentityIpc(registry: IpcRegistry, { window, sanitizeFileName, quitApplication }: IdentityIpcDeps): void {
  registry.handle('identity:status', 'main', async () => getIdentityStatus());
  registry.handle('identity:create', 'main', async () => createIdentity());
  registry.handle('identity:get', 'main', async () => getIdentity(true));
  registry.handle('identity:get-client-id', 'main', async () => getClientId());
  registry.handle('identity:sign-challenge', 'main', async (_event, nonceHex) => signChallenge(nonceHex));
  registry.handle('identity:export', 'main', async (_event, password, extras, dmMode) =>
    exportIdentity(
      password,
      typeof extras === 'string' ? extras : undefined,
      exportDirectMessages(dmMode === 'friends' || dmMode === 'history' ? dmMode : 'none'),
    ));
  registry.handle('identity:import', 'main', async (_event, exportedIdentity, password, replace) => {
    const outcome = await importIdentity(exportedIdentity, password, typeof replace === 'string' ? replace : undefined);
    // Waiting for the user to confirm another identity: friends and DMs stay as they are.
    if (outcome.status !== 'imported') return outcome;
    const { dm, ...imported } = outcome;
    resetDirectMessages();
    importDirectMessages(dm);
    return imported;
  });

  // Logout: the identity only exists on this computer, so leaving it means
  // deleting it together with friends and DMs. The renderer already cleared
  // the identity-bound localStorage; relaunching gives a clean process that
  // lands on the create/import screen.
  let loggingOut = false;
  registry.handle('identity:logout', 'main', async () => {
    if (loggingOut) return { success: true };
    loggingOut = true;
    try {
      deleteIdentity();
      await wipeDirectMessages();
      await window.webContents.session.flushStorageData();
    } catch (error) {
      loggingOut = false;
      console.error('[Identity] Logout failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    setImmediate(() => {
      app.relaunch();
      if (quitApplication) quitApplication();
      else app.quit();
    });
    return { success: true };
  });

  // Backup of saved servers and app settings (#472). The renderer owns the
  // content (it all lives in localStorage); the main process only picks the
  // path, seals the file with the user's password and touches the disk.
  //
  // The backup carries the passwords of saved servers, so it gets the very same
  // protection as the identity export instead of landing on disk as plain JSON.
  registry.handle('backup:encrypt', 'main', async (_event, contents, password) => {
    if (typeof contents !== 'string' || !contents) {
      return { success: false, error: 'Conteúdo de backup inválido.' };
    }
    try {
      return { success: true, payload: await sealBackup(contents, password) };
    } catch (error) {
      return failure(error);
    }
  });

  registry.handle('backup:decrypt', 'main', async (_event, payload, password) => {
    if (typeof payload !== 'string' || !payload) {
      return { success: false, error: 'Arquivo de backup inválido.' };
    }
    try {
      return { success: true, contents: await openBackup(payload, password) };
    } catch (error) {
      return failure(error);
    }
  });

  registry.handle('backup:save-file', 'main', async (_event, contents, suggestedName) => {
    if (typeof contents !== 'string' || !contents) {
      return { success: false, error: 'Conteúdo de backup inválido.' };
    }
    try {
      const safeName = sanitizeFileName(suggestedName || 'monky-backup.monkybackup');
      const result = await dialog.showSaveDialog(window, {
        title: mt('dialog.saveBackup'),
        defaultPath: path.join(app.getPath('documents'), safeName),
        filters: [{ name: 'Monky', extensions: ['monkybackup', 'json'] }],
      });
      if (result.canceled || !result.filePath) return { success: false };
      await writeFile(result.filePath, contents, 'utf8');
      return { success: true, filePath: result.filePath };
    } catch (error) {
      return failure(error);
    }
  });

  registry.handle('backup:open-file', 'main', async () => {
    try {
      const result = await dialog.showOpenDialog(window, {
        title: mt('dialog.openBackup'),
        filters: [{ name: 'Monky', extensions: ['monkybackup', 'json'] }],
        properties: ['openFile'],
      });
      if (result.canceled || result.filePaths.length === 0) return { success: false };
      return { success: true, contents: await readFile(result.filePaths[0], 'utf8') };
    } catch (error) {
      return failure(error);
    }
  });
}
