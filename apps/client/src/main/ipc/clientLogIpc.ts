import type { ClientLogger } from '../clientLogger';
import type { IpcRegistry } from './registry';

/** The client log (#444): what the renderer writes to it, its settings, export and clearing. */
export function registerClientLogIpc(registry: IpcRegistry, logger: ClientLogger): void {
  registry.handle('client-log:write', 'main', (_event, entry) => {
    logger.write(entry);
  });
  registry.handle('client-log:get-config', 'main', () => logger.getConfig());
  registry.handle('client-log:set-config', 'main', (_event, config) => {
    logger.setConfig(config);
  });
  registry.handle('client-log:export', 'main', () => logger.exportLogs());
  registry.handle('client-log:get-size', 'main', () => logger.getTotalSize());
  registry.handle('client-log:clear', 'main', () => {
    logger.clearLogs();
  });
}
