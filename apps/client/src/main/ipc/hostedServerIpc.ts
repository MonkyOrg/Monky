import { LanDiscovery } from '../lanDiscovery';
import type { ServerManager } from '../serverManager';
import { isPort } from './guards';
import type { IpcRegistry } from './registry';

/** Servers this app hosts, and the ones announced on the local network. */
export function registerHostedServerIpc(registry: IpcRegistry, serverManager: ServerManager): void {
  registry.handle('server-host:start', 'main', async (_event, options) => serverManager.startServer(options));
  registry.handle('server-host:stop', 'main', async (_event, port) => {
    if (!isPort(port)) return { success: false };
    await serverManager.stopServer(port);
    return { success: true };
  });
  registry.handle('server-host:status', 'main', async () => serverManager.getStatus());
  registry.handle('server-host:logs', 'main', async (_event, port) => isPort(port) ? serverManager.getLogs(port) : []);
  registry.handle('server-host:clear-logs', 'main', async (_event, port) => {
    if (isPort(port)) serverManager.clearLogs(port);
  });
  registry.handle('server-host:stats', 'main', async (_event, port) => isPort(port) ? serverManager.getStats(port) : null);
  // Removing a server from "Meus Servidores" has to take its data with it (#364).
  registry.handle('server-host:delete-data', 'main', async (_event, serverId) => {
    if (typeof serverId !== 'string') return { success: false };
    return serverManager.deleteServerData(serverId);
  });

  const lanDiscovery = new LanDiscovery((event, server) => registry.send('main', event, server));
  registry.handle('lan:start', 'main', async () => {
    await lanDiscovery.start();
  });
  registry.handle('lan:stop', 'main', async () => {
    await lanDiscovery.stop();
  });
  registry.onDispose(() => { void lanDiscovery.stop(); });
}
