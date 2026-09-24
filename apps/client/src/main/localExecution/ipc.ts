import { BrowserWindow, ipcMain } from 'electron';
import {
  LOCAL_EXECUTION_CHANGED, LOCAL_EXECUTION_IPC, LOCAL_EXECUTION_TASK_FAILED,
  type LocalExecutionFailedResult, type LocalExecutionSnapshot, type LocalTaskFailureEvent,
} from '@monky/shared';
import { mt } from '../i18n';
import { localFailureDetails } from './errors';
import { LocalExecutionService } from './service';

export interface LocalExecutionNotifications {
  changed: () => void;
  failed: (failure: LocalTaskFailureEvent) => void;
}

export interface LocalExecutionIpc {
  service: LocalExecutionService;
  freezeAdmissions: () => void;
  dispose: () => Promise<void>;
}

export function setupLocalExecutionIpc(
  window: BrowserWindow,
  create: (notifications: LocalExecutionNotifications) => LocalExecutionService,
): LocalExecutionIpc {
  const contents = window.webContents;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let publishing = false;
  let dirty = false;
  let closed = false;
  let disposal: Promise<void> | null = null;
  let admissionsFrozen = false;
  const usable = (): boolean => !closed && !window.isDestroyed() && !contents.isDestroyed();
  const owns = (event: Electron.IpcMainInvokeEvent): boolean =>
    usable() && event.sender === contents && event.senderFrame === contents.mainFrame;

  const schedule = (): void => {
    dirty = true;
    if (!usable() || publishing || timer) return;
    timer = setTimeout(() => {
      timer = null;
      void publish();
    }, 100);
  };
  const publish = async (): Promise<void> => {
    if (!usable()) return;
    publishing = true;
    dirty = false;
    try {
      const snapshot = await service.snapshot();
      if (usable()) contents.send(LOCAL_EXECUTION_CHANGED, snapshot);
    } catch (error) {
      console.warn('[LocalExecution] Could not publish local state:', error);
    } finally {
      publishing = false;
      if (dirty) schedule();
    }
  };

  const service = create({
    changed: schedule,
    failed: (failure) => {
      if (usable()) contents.send(LOCAL_EXECUTION_TASK_FAILED, failure);
    },
  });

  async function invoke<T>(event: Electron.IpcMainInvokeEvent, action: () => Promise<T>, admission = false): Promise<T | LocalExecutionFailedResult> {
    if (!owns(event)) {
      console.warn('[LocalExecution] Rejected IPC from a non-owner frame.');
      return { status: 'failed', reason: 'invalid_request' };
    }
    if (admission && admissionsFrozen) {
      console.warn('[LocalExecution] Rejected new work during application shutdown.');
      return { status: 'failed', reason: 'executor_unavailable' };
    }
    try {
      return await action();
    } catch (error) {
      console.warn('[LocalExecution] IPC operation failed:', error);
      return { status: 'failed', ...localFailureDetails(error, 'worker_failed') };
    }
  }

  ipcMain.handle(LOCAL_EXECUTION_IPC.getState, async (event): Promise<LocalExecutionSnapshot> => {
    if (!owns(event)) {
      console.warn('[LocalExecution] Rejected state request from a non-owner frame.');
      throw new Error(mt('localExecution.invalidOwner'));
    }
    try {
      return await service.snapshot();
    } catch (error) {
      console.warn('[LocalExecution] Could not read local state:', error);
      throw new Error(mt('localExecution.stateFailed'));
    }
  });
  ipcMain.handle(LOCAL_EXECUTION_IPC.setPermission, (event, input: unknown) =>
    invoke(event, () => service.setPermission(input), true));
  ipcMain.handle(LOCAL_EXECUTION_IPC.removeTool, (event, input: unknown) =>
    invoke(event, () => service.removeTool(input), true));
  ipcMain.handle(LOCAL_EXECUTION_IPC.clearCache, (event) => invoke(event, () => service.clearCache(), true));
  ipcMain.handle(LOCAL_EXECUTION_IPC.cancelTask, (event, taskId: unknown) =>
    invoke(event, () => service.cancelTask(taskId)));
  ipcMain.handle(LOCAL_EXECUTION_IPC.prepare, (event, input: unknown) =>
    invoke(event, () => service.prepare(input), true));
  ipcMain.handle(LOCAL_EXECUTION_IPC.startTask, (event, input: unknown) =>
    invoke(event, () => service.startTask(input), true));
  ipcMain.handle(LOCAL_EXECUTION_IPC.readFrames, (event, input: unknown) =>
    invoke(event, () => service.readFrames(input)));
  ipcMain.handle(LOCAL_EXECUTION_IPC.acknowledgeFrames, (event, input: unknown) =>
    invoke(event, () => service.acknowledgeFrames(input)));
  ipcMain.handle(LOCAL_EXECUTION_IPC.cancelRequest, (event, input: unknown) =>
    invoke(event, () => service.cancelRequest(input)));
  ipcMain.handle(LOCAL_EXECUTION_IPC.setPaused, (event, input: unknown) =>
    invoke(event, () => service.setPaused(input)));
  ipcMain.handle(LOCAL_EXECUTION_IPC.setConnection, (event, input: unknown) =>
    invoke(event, () => service.setConnection(input)));

  const cancelOwner = (): void => {
    void service.cancelOwner().catch((error: unknown) => {
      console.warn('[LocalExecution] Could not finish owner cancellation:', error);
    });
  };
  const navigation = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame && !inPlace) cancelOwner();
  };
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    if (!closed) {
      closed = true;
      if (timer) clearTimeout(timer);
      timer = null;
      for (const channel of Object.values(LOCAL_EXECUTION_IPC)) ipcMain.removeHandler(channel);
      contents.removeListener('did-start-navigation', navigation);
      contents.removeListener('render-process-gone', cancelOwner);
      contents.removeListener('destroyed', onDestroyed);
    }
    const stopping = service.dispose();
    disposal = stopping;
    stopping.catch(() => {
      if (disposal === stopping) disposal = null;
    });
    return stopping;
  };
  const onDestroyed = (): void => {
    void dispose().catch((error: unknown) => {
      console.warn('[LocalExecution] Could not shut down local execution:', error);
    });
  };
  contents.on('did-start-navigation', navigation);
  contents.on('render-process-gone', cancelOwner);
  contents.once('destroyed', onDestroyed);
  return { service, freezeAdmissions: () => { admissionsFrozen = true; }, dispose };
}
