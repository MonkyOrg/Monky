import { WebSocket } from 'ws';
import {
  MessageType, Permission, canAccessChannel, hasChannelPermission, hasPermission,
  type ChannelCategory, type ChannelSummary, type ServerMessage,
} from '@monky/shared';
import type { BotLocalExecutionService } from '../../../application/services/BotLocalExecutionService';
import type { ChannelAccessContext, ChannelService } from '../../../application/services/ChannelService';
import type { SignalingService } from '../../../application/services/SignalingService';
import type { UserService } from '../../../application/services/UserService';
import { Logger } from '../../logger/Logger';
import type { BotInteractionHandler, BotInteractionSession } from '../BotInteractionHandler';
import type { BotScreenHandler } from '../BotScreenHandler';
import type { ClientSession } from '../ClientSession';
import type { VoiceSessionHandler } from '../voice/VoiceSessionHandler';
import type { AccessEpoch } from './AccessEpoch';

/** Channels whose rows changed, resent to whoever keeps seeing them: every one of them, or the ones listed. */
export type ChannelRefresh = boolean | ReadonlySet<string>;

export interface ChannelVisibilityHost {
  readonly channels: ChannelService;
  readonly users: UserService;
  readonly signaling: SignalingService;
  readonly epoch: AccessEpoch;
  readonly botScreens?: Pick<BotScreenHandler, 'revokeInvalid'>;
  readonly botInteractions: Pick<BotInteractionHandler, 'reconcileAccess'>;
  readonly botLocalExecution: Pick<BotLocalExecutionService<BotInteractionSession>, 'reconcileAccess'>;
  readonly voiceSessions: Pick<VoiceSessionHandler,
    'evictFromVoiceChannel' | 'applyPermissionMuted' | 'voicePresenceChannelIds' | 'roomListed' | 'roomWithdrawn'>;
  readonly closing: boolean;
  sessions(): Iterable<ClientSession>;
  isCurrentSession(session: ClientSession): boolean;
  hasBotVoiceGrant(session: ClientSession, channelId: string): boolean;
  send(ws: WebSocket, message: ServerMessage): void;
  broadcastToChannel(channelId: string, message: ServerMessage, ignoreWs?: WebSocket, canSend?: () => boolean): Promise<void>;
}

/**
 * Which channels each connection is told about (#384). The server filters
 * private channels out of what it sends, so it remembers what each connection
 * was told and, whenever access may have changed, pushes only the difference.
 */
export class ChannelVisibility {
  /** One voice-presence pass at a time, so the deltas sent to a connection never interleave. */
  private presenceSync: Promise<void> = Promise.resolve();

  constructor(private readonly host: ChannelVisibilityHost) {}

