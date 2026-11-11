import { ipcMain, type BrowserWindow } from 'electron';
import {
  MINIAPP_BROWSER_CLOSED, MINIAPP_BROWSER_IPC,
  miniappBrowserControlSchema, miniappBrowserOpenSchema, miniappBrowserOwnerCommandSchema,
} from '@monky/shared';
import { IpcRegistry, windowContents } from './registry';
import { MiniappBrowserWindows } from '../miniappBrowserWindows';

export function registerMiniappBrowserIpc(owner: BrowserWindow): MiniappBrowserWindows {
  const browsers = new MiniappBrowserWindows(owner, requestId => registry.send('main', MINIAPP_BROWSER_CLOSED, requestId));
  const registry = new IpcRegistry(ipcMain, {
    main: () => windowContents(owner), browser: () => browsers.controls(),
  });
  registry.handle(MINIAPP_BROWSER_IPC.open, 'main', (_event, input) => browsers.open(miniappBrowserOpenSchema.parse(input)));
  registry.handle(MINIAPP_BROWSER_IPC.owner, 'main', (_event, input) => {
    const command = miniappBrowserOwnerCommandSchema.parse(input);
    if (command.action === 'close') browsers.close(command.requestId);
    else if (command.action === 'visibility') browsers.visibility(command.requestId, command.visible);
    else if (command.action === 'locale') browsers.locale(command.requestId, command.locale);
    else if (command.action === 'placement') browsers.placement(command.requestId, command.bounds, command.clip, command.visible);
    else if (command.action === 'appearance') browsers.appearance(command.requestId, command.appearance);
    else if (command.action === 'broadcasting') browsers.broadcasting(command.requestId, command.active);
    else browsers.volume(command.requestId, command.volume);
  });
  registry.handle(MINIAPP_BROWSER_IPC.capture, 'main', (_event, requestId) =>
    browsers.captureSourceId(miniappBrowserOpenSchema.shape.requestId.parse(requestId)));
  registry.handle(MINIAPP_BROWSER_IPC.control, 'browser', (event, input) =>
    browsers.control(event.sender, miniappBrowserControlSchema.parse(input)));
  owner.webContents.once('render-process-gone', () => { void browsers.dispose().catch(error => console.error('[Miniapp browser] Owner cleanup failed.', error)); });
  owner.webContents.on('did-start-navigation', (_event, _url, _inPlace, mainFrame) => {
    if (mainFrame) void browsers.closeAll().catch(error => console.error('[Miniapp browser] Navigation cleanup failed.', error));
  });
  owner.once('closed', () => {
    registry.dispose();
    void browsers.dispose().catch(error => console.error('[Miniapp browser] Shutdown cleanup failed.', error));
  });
  return browsers;
}
