import { serverMessage,
  BOT_SCREEN_LIMITS, MessageType, Permission, ProtocolErrorCode, hasPermission,
  botScreenActionSchema, botScreenCreateSchema, botScreenRefSchema, botScreenListSchema, botScreenUpdateSchema,
  type BotScreenActionEvent, type BotScreenRef, type BotScreenRemoved, type ServerMessage, type ServerMessageArgs,
} from '@monky/shared';
import { ZodError } from 'zod';
import type { BotInteractionSession, VoiceInvocationAuthorization } from './BotInteractionHandler';
import { BotScreenError, BotScreenService, type ActiveBotScreen } from '../../application/services/BotScreenService';
import type { ChannelService } from '../../application/services/ChannelService';
import type { UserService } from '../../application/services/UserService';
import { ServiceError } from '../../application/errors';
import {
  BOT_ACCESS_REFUSALS, BotAccess, BotAccessGate, withStableAccess, type BotAccessDenial, type BotAccessReads,
} from '../../application/services/BotAccessPolicy';
import { Logger } from '../logger/Logger';
import { toProtocolError } from './protocolErrors';

export interface BotScreenTransport {
  sessions(): Iterable<BotInteractionSession>;
  isCurrent(session: BotInteractionSession): boolean;
  /**
   * Moves with every change to who may use a voice room, other than role writes:
   * channels, membership, connections, and voice presence with the grants that
   * keep someone in a room. While it holds, the periodic sweep skips (BOTS-3).
   */
  accessVersion(): number;
  getVoiceChannelId(sessionId: string): string | null;
  send(session: BotInteractionSession, message: ServerMessage): void;
  authorizeInvocation(session: BotInteractionSession, invocationId: string, channelId: string): Promise<VoiceInvocationAuthorization | undefined>;
  endInvocation(session: BotInteractionSession, invocationId: string): void;
}

class ScreenAccessError extends ServiceError {
  constructor(message: string, code: ProtocolErrorCode = ProtocolErrorCode.PERMISSION_DENIED) { super(code, message); }
}

/** Miniapps have always answered a lost membership with PERMISSION_DENIED. */
function screenRefusal(denial: BotAccessDenial): ScreenAccessError {
  const { code, message } = BOT_ACCESS_REFUSALS[denial];
  return new ScreenAccessError(message, denial === 'member' ? ProtocolErrorCode.PERMISSION_DENIED : code);
}

interface RateWindow { start: number; count: number }

export class BotScreenHandler {
  private pending: Promise<void> = Promise.resolve();
  private queued = 0;
  private closed = false;
  private owners = new Map<string, BotInteractionSession>();
  private known = new WeakMap<BotInteractionSession, Set<string>>();
  private rate = new WeakMap<BotInteractionSession, RateWindow>();
  private screenRate = new WeakMap<ActiveBotScreen, RateWindow>();
  private actionIds = new WeakMap<ActiveBotScreen, Set<string>>();
  private timer: ReturnType<typeof setInterval>;
  /** The access versions every screen and viewer was last checked against. */
  private sweptKey: string | null = null;
  /** Who may see or use a miniapp: the rule shared with commands and selectors (BOTS-8). */
  private readonly gate: BotAccessGate;

  constructor(
    private screens: BotScreenService,
    private channels: Pick<ChannelService, 'accessScope' | 'getAccessContext' | 'getRoleAccessVersion' | 'rulesFor'>,
    users: Pick<UserService, 'isMember'>,
    private transport: BotScreenTransport,
  ) {
    this.gate = new BotAccessGate(channels, users);
    this.timer = setInterval(() => {
      if (this.queued === 0) void this.enqueue(() => this.sweep()).catch((error: unknown) => Logger.error('BOT', 'Screen cleanup failed.', error));
    }, 1000);
    this.timer.unref();
  }

