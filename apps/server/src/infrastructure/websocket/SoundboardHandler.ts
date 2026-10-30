import type { WebSocket } from 'ws';
import {
  LIMITS, MessageType, Permission, ProtocolErrorCode, recentSoundMimeTypeSchema,
  type RecentSoundEntry, type RecentSoundMimeType, type RecentSoundRecordPayload, type ServerMessage,
  type SoundboardPlayedPayload, type SoundboardPlayPayload, type SoundboardStoppedPayload, type SoundboardStopPayload,
} from '@monky/shared';
import type { ChannelService } from '../../application/services/ChannelService';
import type { RecentSoundCacheService } from '../../application/services/RecentSoundCacheService';
import type { SignalingService } from '../../application/services/SignalingService';
import type { IServerRepository } from '../../domain/repositories';
import { Logger } from '../logger/Logger';
import type { RateLimiter } from '../security/RateLimiter';
import type { Authorizer } from './access/Authorizer';
import type { ClientSession, SignedInSession } from './ClientSession';
import type { Outbox } from './Outbox';
import { channelIdOf, featureUnavailableCode, route, type Route } from './routing/MessageRouter';

export interface SoundboardHost {
  readonly serverRepo: IServerRepository;
  readonly signaling: SignalingService;
  readonly channels: ChannelService;
  readonly recentSoundCache?: RecentSoundCacheService;
  readonly rateLimiter: Pick<RateLimiter, 'checkLimit'>;
  readonly authorizer: Pick<Authorizer, 'requirePermission'>;
  readonly outbox: Pick<Outbox, 'sendToCall'>;
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  publish(messageFor: (session: SignedInSession) => ServerMessage | undefined, skip?: WebSocket): void;
}

/** A sound as it is played and kept: its name, its type and its bytes. */
interface ValidAudio {
  soundName: string;
  mimeType: RecentSoundMimeType;
  bytes: Buffer;
}

/**
 * The Soundboard: a sound played to the call its author is in, stopping it,
 * and the server's cache of the sounds played recently.
 */
export class SoundboardHandler {
  constructor(private readonly host: SoundboardHost) {}

  routes(): Route[] {
    return [
      // Whether the server allows the Soundboard at all is answered before USE_SOUNDBOARD, in the handler (#359).
      route({
        types: [MessageType.SOUNDBOARD_PLAY], channel: { id: channelIdOf, permissions: [Permission.SPEAK] },
        handle: ({ session, payload, requestId }) => this.play(session, payload as SoundboardPlayPayload, requestId),
      }),
      route({
        types: [MessageType.SOUNDBOARD_STOP], channel: { id: channelIdOf },
        handle: ({ session, payload, requestId }) => this.stop(session, payload as SoundboardStopPayload, requestId),
      }),
      route({
        types: [MessageType.RECENT_SOUND_RECORD],
        handle: ({ session, payload, requestId }) => this.recordRecent(session, payload as RecentSoundRecordPayload, requestId),
      }),
      route({ types: [MessageType.RECENT_SOUNDS_LIST], handle: ({ session, requestId }) => this.listRecent(session, requestId) }),
      route({
        types: [MessageType.RECENT_SOUND_DOWNLOAD],
        handle: ({ session, payload, requestId }) => this.downloadRecent(session, payload, requestId),
      }),
    ];
  }

