import { randomBytes, randomUUID } from 'node:crypto';
import {
  Permission, ProtocolErrorCode, communitySettingsUpdateSchema, eventSaveSchema, eventControlSchema,
  eventOccurrenceStart, liveActionCreateSchema, liveActionUpdateSchema,
  nativeLiveFormCreateSchema, nativeLiveFormResultsRequestSchema, nativeLiveFormSubmitSchema,
  projectResourceAudience,   validateNativeLiveFormValues,
  type CommunitySettings, type CommunitySnapshot, type EventSave, type EventControl,
  type ServerEvent, type ServerEventPublic, type LiveAction, type LiveActionRecord, type LiveActionCreate, type LiveActionUpdate,
  type CommunitySettingsUpdate, type EventInterestedList, type EventInterestedListResult, eventInterestedListSchema,
  type NativeLiveForm, type NativeLiveFormCreate, type NativeLiveFormRecord, type NativeLiveFormResults,
  type NativeLiveFormResultsRequest, type NativeLiveFormSubmit, type NativePoll,
} from '@monky/shared';
import type { ICommunityRepository } from '../../domain/community';
import type { AvatarStorageService } from '../../infrastructure/security/AvatarStorageService';
import type { ChannelService } from './ChannelService';
import type { PermissionService } from './PermissionService';
import type { BotSelectorService } from './BotSelectorService';
import type { NativePollService } from './NativePollService';

export class CommunityError extends Error {
  constructor(message: string, readonly code = ProtocolErrorCode.COMMUNITY_INVALID) { super(message); }
}

const DAY = 86_400_000;
const STAGED_IMAGE_TTL = 60 * 60_000;
const NATIVE_FORM_RETENTION = 30 * DAY;

interface StagedImage {
  path: string;
  userId: string;
  channelId: string;
  expiresAt: number;
}

export class CommunityService {
  private readonly stagedImages = new Map<string, StagedImage>();
  private readonly anonymousFormCursors = new Map<string, {
    formId: string;
    viewerId: string;
    rowCursor: string;
    expiresAt: number;
  }>();

  constructor(
    readonly repository: ICommunityRepository,
    private readonly channels: ChannelService,
    private readonly permissions: PermissionService,
    private readonly images: AvatarStorageService,
    private readonly selectors: BotSelectorService,
    private readonly botAllowed: (botId: string) => boolean,
    private readonly polls?: NativePollService,
  ) {
    this.images.deleteAvatarsWithPrefix('community-stage-');
  }

  settings(): CommunitySettings {
    const settings = this.repository.settings();
    return { eventsEnabled: settings.eventsEnabled, bannerUrl: this.images.getPublicUrl(settings.bannerPath) };
  }

  async requirePermission(userId: string, permission: Permission): Promise<void> {
    if (!await this.permissions.checkPermission(userId, permission)) {
      throw new CommunityError('Permission denied.', ProtocolErrorCode.PERMISSION_DENIED);
    }
  }

  async canViewEvent(userId: string, event: ServerEvent): Promise<boolean> {
    return await this.permissions.canAccessAudience(userId, event.creatorUserId, event.audience) &&
      (event.location.kind === 'external' ||
        await this.channels.canUserAccessChannel(userId, event.location.channelId));
  }

  async canViewLiveAction(userId: string, action: LiveActionRecord): Promise<boolean> {
    return this.settings().eventsEnabled && this.botAllowed(action.botId) && action.expiresAt > Date.now() &&
      (await this.channels.getChannelSummary(action.channelId))?.botCommandsEnabled === true &&
      await this.permissions.checkPermission(userId, Permission.READ_MESSAGES) &&
      await this.channels.canUserAccessChannel(userId, action.channelId) &&
      await this.permissions.canAccessAudience(userId, action.creatorUserId, action.audience);
  }

  async canViewNativeForm(userId: string, form: NativeLiveFormRecord): Promise<boolean> {
    return this.settings().eventsEnabled &&
      await this.permissions.checkPermission(userId, Permission.READ_MESSAGES) &&
      await this.channels.canUserAccessChannel(userId, form.channelId) &&
      await this.permissions.canAccessAudience(userId, form.creatorUserId, form.audience);
  }

  private async canManageAudienceResource(
    userId: string,
    creatorUserId: string,
    audience: ServerEvent['audience'],
    permission: Permission,
  ): Promise<boolean> {
    if (userId === creatorUserId || await this.permissions.checkPermission(userId, Permission.MANAGE_SERVER)) return true;
    return await this.permissions.isSelectedAudienceMember(userId, audience) &&
      await this.permissions.checkPermission(userId, permission);
  }

