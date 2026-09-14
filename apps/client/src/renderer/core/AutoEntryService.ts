import { LIMITS, MessageType } from '@monky/shared';
import { connectionStore, type SavedServer } from '../stores/connectionStore';
import { settingsStore } from '../stores/settingsStore';
import { autoEntryServerKey } from '../utils/autoEntry';
import { t } from '../i18n';
import { appEvents } from './EventBus';
import { clientLog } from './ClientLogService';
import { sessionKeyFor, sessionManager, type ServerSession } from './SessionManager';
import { currentEventOrigin } from './sessionRouting';
import { getServerSessionForAddress, openServerSession } from './serverConnection';

export class AutoEntryService {
  private running: Promise<void> | null = null;
  private cancelled = false;
  private pendingServer: SavedServer | null = null;
  private pendingSession: ServerSession | null = null;
  private pendingKey: string | null = null;
  private pendingCancelled = false;
  private readonly unbind: Array<() => void> = [];

  constructor(
    private readonly reportNotice: (message: string) => void,
    private readonly connectionTimeoutMs = 30_000,
  ) {}

  public start(): Promise<void> {
    // Returning Home, importing settings or toggling a switch is not another
    // launch. In particular, logging out must never reconnect these servers.
    this.running ??= Promise.resolve().then(() => this.run()).catch((error: unknown) => {
      clientLog.warn('CONNECTION', 'Automatic server entry could not finish', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return this.running;
  }

  private async run(): Promise<void> {
    try {
      settingsStore.retainAutoEntryServers(connectionStore.savedServers);
    } catch (error: unknown) {
      clientLog.warn('STORE', 'Could not clean automatic-entry preferences at startup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const candidates = connectionStore.savedServers.filter(server => settingsStore.isServerAutoEntryEnabled(server));
    if (!candidates.length || this.cancelled) return;
    const identity = { clientId: connectionStore.clientId, publicKey: connectionStore.publicKey };
    const nickname = connectionStore.savedNickname.trim();
    const ready = () => connectionStore.hasIdentity && !!identity.clientId && !!identity.publicKey
      && connectionStore.clientId === identity.clientId && connectionStore.publicKey === identity.publicKey
      && settingsStore.onboardingCompleted === true
      && connectionStore.savedNickname.trim() === nickname
      && nickname.length >= LIMITS.MIN_NICKNAME_LENGTH && nickname.length <= LIMITS.MAX_NICKNAME_LENGTH;
    if (!ready()) {
      this.reportNotice(t('autoEntry.prerequisites'));
      return;
    }

    const stillSaved = (server: SavedServer) => connectionStore.savedServers
      .find(item => autoEntryServerKey(item) === autoEntryServerKey(server));
    const checkPending = () => {
      if (this.pendingServer && (!ready() || !stillSaved(this.pendingServer)
        || !settingsStore.isServerAutoEntryEnabled(this.pendingServer))) this.cancelPending();
    };
    this.unbind.push(
      appEvents.on('settings.updated', checkPending),
      appEvents.on('connection.saved_servers_changed', checkPending),
      appEvents.on('network.disconnected', () => {
        // The pending handshake reports its own cancellation through the shared
        // connection path. Leaving another session cancels the startup queue.
        if (currentEventOrigin() !== this.pendingKey) this.dispose();
      }),
    );
    const attempted = new Set<string>();
    try {
      for (const candidate of candidates) {
        if (this.cancelled || !ready()) break;
        const server = stillSaved(candidate);
        const key = server && autoEntryServerKey(server);
        if (!server || !key || attempted.has(key) || !settingsStore.isServerAutoEntryEnabled(server)) continue;
        attempted.add(key);
        if (!server.serverId) {
          this.reportNotice(t('autoEntry.verifyServer', { name: server.name || server.host }));
          continue;
        }
        // The normal auth handler refreshes saved metadata before this await
        // resumes, so retain the identity explicitly chosen before connecting.
        const expectedServerId = server.serverId;
        // Existing connections and reconnects belong to their original owner.
        if (getServerSessionForAddress(server.host, server.port)) continue;
        if (this.hasOtherSessionForServer(expectedServerId)) continue;
        this.pendingServer = server;
        this.pendingKey = sessionKeyFor(server.host, server.port);
        this.pendingCancelled = false;
        try {
          const connecting = openServerSession(server.host, server.port, identity, nickname, server.password, {
            background: sessionManager.getActive() !== null,
            timeoutMs: this.connectionTimeoutMs,
          });
          this.pendingSession = getServerSessionForAddress(server.host, server.port) ?? null;
          const result = await connecting;
          const session = this.pendingSession;
          // A manual alias can start while auth is pending. Keep its connection,
          // rather than leaving two same-device clients replacing each other.
          if (session && sessionManager.get(session.key) === session
            && result.server.id === expectedServerId && this.hasOtherSessionForServer(expectedServerId, session)) {
            sessionManager.remove(session.key);
            continue;
          }
          if (this.cancelled || !ready() || !session || sessionManager.get(session.key) !== session
            || session.client.getStatus() !== 'CONNECTED' || !stillSaved(server)) continue;
          if (result.server.id !== expectedServerId) {
            try {
              connectionStore.invalidateSavedServerIdentity(server.host, server.port);
            } finally {
              sessionManager.remove(session.key);
            }
            this.reportNotice(t('autoEntry.serverChanged', { name: server.name || server.host }));
            continue;
          }
          connectionStore.addSavedServer({ ...server, name: result.server.name, serverId: result.server.id, lastConnected: Date.now() });
          const avatar = connectionStore.savedAvatarBase64;
          if (avatar) {
            // Capture the session: resolving a global proxy after awaiting a
            // different server would send this avatar to the foreground server.
            void session.client.sendRequest(MessageType.USER_UPDATE_AVATAR, {
              avatarBase64: avatar, mimeType: 'image/png',
            }).catch((error: unknown) => {
              clientLog.warn('CONNECTION', 'Could not update the automatic-entry avatar', {
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
        } catch (error: unknown) {
          if (error instanceof DOMException && error.name === 'AbortError') {
            if (!this.pendingCancelled) this.cancelled = true;
          } else if (!this.cancelled && stillSaved(server) && settingsStore.isServerAutoEntryEnabled(server)) {
            clientLog.warn('CONNECTION', `Automatic entry failed for ${server.host}:${server.port}`, {
              error: error instanceof Error ? error.message : String(error),
            });
            this.reportNotice(t('autoEntry.failed', { name: server.name || server.host }));
          }
        } finally {
          this.pendingServer = null;
          this.pendingSession = null;
          this.pendingKey = null;
        }
      }
    } finally {
      for (const off of this.unbind.splice(0)) off();
    }
  }

  private hasOtherSessionForServer(serverId: string, excluded?: ServerSession): boolean {
    return sessionManager.getAll().some(session => {
      if (session === excluded) return false;
      const knownId = session.serverStore.serverDetails?.id ?? connectionStore.savedServers
        .find(item => autoEntryServerKey(item) === autoEntryServerKey(session))?.serverId;
      return knownId === serverId;
    });
  }

  private cancelPending(): void {
    this.pendingCancelled = true;
    const session = this.pendingSession;
    if (session && sessionManager.get(session.key) === session && session.client.getStatus() === 'CONNECTING') {
      sessionManager.remove(session.key);
    }
  }

  public dispose(): void {
    this.cancelled = true;
    this.cancelPending();
    for (const off of this.unbind.splice(0)) off();
  }
}
