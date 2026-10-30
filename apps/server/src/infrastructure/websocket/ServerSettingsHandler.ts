import type http from 'http';
import type { WebSocket } from 'ws';
import {
  LIMITS, MessageType, Permission, ProtocolErrorCode, channelNameSchema, isAfkTimeoutSeconds, serverUpdateSettingsSchema,
  type ServerMessage, type ServerSettingsUpdatedPayload, type ServerUpdateSettingsPayload, type VoiceModeTransition,
} from '@monky/shared';
import type { AuthService } from '../../application/services/AuthService';
import type { BotLocalExecutionService } from '../../application/services/BotLocalExecutionService';
import type { ChannelService } from '../../application/services/ChannelService';
import type { CommunityService } from '../../application/services/CommunityService';
import type { RecentSoundCacheService } from '../../application/services/RecentSoundCacheService';
import { auditRef } from '../../application/services/ServerAuditService';
import { channelChanges, serverSettingsChanges } from '../../application/services/serverAuditChanges';
import type { IServerRepository } from '../../domain/repositories';
import { scanServerNetworkInterfaces } from '../discovery/ServerIpScanner';
import { Logger } from '../logger/Logger';
import { describeSfuPortProblem, type SfuManager } from '../sfu/SfuManager';
import { checkSfuPreflight, formatSfuPreflightForLog } from '../sfu/SfuPreflight';
import { CoturnManager } from '../turn/CoturnManager';
import type { AccessEpoch } from './access/AccessEpoch';
import type { Authorizer } from './access/Authorizer';
import type { ChannelVisibility } from './access/ChannelVisibility';
import type { AuditRecorder } from './AuditRecorder';
import type { BotInteractionSession } from './BotInteractionHandler';
import type { ChannelHandler } from './ChannelHandler';
import type { ClientSession } from './ClientSession';
import { featureUnavailableCode, route, type Route } from './routing/MessageRouter';
import type { VoiceSessionHandler } from './voice/VoiceSessionHandler';

export interface ServerSettingsHost {
  readonly httpServer: http.Server;
  readonly serverRepo: IServerRepository;
  readonly auth: AuthService;
  readonly coturn: CoturnManager;
  readonly sfu: SfuManager;
  readonly recentSoundCache?: RecentSoundCacheService;
  readonly channels: ChannelService;
  readonly communityService?: CommunityService;
  readonly channelAdmin: Pick<ChannelHandler, 'releaseDeleted' | 'publishUpdate'>;
  readonly visibility: Pick<ChannelVisibility, 'reconcile'>;
  readonly voiceSessions: Pick<VoiceSessionHandler, 'voiceModeChanged'>;
  readonly botLocalExecution: Pick<BotLocalExecutionService<BotInteractionSession>, 'voiceModeChanged'>;
  readonly epoch: AccessEpoch;
  readonly authorizer: Pick<Authorizer, 'requirePermission'>;
  readonly auditLog: AuditRecorder;
  isCurrentSession(session: ClientSession): boolean;
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  broadcast(message: ServerMessage, ignoreWs?: WebSocket): void;
}

/**
 * The server's own settings: name, password, limits, the voice mode with the
 * SFU and the TURN relay it may need installed, the AFK room and the cache of
 * recent sounds. Also the addresses an invitation to it can use.
 */
export class ServerSettingsHandler {
  /** Saves run one after another, whoever sends them. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly host: ServerSettingsHost) {}

  routes(): Route[] {
    return [
      // MANAGE_SERVER is checked again after the waits of a save (#384, #431).
      route({
        types: [MessageType.SERVER_UPDATE_SETTINGS], permission: Permission.MANAGE_SERVER,
        schema: { type: serverUpdateSettingsSchema, message: 'Configurações do servidor inválidas.' },
        handle: ({ session, payload, requestId }) => this.update(session, payload, requestId),
      }),
      route({ types: [MessageType.SERVER_GET_INVITE_INFO], handle: ({ session, requestId }) => this.inviteInfo(session, requestId) }),
    ];
  }

  /** Resolves once every save queued so far is over. */
  settled(): Promise<void> {
    return this.queue;
  }

