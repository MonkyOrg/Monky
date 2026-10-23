import { connectionStore, type CreatedServer } from '../stores/connectionStore';
import { t, getLanguage } from '../i18n';

/** Starts in flight, per server: a second click joins the same start. */
const pendingStarts = new Map<string, Promise<void>>();

export function findOwnedServer(host: string, port: number): CreatedServer | undefined {
  const localHost = host.trim().replace(/^wss?:\/\//i, '').replace(/^\[(.+)\]$/, '$1').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(localHost)) return undefined;
  return connectionStore.createdServers.find(server => server.port === port);
}

/**
 * Several of the user's servers may run side by side, each on its own port.
 * Starting never replaces another hosted instance: a port held by a different
 * server, or this server already running elsewhere, is reported instead.
 */
export function ensureHostedServerStarted(server: CreatedServer): Promise<void> {
  const pending = pendingStarts.get(server.id);
  if (pending) return pending;

  const target = { ...server };
  const promise = (async () => {
    if (!window.api?.hostServerStatus || !window.api?.hostServerStart) {
      throw new Error(t('navigation.hostingUnavailable'));
    }
    const api = window.api;
    const status = await api.hostServerStatus().catch((error: unknown) => {
      throw new Error(t('main.serverStartFailedMessage'), { cause: error });
    });
    const onPort = status.servers.find(item => item.port === target.port);
    if (onPort && onPort.serverId !== target.id) {
      throw new Error(t('navigation.hostedPortInUse', { port: String(target.port) }));
    }
    const elsewhere = status.servers.find(item => item.serverId === target.id && item.port !== target.port);
    if (elsewhere) throw new Error(t('navigation.hostedServerElsewhere', { port: String(elsewhere.port) }));

    // A matching status is not proof of readiness: a stop may already be queued.
    const result = await api.hostServerStart({
      port: target.port,
      serverName: target.name,
      password: target.password,
      initialTextChannel: target.textChannel,
      categoryLocale: getLanguage(),
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

  pendingStarts.set(target.id, promise);
  void promise.then(
    () => { if (pendingStarts.get(target.id) === promise) pendingStarts.delete(target.id); },
    () => { if (pendingStarts.get(target.id) === promise) pendingStarts.delete(target.id); },
  );
  return promise;
}