  private async play(session: SignedInSession, payload: SoundboardPlayPayload, requestId?: string): Promise<void> {
    if (!session.sessionId) return;

    // Check if soundboard is allowed on the server
    const server = await this.host.serverRepo.getServer();
    if (server && server.allowSoundboard === false) {
      this.host.sendError(
        session.ws,
        ProtocolErrorCode.BAD_REQUEST,
        'A reprodução de soundboard está desabilitada neste servidor.',
        requestId
      );
      return;
    }

    // Checked after the server-wide switch so the more specific "disabled here"
    // message wins when the whole feature is off (#359).
    if (!(await this.host.authorizer.requirePermission(session, Permission.USE_SOUNDBOARD, requestId, payload?.channelId))) return;

    if (!payload?.channelId) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de som inválidos', requestId);
      return;
    }
    // A sound belongs to the call its author is in. Naming any other channel,
    // a text one included, used to reach everyone online when nobody was there.
    if (this.host.signaling.getVoiceState(session.sessionId)?.channelId !== payload.channelId) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Entre na chamada deste canal para tocar sons.', requestId);
      return;
    }
    // The AFK room silences everyone inside it, the Soundboard included.
    if (payload.channelId === await this.host.channels.getAfkChannelId()) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'O canal AFK não toca sons da Soundboard.', requestId);
      return;
    }
    const audio = this.validAudio(session, payload, requestId);
    if (!audio) return;

    const cache = this.host.recentSoundCache;
    if (server?.recentSoundCacheEnabled && cache) {
      void cache.record({
          ...audio,
          userId: session.user.id,
          userName: session.user.nickname,
        }).then((entry) => {
          if (entry) this.announceRecent(entry);
        }).catch((error) => {
          Logger.warn('SOUNDBOARD', 'Could not persist a recent sound; playback will continue.', error);
        });
    }

    const broadcastPayload: SoundboardPlayedPayload = {
      channelId: payload.channelId,
      userId: session.user.id,
      userName: session.user.nickname,
      soundName: audio.soundName,
      audioBase64: payload.audioBase64,
      mimeType: audio.mimeType,
    };

    // Only the participants of that call hear it, the author included.
    this.host.outbox.sendToCall(payload.channelId, { type: MessageType.SOUNDBOARD_PLAYED, requestId, payload: broadcastPayload });

    Logger.info('SOUNDBOARD', `User ${session.user.nickname} played sound "${audio.soundName}" in channel ${payload.channelId}`);
  }

  /**
   * Relays "stop my sound" to the channel (#499). No permission gate beyond
   * channel access: the payload carries no audio and the server only ever
   * silences the sound of the very session that asked, so the worst a caller
   * can do is cut their own playback short.
   */
  private stop(session: SignedInSession, payload: SoundboardStopPayload, requestId?: string): void {
    if (!payload || !payload.channelId) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Canal inválido', requestId);
      return;
    }

    const stoppedPayload: SoundboardStoppedPayload = {
      channelId: payload.channelId,
      userId: session.user.id,
    };
    this.host.outbox.sendToCall(payload.channelId, { type: MessageType.SOUNDBOARD_STOPPED, requestId, payload: stoppedPayload });
  }

  /** A sound its author played only to themselves, kept in the cache like the others. Ignored where the cache is off. */
  private async recordRecent(session: SignedInSession, payload: RecentSoundRecordPayload, requestId?: string): Promise<void> {
    if (session.isBot || !session.protocol?.features.includes('recent-sounds')) return;
    const server = await this.host.serverRepo.getServer();
    if (!server?.recentSoundCacheEnabled || server.allowSoundboard === false) return;
    if (!(await this.host.authorizer.requirePermission(session, Permission.USE_SOUNDBOARD, requestId))) return;
    const audio = this.validAudio(session, payload, requestId);
    const cache = this.host.recentSoundCache;
    if (!audio || !cache) return;
    try {
      const entry = await cache.record({
        ...audio,
        userId: session.user.id,
        userName: session.user.nickname,
      });
      if (entry) this.announceRecent(entry);
    } catch (error) {
      Logger.warn('SOUNDBOARD', 'Could not persist a local Soundboard playback.', error);
    }
  }

  private async listRecent(session: SignedInSession, requestId?: string): Promise<void> {
    const cache = this.browsableCache(session, requestId);
    if (!cache) return;
    const server = await this.host.serverRepo.getServer();
    const enabled = Boolean(server?.recentSoundCacheEnabled);
    this.host.send(session.ws, {
      type: MessageType.RECENT_SOUNDS_RESULT,
      requestId,
      payload: {
        enabled,
        limit: server?.recentSoundCacheLimit ?? LIMITS.RECENT_SOUND_CACHE_DEFAULT_LIMIT,
        items: enabled ? await cache.list() : [],
      },
    });
  }

  private async downloadRecent(session: SignedInSession, payload: unknown, requestId?: string): Promise<void> {
    const cache = this.browsableCache(session, requestId);
    if (!cache) return;
    const server = await this.host.serverRepo.getServer();
    if (!server?.recentSoundCacheEnabled) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'O cache de áudios está desabilitado.', requestId);
      return;
    }
    if (!this.host.rateLimiter.checkLimit(
      `recent-sound-download:${session.user.id}`,
      LIMITS.RECENT_SOUND_DOWNLOAD_RATE_LIMIT,
      LIMITS.RECENT_SOUND_DOWNLOAD_RATE_WINDOW_MS,
    )) {
      this.host.sendError(session.ws, ProtocolErrorCode.RATE_LIMITED,
        'Muitas solicitações de áudio. Aguarde um momento.', requestId);
      return;
    }
    const id = payload && typeof payload === 'object' && 'id' in payload ? payload.id : null;
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/iu.test(id)) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Áudio recente inválido.', requestId);
      return;
    }
    const sound = await cache.download(id);
    if (!sound) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Áudio recente não encontrado.', requestId);
      return;
    }
    this.host.send(session.ws, { type: MessageType.RECENT_SOUND_DATA, requestId, payload: sound });
  }

  /** The cache of recent sounds, when this person may browse it; the refusal is answered otherwise. */
  private browsableCache(session: SignedInSession, requestId?: string): RecentSoundCacheService | undefined {
    if (session.isBot) {
      this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Bots não podem acessar áudios recentes.', requestId);
      return undefined;
    }
    if (!session.protocol?.features.includes('recent-sounds')) {
      this.host.sendError(session.ws, ProtocolErrorCode.FEATURE_REQUIRES_UPDATE,
        'O histórico de áudios exige um cliente e servidor atualizados.', requestId);
      return undefined;
    }
    if (!this.host.recentSoundCache) {
      this.host.sendError(session.ws, featureUnavailableCode(session, ProtocolErrorCode.INTERNAL_ERROR),
        'O cache de áudios não está disponível neste servidor.', requestId);
      return undefined;
    }
    return this.host.recentSoundCache;
  }

  /** The sound a payload carries, or null once the refusal is answered. */
  private validAudio(session: ClientSession, payload: RecentSoundRecordPayload, requestId?: string): ValidAudio | null {
    if (!payload?.audioBase64 || !payload.soundName) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de som inválidos', requestId);
      return null;
    }
    if (payload.audioBase64.length > 4 * 1024 * 1024) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Áudio muito grande (máximo 15 segundos / ~2MB)', requestId);
      return null;
    }
    const soundName = String(payload.soundName).trim().slice(0, 100);
    const mimeType = recentSoundMimeTypeSchema.safeParse(payload.mimeType || 'audio/mpeg');
    if (!soundName || !mimeType.success || !/^[A-Za-z0-9+/]+={0,2}$/u.test(payload.audioBase64)) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Dados de som inválidos', requestId);
      return null;
    }
    const bytes = Buffer.from(payload.audioBase64, 'base64');
    if (bytes.length < 1 || bytes.length > LIMITS.MAX_SOUNDBOARD_FILE_SIZE) {
      this.host.sendError(session.ws, ProtocolErrorCode.BAD_REQUEST, 'Áudio muito grande', requestId);
      return null;
    }
    return { soundName, mimeType: mimeType.data, bytes };
  }

  /** A sound just kept, to every person whose app shows the recent ones. */
  private announceRecent(entry: RecentSoundEntry): void {
    const message: ServerMessage<MessageType.RECENT_SOUND_ADDED> = { type: MessageType.RECENT_SOUND_ADDED, payload: entry };
    this.host.publish((recipient) =>
      !recipient.isBot && recipient.protocol?.features.includes('recent-sounds') ? message : undefined);
  }
}