  /**
   * Brings every client's channel list back in sync with what it is allowed to
   * see (#384), pushing only the difference: channels that just became visible
   * arrive as CHANNEL_CREATED, ones that no longer are leave as CHANNEL_DELETED.
   * `refreshChannels` also resends channels whose rows changed to whoever keeps
   * seeing them: `true` all of them, a set only those.
   *
   * A bot that loses access while sitting in a voice channel is disconnected
   * from it. A person stays: VIEW_CHANNEL only gates finding a room and joining
   * it by oneself, so they keep seeing the room until they leave.
   */
  async reconcile(refreshChannels: ChannelRefresh = false): Promise<void> {
    const { host } = this;
    host.epoch.generation++;
    host.epoch.miniapps++;
    const accessVersion = host.epoch.generation;
    await host.botScreens?.revokeInvalid();
    const channels = await host.channels.listChannels();
    const categories = await host.channels.listCategories();
    const channelsById = new Map(channels.map((channel) => [channel.id, channel]));
    const afkChannelId = await host.channels.getAfkChannelId();

    const contexts = new Map<string, ChannelAccessContext>();
    const userIds = new Set<string>();
    const grantCreators = new Set<string>();
    const members = new Set<string>();
    for (const session of host.sessions()) {
      if (session.user) userIds.add(session.user.id);
      if (session.botVoiceGrant) {
        userIds.add(session.botVoiceGrant.creatorUserId);
        grantCreators.add(session.botVoiceGrant.creatorUserId);
      }
    }
    await Promise.all(
      Array.from(userIds).map(async (userId) => {
        contexts.set(userId, await host.channels.getAccessContext(userId));
        if (grantCreators.has(userId) && await host.users.isMember(userId)) members.add(userId);
      })
    );
    host.botInteractions.reconcileAccess(channelsById, contexts);

    if (accessVersion === host.epoch.generation) for (const session of host.sessions()) {
      const grant = session.botVoiceGrant;
      if (!grant || !session.sessionId) continue;
      const creator = contexts.get(grant.creatorUserId);
      const bot = session.user && contexts.get(session.user.id);
      const voice = channelsById.get(grant.channelId);
      const origin = channelsById.get(grant.originChannelId);
      const valid = members.has(grant.creatorUserId) && creator && bot &&
        hasPermission(bot.permissions, Permission.SPEAK) &&
        voice?.type === 'VOICE' && (origin?.type === 'TEXT' || origin?.type === 'VOICE') && origin.botCommandsEnabled &&
        hasChannelPermission(voice, creator.permissions, creator.roleIds, Permission.SPEAK, false, creator.userId) &&
        hasChannelPermission(origin, creator.permissions, creator.roleIds, Permission.SEND_MESSAGES, false, creator.userId) &&
        hasChannelPermission(origin, creator.permissions, creator.roleIds, Permission.USE_BOT_COMMANDS, false, creator.userId);
      if (valid) grant.accessVersion = accessVersion;
      else {
        session.botVoiceGrant = undefined;
        host.voiceSessions.evictFromVoiceChannel(session.sessionId, grant.channelId);
      }
    }

    await host.botLocalExecution.reconcileAccess();
    for (const session of host.sessions()) {
      if (!session.user || session.ws.readyState !== WebSocket.OPEN) continue;

      const context = contexts.get(session.user.id);
      if (!context) continue;

      const nowVisible = this.visibleChannelIds(channels, context);
      if (!session.isBot) session.voicePresenceKey = this.presenceKey(session.user.id);
      this.sendChannels(session, nowVisible, channels, categories, context, refreshChannels, (channelId) => {
        if (session.sessionId && !host.hasBotVoiceGrant(session, channelId)) host.voiceSessions.evictFromVoiceChannel(session.sessionId, channelId);
      });

      const voiceState = session.sessionId && host.signaling.getVoiceState(session.sessionId);
      const voiceChannel = voiceState && channelsById.get(voiceState.channelId);
      if (voiceState && voiceChannel && !host.hasBotVoiceGrant(session, voiceState.channelId)) {
        const rules = host.channels.rulesFor(voiceChannel, context);
        const canView = hasChannelPermission(rules, context.permissions, context.roleIds, Permission.VIEW_CHANNEL, context.isBot, context.userId);
        const canSpeak = hasChannelPermission(rules, context.permissions, context.roleIds, Permission.SPEAK, context.isBot, context.userId);
        if (!canView || (session.isBot && !canSpeak)) {
          host.voiceSessions.evictFromVoiceChannel(voiceState.sessionId, voiceState.channelId);
        } else {
          const afkMuted = !session.isBot && voiceState.channelId === afkChannelId;
          const updated = await host.voiceSessions.applyPermissionMuted(voiceState.sessionId, !canSpeak || afkMuted);
          if (updated && updated !== voiceState) {
            await host.broadcastToChannel(updated.channelId, {
              type: MessageType.VOICE_STATE_CHANGED,
              payload: { voiceState: updated },
            }, undefined, () => host.signaling.getVoiceState(updated.sessionId) === updated);
          }
        }
      }
    }
  }

  /** The voice rooms a person is shown because they are inside them, as one comparable key. */
  presenceKey(userId: string): string {
    return [...this.host.voiceSessions.voicePresenceChannelIds(userId)].sort().join('\n');
  }

  visibleChannelIds(channels: readonly ChannelSummary[], context: ChannelAccessContext): Set<string> {
    return new Set(channels
      .filter((channel) => canAccessChannel(this.host.channels.rulesFor(channel, context),
        context.permissions, context.roleIds, context.isBot, context.userId))
      .map((channel) => channel.id));
  }

