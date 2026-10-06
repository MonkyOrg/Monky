import { randomUUID } from 'node:crypto';
import {
  MessageType, Permission, ProtocolErrorCode, eventListSchema, eventSaveSchema, eventControlSchema,
  eventInterestSchema, communitySettingsUpdateSchema, liveActionCreateSchema, liveActionUpdateSchema,
  eventIdRequestSchema, eventInterestedListSchema, communityImageUploadSchema,
  liveActionIdSchema, liveActionSubmitSchema, validateBotFormValues,
  nativeLiveFormCreateSchema, nativeLiveFormIdSchema, nativeLiveFormResultsRequestSchema,
  nativeLiveFormSubmitSchema,
  type ProtocolMessage, type ServerEvent, type LiveActionSubmission,
} from '@monky/shared';
import { ZodError } from 'zod';
import { CommunityService, CommunityError } from '../../application/services/CommunityService';
import type { ChannelService } from '../../application/services/ChannelService';
import type { BotInteractionSession, SelectorInvocationAuthorization } from './BotInteractionHandler';
import { RateLimiter } from '../security/RateLimiter';
import { Logger } from '../logger/Logger';

interface CommunityTransport {
  sessions(): Iterable<BotInteractionSession>;
  isCurrent(session: BotInteractionSession): boolean;
  accessVersion(): number | null;
  botSession(botId: string): BotInteractionSession | undefined;
  authorizeInvocation(session: BotInteractionSession, invocationId: string, channelId: string): Promise<SelectorInvocationAuthorization | undefined>;
  send(session: BotInteractionSession, message: ProtocolMessage): void;
  pollUpdated(poll: import('@monky/shared').NativePoll): Promise<void>;
}

export class CommunityHandler {
  private readonly timer: ReturnType<typeof setInterval>;
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private lastAccessVersion: number | null = -1;
  private submissions = new Map<string, number>();
  private pendingStarts = new Map<string, { event: ServerEvent; recipients: Set<BotInteractionSession> }>();

  constructor(
    private readonly service: CommunityService,
    private readonly channels: ChannelService,
    private readonly limiter: RateLimiter,
    private readonly transport: CommunityTransport,
  ) {
    this.timer = setInterval(() => {
      void this.enqueue(async () => {
        const result = service.advance();
        for (const event of result.started) this.queueStarted(event);
        for (const poll of result.polls) await transport.pollUpdated(poll);
        if (result.changed || this.lastAccessVersion !== transport.accessVersion()) await this.refreshNow();
        await this.flushStarted();
        const cutoff = Date.now() - 60_000;
        for (const [key, time] of this.submissions) if (time < cutoff) this.submissions.delete(key);
      }).catch((error: unknown) => Logger.error('NETWORK', 'Community scheduler failed.', error));
    }, 1000);
    this.timer.unref();
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.pending.then(async () => { if (!this.closed) await operation(); });
    this.pending = result.catch(() => {});
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await this.pending;
    this.submissions.clear();
    this.pendingStarts.clear();
  }

  refresh(): Promise<void> { return this.enqueue(() => this.refreshNow()); }