  /**
   * Saves the server settings. Saves from several admins wait for each other:
   * each has its own socket queue, and a duplicate save could otherwise see the
   * old voice mode and evict the new call twice.
   */
  async update(
    session: ClientSession,
    payload: ServerUpdateSettingsPayload,
    requestId?: string
  ): Promise<void> {
    if (payload.messageDeleteUndoSeconds !== undefined && !session.protocol?.features.includes('message-delete-undo')) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Atualize o cliente e o servidor para configurar o prazo de exclusão.', requestId);
      return;
    }
    if (payload.maxMessageLength !== undefined && !session.protocol?.features.includes('message-length-setting')) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Atualize o cliente e o servidor para configurar o limite de mensagens.', requestId);
      return;
    }
    if ((payload.recentSoundCacheEnabled !== undefined || payload.recentSoundCacheLimit !== undefined)
      && !session.protocol?.features.includes('recent-sounds')) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Atualize o cliente e o servidor para configurar o cache de áudios.', requestId);
      return;
    }
    if (payload.dmRelayEnabled !== undefined && !session.protocol?.features.includes('dm-relay')) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Atualize o cliente e o servidor para configurar mensagens diretas.', requestId);
      return;
    }
    const changesAfk = payload.afkChannelEnabled !== undefined || payload.afkChannelName !== undefined
      || payload.afkTimeoutSeconds !== undefined;
    if (changesAfk && !session.protocol?.features.includes('afk-channel')) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'Atualize o cliente e o servidor para configurar o canal AFK.', requestId);
      return;
    }
    // Checked before anything is applied, so a bad field never leaves the AFK room half configured.
    if ((payload.afkChannelEnabled !== undefined && typeof payload.afkChannelEnabled !== 'boolean')
      || (payload.afkTimeoutSeconds !== undefined && !isAfkTimeoutSeconds(payload.afkTimeoutSeconds))) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Configuração do canal AFK inválida.', requestId);
      return;
    }
    if (payload.afkChannelName !== undefined) {
      const name = channelNameSchema.safeParse(payload.afkChannelName);
      if (!name.success) {
        this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST,
          name.error.errors[0]?.message ?? 'Nome do canal AFK inválido.', requestId);
        return;
      }
    }
    if ((payload.recentSoundCacheEnabled !== undefined || payload.recentSoundCacheLimit !== undefined)
      && !this.host.recentSoundCache) {
      this.host.sendError(session.ws, featureUnavailableCode(session, ProtocolErrorCode.INTERNAL_ERROR),
        'O cache de áudios não está disponível neste servidor.', requestId);
      return;
    }
    const update = this.queue.then(() => this.apply(session, payload, requestId));
    this.queue = update.catch(() => {});
    await update;
  }

  /**
   * Brings the relay in line with the freshly saved setting (#425).
   *
   * Members already in a call keep the ICE servers they were given at login, so
   * switching the relay on only helps the calls started afterwards — which is
   * why the UI tells the operator to reconnect.
   */
  private async applyTurnState(enabled: boolean): Promise<void> {
    try {
      if (!enabled) {
        await this.host.coturn.stop();
        return;
      }
      const server = await this.host.serverRepo.getServer();
      if (!server?.turnSecret) {
        throw new Error('O relay TURN não pôde iniciar: a chave compartilhada não está disponível.');
      }
      const started = await this.host.coturn.start(server.turnSecret);
      if (!started || !this.host.coturn.isRunning()) {
        throw new Error('O coturn não iniciou ou encerrou antes de ficar pronto. Verifique o log do servidor.');
      }

      // Verify the relay is actually reachable. A VPS whose firewall blocks
      // port 3478 will silently swallow TURN allocations, and the only sign is
      // that members behind CGNAT never connect — exactly the bug #425
      // reported. Checking right after start catches the most common
      // misconfiguration before anyone tries to call.
      const portProblem = await CoturnManager.checkPortReachability();
      if (portProblem) {
        throw new Error(portProblem);
      }
    } catch (error) {
      Logger.error('NETWORK', 'Failed to apply the TURN relay state', error);
      throw error;
    }
  }

  /**
   * Makes sure coturn is actually usable, installing it when needed.
   *
   * Returns null when the relay can run, or the reason it cannot.
   */
  private async ensureRelayCanRun(session: ClientSession): Promise<string | null> {
    if (!CoturnManager.isSupportedPlatform()) {
      return 'O relay TURN só é suportado em servidores Linux. Não existe pacote do coturn para Windows ou macOS.';
    }
    if (CoturnManager.isInstalled()) return null;

    // The install takes minutes, so whoever asked for it gets told how far it
    // has gone instead of watching a frozen modal (#438).
    const outcome = await CoturnManager.ensureInstalled((progress) => {
      this.host.send(session.ws, { type: MessageType.TURN_INSTALL_PROGRESS, payload: progress });
    });
    if (outcome.ok) return null;

    switch (outcome.reason) {
      case 'no-privileges':
        return 'O coturn não está instalado e o servidor não tem privilégio para instalá-lo. Rode "sudo bash scripts/install-turn.sh" no host.';
      case 'unknown-package-manager':
        return 'O coturn não está instalado e nenhum gerenciador de pacotes conhecido foi encontrado. Instale o coturn manualmente no host.';
      case 'unsupported-platform':
        return 'O relay TURN só é suportado em servidores Linux. Não existe pacote do coturn para Windows ou macOS.';
      default:
        return `Não foi possível instalar o coturn automaticamente: ${outcome.detail ?? 'erro desconhecido'}`;
    }
  }

  private async apply(
    session: ClientSession,
    payload: ServerUpdateSettingsPayload,
    requestId?: string
  ): Promise<void> {
    if (!session.user || !this.host.isCurrentSession(session)) return;
    if (!(await this.host.authorizer.requirePermission(session, Permission.MANAGE_SERVER, requestId)) || !this.host.isCurrentSession(session)) return;
    const previousServer = await this.host.serverRepo.getServer();
    const previousVoiceMode = previousServer?.voiceMode ?? 'p2p';
    if (!this.host.isCurrentSession(session)) return;

    // Switching the relay on is the whole intent, so the server installs coturn
    // itself when it is missing rather than sending the operator to a terminal
    // (#431). Only a relay that truly cannot run is rejected, so the toggle
    // never shows "on" while nothing is actually relaying (#425).
    //
    // A save that enters SFU is exempt: the relay flag rides along because the
    // desktop submits the whole form, but `resolveTurnSfuExclusion` is about to
    // discard it. Acting on it here would install coturn (a multi-minute
    // apt-get) only to switch it off moments later — or, on a host that cannot
    // run a relay at all, refuse the SFU switch outright (#515).
    if (payload.turnEnabled === true && payload.voiceMode !== 'sfu') {
      if (previousVoiceMode === 'sfu' && payload.voiceMode !== 'p2p') {
        this.host.sendError(session.ws, ProtocolErrorCode.TURN_UNAVAILABLE,
          'O relay TURN não pode ser ativado no modo SFU.', requestId);
        return;
      }
      const blocked = await this.ensureRelayCanRun(session);
      if (blocked) {
        this.host.sendError(session.ws, ProtocolErrorCode.TURN_UNAVAILABLE, blocked, requestId);
        return;
      }
    }

    // Same contract for the SFU: a mode the host cannot serve is refused up
    // front, because accepting it would only surface later as a call that
    // quietly fell back to P2P (#515).
    //
    // Only an actual switch is probed. The desktop submits the current voice
    // mode on every save, so probing on `payload.voiceMode === 'sfu'` alone
    // would bind UDP ports on every rename or password change — and a worker
    // already serving a call legitimately holds ports in this range, so the
    // probe would report the admin's own SFU as a blocked firewall. Comparing
    // against the stored mode is what excludes that case; the worker's own
    // state is not a substitute, since creating it binds no RTC port and so
    // proves nothing about the range.
    if (payload.voiceMode === 'sfu') {
      if (previousVoiceMode !== 'sfu') {
        const portProblem = await this.host.sfu.checkPortAvailability();
        if (portProblem) {
          this.host.sendError(
            session.ws,
            ProtocolErrorCode.SFU_UNAVAILABLE,
            describeSfuPortProblem(portProblem),
            requestId
          );
          return;
        }
      }
      const ok = await this.host.sfu.init({ retryNow: true });
      if (!ok) {
        const preflight = checkSfuPreflight();
        const diagnosis = preflight.ok ? '' : ` ${formatSfuPreflightForLog(preflight)}`;
        const reason = `${this.host.sfu.getLastError() || 'SFU worker failed to initialize'}${diagnosis}`.trim();
        Logger.error('SFU', `SFU initialization failed on mode change: ${reason}`);
        this.host.sfu.close();
        this.host.sendError(session.ws, ProtocolErrorCode.SFU_UNAVAILABLE, reason, requestId);
        return;
      }
    }

    // Installation and the shared settings queue can both take minutes. A
    // permission/session valid before waiting must not authorize a later write.
    const stillAllowed = await this.host.authorizer.requirePermission(session, Permission.MANAGE_SERVER, requestId);
    if (!stillAllowed || !this.host.isCurrentSession(session)) {
      if (payload.voiceMode === 'sfu' && previousVoiceMode !== 'sfu') this.host.sfu.close();
      return;
    }
    const afkError = await this.applyAfkChannelSettings(session, payload);
    if (afkError) {
      if (payload.voiceMode === 'sfu' && previousVoiceMode !== 'sfu') this.host.sfu.close();
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, afkError, requestId);
      return;
    }
    const result = await this.host.epoch.change(() => this.host.auth.updateServerSettings(payload));
    if (!result.success) {
      if (payload.voiceMode === 'sfu' && previousVoiceMode !== 'sfu') this.host.sfu.close();
      this.host.sendError(
        session.ws,
        ProtocolErrorCode.BAD_REQUEST,
        result.errorMessage || 'Erro ao atualizar configurações do servidor',
        requestId
      );
      return;
    }
    let { settings } = result;
    let recentSoundCacheError: string | undefined;
    if ((payload.recentSoundCacheEnabled !== undefined || payload.recentSoundCacheLimit !== undefined
      || payload.allowSoundboard === false)
      && this.host.recentSoundCache) {
      try {
        const configuration = await this.host.recentSoundCache.configure(settings.recentSoundCacheEnabled, settings.recentSoundCacheLimit);
        if (configuration.cleanupError) {
          Logger.warn('SOUNDBOARD', 'Recent sound cache settings were applied, but stale files could not all be removed.',
            configuration.cleanupError);
        }
      } catch (error) {
        const reconciled = await this.host.epoch.change(() => this.host.auth.updateServerSettings({
          recentSoundCacheEnabled: Boolean(previousServer?.recentSoundCacheEnabled),
          recentSoundCacheLimit: previousServer?.recentSoundCacheLimit ?? LIMITS.RECENT_SOUND_CACHE_DEFAULT_LIMIT,
        }));
        if (reconciled.success) settings = reconciled.settings;
        recentSoundCacheError = 'Não foi possível aplicar as configurações do cache de áudios.';
        if (!reconciled.success) {
          recentSoundCacheError += ` ${reconciled.errorMessage || 'Não foi possível restaurar o estado persistido.'}`;
        }
        Logger.error('SOUNDBOARD', 'Could not apply recent sound cache settings.', error);
      }
    }

    let voiceTransition: VoiceModeTransition | undefined;
    if (settings.voiceMode !== previousVoiceMode) {
      this.host.botLocalExecution.voiceModeChanged();
      voiceTransition = this.host.voiceSessions.voiceModeChanged(settings.voiceMode);
    }

    let relayError: string | undefined;
    if (payload.turnEnabled !== undefined || payload.voiceMode !== undefined) {
      // Also runs on a plain mode change: switching to SFU forces the relay off
      // in AuthService, and coturn has to actually stop (#515).
      try {
        await this.applyTurnState(settings.turnEnabled);
      } catch (error) {
        relayError = error instanceof Error && error.message.trim() ? error.message : 'Não foi possível aplicar o estado do relay TURN.';
        // A failed start used to acknowledge turnEnabled=true even with no
        // process. Publish actual persisted truth before rejecting the request.
        const running = this.host.coturn.isRunning();
        if (running !== settings.turnEnabled) {
          const reconciled = await this.host.epoch.change(() => this.host.auth.updateServerSettings({ turnEnabled: running }));
          if (!reconciled.success) {
            this.host.sendError(session.ws, ProtocolErrorCode.TURN_UNAVAILABLE,
              `${relayError} ${reconciled.errorMessage || 'Não foi possível atualizar o estado persistido.'}`, requestId);
            return;
          }
          settings = reconciled.settings;
        }
      }
    }

    if (this.host.auditLog.enabled && previousServer) {
      const current = await this.host.serverRepo.getServer();
      const changes = current ? serverSettingsChanges(previousServer, current) : [];
      if (changes.length) this.host.auditLog.record(session, 'server.update', { changes });
    }

    const broadcastPayload: ServerSettingsUpdatedPayload = {
      ...settings,
      voiceTransition,
      turnAvailability: await CoturnManager.availability(),
      afkChannelId: await this.host.channels.getAfkChannelId(),
    };

    // Broadcast updated server settings to all clients
    const settingsError = [relayError, recentSoundCacheError].filter(Boolean).join(' ');
    this.host.broadcast({
      type: MessageType.SERVER_SETTINGS_UPDATED,
      requestId: settingsError ? undefined : requestId,
      payload: broadcastPayload,
    });
    if (settingsError) {
      this.host.sendError(session.ws, relayError ? ProtocolErrorCode.TURN_UNAVAILABLE : ProtocolErrorCode.BAD_REQUEST,
        settingsError, requestId);
    }

    Logger.info(
      'INFO',
      `Configurações do servidor atualizadas (Nome: ${settings.name}, Senha: ${
        settings.hasPassword ? 'Ativa' : 'Sem Senha'
      }, Modo de Voz: ${settings.voiceMode}, Soundboard: ${settings.allowSoundboard ? 'Habilitado' : 'Desabilitado'})`
    );
  }

  /**
   * Creates, renames or removes the AFK room (`afk-channel`). It is an ordinary
   * voice channel, so its arrival, rename and removal reach members through the
   * usual channel events. Returns why nothing changed, or null.
   */
  private async applyAfkChannelSettings(session: ClientSession, payload: ServerUpdateSettingsPayload): Promise<string | null> {
    if (payload.afkChannelEnabled === undefined && payload.afkChannelName === undefined) return null;
    const current = await this.host.channels.getAfkChannelId();
    if (payload.afkChannelEnabled === false) {
      if (!current) return null;
      const cleanupCommunityMedia = this.host.communityService?.prepareChannelDeletion(current);
      const removed = await this.host.epoch.change(() => this.host.channels.removeAfkChannel());
      cleanupCommunityMedia?.();
      if (removed) this.host.channelAdmin.releaseDeleted(removed);
      await this.host.visibility.reconcile();
      return null;
    }
    if (payload.afkChannelEnabled === true && !current) {
      const created = await this.host.epoch.change(() => this.host.channels.createAfkChannel(payload.afkChannelName ?? 'AFK'));
      if (!created.success) return created.errorMessage ?? 'Não foi possível criar o canal AFK.';
      await this.host.visibility.reconcile();
      return null;
    }
    if (payload.afkChannelName === undefined || !current) return null;
    const before = await this.host.channels.getChannelSummary(current);
    const renamed = await this.host.epoch.change(() => this.host.channels.updateChannel({ channelId: current, name: payload.afkChannelName }));
    if (!renamed.success || !renamed.channel) return renamed.errorMessage ?? 'Não foi possível renomear o canal AFK.';
    if (this.host.auditLog.enabled && before) {
      const changes = channelChanges(before, renamed.channel, await this.host.auditLog.names(before, renamed.channel));
      if (changes.length) this.host.auditLog.record(session, 'channel.update', { target: auditRef.channel(renamed.channel), changes });
    }
    await this.host.channelAdmin.publishUpdate(renamed.channel);
    return null;
  }

  private async inviteInfo(session: ClientSession, requestId?: string): Promise<void> {
    try {
      const server = await this.host.serverRepo.getServer();
      const addr = this.host.httpServer.address();
      const port = addr && typeof addr === 'object' ? addr.port : LIMITS.DEFAULT_PORT;
      const networkInterfaces = await scanServerNetworkInterfaces();

      this.host.send(session.ws, {
        type: MessageType.SERVER_INVITE_INFO,
        requestId,
        payload: {
          port,
          serverName: server?.name || 'Monky Server',
          networkInterfaces,
        },
      });
    } catch (error: unknown) {
      Logger.error('NETWORK', 'Error generating server invite info', error);
      this.host.sendError(
        session.ws,
        ProtocolErrorCode.INTERNAL_ERROR,
        'Erro ao obter informações de convite do servidor',
        requestId
      );
    }
  }
}
