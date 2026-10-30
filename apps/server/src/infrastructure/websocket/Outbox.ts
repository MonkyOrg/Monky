import { WebSocket } from 'ws';
import {
  MessageType, Permission, canAccessChannel, hasChannelPermission,
  type ChannelAccessRules, type ServerMessage,
} from '@monky/shared';
import type { ChannelService } from '../../application/services/ChannelService';
import type { ForumService } from '../../application/services/ForumService';
import type { NativePollService } from '../../application/services/NativePollService';
import type { PermissionService } from '../../application/services/PermissionService';
import type { SignalingService } from '../../application/services/SignalingService';
import type { NativePollRecord } from '../../domain/entities';
import { BOT_CHAT_EVENTS } from './botCapabilityPolicy';
import { isSignedIn, type ClientSession, type SignedInSession } from './ClientSession';
import { pollReference } from './pollProjection';

/**
 * Serialized frames of one fan-out, keyed by the message a recipient ends up
 * with after its projections: recipients sharing a message share its bytes.
 */
export type FanOutFrames = Map<ServerMessage, Buffer>;

export interface OutboxHost {
  readonly channels: ChannelService;
  readonly permissions: PermissionService;
  readonly signaling: SignalingService;
  readonly pollService?: NativePollService;
  readonly forumService?: ForumService;
  sessions(): Iterable<ClientSession>;
  findSocket(sessionId: string): WebSocket | undefined;
  isCurrentSession(session: ClientSession): boolean;
  hasBotVoiceGrant(session: ClientSession, channelId: string): boolean;
  canDeliverBotEvent(session: ClientSession, message: ServerMessage): boolean;
  /** Null while a change to channel access is in progress. */
  channelAccessVersion(): number | null;
  /** Delivers one message to one connection, after the projections that depend on it. */
  send(ws: WebSocket, message: ServerMessage, frames?: FanOutFrames): void;
}

/**
 * Who receives what. Every audience the server sends to is decided here: all
 * signed-in connections, the participants of a call, the members allowed into
 * a channel (a forum's readers, or the audience of a private poll, for what
 * belongs to them). Delivery itself, one connection at a time, is `send`'s.
 */
export class Outbox {
  constructor(private readonly host: OutboxHost) {}

  /**
   * Sends every connection that may receive broadcasts — open, signed in and
   * not superseded by a newer connection of its device — the message
   * `messageFor` picks for it, if any. Recipients that end up with the same
   * message share one serialization (S-WS-8); bots are filtered by `send`.
   */
  publish(messageFor: (session: SignedInSession) => ServerMessage | undefined, skip?: WebSocket): void {
    const frames: FanOutFrames = new Map();
    for (const session of this.host.sessions()) {
      const { ws } = session;
      if (ws === skip || ws.readyState !== WebSocket.OPEN || !isSignedIn(session) || session.replaced) continue;
      const message = messageFor(session);
      if (message) this.host.send(ws, message, frames);
    }
  }

  broadcast(message: ServerMessage, ignoreWs?: WebSocket): void {
    this.publish(() => message, ignoreWs);
  }

  /** Delivers one message to the connections in a call, serialized once for all of them (S-WS-8). */
  sendToCall(channelId: string, message: ServerMessage): void {
    const frames: FanOutFrames = new Map();
    for (const participant of this.host.signaling.getParticipantsInChannel(channelId)) {
      const ws = this.host.findSocket(participant.sessionId);
      if (ws && ws.readyState === WebSocket.OPEN) this.host.send(ws, message, frames);
    }
  }

  /**
   * Scopes an event to the members allowed into the channel it belongs to
   * (#384). A deleted channel no longer has an audience; broadcasting it to
   * everyone would expose previously private content during a deletion race.
   */
  async broadcastToChannel(
    channelId: string,
    message: ServerMessage,
    ignoreWs?: WebSocket,
    canSend?: () => boolean
  ): Promise<void> {
    const channelVersion = this.host.channelAccessVersion();
    const roleVersion = this.host.permissions.getRoleAccessVersion();
    const isCurrent = () => channelVersion !== null && roleVersion !== null &&
      channelVersion === this.host.channelAccessVersion() && roleVersion === this.host.permissions.getRoleAccessVersion() &&
      (!canSend || canSend());
    if (!isCurrent()) return;
    const privatePoll = this.privatePollFor(message);
    if (privatePoll) {
      const frames: FanOutFrames = new Map();
      for (const session of this.host.sessions()) {
        if (!session.user || session.ws === ignoreWs || !this.host.isCurrentSession(session) ||
            session.ws.readyState !== WebSocket.OPEN || !this.host.canDeliverBotEvent(session, message) ||
            (canSend && !canSend())) continue;
        if (await this.host.pollService?.canView(session.user.id, privatePoll) && isCurrent() &&
            this.host.isCurrentSession(session)) this.host.send(session.ws, message, frames);
      }
      return;
    }
    const channel = await this.host.channels.getChannelSummary(channelId);
    if (!channel || !isCurrent()) return;
    if (channel.type === 'FORUM' || channel.forumId) {
      await this.forumActivity(channelId, [message], ignoreWs, isCurrent);
      return;
    }
    // Departures and closed producers never come this way: they go out at once
    // (VoiceSessionHandler.announceVoiceDeparture, SfuSignalingHandler.notifyProducersClosed).
    const isVoiceEvent = message.type === MessageType.VOICE_USER_JOINED || message.type === MessageType.VOICE_STATE_CHANGED;
    await this.toChannelAudience(channel, message, ignoreWs, isCurrent, isVoiceEvent ? channelId : undefined);
  }

