import { app, dialog, type BrowserWindow } from 'electron';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EVENT_CALENDAR_IPC, eventCalendarExportSchema, type EventCalendarSaveResult } from '@monky/shared';
import { createEventCalendar } from './serverEventCalendar';
import { mt } from './i18n';
import type { IpcRegistry } from './ipc/registry';

export function registerEventCalendarIpc(registry: IpcRegistry, mainWindow: BrowserWindow,
  sanitizeFileName: (name: string) => string): void {
  let saving = false, disposed = false;
  registry.onDispose(() => { disposed = true; });
  const refused: EventCalendarSaveResult = { status: 'failed', error: mt('calendar.failed') };
  registry.handle(EVENT_CALENDAR_IPC, { from: 'main', refused }, async (_event, input): Promise<EventCalendarSaveResult> => {
    if (disposed || mainWindow.isDestroyed() || saving) {
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
}