  handle(session: BotInteractionSession, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    if (!this.transport.isCurrent(session) || !session.user || this.closed) return Promise.resolve();
    if (!this.allow(this.rate, session, session.isBot ? 20 : BOT_SCREEN_LIMITS.actionsPerSecond) || this.queued >= 256) {
      this.error(session, new ScreenAccessError('Screen operation rate exceeded.', ProtocolErrorCode.BOT_COMMAND_BUSY), requestId);
      return Promise.resolve();
    }
    return this.enqueue(async () => {
      if (!this.transport.isCurrent(session) || !session.user) return;
      try {
        await this.sweep();
        if (type === MessageType.BOT_SCREEN_LIST) {
          const { channelId } = botScreenListSchema.parse(payload);
          const candidates = this.screens.list().filter((entry) =>
            entry.screen.channelId === channelId && (!session.isBot || entry.screen.botId === session.botId));
          let visible: ActiveBotScreen[] = [];
          const access = this.fanOut();
          await this.stableAccess(async () => {
            if (!session.isBot) await this.requireViewer(session, channelId, false, access());
            // A screen whose bot lost access is left out rather than failing the whole list.
            visible = [];
            for (const entry of candidates) {
              try {
                await this.requireOwner(entry, access());
                visible.push(entry);
              } catch (error: unknown) {
                if (!(error instanceof ScreenAccessError)) throw error;
              }
            }
          }, () => {
            if (!session.isBot) this.requireVoiceMembership(session, channelId);
            const listed = visible.filter((entry) => this.screens.get(entry.screen.id) === entry && this.ownerIsCurrent(entry));
            for (const entry of listed) this.remember(session, entry.screen.id);
            this.send(session, MessageType.BOT_SCREEN_LIST_RESULT, { channelId, screens: listed.map(({ screen }) => screen) }, requestId);
          });
          return;
        }
        if (type === MessageType.BOT_SCREEN_CREATE) {
          this.requireBot(session);
          const input = botScreenCreateSchema.parse(payload);
          let invocation: VoiceInvocationAuthorization | undefined;
          const entry = await this.stableAccess(async () => {
            if (input.invocationId) {
              invocation = await this.transport.authorizeInvocation(session, input.invocationId, input.channelId);
              if (!invocation) throw new ScreenAccessError('The caller must currently be in this voice room.');
            }
            const principal = invocation?.creatorUserId ?? session.user!.id;
            await this.requirePrincipal(principal, input.channelId, !!invocation, true);
          }, () => {
            if (!this.transport.isCurrent(session) || (invocation && !invocation.isCurrent())) {
              throw new ScreenAccessError('The invocation or bot connection ended.', ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
            }
            const created = this.screens.create(session.botId!, input, invocation?.creatorUserId);
            this.owners.set(created.screen.id, session);
            this.remember(session, created.screen.id);
            this.send(session, MessageType.BOT_SCREEN_SNAPSHOT, created.screen, requestId);
            return created;
          });
          await this.notify(entry);
          return;
        }
        if (type === MessageType.BOT_SCREEN_ACTION) {
          if (session.isBot) throw new ScreenAccessError('Only authenticated human members may act.');
          const input = botScreenActionSchema.parse(payload);
          const entry = this.requireInstance(input);
          await this.stableAccess(async () => {
            await this.requireViewer(session, entry.screen.channelId, true);
            await this.requireOwner(entry);
          }, () => {
            this.requireVoiceMembership(session, entry.screen.channelId);
            const owner = this.requireOwnerSession(entry);
            if (input.revision !== entry.screen.revision) throw new BotScreenError('Screen revision is stale. Reload the current snapshot.', ProtocolErrorCode.BOT_SCREEN_CONFLICT);
            const ids = this.actionIds.get(entry) ?? new Set<string>();
            const key = JSON.stringify([session.user!.id, input.actionId]);
            if (!ids.has(key)) {
              if (!this.allow(this.screenRate, entry, BOT_SCREEN_LIMITS.actionsPerScreenPerSecond)) {
                throw new BotScreenError('Screen action rate exceeded.', ProtocolErrorCode.BOT_INTERACTION_INVALID);
              }
              ids.add(key);
              if (ids.size > 256) ids.delete(ids.values().next().value!);
              this.actionIds.set(entry, ids);
              const event: BotScreenActionEvent = {
                screenId: input.id, instanceId: input.instanceId, channelId: entry.screen.channelId, userId: session.user!.id,
                userNickname: session.user!.nickname, action: input.action, payload: input.payload,
                revision: input.revision, actionId: input.actionId,
              };
              this.send(owner, MessageType.BOT_SCREEN_ACTION_EVENT, event);
            }
            this.remember(session, entry.screen.id);
            this.send(session, MessageType.BOT_SCREEN_SNAPSHOT, entry.screen, requestId);
          });
          return;
        }
        if (type === MessageType.BOT_SCREEN_END) {
          if (session.isBot) throw new ScreenAccessError('Only authenticated human members may end a miniapp.');
          const input = botScreenRefSchema.parse(payload);
          const entry = this.requireInstance(input);
          await this.stableAccess(async () => {
            await this.requireViewer(session, entry.screen.channelId, false);
            const context = await this.channels.getAccessContext(session.user!.id);
            if (session.user!.id !== entry.creatorUserId && !hasPermission(context.permissions, Permission.ADMINISTRATOR)) {
              throw new ScreenAccessError('Only the creator or an administrator may end this miniapp.');
            }
            await this.requireOwner(entry);
          }, () => {
            this.requireVoiceMembership(session, entry.screen.channelId);
            const owner = this.requireOwnerSession(entry);
            if (entry.sourceInvocationId) this.transport.endInvocation(owner, entry.sourceInvocationId);
            const removed: BotScreenRemoved = {
              ...input, channelId: entry.screen.channelId, reason: 'ended', endedByUserId: session.user!.id,
            };
            this.remove(entry, removed);
            this.send(session, MessageType.BOT_SCREEN_REMOVED, removed, requestId);
          });
          return;
        }
        this.requireBot(session);
        if (type !== MessageType.BOT_SCREEN_UPDATE && type !== MessageType.BOT_SCREEN_CLOSE) {
          throw new BotScreenError('Unsupported screen operation.', ProtocolErrorCode.BOT_INTERACTION_INVALID);
        }
        const input = type === MessageType.BOT_SCREEN_UPDATE ? botScreenUpdateSchema.parse(payload) : botScreenRefSchema.parse(payload);
        const entry = this.requireInstance(input);
        if (entry.screen.botId !== session.botId || this.owners.get(input.id) !== session) throw new BotScreenError('Screen not found.', ProtocolErrorCode.BOT_SCREEN_NOT_FOUND);
        if (type === MessageType.BOT_SCREEN_CLOSE) {
          await this.stableAccess(() => this.requireOwner(entry), () => {
            this.requireOwnerSession(entry);
            const removed: BotScreenRemoved = {
              id: input.id, instanceId: input.instanceId, channelId: entry.screen.channelId, reason: 'closed',
            };
            this.remove(entry, removed);
            this.send(session, MessageType.BOT_SCREEN_REMOVED, removed, requestId);
          });
        } else {
          const updated = await this.stableAccess(() => this.requireOwner(entry), () => {
            this.requireOwnerSession(entry);
            const result = this.screens.update(input, session.botId!, botScreenUpdateSchema.parse(payload));
            this.send(session, MessageType.BOT_SCREEN_SNAPSHOT, result.screen, requestId);
            return result;
          });
          await this.notify(updated);
        }
      } catch (error: unknown) {
        this.error(session, error, requestId);
      }
    });
  }

  /** Call on access mutations; the periodic sweep is only a lifecycle safety net. */
  revokeInvalid(): Promise<void> { return this.enqueue(() => this.sweep(true)); }

  disconnect(session: BotInteractionSession): Promise<void> {
    return this.enqueue(async () => {
      for (const entry of this.screens.list()) {
        if (this.owners.get(entry.screen.id) === session) this.remove(entry, {
          id: entry.screen.id, instanceId: entry.screen.instanceId, channelId: entry.screen.channelId, reason: 'bot_disconnected',
        });
      }
      this.known.delete(session);
      this.rate.delete(session);
    });
  }

  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.screens.clear();
    this.owners.clear();
  }