  /** Messages about a forum topic, for the members who may read it. */
  async forumActivity(
    channelId: string, messages: ServerMessage[], ignoreWs?: WebSocket, canSend?: () => boolean
  ): Promise<void> {
    const frames: FanOutFrames = new Map();
    for (const session of this.host.sessions()) {
      if (!session.user || session.ws === ignoreWs || !this.host.isCurrentSession(session)) continue;
      const channels = this.host.channelAccessVersion();
      const roles = this.host.permissions.getRoleAccessVersion();
      if (channels === null || roles === null || !await this.host.forumService?.canRead(session.user.id, channelId) ||
          channels !== this.host.channelAccessVersion() || roles !== this.host.permissions.getRoleAccessVersion() ||
          !this.host.isCurrentSession(session) || (canSend && !canSend())) continue;
      for (const message of messages) this.host.send(session.ws, message, frames);
    }
  }

  /**
   * Ids of the connected users allowed into a channel. Permissions are resolved
   * once per person, not per socket, since one member may hold several
   * connections (#309), and the whole set is settled before anything is sent so
   * the delivery loop itself stays synchronous.
   */
  async channelAudience(
    channel: ChannelAccessRules & { id: string }, permission: Permission = Permission.VIEW_CHANNEL,
  ): Promise<Set<string>> {
    const userIds = new Set<string>();
    for (const session of this.host.sessions()) {
      if (session.user) userIds.add(session.user.id);
    }

    const allowed = new Set<string>();
    await Promise.all(
      Array.from(userIds).map(async (userId) => {
        const context = await this.host.channels.getAccessContext(userId);
        const rules = this.host.channels.rulesFor(channel, context);
        if (canAccessChannel(rules, context.permissions, context.roleIds, context.isBot, context.userId) &&
            hasChannelPermission(rules, context.permissions, context.roleIds, permission, context.isBot, context.userId)) {
          allowed.add(userId);
        }
      })
    );
    return allowed;
  }

  /**
   * Broadcasts an event that belongs to a channel, reaching only the members
   * allowed to see its content. Even public channels may deny message reading.
   */
  private async toChannelAudience(
    channel: ChannelAccessRules & { id: string },
    message: ServerMessage,
    ignoreWs?: WebSocket,
    canSend?: () => boolean,
    voiceChannelId?: string
  ): Promise<void> {
    const version = this.host.channelAccessVersion();
    const roleVersion = this.host.permissions.getRoleAccessVersion();
    if (version === null || roleVersion === null) return;
    const permission = BOT_CHAT_EVENTS.has(message.type) || message.type === MessageType.POLL_UPDATED
      ? Permission.READ_MESSAGES : Permission.VIEW_CHANNEL;
    const allowedUserIds = await this.channelAudience(channel, permission);
    if ((canSend && !canSend()) || version !== this.host.channelAccessVersion() ||
        roleVersion !== this.host.permissions.getRoleAccessVersion()) return;
    this.publish((session) => allowedUserIds.has(session.user.id) ||
      (voiceChannelId && this.host.hasBotVoiceGrant(session, voiceChannelId)) ? message : undefined, ignoreWs);
  }

  /** A private poll the message carries or is about: only its audience may receive it. */
  private privatePollFor(message: ServerMessage): NativePollRecord | undefined {
    const reference = pollReference(message);
    const polls = this.host.pollService;
    if (!polls || !reference) return undefined;
    const poll = 'pollId' in reference
      ? polls.repository.findById(reference.pollId)
      : polls.repository.findByMessageId(reference.messageId);
    return poll?.audience.visibility === 'private' ? poll : undefined;
  }
}
