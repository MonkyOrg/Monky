import type { BrowserWindow } from 'electron';
import path from 'node:path';
import { errorDiagnostic } from '@monky/bot-sdk/dist/localRuntime';
import { LocalTools } from './LocalTools';
import { LocalPermissions } from './LocalPermissions';
import { LocalExecutionDialogs } from './dialogs';
import { LocalExecutionService } from './service';
import type { LocalExecutionNotifications } from './ipc';
import { createLocalRuntimeTask, probeLocalTool } from './workerClient';

export function createLocalExecutionService(
  window: BrowserWindow, userData: string, notifications: LocalExecutionNotifications, onTools?: (tools: LocalTools) => void,
): LocalExecutionService {
  const root = path.join(userData, 'local-execution');
  const logError = (message: string, error: unknown): void => {
    console.warn(`[LocalExecution] ${message}: ${errorDiagnostic(error)}`);
  };
  let dialogs: LocalExecutionDialogs | undefined;
  const tools: LocalTools = new LocalTools({
    root,
    onChanged: () => { notifications.changed(); dialogs?.toolsChanged(); },
    probe: (tool, paths, signal) => probeLocalTool(tool, paths, signal, tools, logError),
  });
  onTools?.(tools);
  dialogs = new LocalExecutionDialogs(window, tools);
  const permissions = new LocalPermissions(path.join(root, 'permissions.json'), notifications.changed);
  return new LocalExecutionService({
    owner: window.webContents.id,
    tools,
    permissions,
    dialogs,
    createRuntime: (input) => createLocalRuntimeTask(input, tools, logError),
    changed: notifications.changed,
    failed: notifications.failed,
    logError,
  });
}
