import type { WebSocket } from 'ws';
import type { z } from 'zod';
import {
  MessageType, Permission, ProtocolErrorCode,
  nativePollCreateSchema, nativePollEditSchema, nativePollIdSchema, nativePollVoteSchema,
  type ProtocolFeature, type ServerMessage,
} from '@monky/shared';
import type { ChannelService } from '../../application/services/ChannelService';
import type { ChatService } from '../../application/services/ChatService';
import type { CommunityService } from '../../application/services/CommunityService';
import { NativePollError, type NativePollService } from '../../application/services/NativePollService';
import type { PermissionService } from '../../application/services/PermissionService';
import { auditRef } from '../../application/services/ServerAuditService';
import { pollChanges } from '../../application/services/serverAuditChanges';
import type { NativePollRecord } from '../../domain/entities';
import type { Authorizer } from './access/Authorizer';
import type { AuditRecorder } from './AuditRecorder';
import type { ClientSession, SignedInSession } from './ClientSession';
import type { CommunityHandler } from './CommunityHandler';
import type { UnexpectedFailure } from './protocolErrors';
import { route, type Route } from './routing/MessageRouter';

export interface PollHost {
  readonly pollService?: NativePollService;
  readonly channels: ChannelService;
  readonly chat: ChatService;
  readonly permissions: PermissionService;
  readonly communityService?: CommunityService;
  readonly community?: Pick<CommunityHandler, 'refresh'>;
  readonly authorizer: Pick<Authorizer, 'authorizeChannel'>;
  readonly auditLog: AuditRecorder;
  send(ws: WebSocket, message: ServerMessage): void;
  sendError(ws: WebSocket, code: ProtocolErrorCode, message: string, requestId?: string): void;
  sendCaughtError(ws: WebSocket, error: unknown, failure: UnexpectedFailure, requestId?: string): void;
  broadcastToChannel(channelId: string, message: ServerMessage, ignoreWs?: WebSocket, canSend?: () => boolean): Promise<void>;
}

/**
 * Native polls: created in a message channel, voted, closed and edited, and
 * read back with their voters or as the editor sees them. Polls run as live
 * actions also move the community view, and are always in the audit log.
 */
export class PollHandler {
  constructor(private readonly host: PollHost) {}

  routes(): Route[] {
    // People only: bots have no poll operation, and older apps cannot draw what they did not negotiate.
    const unavailable = (message: string, feature?: ProtocolFeature) => ({
      when: (session: ClientSession) => !this.host.pollService || !session.user || session.isBot === true ||
        (feature !== undefined && !session.protocol?.features.includes(feature)),
      message,
    });
    const polls = unavailable('Native polls unavailable.');
    const invalid = 'Invalid poll.';
    return [
      route({
        types: [MessageType.POLL_CREATE], unavailable: polls, schema: { type: nativePollCreateSchema, message: invalid },
        channel: { id: (poll) => poll.channelId, permissions: [Permission.SEND_MESSAGES, Permission.READ_MESSAGES] },
        handle: ({ session, payload, requestId }) => this.create(session, payload, requestId),
      }),
      route({
        types: [MessageType.POLL_VOTE], unavailable: polls, schema: { type: nativePollVoteSchema, message: 'Invalid vote.' },
        handle: ({ session, payload, requestId }) => this.vote(session, payload, requestId),
      }),
      route({
        types: [MessageType.POLL_CLOSE], unavailable: polls, schema: { type: nativePollIdSchema, message: invalid },
        handle: ({ session, payload, requestId }) => this.close(session, payload.id, requestId),
      }),
      route({
        types: [MessageType.POLL_VOTERS], unavailable: unavailable('Poll voters unavailable.', 'poll-voters'),
        schema: { type: nativePollIdSchema, message: invalid },
        handle: ({ session, payload, requestId }) => this.voters(session, payload.id, requestId),
      }),
      route({
        types: [MessageType.POLL_EDIT], unavailable: unavailable('Poll editing unavailable.', 'poll-edit'),
        schema: { type: nativePollEditSchema, message: invalid },
        handle: ({ session, payload, requestId }) => this.edit(session, payload, requestId),
      }),
      route({
        types: [MessageType.POLL_GET], unavailable: unavailable('Poll editing unavailable.', 'poll-edit'),
        schema: { type: nativePollIdSchema, message: invalid },
        handle: ({ session, payload, requestId }) => this.get(session, payload.id, requestId),
      }),
    ];
  }

