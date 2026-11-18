import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import {
  AUTOMATION_CANCEL, AUTOMATION_CHANGED, AUTOMATION_IPC, AUTOMATION_REQUEST, AUTOMATION_TOOLS,
  automationErrorSchema, type AutomationCommand, type AutomationResult,
} from '@monky/shared';
import { AutomationService, type AutomationExecutor } from '../automation/AutomationService';
import { AutomationStore } from '../automation/AutomationStore';
import { isRecord } from './guards';
import type { IpcRegistry } from './registry';

export function registerAutomationIpc(registry: IpcRegistry, window: BrowserWindow, profile: string): AutomationService {
  const contents = window.webContents;
  let ready = false;
  const pending = new Map<string, { command: AutomationCommand; finish: (result: AutomationResult) => void }>();
  const execute: AutomationExecutor = (command, grant, signal) => {
    if (!ready || signal.aborted) return Promise.resolve({ ok: false, code: 'not_ready' });
    return new Promise<AutomationResult>(resolve => {
      const requestId = randomUUID();
      const finish = (result: AutomationResult): void => {
        if (!pending.delete(requestId)) return;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        registry.send('main', AUTOMATION_CANCEL, requestId);
        resolve(result);
      };
      const cancel = (): void => finish({ ok: false, code: 'cancelled' });
      const timer = setTimeout(() => finish({ ok: false,
        code: AUTOMATION_TOOLS[command.tool].capability === 'read' ? 'disconnected' : 'unknown_outcome',
      }), 30_000);
      pending.set(requestId, { command, finish });
      signal.addEventListener('abort', cancel, { once: true });
      if (!registry.send('main', AUTOMATION_REQUEST, { requestId, command, grant })) finish({ ok: false, code: 'not_ready' });
    });
  };
  const service = new AutomationService(new AutomationStore(profile), execute,
    snapshot => registry.send('main', AUTOMATION_CHANGED, snapshot));
  registry.handle(AUTOMATION_IPC.snapshot, 'main', () => service.snapshot());
  registry.handle(AUTOMATION_IPC.mutate, 'main', (_event, input) => service.mutate(input));
  registry.handle(AUTOMATION_IPC.ready, 'main', () => { ready = true; });
  registry.handle(AUTOMATION_IPC.reply, 'main', (_event, value) => {
    if (!isRecord(value) || typeof value.requestId !== 'string' || !isRecord(value.result)) return;
    const request = pending.get(value.requestId);
    if (!request) return;
    if (value.result.ok === false) {
      const code = automationErrorSchema.safeParse(value.result.code);
      request.finish({ ok: false, code: code.success ? code.data : 'failed' });
    } else if (value.result.ok === true) {
      const data = AUTOMATION_TOOLS[request.command.tool].output.safeParse(value.result.data);
      request.finish(data.success ? { ok: true, data: data.data } : { ok: false, code: 'failed' });
    }
  });
  const offline = (): void => {
    ready = false;
    for (const request of [...pending.values()]) request.finish({ ok: false,
      code: AUTOMATION_TOOLS[request.command.tool].capability === 'read' ? 'cancelled' : 'unknown_outcome' });
  };
  const navigating = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame && !inPlace) offline();
  };
  contents.on('did-start-navigation', navigating);
  contents.on('render-process-gone', offline);
  registry.onDispose(() => {
    offline();
    void service.close();
    contents.removeListener('did-start-navigation', navigating);
    contents.removeListener('render-process-gone', offline);
  });
  void service.start();
  return service;
}