  handle(session: BotInteractionSession, type: MessageType, payload: unknown, requestId?: string): Promise<void> {
    return this.enqueue(async () => {
      if (!session.user || !this.transport.isCurrent(session)) return;
      try {
        if (!this.limiter.checkLimit(`community:${session.user.id}`, 30, 10_000)) {
          throw new CommunityError('Too many requests.', ProtocolErrorCode.RATE_LIMITED);
        }
        const userId = session.user.id;
        const accessVersion = this.transport.accessVersion();
        const assertCurrent = () => {
          if (accessVersion === null || !this.transport.isCurrent(session) || accessVersion !== this.transport.accessVersion()) {
            throw new CommunityError('Access changed. Try again.', ProtocolErrorCode.PERMISSION_DENIED);
          }
        };
        if (type === MessageType.COMMUNITY_GET) {
          this.requireHuman(session);
          const input = eventListSchema.parse(payload);
          await this.sendSnapshot(session, requestId, input.includeEnded);
          return;
        }
        if (type === MessageType.COMMUNITY_IMAGE_UPLOAD) {
          this.requireHuman(session);
          const input = communityImageUploadSchema.parse(payload);
          await this.service.requirePermission(userId, Permission.SEND_MESSAGES, input.channelId);
          const channel = await this.channels.getChannelSummary(input.channelId);
          if ((channel?.type !== 'TEXT' && channel?.type !== 'VOICE') ||
              !await this.channels.canUserAccessChannel(userId, input.channelId)) {
            throw new CommunityError('Channel unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
          }
          assertCurrent();
          const image = await this.service.stageImage(userId, input.channelId, input.imageData);
          assertCurrent();
          this.send(session, MessageType.COMMUNITY_IMAGE_UPLOAD, image, requestId);
          return;
        }
        if (type === MessageType.EVENT_GET) {
          this.requireHuman(session);
          const { id } = eventIdRequestSchema.parse(payload);
          const event = await this.service.getEvent(userId, id, assertCurrent);
          assertCurrent();
          this.send(session, MessageType.EVENT_SAVED, { event }, requestId);
          return;
        }
        if (type === MessageType.EVENT_GET_INTERESTED) {
          this.requireHuman(session);
          const result = await this.service.interestedMembers(userId, eventInterestedListSchema.parse(payload), assertCurrent);
          assertCurrent();
          this.send(session, MessageType.EVENT_INTERESTED_LIST, result, requestId);
          return;
        }
        if (type === MessageType.COMMUNITY_UPDATE_SETTINGS) {
          this.requireHuman(session);
          const closedPolls = await this.service.updateSettings(
            userId,
            communitySettingsUpdateSchema.parse(payload),
            assertCurrent,
          );
          for (const poll of closedPolls) await this.transport.pollUpdated(poll);
        } else if (type === MessageType.EVENT_SAVE) {
          this.requireHuman(session);
          const event = await this.service.saveEvent(userId, eventSaveSchema.parse(payload), Date.now(), assertCurrent);
          this.send(session, MessageType.EVENT_SAVED, { event: await this.service.publicEvent(event, userId) }, requestId);
          await this.refreshNow();
          return;
        } else if (type === MessageType.EVENT_CONTROL) {
          this.requireHuman(session);
          const event = await this.service.controlEvent(userId, eventControlSchema.parse(payload), Date.now(), assertCurrent);
          if (event?.status === 'active') { this.queueStarted(event); await this.flushStarted(); }
        } else if (type === MessageType.EVENT_INTEREST) {
          this.requireHuman(session);
          const input = eventInterestSchema.parse(payload);
          await this.service.setInterest(userId, input.id, input.interested, assertCurrent);
        } else if (type === MessageType.NATIVE_FORM_CREATE) {
          this.requireNativeForms(session);
          this.requireHuman(session);
          const form = await this.service.createNativeForm(
            userId,
            nativeLiveFormCreateSchema.parse(payload),
            Date.now(),
            assertCurrent,
          );
          this.send(session, MessageType.NATIVE_FORM_SNAPSHOT, form, requestId);
          await this.refreshNow();
          return;
        } else if (type === MessageType.NATIVE_FORM_SUBMIT) {
          this.requireNativeForms(session);
          this.requireHuman(session);
          const form = await this.service.submitNativeForm(
            userId,
            nativeLiveFormSubmitSchema.parse(payload),
            Date.now(),
            assertCurrent,
          );
          this.send(session, MessageType.NATIVE_FORM_SNAPSHOT, form, requestId);
          await this.refreshNow();
          return;
        } else if (type === MessageType.NATIVE_FORM_CLOSE) {
          this.requireNativeForms(session);
          this.requireHuman(session);
          await this.service.closeNativeForm(
            userId,
            nativeLiveFormIdSchema.parse(payload).id,
            Date.now(),
            assertCurrent,
          );
        } else if (type === MessageType.NATIVE_FORM_RESULTS) {
          this.requireNativeForms(session);
          this.requireHuman(session);
          const results = await this.service.nativeFormResults(
            userId,
            nativeLiveFormResultsRequestSchema.parse(payload),
            assertCurrent,
          );
          this.send(session, MessageType.NATIVE_FORM_RESULTS_RESULT, results, requestId);
          return;
        } else if (type === MessageType.LIVE_ACTION_CREATE) {
          const botId = this.requireBot(session);
          const input = liveActionCreateSchema.parse(payload);
          const authorization = await this.transport.authorizeInvocation(session, input.invocationId, input.channelId);
          if (!authorization) throw new CommunityError('A current command invocation is required.', ProtocolErrorCode.PERMISSION_DENIED);
          await this.service.requirePermission(authorization.creatorUserId, Permission.EMIT_LIVE_ACTIONS, input.channelId);
          await this.requireChannel(session, input.channelId, authorization.creatorUserId);
          if (!authorization.isCurrent() || !this.transport.isCurrent(session)) {
            throw new CommunityError('The invocation has ended.', ProtocolErrorCode.BOT_INTERACTION_EXPIRED);
          }
          assertCurrent();
          const action = this.service.createLiveAction(botId, authorization.creatorUserId, input);
          this.send(session, MessageType.LIVE_ACTION_SNAPSHOT, action, requestId);
          await this.refreshNow();
          return;
        } else if (type === MessageType.LIVE_ACTION_UPDATE) {
          const botId = this.requireBot(session);
          const input = liveActionUpdateSchema.parse(payload);
          const existing = this.service.ownedLiveAction(botId, input.id);
          await this.requireChannel(session, existing.channelId, existing.creatorUserId);
          if (!this.transport.isCurrent(session)) return;
          assertCurrent();
          const action = this.service.updateLiveAction(botId, input);
          this.send(session, MessageType.LIVE_ACTION_SNAPSHOT, action, requestId);
          await this.refreshNow();
          return;
        } else if (type === MessageType.LIVE_ACTION_CLOSE) {
          const { id } = liveActionIdSchema.parse(payload);
          if (session.isBot) this.service.closeLiveAction(this.requireBot(session), id);
          else {
            this.requireHuman(session);
            await this.service.closeLiveActionForUser(userId, id, assertCurrent);
          }
        } else if (type === MessageType.LIVE_ACTION_LIST) {
          const botId = this.requireBot(session);
          this.send(session, MessageType.LIVE_ACTION_LIST_RESULT, {
            liveActions: this.service.repository.liveActions().filter((action) => action.botId === botId),
          }, requestId);
          return;
        } else if (type === MessageType.LIVE_ACTION_SUBMIT) {
          this.requireHuman(session);
          const input = liveActionSubmitSchema.parse(payload);
          const action = this.service.repository.liveAction(input.id);
          if (!action || !await this.service.canViewLiveAction(userId, action)) {
            throw new CommunityError('Live action unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
          }
          await this.service.requirePermission(userId, Permission.USE_BOT_COMMANDS, action.channelId);
          await this.service.requirePermission(userId, Permission.SEND_MESSAGES, action.channelId);
          const channel = await this.channels.getChannelSummary(action.channelId);
          if (!channel?.botCommandsEnabled) throw new CommunityError('Commands are disabled.', ProtocolErrorCode.PERMISSION_DENIED);
          if (action.revision !== input.expectedRevision || action.content.kind !== 'form') {
            throw new CommunityError('The live action changed. Reopen it before responding.', ProtocolErrorCode.COMMUNITY_CONFLICT);
          }
          const validation = validateBotFormValues(action.content.form, input.values);
          if (!validation.success) throw new CommunityError('Invalid form response.', ProtocolErrorCode.BOT_INTERACTION_INVALID);
          const owner = this.transport.botSession(action.botId);
          if (!owner || !this.transport.isCurrent(owner)) throw new CommunityError('Bot offline.', ProtocolErrorCode.BOT_OFFLINE);
          const submissionKey = JSON.stringify([userId, input.id, requestId]);
          if (!requestId || !this.submissions.has(submissionKey)) {
            const submission: LiveActionSubmission = {
              ...input, values: validation.values, submissionId: randomUUID(), channelId: action.channelId,
              userId, userNickname: session.user.nickname,
            };
            if (!this.transport.isCurrent(session)) return;
            assertCurrent();
            this.send(owner, MessageType.LIVE_ACTION_SUBMITTED, submission);
            if (requestId) this.submissions.set(submissionKey, Date.now());
          }
          this.send(session, MessageType.COMMUNITY_ACK, {}, requestId);
          return;
        } else {
          throw new CommunityError('Unsupported community operation.');
        }
        this.send(session, MessageType.COMMUNITY_ACK, {}, requestId);
        await this.refreshNow();
      } catch (error: unknown) {
        const code = error instanceof CommunityError ? error.code :
          error instanceof ZodError ? ProtocolErrorCode.COMMUNITY_INVALID : ProtocolErrorCode.INTERNAL_ERROR;
        if (code === ProtocolErrorCode.INTERNAL_ERROR) Logger.error('NETWORK', 'Community operation failed.', error);
        this.send(session, MessageType.SERVER_ERROR, {
          code,
          message: error instanceof CommunityError ? error.message :
            code === ProtocolErrorCode.COMMUNITY_INVALID ? 'Invalid community request.' : 'Community operation failed.',
        }, requestId);
      }
    });
  }

  private async requireChannel(session: BotInteractionSession, channelId: string, accessUserId: string): Promise<void> {
    const channel = await this.channels.getChannelSummary(channelId);
    if (!session.user || !channel?.botCommandsEnabled ||
        !await this.channels.canUserAccessChannel(accessUserId, channelId)) {
      throw new CommunityError('Channel unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
    }
  }

  private requireHuman(session: BotInteractionSession): void {
    if (session.isBot) throw new CommunityError('This operation requires a human member.', ProtocolErrorCode.PERMISSION_DENIED);
  }

  private requireBot(session: BotInteractionSession): string {
    if (!session.isBot || !session.botId) throw new CommunityError('This operation requires a bot.', ProtocolErrorCode.PERMISSION_DENIED);
    return session.botId;
  }

  private requireNativeForms(session: BotInteractionSession): void {
    if (!session.protocol?.features.includes('native-live-forms')) {
      throw new CommunityError('Native live forms require an updated client.', ProtocolErrorCode.FEATURE_REQUIRES_UPDATE);
    }
  }

  private send(session: BotInteractionSession, type: MessageType, payload: unknown, requestId?: string): void {
    if (this.transport.isCurrent(session)) this.transport.send(session, { type, payload, requestId });
  }

  private async sendSnapshot(session: BotInteractionSession, requestId?: string, includeEnded = false): Promise<void> {
    if (!session.user || session.isBot) return;
    while (this.transport.isCurrent(session) && !this.closed) {
      const version = this.transport.accessVersion();
      if (version === null) {
        if (requestId) throw new CommunityError('Access is changing. Try again.', ProtocolErrorCode.PERMISSION_DENIED);
        return;
      }
      const snapshot = await this.service.snapshot(session.user.id, includeEnded);
      if (version !== this.transport.accessVersion()) continue;
      if (session.protocol?.features.includes('native-live-forms')) {
        this.send(session, MessageType.COMMUNITY_SNAPSHOT, snapshot, requestId);
      } else {
        const { nativeForms: _nativeForms, ...compatible } = snapshot;
        this.send(session, MessageType.COMMUNITY_SNAPSHOT, compatible, requestId);
      }
      return;
    }
  }

  private async refreshNow(): Promise<void> {
    this.lastAccessVersion = this.transport.accessVersion();
    for (const session of this.transport.sessions()) await this.sendSnapshot(session);
  }

  private queueStarted(event: ServerEvent): void {
    const key = `${event.id}:${event.startsAt}`;
    if (!this.pendingStarts.has(key)) this.pendingStarts.set(key, {
      event,
      recipients: new Set([...this.transport.sessions()].filter(session => session.user && !session.isBot && this.transport.isCurrent(session))),
    });
  }

  private async flushStarted(): Promise<void> {
    for (const [key, pending] of this.pendingStarts) {
      const event = this.service.repository.event(pending.event.id);
      if (!this.service.settings().eventsEnabled || event?.status !== 'active' || event.startsAt !== pending.event.startsAt) {
        this.pendingStarts.delete(key);
        continue;
      }
      for (const session of pending.recipients) {
        if (!session.user || !this.transport.isCurrent(session)) { pending.recipients.delete(session); continue; }
        const version = this.transport.accessVersion();
        if (version === null) continue;
        const visible = await this.service.canViewEvent(session.user.id, event);
        if (version !== this.transport.accessVersion()) continue;
        pending.recipients.delete(session);
        if (!visible) continue;
        const snapshot = await this.service.publicEvent(event, session.user.id);
        if (snapshot.interested) this.send(session, MessageType.EVENT_STARTED, { event: snapshot });
      }
      if (!pending.recipients.size) this.pendingStarts.delete(key);
    }
  }
}