  /** The route already checked that the member may write and read in the channel. */
  private async create(session: SignedInSession, poll: z.output<typeof nativePollCreateSchema>, requestId?: string): Promise<void> {
    const channel = await this.host.channels.getChannelSummary(poll.channelId);
    if (!channel || channel.forumId || (channel.type !== 'TEXT' && channel.type !== 'VOICE')) {
      this.host.sendError(session.ws, ProtocolErrorCode.CHANNEL_NOT_FOUND, 'Polls require a message channel.', requestId);
      return;
    }
    if (poll.liveAction &&
        !(await this.host.authorizer.authorizeChannel(session, poll.channelId, [Permission.EMIT_LIVE_ACTIONS], requestId))) return;
    if (poll.liveAction && this.liveActionsDisabled()) {
      this.host.sendError(session.ws, ProtocolErrorCode.COMMUNITY_INVALID, 'Live actions are disabled.', requestId);
      return;
    }
    await this.attempt(session, requestId, 'Could not create poll.', async () => {
      const result = this.polls.create(session.user.id, poll);
      const [message] = await this.host.chat.loadHistory(poll.channelId, 1, undefined, result.poll.messageId, session.user.id);
      if (!message) throw new NativePollError('Poll message was not persisted.', ProtocolErrorCode.INTERNAL_ERROR);
      if (!result.created) {
        this.host.send(session.ws, { type: MessageType.CHAT_MESSAGE, requestId, payload: message });
        return;
      }
      await this.host.broadcastToChannel(message.channelId, { type: MessageType.CHAT_MESSAGE, requestId, payload: message });
      if (result.poll.liveAction) {
        await this.audit(session, 'poll.create', undefined, result.poll);
        await this.host.community?.refresh();
      }
    });
  }

  private async vote(session: SignedInSession, vote: z.output<typeof nativePollVoteSchema>, requestId?: string): Promise<void> {
    await this.attempt(session, requestId, 'Could not record vote.', async () => {
      const existing = await this.visible(session, vote.id, [Permission.SEND_MESSAGES], requestId);
      if (!existing) return;
      const updated = this.polls.vote(session.user.id, vote.id, vote.optionIds);
      await this.publish(session, updated, requestId);
      if (updated.liveAction) await this.host.community?.refresh();
    });
  }

  /** The creator, server managers and, for a selected audience, its members who may emit live actions. */
  private async close(session: SignedInSession, pollId: string, requestId?: string): Promise<void> {
    await this.attempt(session, requestId, 'Could not close poll.', async () => {
      const existing = await this.visible(session, pollId, [], requestId);
      if (!existing) return;
      const userId = session.user.id;
      const canManage = existing.creatorUserId === userId ||
        await this.host.permissions.checkPermission(userId, Permission.MANAGE_SERVER) ||
        (await this.host.permissions.isSelectedAudienceMember(userId, existing.audience) &&
          await this.host.channels.canUserAccessChannel(userId, existing.channelId, Permission.EMIT_LIVE_ACTIONS));
      if (!canManage) {
        this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Poll unavailable.', requestId);
        return;
      }
      const closed = this.polls.close(existing.id);
      await this.publish(session, closed, requestId);
      if (existing.liveAction || existing.creatorUserId !== userId) await this.audit(session, 'poll.close', existing, closed);
      if (existing.liveAction) await this.host.community?.refresh();
    });
  }

  private async voters(session: SignedInSession, pollId: string, requestId?: string): Promise<void> {
    await this.attempt(session, requestId, 'Could not load poll voters.', async () => {
      const poll = await this.visible(session, pollId, [Permission.READ_MESSAGES], requestId);
      if (poll) this.host.send(session.ws, { type: MessageType.POLL_VOTERS_RESULT, requestId, payload: this.polls.voters(poll) });
    });
  }

