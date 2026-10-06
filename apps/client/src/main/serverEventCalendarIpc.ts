import { app, dialog, ipcMain, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EVENT_CALENDAR_IPC, eventCalendarExportSchema, type EventCalendarSaveResult } from '@monky/shared';
import { createEventCalendar } from './serverEventCalendar';
import { mt } from './i18n';

export function setupEventCalendarIpc(mainWindow: BrowserWindow, sanitizeFileName: (name: string) => string): () => void {
  let saving = false, disposed = false;
  ipcMain.handle(EVENT_CALENDAR_IPC, async (event, input: unknown): Promise<EventCalendarSaveResult> => {
    if (disposed || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame || saving) {
      console.warn('[Community] Rejected calendar export from an unavailable sender or while saving.');
      return { status: 'failed', error: mt('calendar.failed') };
    }
    saving = true;
    try {
      const payload = eventCalendarExportSchema.parse(input);
      const contents = createEventCalendar(payload);
      const result = await dialog.showSaveDialog(mainWindow, {
        title: mt('calendar.save'),
        defaultPath: path.join(app.getPath('documents'), sanitizeFileName(`${payload.event.title}.ics`)),
        filters: [{ name: mt('calendar.filter'), extensions: ['ics'] }],
      });
      if (result.canceled || !result.filePath || disposed || mainWindow.isDestroyed()) return { status: 'cancelled' };
      await writeFile(result.filePath, contents, 'utf8');
      return { status: 'saved' };
    } catch (error) {
      console.warn('[Community] Calendar export failed.', error);
      return { status: 'failed', error: mt('calendar.failed') };
    } finally { saving = false; }
  });
  return () => { disposed = true; ipcMain.removeHandler(EVENT_CALENDAR_IPC); };
}