  private stableAccess<T>(check: () => Promise<void>, use: () => T): Promise<T> {
    return withStableAccess({
      version: () => this.accessKey(),
      check,
      use: () => {
        if (this.closed) throw new ScreenAccessError('The server is stopping.');
        return use();
      },
      isRefusal: (error) => error instanceof ScreenAccessError,
      busy: () => new ScreenAccessError('Permissions are changing. Retry shortly.', ProtocolErrorCode.BOT_COMMAND_BUSY),
    });
  }

  /** Without `reads`, a single check reads everything afresh. */
  private async requirePrincipal(
    userId: string, channelId: string, human: boolean, interact: boolean, reads?: BotAccessReads,
  ): Promise<void> {
    const denial = await this.gate.check(userId, channelId, BotAccess.screen(human, interact), reads);
    if (denial) throw screenRefusal(denial);
  }

  /**
   * Access only changes along with these versions (see BotScreenTransport.accessVersion).
   * Null while a role write is pending: role writes can precede their WebSocket access-epoch update.
   */
  private accessKey(): string | null {
    const roles = this.channels.getRoleAccessVersion();
    return roles === null ? null : `${this.transport.accessVersion()}:${roles}`;
  }

  /** The reads one fan-out shares, so reaching every viewer reads the channel and each member once (BOTS-3). */
  private fanOut(): () => BotAccessReads {
    return this.gate.fanOut(() => this.accessKey());
  }