  async publicEvent(event: ServerEvent, userId: string): Promise<ServerEventPublic> {
    const reveal = await this.permissions.canRevealAudience(userId, event.creatorUserId);
    return {
      ...event,
      audience: projectResourceAudience(event.audience, reveal),
      ...this.repository.interest(event.id, userId),
    };
  }

  async publicLiveAction(action: LiveActionRecord, userId: string): Promise<LiveAction> {
    const reveal = await this.permissions.canRevealAudience(userId, action.creatorUserId);
    return { ...action, audience: projectResourceAudience(action.audience, reveal) };
  }

  async getEvent(userId: string, id: string, assertCurrent: () => void = () => {}): Promise<ServerEventPublic> {
    const event = this.repository.event(id);
    if (!this.settings().eventsEnabled || !event || !await this.canViewEvent(userId, event)) {
      throw new CommunityError('Event unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    assertCurrent();
    return this.publicEvent(event, userId);
  }

  async interestedMembers(userId: string, input: EventInterestedList, assertCurrent: () => void = () => {}): Promise<EventInterestedListResult> {
    const { id, cursor, limit } = eventInterestedListSchema.parse(input);
    await this.getEvent(userId, id, assertCurrent);
    assertCurrent();
    const rows = this.repository.interestedMembers(id, cursor, limit + 1);
    const users = rows.slice(0, limit).map(member => ({
      id: member.id, nickname: member.nickname, avatarUrl: this.images.getPublicUrl(member.avatarPath),
    }));
    return { id, users, nextCursor: rows.length > limit ? users.at(-1)!.id : null };
  }

  async snapshot(userId: string, includeEnded = false): Promise<CommunitySnapshot> {
    const settings = this.settings();
    const events: ServerEventPublic[] = [];
    if (settings.eventsEnabled) {
      for (const event of this.repository.events(includeEnded)) {
        if (await this.canViewEvent(userId, event)) events.push(await this.publicEvent(event, userId));
      }
    }
    const polls: NativePoll[] = [];
    const liveActions: LiveAction[] = [];
    const nativeForms: NativeLiveForm[] = [];
    if (settings.eventsEnabled) {
      for (const action of this.repository.liveActions()) {
        if (await this.canViewLiveAction(userId, action)) liveActions.push(await this.publicLiveAction(action, userId));
      }
      for (const poll of this.polls?.repository.listActiveLiveActions(Date.now()) ?? []) {
        if (await this.permissions.checkPermission(userId, Permission.READ_MESSAGES) &&
            await this.channels.canUserAccessChannel(userId, poll.channelId) &&
            await this.permissions.canAccessAudience(userId, poll.creatorUserId, poll.audience)) {
          polls.push(this.polls!.publicPoll(
            poll,
            userId,
            await this.permissions.canRevealAudience(userId, poll.creatorUserId),
          ));
        }
      }
      for (const form of this.repository.activeNativeForms(Date.now())) {
        if (await this.canViewNativeForm(userId, form)) nativeForms.push(await this.publicNativeForm(form, userId));
      }
    }
    return { settings, events, liveActions, polls, nativeForms };
  }

  async updateSettings(
    userId: string,
    input: CommunitySettingsUpdate,
    assertCurrent: () => void = () => {},
    now = Date.now(),
  ): Promise<NativePoll[]> {
    const parsed = communitySettingsUpdateSchema.parse(input);
    await this.requirePermission(userId, Permission.MANAGE_SERVER);
    assertCurrent();
    await this.requirePermission(userId, Permission.MANAGE_SERVER);
    const previous = this.repository.settings();
    const path = parsed.bannerBase64 === undefined ? previous.bannerPath : await this.saveImage(parsed.bannerBase64);
    const enabled = parsed.eventsEnabled ?? previous.eventsEnabled;
    const closing = previous.eventsEnabled && !enabled;
    const opening = !previous.eventsEnabled && enabled;
    const closedPolls: NativePoll[] = [];
    const expiredImageUrls: string[] = [];
    try {
      await this.requirePermission(userId, Permission.MANAGE_SERVER);
      assertCurrent();
      this.repository.transaction(() => {
        if (closing) {
          for (const action of this.repository.liveActions()) {
            this.repository.deleteLiveAction(action.id);
            expiredImageUrls.push(...action.imageUrls);
          }
          this.repository.closeExpiredNativeForms(now);
          for (const form of this.repository.activeNativeForms(now)) this.repository.closeNativeForm(form.id, now);
          if (this.polls) {
            closedPolls.push(...this.polls.advance(now));
            for (const poll of this.polls.repository.listActiveLiveActions(now)) {
              closedPolls.push(this.polls.publicPoll(this.polls.close(poll.id, now)));
            }
          }
        } else if (opening) {
          const pausedFor = Math.max(0, now - (previous.disabledAt ?? now));
          if (pausedFor > 0) {
            for (const event of this.repository.events()) {
              if (event.status !== 'scheduled' && event.status !== 'active') continue;
              event.startsAt += pausedFor;
              event.anchorStartsAt += pausedFor;
              if (event.endsAt !== null) event.endsAt += pausedFor;
              if (event.startedAt !== null) event.startedAt += pausedFor;
              event.revision++;
              this.repository.saveEvent(event);
            }
          }
        }
        this.repository.setSettings(enabled, path, enabled ? null : previous.disabledAt ?? now);
      });
    } catch (error) {
      if (path && path !== previous.bannerPath) this.images.deleteAvatar(path);
      throw error;
    }
    this.deleteImageUrls(expiredImageUrls);
    if (previous.bannerPath && path !== previous.bannerPath) this.images.deleteAvatar(previous.bannerPath);
    return closedPolls;
  }

  async saveEvent(userId: string, input: EventSave, now = Date.now(), assertCurrent: () => void = () => {}): Promise<ServerEvent> {
    const parsed = eventSaveSchema.parse(input);
    if (!this.settings().eventsEnabled) throw new CommunityError('Events are disabled.');
    const previous = parsed.id ? this.repository.event(parsed.id) : undefined;
    if (parsed.id && !previous) throw new CommunityError('Event not found.');
    if (previous) {
      if (!await this.canViewEvent(userId, previous) ||
          !await this.canManageAudienceResource(userId, previous.creatorUserId, previous.audience, Permission.MANAGE_EVENTS)) {
        throw new CommunityError('Event unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
      }
    } else {
      await this.requirePermission(userId, Permission.MANAGE_EVENTS);
    }
    if (previous && previous.status !== 'scheduled' && previous.status !== 'active') {
      throw new CommunityError('This event has ended.');
    }
    if (previous && previous.revision !== parsed.expectedRevision) throw new CommunityError('The event changed. Reload before editing.', ProtocolErrorCode.COMMUNITY_CONFLICT);
    if (parsed.endsAt !== null && parsed.endsAt <= now) throw new CommunityError('The end time must be in the future.');
    if ((!previous || previous.status === 'scheduled') && parsed.startsAt < now - 60_000) {
      throw new CommunityError('The start time must be in the future.');
    }
    if (parsed.startsAt > now + 2 * 366 * DAY) throw new CommunityError('Schedule events within the next two years.');
    if (previous?.status === 'active' && parsed.startsAt !== previous.startsAt) {
      throw new CommunityError('An active event cannot be rescheduled.');
    }
    if (parsed.location.kind !== 'external') {
      const channel = await this.channels.getChannelSummary(parsed.location.channelId);
      const expectedType = parsed.location.kind === 'voice' ? 'VOICE' : 'TEXT';
      if (channel?.type !== expectedType || channel.forumId ||
          !await this.channels.canUserAccessChannel(userId, channel.id)) {
        throw new CommunityError('Event channel unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
      }
    }
    const { imageBase64, imageSources, expectedRevision: _revision, id, ...definition } = parsed;
    const oldUrls = previous?.imageUrls.length ? previous.imageUrls : previous?.imageUrl ? [previous.imageUrl] : [];
    const oldPaths = oldUrls.map(url => url.split('/').pop()!).filter(Boolean);
    let paths = oldPaths;
    let imagesChanged = false;
    if (imageSources !== undefined || imageBase64 !== undefined) {
      imagesChanged = true;
      const sources = imageSources ?? (imageBase64 === null ? [] : [imageBase64!]);
      const created: string[] = [];
      try {
        paths = [];
        for (const source of sources) {
          if (source.startsWith('/avatars/')) {
            if (!oldUrls.includes(source)) throw new CommunityError('Event image is unavailable.');
            paths.push(source.split('/').pop()!);
          } else {
            const path = await this.saveImage(source);
            if (!path) throw new CommunityError('Invalid image.');
            paths.push(path);
            created.push(path);
          }
        }
      } catch (error) {
        this.deleteImagePaths(created);
        throw error;
      }
    }
    let saved = false;
    try {
      if (previous) {
        if (!await this.canManageAudienceResource(userId, previous.creatorUserId, previous.audience, Permission.MANAGE_EVENTS)) {
          throw new CommunityError('Event unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
        }
      } else {
        await this.requirePermission(userId, Permission.MANAGE_EVENTS);
      }
      assertCurrent();
      return this.repository.transaction(() => {
        if (!this.settings().eventsEnabled) throw new CommunityError('Events are disabled.');
        if (previous && this.repository.event(previous.id)?.revision !== previous.revision) {
          throw new CommunityError('The event changed. Reload before editing.', ProtocolErrorCode.COMMUNITY_CONFLICT);
        }
        if (!previous && this.repository.events().length >= 100) throw new CommunityError('Too many scheduled events.');
        const event: ServerEvent = {
          ...definition, id: id ?? randomUUID(), creatorUserId: previous?.creatorUserId ?? userId,
          imageUrl: this.images.getPublicUrl(paths[0] ?? null),
          imageUrls: paths.map(path => this.images.getPublicUrl(path)!),
          status: previous?.status ?? 'scheduled',
          createdAt: previous?.createdAt ?? now, revision: (previous?.revision ?? -1) + 1,
          occurrence: previous && previous.startsAt === definition.startsAt && previous.repeat === definition.repeat ? previous.occurrence : 0,
          anchorStartsAt: previous && previous.startsAt === definition.startsAt && previous.repeat === definition.repeat ? previous.anchorStartsAt : definition.startsAt,
          startedAt: previous?.startedAt ?? null, endedAt: null,
        };
        this.repository.saveEvent(event);
        saved = true;
        return event;
      });
    } catch (error) {
      if (imagesChanged) this.deleteImagePaths(paths.filter(path => !oldPaths.includes(path)));
      throw error;
    } finally {
      if (saved && imagesChanged) this.deleteImagePaths(oldPaths.filter(path => !paths.includes(path)));
    }
  }

  async controlEvent(userId: string, input: EventControl, now = Date.now(), assertCurrent: () => void = () => {}): Promise<ServerEvent | null> {
    const parsed = eventControlSchema.parse(input);
    const event = this.repository.event(parsed.id);
    if (!event || !await this.canViewEvent(userId, event) ||
        !await this.canManageAudienceResource(userId, event.creatorUserId, event.audience, Permission.MANAGE_EVENTS)) {
      throw new CommunityError('Event not found.');
    }
    assertCurrent();
    if (!await this.canManageAudienceResource(userId, event.creatorUserId, event.audience, Permission.MANAGE_EVENTS)) {
      throw new CommunityError('Event not found.');
    }
    if (event.revision !== parsed.expectedRevision) throw new CommunityError('The event changed. Reload before editing.', ProtocolErrorCode.COMMUNITY_CONFLICT);
    if (parsed.action === 'delete') {
      this.repository.deleteEvent(event.id);
      const urls = event.imageUrls.length ? event.imageUrls : event.imageUrl ? [event.imageUrl] : [];
      this.deleteImageUrls(urls);
      return null;
    }
    if (parsed.action === 'start') {
      if (!this.settings().eventsEnabled || event.status !== 'scheduled' || (event.endsAt !== null && event.endsAt <= now)) {
        throw new CommunityError('This event cannot be started.');
      }
      event.status = 'active';
      event.startedAt = now;
    } else if (parsed.action === 'end') {
      if (event.status !== 'active') throw new CommunityError('This event is not active.');
      event.status = 'ended';
      event.endedAt = now;
    } else {
      event.status = 'cancelled';
      event.endedAt = now;
    }
    event.revision++;
    this.repository.saveEvent(event);
    if (event.status === 'ended') this.scheduleNext(event, now);
    return event;
  }

  async setInterest(userId: string, id: string, interested: boolean, assertCurrent: () => void = () => {}): Promise<void> {
    const event = this.repository.event(id);
    if (!this.settings().eventsEnabled || !event || !await this.canViewEvent(userId, event) ||
        !['scheduled', 'active'].includes(event.status)) throw new CommunityError('Event not found.');
    assertCurrent();
    this.repository.setInterest(id, userId, interested);
  }

  advance(now = Date.now()): { changed: boolean; started: ServerEvent[]; polls: NativePoll[] } {
    const started: ServerEvent[] = [];
    const expiredImageUrls: string[] = [];
    let changed = false;
    this.repository.transaction(() => {
      if (this.settings().eventsEnabled) {
        for (const event of this.repository.events()) {
          if (event.endsAt !== null && event.endsAt <= now) {
            event.status = 'ended';
            event.endedAt = event.endsAt;
            event.revision++;
            this.repository.saveEvent(event);
            this.scheduleNext(event, now);
            changed = true;
          }
          if (event.status === 'scheduled' && event.startsAt <= now) {
            event.status = 'active';
            event.startedAt = now;
            event.revision++;
            this.repository.saveEvent(event);
            started.push(event);
            changed = true;
          }
        }
      }
      for (const action of this.repository.liveActions()) {
        const selector = action.content.kind === 'selector' ? this.selectors.get(action.content.selectorId) : undefined;
        if (action.expiresAt <= now || !this.botAllowed(action.botId) ||
            (action.content.kind === 'selector' && (!selector || selector.closedAt !== null ||
              (selector.expiresAt !== undefined && selector.expiresAt <= now)))) {
          this.repository.deleteLiveAction(action.id);
          expiredImageUrls.push(...action.imageUrls);
          changed = true;
        }
      }
    });
    this.deleteImageUrls(expiredImageUrls);
    for (const [ref, image] of this.stagedImages) {
      if (image.expiresAt > now) continue;
      this.images.deleteAvatar(image.path);
      this.stagedImages.delete(ref);
    }
    const polls = this.polls?.advance(now) ?? [];
    if (polls.length > 0) changed = true;
    if (this.repository.closeExpiredNativeForms(now).length > 0) changed = true;
    this.repository.deleteClosedNativeForms(now - NATIVE_FORM_RETENTION);
    return { changed, started, polls };
  }

  private scheduleNext(event: ServerEvent, now: number): void {
    if (event.repeat === 'none' || event.endsAt === null) return;
    const duration = event.endsAt - event.startsAt;
    let low = event.occurrence + 1;
    let high = low;
    while (eventOccurrenceStart(event, high) + duration <= now) high *= 2;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (eventOccurrenceStart(event, middle) + duration <= now) low = middle + 1;
      else high = middle;
    }
    event.occurrence = low;
    event.startsAt = eventOccurrenceStart(event, low);
    event.endsAt = event.startsAt + duration;
    event.status = 'scheduled';
    event.startedAt = event.endedAt = null;
    this.repository.saveEvent(event);
  }

  createLiveAction(botId: string, creatorUserId: string, input: LiveActionCreate, now = Date.now()): LiveActionRecord {
    const parsed = liveActionCreateSchema.parse(input);
    if (!this.settings().eventsEnabled) throw new CommunityError('Live actions are disabled.');
    this.requireBot(botId);
    this.checkDeadline(parsed.expiresAt, now);
    this.checkContent(botId, parsed.channelId, parsed.content);
    const existing = parsed.id ? this.repository.liveAction(parsed.id) : undefined;
    if (existing) {
      if (existing.botId !== botId || existing.creatorUserId !== creatorUserId || existing.channelId !== parsed.channelId) {
        throw new CommunityError('Live action belongs to another owner.', ProtocolErrorCode.PERMISSION_DENIED);
      }
      return existing;
    }
    const current = this.repository.liveActions();
    if (current.length >= 64 || current.filter((action) => action.botId === botId).length >= 16) {
      throw new CommunityError('Too many live actions.');
    }
    const { invocationId: _invocation, imageAssetRefs, id, ...definition } = parsed;
    const imageUrls = this.consumeImageAssets(imageAssetRefs ?? [], creatorUserId, parsed.channelId);
    const action: LiveActionRecord = {
      ...definition, imageUrls, id: id ?? randomUUID(), botId, creatorUserId, revision: 0, createdAt: now,
    };
    try {
      this.repository.saveLiveAction(action);
    } catch (error) {
      this.deleteImageUrls(imageUrls);
      throw error;
    }
    return action;
  }

  updateLiveAction(botId: string, input: LiveActionUpdate, now = Date.now()): LiveActionRecord {
    const parsed = liveActionUpdateSchema.parse(input);
    if (!this.settings().eventsEnabled) throw new CommunityError('Live actions are disabled.');
    this.requireBot(botId);
    const action = this.ownedLiveAction(botId, parsed.id);
    if (action.revision !== parsed.expectedRevision) throw new CommunityError('The live action changed.', ProtocolErrorCode.COMMUNITY_CONFLICT);
    const { id: _id, expectedRevision: _revision, imageAssetRefs, ...patch } = parsed;
    const expiresAt = patch.expiresAt ?? action.expiresAt;
    const content = patch.content ?? action.content;
    this.checkDeadline(expiresAt, now);
    this.checkContent(botId, action.channelId, content);
    const imageUrls = imageAssetRefs === undefined ? action.imageUrls :
      this.consumeImageAssets(imageAssetRefs, action.creatorUserId, action.channelId);
    const updated: LiveActionRecord = { ...action, ...patch, imageUrls, revision: action.revision + 1 };
    try {
      this.repository.saveLiveAction(updated);
    } catch (error) {
      if (imageAssetRefs !== undefined) this.deleteImageUrls(imageUrls);
      throw error;
    }
    if (imageAssetRefs !== undefined) this.deleteImageUrls(action.imageUrls);
    return updated;
  }

  closeLiveAction(botId: string, id: string): void {
    const action = this.ownedLiveAction(botId, id);
    this.deleteLiveAction(action);
  }

  async closeLiveActionForUser(
    userId: string,
    id: string,
    assertCurrent: () => void = () => {},
  ): Promise<void> {
    const action = this.repository.liveAction(id);
    if (!action || !await this.canViewLiveAction(userId, action) ||
        !await this.canManageAudienceResource(userId, action.creatorUserId, action.audience, Permission.EMIT_LIVE_ACTIONS)) {
      throw new CommunityError('Live action unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    assertCurrent();
    if (!await this.canManageAudienceResource(userId, action.creatorUserId, action.audience, Permission.EMIT_LIVE_ACTIONS)) {
      throw new CommunityError('Live action unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    this.deleteLiveAction(action);
  }

  async createNativeForm(
    userId: string,
    input: NativeLiveFormCreate,
    now = Date.now(),
    assertCurrent: () => void = () => {},
  ): Promise<NativeLiveForm> {
    const parsed = nativeLiveFormCreateSchema.parse(input);
    if (!this.settings().eventsEnabled) throw new CommunityError('Live actions are disabled.');
    await this.requirePermission(userId, Permission.EMIT_LIVE_ACTIONS);
    const channel = await this.channels.getChannelSummary(parsed.channelId);
    if ((channel?.type !== 'TEXT' && channel?.type !== 'VOICE') || channel.forumId ||
        !await this.channels.canUserAccessChannel(userId, parsed.channelId)) {
      throw new CommunityError('Channel unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    const active = this.repository.activeNativeForms(now);
    if (active.length >= 64 || active.filter(form => form.creatorUserId === userId).length >= 16) {
      throw new CommunityError('Too many native live forms.');
    }
    assertCurrent();
    await this.requirePermission(userId, Permission.EMIT_LIVE_ACTIONS);
    const form: NativeLiveFormRecord = {
      id: randomUUID(),
      channelId: parsed.channelId,
      creatorUserId: userId,
      form: parsed.form,
      expiresAt: now + parsed.durationMinutes * 60_000,
      closedAt: null,
      createdAt: now,
      revision: 0,
      audience: parsed.audience,
    };
    this.repository.saveNativeForm(form);
    return this.publicNativeForm(form, userId);
  }

  async submitNativeForm(
    userId: string,
    input: NativeLiveFormSubmit,
    now = Date.now(),
    assertCurrent: () => void = () => {},
  ): Promise<NativeLiveForm> {
    const parsed = nativeLiveFormSubmitSchema.parse(input);
    if (!this.settings().eventsEnabled) throw new CommunityError('Live actions are disabled.');
    const form = this.repository.nativeForm(parsed.id);
    if (!form || form.closedAt !== null || form.expiresAt <= now || !await this.canViewNativeForm(userId, form)) {
      throw new CommunityError('Live form unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    if (form.revision !== parsed.expectedRevision) {
      throw new CommunityError('The live form changed.', ProtocolErrorCode.COMMUNITY_CONFLICT);
    }
    const validation = validateNativeLiveFormValues(form.form, parsed.values);
    if (!validation.success) throw new CommunityError('Invalid form response.', ProtocolErrorCode.BOT_INTERACTION_INVALID);
    assertCurrent();
    this.repository.saveNativeFormResponse(form.id, userId, validation.values, now);
    return this.publicNativeForm(form, userId);
  }

  async closeNativeForm(
    userId: string,
    id: string,
    now = Date.now(),
    assertCurrent: () => void = () => {},
  ): Promise<void> {
    const form = this.repository.nativeForm(id);
    if (!form || !await this.canViewNativeForm(userId, form) ||
        !await this.canManageAudienceResource(userId, form.creatorUserId, form.audience, Permission.EMIT_LIVE_ACTIONS)) {
      throw new CommunityError('Live form unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    assertCurrent();
    if (!await this.canManageAudienceResource(userId, form.creatorUserId, form.audience, Permission.EMIT_LIVE_ACTIONS)) {
      throw new CommunityError('Live form unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    this.repository.closeNativeForm(id, now);
  }

  async nativeFormResults(
    userId: string,
    input: NativeLiveFormResultsRequest,
    assertCurrent: () => void = () => {},
  ): Promise<NativeLiveFormResults> {
    const parsed = nativeLiveFormResultsRequestSchema.parse(input);
    const form = this.repository.nativeForm(parsed.id);
    if (!form || !await this.canViewNativeForm(userId, form) ||
        !await this.canManageAudienceResource(userId, form.creatorUserId, form.audience, Permission.EMIT_LIVE_ACTIONS)) {
      throw new CommunityError('Live form unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
    }
    assertCurrent();
    const now = Date.now();
    let rowCursor = parsed.cursor;
    if (form.form.anonymous) {
      for (const [token, cursor] of this.anonymousFormCursors) {
        if (cursor.expiresAt <= now) this.anonymousFormCursors.delete(token);
      }
      if (parsed.cursor) {
        const cursor = this.anonymousFormCursors.get(parsed.cursor);
        this.anonymousFormCursors.delete(parsed.cursor);
        if (!cursor || cursor.formId !== form.id || cursor.viewerId !== userId || cursor.expiresAt <= now) {
          throw new CommunityError('Invalid live form results cursor.', ProtocolErrorCode.COMMUNITY_INVALID);
        }
        rowCursor = cursor.rowCursor;
      } else {
        rowCursor = undefined;
      }
    }
    const rows = this.repository.nativeFormResponses(form.id, rowCursor, parsed.limit + 1);
    const responses = rows.slice(0, parsed.limit).map(row => form.form.anonymous ? {
      user: null,
      response: { values: row.response.values },
    } : {
      user: {
        id: row.userId,
        nickname: row.nickname,
        avatarUrl: this.images.getPublicUrl(row.avatarPath),
      },
      response: row.response,
    });
    let nextCursor: string | null = null;
    if (rows.length > parsed.limit) {
      if (form.form.anonymous) {
        nextCursor = randomBytes(24).toString('base64url');
        this.anonymousFormCursors.set(nextCursor, {
          formId: form.id,
          viewerId: userId,
          rowCursor: rows[parsed.limit - 1]!.userId,
          expiresAt: now + 5 * 60_000,
        });
      } else {
        nextCursor = rows[parsed.limit - 1]!.userId;
      }
    }
    return {
      id: form.id,
      responses,
      nextCursor,
    };
  }

  async publicNativeForm(form: NativeLiveFormRecord, userId: string): Promise<NativeLiveForm> {
    const reveal = await this.permissions.canRevealAudience(userId, form.creatorUserId);
    return {
      ...form,
      audience: projectResourceAudience(form.audience, reveal),
      responseCount: this.repository.nativeFormResponseCount(form.id),
      myResponse: this.repository.nativeFormResponse(form.id, userId) ?? null,
    };
  }

  prepareChannelDeletion(channelId: string): () => void {
    const persistentPaths = new Set([
      ...this.repository.liveActions()
        .filter(action => action.channelId === channelId)
        .flatMap(action => action.imageUrls.map(url => url.split('/').pop()!).filter(Boolean)),
      ...(this.polls?.repository.listByChannel(channelId).flatMap(poll => poll.imagePaths) ?? []),
    ]);
    const stagedRefs = [...this.stagedImages]
      .filter(([, image]) => image.channelId === channelId)
      .map(([ref]) => ref);
    return () => {
      this.deleteImagePaths([...persistentPaths]);
      for (const ref of stagedRefs) {
        const image = this.stagedImages.get(ref);
        if (!image) continue;
        this.images.deleteAvatar(image.path);
        this.stagedImages.delete(ref);
      }
    };
  }

  prepareBotDeletion(botId: string): () => void {
    const persistentPaths = this.repository.liveActions()
      .filter(action => action.botId === botId)
      .flatMap(action => action.imageUrls.map(url => url.split('/').pop()!).filter(Boolean));
    return () => this.deleteImagePaths(persistentPaths);
  }

  ownedLiveAction(botId: string, id: string): LiveActionRecord {
    const action = this.repository.liveAction(id);
    if (!action || action.botId !== botId) throw new CommunityError('Live action not found.', ProtocolErrorCode.PERMISSION_DENIED);
    return action;
  }

  private deleteLiveAction(action: LiveActionRecord): void {
    this.repository.deleteLiveAction(action.id);
    this.deleteImageUrls(action.imageUrls);
  }

  private requireBot(botId: string): void {
    if (!this.botAllowed(botId)) throw new CommunityError('Live action capability is not granted.', ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED);
  }

  private checkContent(botId: string, channelId: string, content: LiveAction['content']): void {
    if (content.kind !== 'selector') return;
    const selector = this.selectors.get(content.selectorId);
    if (!selector || selector.botId !== botId || selector.channelId !== channelId || selector.closedAt !== null) {
      throw new CommunityError('The live action requires an open selector owned by this bot in this channel.');
    }
  }

  private checkDeadline(expiresAt: number, now: number): void {
    if (expiresAt <= now || expiresAt > now + 30 * DAY) throw new CommunityError('Live actions must expire within 30 days.');
  }

  async stageImage(userId: string, channelId: string, input: string, now = Date.now()): Promise<{ ref: string; url: string }> {
    const path = await this.saveImage(input, 'community-stage-');
    if (!path) throw new CommunityError('Invalid image.');
    const ref = randomUUID();
    this.stagedImages.set(ref, { path, userId, channelId, expiresAt: now + STAGED_IMAGE_TTL });
    return { ref, url: this.images.getPublicUrl(path)! };
  }

  resolveImageAssets(refs: string[], userId: string, channelId: string, now = Date.now()): string[] {
    if (new Set(refs).size !== refs.length) throw new CommunityError('Duplicate image asset.');
    return refs.map(ref => {
      const asset = this.stagedImages.get(ref);
      if (!asset || asset.userId !== userId || asset.channelId !== channelId || asset.expiresAt <= now) {
        throw new CommunityError('Image asset is unavailable.', ProtocolErrorCode.PERMISSION_DENIED);
      }
      return this.images.getPublicUrl(asset.path)!;
    });
  }

  consumeImageAssets(refs: string[], userId: string, channelId: string, now = Date.now()): string[] {
    this.resolveImageAssets(refs, userId, channelId, now);
    const assets = refs.map(ref => {
      const asset = this.stagedImages.get(ref)!;
      return { ref, asset };
    });
    const promoted: string[] = [];
    try {
      for (const { asset } of assets) promoted.push(this.images.renameAvatar(asset.path, 'community-media-'));
    } catch (error) {
      for (const path of promoted) this.images.deleteAvatar(path);
      for (const { ref, asset } of assets) {
        this.images.deleteAvatar(asset.path);
        this.stagedImages.delete(ref);
      }
      throw new CommunityError(error instanceof Error ? error.message : 'Could not store image.');
    }
    for (const { ref } of assets) this.stagedImages.delete(ref);
    return promoted.map(path => this.images.getPublicUrl(path)!);
  }

  deleteImagePaths(paths: string[]): void {
    for (const path of paths) this.images.deleteAvatar(path);
  }

  private deleteImageUrls(urls: string[]): void {
    this.deleteImagePaths(urls.map(url => url.split('/').pop()!).filter(Boolean));
  }

  private async saveImage(input: string | null, prefix = ''): Promise<string | null> {
    if (input === null) return null;
    const encoded = input.replace(/^data:image\/(?:png|jpeg|webp);base64,/, '');
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new CommunityError('Invalid image.');
    const result = this.images.validateAvatarBuffer(Buffer.from(encoded, 'base64'));
    if (!result.isValid || !result.buffer || !result.extension) throw new CommunityError(result.error ?? 'Invalid image.');
    return this.images.saveAvatar(result.buffer, result.extension, prefix);
  }
}