  /** The creator and server managers may change an open poll. */
  private async edit(session: SignedInSession, edit: z.output<typeof nativePollEditSchema>, requestId?: string): Promise<void> {
    await this.attempt(session, requestId, 'Could not edit poll.', async () => {
      const existing = await this.visible(session, edit.id, [], requestId);
      if (!existing) return;
      if (existing.creatorUserId !== session.user.id &&
          !await this.host.permissions.checkPermission(session.user.id, Permission.MANAGE_SERVER)) {
        this.host.sendError(session.ws, ProtocolErrorCode.PERMISSION_DENIED, 'Poll unavailable.', requestId);
        return;
      }
      if (edit.liveAction && !existing.liveAction) {
        if (!(await this.host.authorizer.authorizeChannel(session, existing.channelId, [Permission.EMIT_LIVE_ACTIONS], requestId))) return;
        if (this.liveActionsDisabled()) {
          this.host.sendError(session.ws, ProtocolErrorCode.COMMUNITY_INVALID, 'Live actions are disabled.', requestId);
          return;
        }
      }
      const updated = this.polls.edit(session.user.id, edit);
      await this.publish(session, updated, requestId);
      if (existing.liveAction || updated.liveAction || existing.creatorUserId !== session.user.id) {
        await this.audit(session, 'poll.edit', existing, updated);
      }
      if (existing.liveAction || updated.liveAction) await this.host.community?.refresh();
    });
  }

  /** Broadcast polls carry no personal vote or revealed audience; an editor starts from its own view. */
  private async get(session: SignedInSession, pollId: string, requestId?: string): Promise<void> {
    await this.attempt(session, requestId, 'Could not load poll.', async () => {
      const poll = await this.visible(session, pollId, [Permission.READ_MESSAGES], requestId);
      if (poll) {
        this.host.send(session.ws, {
          type: MessageType.POLL_UPDATED, requestId, payload: await this.polls.publicPollForUser(poll, session.user.id),
        });
      }
    });
  }

  /** The routes answer FEATURE_REQUIRES_UPDATE before any handler runs on a server without polls. */
  private get polls(): NativePollService {
    const polls = this.host.pollService;
    if (!polls) throw new Error('Native polls are unavailable.');
    return polls;
  }

  /**
   * A poll the member may see, holding `permissions` in its channel. A missing
   * or hidden one throws the refusal; a channel refused is answered there.
   */
  private async visible(
    session: SignedInSession, pollId: string, permissions: readonly Permission[], requestId?: string,
  ): Promise<NativePollRecord | undefined> {
    const poll = this.polls.get(pollId);
    if (!(await this.host.authorizer.authorizeChannel(session, poll.channelId, permissions, requestId))) return undefined;
    if (!await this.polls.canView(session.user.id, poll)) throw new NativePollError('Poll not found.', ProtocolErrorCode.PERMISSION_DENIED);
    return poll;
  }

  /** The member gets the poll as they see it, with their vote; the channel gets the public one. */
  private async publish(session: SignedInSession, poll: NativePollRecord, requestId?: string): Promise<void> {
    const personalized = await this.polls.publicPollForUser(poll, session.user.id);
    this.host.send(session.ws, { type: MessageType.POLL_UPDATED, requestId, payload: personalized });
    await this.host.broadcastToChannel(poll.channelId, { type: MessageType.POLL_UPDATED, payload: this.polls.publicPoll(poll) });
  }

  /** Runs one poll operation: a refusal goes back as the service worded it, a failure only in general terms. */
  private async attempt(session: SignedInSession, requestId: string | undefined, failure: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error: unknown) {
      this.host.sendCaughtError(session.ws, error, { message: failure, category: 'NETWORK' }, requestId);
    }
  }

  private liveActionsDisabled(): boolean {
    return !!this.host.communityService && !this.host.communityService.settings().eventsEnabled;
  }

  /** Polls run as live actions are always recorded; ordinary polls only when someone else's is changed. */
  private async audit(
    session: SignedInSession, action: 'poll.create' | 'poll.edit' | 'poll.close', before: NativePollRecord | undefined, after: NativePollRecord,
  ): Promise<void> {
    if (!this.host.auditLog.enabled) return;
    this.host.auditLog.record(session, action, {
      target: auditRef.of('poll', after.id, after.question),
      related: {
        channel: await this.host.auditLog.channel(after.channelId),
        author: after.creatorUserId !== session.user.id ? await this.host.auditLog.identity(after.creatorUserId) : null,
      },
      changes: action === 'poll.close' ? [] : pollChanges(before, after),
    });
  }
}