  private requireVoiceMembership(session: BotInteractionSession, channelId: string): void {
    if (!session.user || session.isBot || !session.sessionId || !this.transport.isCurrent(session) ||
        this.transport.getVoiceChannelId(session.sessionId) !== channelId) {
      throw new ScreenAccessError('The miniapp is only available inside its voice room.', ProtocolErrorCode.CHANNEL_NOT_FOUND);
    }
  }

  private async requireViewer(
    session: BotInteractionSession, channelId: string, interact: boolean, reads?: BotAccessReads,
  ): Promise<void> {
    this.requireVoiceMembership(session, channelId);
    await this.requirePrincipal(session.user!.id, channelId, true, interact, reads);
    this.requireVoiceMembership(session, channelId);
  }

  private requireBot(session: BotInteractionSession): void {
    if (!session.isBot || !session.botId || !session.user) throw new ScreenAccessError('A bot account is required.');
  }

  private requireInstance(ref: BotScreenRef): ActiveBotScreen {
    const entry = this.screens.get(ref.id);
    if (!entry || entry.screen.instanceId !== ref.instanceId) {
      throw new BotScreenError('Screen instance not found.', ProtocolErrorCode.BOT_SCREEN_NOT_FOUND);
    }
    return entry;
  }

  private requireOwnerSession(entry: ActiveBotScreen): BotInteractionSession {
    const owner = this.owners.get(entry.screen.id);
    if (!owner?.user || !this.transport.isCurrent(owner)) throw new ScreenAccessError('The screen bot is disconnected.');
    return owner;
  }

  private ownerIsCurrent(entry: ActiveBotScreen): boolean {
    const owner = this.owners.get(entry.screen.id);
    return !!owner?.user && this.transport.isCurrent(owner);
  }

  private async requireOwner(entry: ActiveBotScreen, reads?: BotAccessReads): Promise<void> {
    const owner = this.requireOwnerSession(entry);
    await this.requirePrincipal(entry.creatorUserId ?? owner.user!.id, entry.screen.channelId, !!entry.creatorUserId, true, reads);
  }

  /**
   * Every access mutation calls revokeInvalid, which forces a sweep. Otherwise
   * a sweep only runs once the access versions moved since the last one: an
   * unchanged pair keeps its verdict, so an idle server reads nothing (BOTS-3).
   */
  private async sweep(force = false): Promise<void> {
    const key = this.accessKey();
    if (!force && key !== null && key === this.sweptKey) return;
    const access = this.fanOut();
    for (const entry of this.screens.list()) {
      if (this.closed) return;
      try { await this.stableAccess(() => this.requireOwner(entry, access()), () => {}); }
      catch (error: unknown) {
        if (!(error instanceof ScreenAccessError) || error.code === ProtocolErrorCode.BOT_COMMAND_BUSY) throw error;
        const owner = this.owners.get(entry.screen.id);
        this.remove(entry, {
          id: entry.screen.id, instanceId: entry.screen.instanceId, channelId: entry.screen.channelId,
          reason: owner && this.transport.isCurrent(owner) ? 'access_revoked' : 'bot_disconnected',
        });
        continue;
      }
      for (const session of this.transport.sessions()) {
        if (session.isBot || !session.user || !this.known.get(session)?.has(entry.screen.id)) continue;
        try { await this.stableAccess(() => this.requireViewer(session, entry.screen.channelId, false, access()), () => {}); }
        catch (error: unknown) {
          if (!(error instanceof ScreenAccessError) || error.code === ProtocolErrorCode.BOT_COMMAND_BUSY) throw error;
          this.forget(session, entry);
        }
      }
    }
    // A change during the sweep leaves the versions ahead of this key, so the next one runs again.
    this.sweptKey = key;
  }

