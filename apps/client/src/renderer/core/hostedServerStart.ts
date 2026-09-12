import { connectionStore, type CreatedServer } from '../stores/connectionStore';
import { t } from '../i18n';

let pendingStart: { id: string; port: number; promise: Promise<void> } | null = null;

export function findOwnedServer(host: string, port: number): CreatedServer | undefined {
  const localHost = host.trim().replace(/^wss?:\/\//i, '').replace(/^\[(.+)\]$/, '$1').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(localHost)) return undefined;
  return connectionStore.createdServers.find(server => server.port === port);
}

/**
 * Starting for browsing never replaces another hosted instance. The same rule
 * applies to Home and the rail, independently of where the current call lives.
 */
export async function ensureHostedServerStarted(server: CreatedServer): Promise<void> {
  if (pendingStart) {
    if (pendingStart.id === server.id && pendingStart.port === server.port) return pendingStart.promise;
    throw new Error(t('navigation.hostStartBusy'));
  }

  const target = { ...server };
  const promise = (async () => {
    if (!window.api?.hostServerStatus || !window.api?.hostServerStart) {
      throw new Error(t('navigation.hostingUnavailable'));
    }
    const api = window.api;
    const status = await api.hostServerStatus().catch((error: unknown) => {
      throw new Error(t('main.serverStartFailedMessage'), { cause: error });
    });
    if (status.isRunning && (status.port !== target.port || status.serverId !== target.id)) {
      throw new Error(t('navigation.otherHostedServerRunning'));
    }

    // A matching status is not proof of readiness: a stop may already be queued.
    const result = await api.hostServerStart({
      port: target.port,
      serverName: target.name,
      password: target.password,
      initialTextChannel: target.textChannel,
      initialVoiceChannel: target.voiceChannel,
      serverId: target.id,
      maxUsers: target.maxUsers,
      voiceMode: target.voiceMode,
    }).catch((error: unknown) => {
      throw new Error(t('main.serverStartFailedMessage'), { cause: error });
    });
    if (!result.success) {
      throw new Error(result.error
        ? `${t('main.serverStartFailedMessage')}\n${result.error}`
        : t('main.serverStartFailedMessage'));
    }
    connectionStore.saveCreatedServer({ ...target, lastStarted: Date.now() });
  })();

  const operation = { id: target.id, port: target.port, promise };
  pendingStart = operation;
  try {
    await promise;
  } finally {
    if (pendingStart === operation) pendingStart = null;
  }
}