  /**
   * Sends one connection the difference between the channels it was told about
   * and `nowVisible` (#384). A voice room it is shown comes with whoever is
   * inside. `beforeRemoval` runs before a channel is withdrawn, so a voice
   * eviction still reaches the client while it knows the room, and whoever is
   * still inside is then withdrawn with it. Its categories go only when they
   * differ from the ones it already has (S-WS-4).
   */
  sendChannels(
    session: ClientSession,
    nowVisible: Set<string>,
    channels: readonly ChannelSummary[],
    categories: readonly ChannelCategory[],
    context: ChannelAccessContext,
    refreshChannels: ChannelRefresh,
    beforeRemoval?: (channelId: string) => void,
  ): void {
    const previouslyVisible = session.visibleChannelIds ?? new Set<string>();
    const visibleCategories = categories.filter((category) =>
      canAccessChannel(category, context.permissions, context.roleIds, context.isBot, context.userId) ||
      channels.some((channel) => channel.categoryId === category.id && nowVisible.has(channel.id)));
    const categoriesKey = JSON.stringify(visibleCategories);
    if (session.categoriesKey !== categoriesKey) {
      session.categoriesKey = categoriesKey;
      this.host.send(session.ws, {
        type: MessageType.CATEGORIES_UPDATED,
        payload: { categories: visibleCategories },
      });
    }

    const refreshed = (channelId: string) =>
      refreshChannels === true || (refreshChannels !== false && refreshChannels.has(channelId));
    for (const channel of channels) {
      if (!nowVisible.has(channel.id) || (previouslyVisible.has(channel.id) && !refreshed(channel.id))) continue;
      const listed = previouslyVisible.has(channel.id);
      this.host.send(session.ws, { type: listed ? MessageType.CHANNEL_UPDATED : MessageType.CHANNEL_CREATED, payload: { channel } });
      if (!listed && channel.type === 'VOICE') this.host.voiceSessions.roomListed(session, channel.id);
    }

    for (const channelId of previouslyVisible) {
      if (nowVisible.has(channelId)) continue;
      beforeRemoval?.(channelId);
      this.host.voiceSessions.roomWithdrawn(session, channelId);
      this.host.send(session.ws, { type: MessageType.CHANNEL_DELETED, payload: { channelId } });
    }
    session.visibleChannelIds = nowVisible;
  }

  /**
   * Lists the voice room a person is inside even when their own access would
   * not, and withdraws it once they leave. One pass runs at a time, so the
   * deltas sent to a connection never interleave.
   */
  syncVoicePresence(): Promise<void> {
    // Being in a room is access (rulesFor), and every change to it comes through
    // here, including a return or reconnect grant that lapses or is withdrawn
    // while its holder is offline. Miniapps recheck now, as on voice membership.
    this.host.epoch.miniapps++;
    void this.host.botScreens?.revokeInvalid()
      .catch((error: unknown) => Logger.error('BOT', 'Failed to reconcile voice miniapp access.', error));
    const run = this.presenceSync.then(() => this.applyVoicePresence());
    this.presenceSync = run.catch((error: unknown) => Logger.error('NETWORK', 'Failed to sync voice room visibility.', error));
    return this.presenceSync;
  }

  /** A person signing in while inside a room they cannot see by themselves still gets it listed. */
  async includePresenceChannels(
    userId: string, details: { channels: ChannelSummary[]; categories?: ChannelCategory[] },
  ): Promise<void> {
    const missing = [...this.host.voiceSessions.voicePresenceChannelIds(userId)]
      .filter((id) => !details.channels.some((channel) => channel.id === id));
    if (missing.length === 0) return;
    const [channels, categories] = await Promise.all([this.host.channels.listChannels(), this.host.channels.listCategories()]);
    for (const channel of channels) {
      if (!missing.includes(channel.id)) continue;
      details.channels.push(channel);
      const category = categories.find((entry) => entry.id === channel.categoryId);
      if (category && !details.categories?.some((entry) => entry.id === category.id)) {
        details.categories = [...(details.categories ?? []), category];
      }
    }
  }

  private async applyVoicePresence(): Promise<void> {
    const stale = [...this.host.sessions()].filter((session) => !!session.user && !session.isBot &&
      !!session.visibleChannelIds && session.voicePresenceKey !== this.presenceKey(session.user.id));
    if (this.host.closing || stale.length === 0) return;
    const [channels, categories] = await Promise.all([this.host.channels.listChannels(), this.host.channels.listCategories()]);
    const contexts = new Map<string, ChannelAccessContext>();
    for (const session of stale) {
      const userId = session.user?.id;
      if (!userId || !this.host.isCurrentSession(session)) continue;
      const context = contexts.get(userId) ?? await this.host.channels.getAccessContext(userId);
      contexts.set(userId, context);
      if (!this.host.isCurrentSession(session)) continue;
      const previouslyVisible = session.visibleChannelIds ?? new Set<string>();
      const nowVisible = this.visibleChannelIds(channels, context);
      session.voicePresenceKey = this.presenceKey(userId);
      if (nowVisible.size === previouslyVisible.size && [...nowVisible].every((id) => previouslyVisible.has(id))) continue;
      this.sendChannels(session, nowVisible, channels, categories, context, false);
    }
  }
}