  private async notify(entry: ActiveBotScreen): Promise<void> {
    const owner = this.owners.get(entry.screen.id);
    const access = this.fanOut();
    for (const session of this.transport.sessions()) {
      if (!session.user || !this.transport.isCurrent(session)) continue;
      // Only the owning bot, the people in the room and those who still hold the screen are concerned (BOTS-3).
      if (session.isBot ? session !== owner : !this.inRoom(session, entry.screen.channelId) && !this.known.get(session)?.has(entry.screen.id)) continue;
      try {
        await this.stableAccess(async () => {
          await this.requireOwner(entry, access());
          if (!session.isBot) await this.requireViewer(session, entry.screen.channelId, false, access());
        }, () => {
          if (!session.isBot) this.requireVoiceMembership(session, entry.screen.channelId);
          this.requireOwnerSession(entry);
          this.remember(session, entry.screen.id);
          this.send(session, MessageType.BOT_SCREEN_SNAPSHOT, entry.screen);
        });
      } catch (error: unknown) {
        if (!(error instanceof ScreenAccessError) || error.code === ProtocolErrorCode.BOT_COMMAND_BUSY) throw error;
        this.forget(session, entry);
      }
    }
  }

  private remove(entry: ActiveBotScreen, removed: BotScreenRemoved): void {
    if (this.screens.get(entry.screen.id) !== entry) return;
    const owner = this.owners.get(entry.screen.id);
    this.screens.remove(entry.screen, entry.screen.botId);
    this.owners.delete(entry.screen.id);
    this.actionIds.delete(entry);
    this.screenRate.delete(entry);
    for (const session of this.transport.sessions()) {
      if (session !== owner) this.forget(session, entry, removed);
    }
    if (owner) {
      this.known.get(owner)?.delete(entry.screen.id);
      this.send(owner, MessageType.BOT_SCREEN_REMOVED, removed);
    }
  }

  private remember(session: BotInteractionSession, id: string): void {
    const known = this.known.get(session) ?? new Set<string>();
    known.add(id);
    this.known.set(session, known);
  }

  private forget(session: BotInteractionSession, entry: ActiveBotScreen, removed?: BotScreenRemoved): void {
    if (!this.known.get(session)?.delete(entry.screen.id)) return;
    // A revoked viewer only receives the ID it already knew, never new channel data.
    this.send(session, MessageType.BOT_SCREEN_REMOVED, removed ?? {
      id: entry.screen.id, instanceId: entry.screen.instanceId, channelId: entry.screen.channelId, reason: 'view_revoked',
    });
  }

  private allow<T extends object>(map: WeakMap<T, RateWindow>, key: T, max: number): boolean {
    const now = Date.now();
    const current = map.get(key);
    if (!current || now - current.start >= 1000) {
      map.set(key, { start: now, count: 1 });
      return true;
    }
    return ++current.count <= max;
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.queued++;
    const next = this.pending.then(async () => { if (!this.closed) await work(); }).finally(() => { this.queued--; });
    this.pending = next.catch(() => {});
    return next;
  }

  private inRoom(session: BotInteractionSession, channelId: string): boolean {
    return !!session.sessionId && this.transport.getVoiceChannelId(session.sessionId) === channelId;
  }

  /**
   * A refusal goes out as worded. An invalid payload tells the bot developer
   * what was wrong with it; any other failure is logged and answered in
   * general terms, without the words of a database or runtime error (BOTS-8).
   */
  private error(session: BotInteractionSession, error: unknown, requestId?: string): void {
    this.send(session, MessageType.SERVER_ERROR, error instanceof ZodError
      ? { code: ProtocolErrorCode.BOT_INTERACTION_INVALID, message: error.message }
      : toProtocolError(error, { message: 'Screen operation failed.', category: 'BOT', code: ProtocolErrorCode.BOT_INTERACTION_INVALID }),
    requestId);
  }

  private send(session: BotInteractionSession, ...message: [...ServerMessageArgs, requestId?: string]): void {
    if (!this.closed && this.transport.isCurrent(session)) this.transport.send(session, serverMessage(...message));
  }
}
