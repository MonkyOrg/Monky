import {
  ProtocolErrorCode,
  VoiceParticipantState,
  WebRtcSignalPayload,
  type NativeScreenSignalPayload,
  type NativeScreenSource,
  type UserRoleSummary,
  screenWatchSignalSchema,
  type ScreenWatchSignalPayload,
} from '@monky/shared';
import { IChannelRepository, IVoiceRestrictionRepository } from '../../domain/repositories';
import type { VoiceRestrictions } from '../../domain/entities';
import { Logger } from '../../infrastructure/logger/Logger';

export class SignalingService {
  /** Hard cap on simultaneous screen shares per participant (#253). */
  private static readonly MAX_SCREEN_SHARES = 2;

  // Map of sessionId -> VoiceParticipantState. Keyed per connection, not per
  // person, so the same user can be in voice from two devices at once (#309).
  private voiceStates: Map<string, VoiceParticipantState> = new Map();
  private voiceMembershipListener?: () => void;
  private screenPeerEpochs = new Map<string, Map<string, string>>();
  private legacyScreenViewers = new Map<string, ScreenWatchSignalPayload>();
  private screenRoleIds = new Map<string, Set<string>>();
  private screenRoleVersion: number | null = null;
  private currentRoleVersion: () => number | null = () => null;
  private screenSubscriptionRevoked?: (request: Extract<NativeScreenSignalPayload, { action: 'watch' }>) => void;

  public configureScreenAccess(
    version: () => number | null,
    revoked: ((request: Extract<NativeScreenSignalPayload, { action: 'watch' }>) => void) | undefined,
  ): void {
    this.currentRoleVersion = version;
    this.screenSubscriptionRevoked = revoked;
  }

  public setScreenRoles(roles: readonly { id: string }[], userRoles: readonly UserRoleSummary[], version: number): void {
    const existing = new Set(roles.map(role => role.id));
    this.screenRoleIds = new Map(userRoles.map(user => [
      user.userId, new Set(user.roleIds.filter(id => existing.has(id))),
    ]));
    this.screenRoleVersion = version;
  }

  public invalidateScreenRoles(revocation: { roleId?: string; userId?: string }, version: number): void {
    // Remove authority at the write boundary without interrupting unrelated audiences.
    for (const [userId, roles] of this.screenRoleIds) {
      if (revocation.userId && revocation.userId !== userId) continue;
      if (revocation.roleId) roles.delete(revocation.roleId);
      else roles.clear();
    }
    this.screenRoleVersion = version;
  }

  public canSeeScreenSource(publisher: VoiceParticipantState, source: NativeScreenSource, viewerUserId?: string): boolean {
    if (!source.audience) return true;
    if (!viewerUserId) return false;
    if (publisher.userId === viewerUserId || source.audience.userIds.includes(viewerUserId)) return true;
    const version = this.currentRoleVersion();
    return version !== null && version === this.screenRoleVersion
      && source.audience.roleIds.some(id => this.screenRoleIds.get(viewerUserId)?.has(id));
  }

  public projectVoiceState(state: VoiceParticipantState, viewerUserId?: string): VoiceParticipantState {
    const sources = state.nativeScreenShares ?? [];
    const visible = sources.filter(source => this.canSeeScreenSource(state, source, viewerUserId));
    const hidden = new Set(sources.filter(source => !visible.includes(source)).map(source => source.shareId));
    const screenShareIds = (state.screenShareIds ?? []).filter(id => !hidden.has(id));
    return {
      ...state, screenShareIds,
      nativeScreenShares: visible.map(source => {
        if (viewerUserId === state.userId) return source;
        const { audience: _audience, ...descriptor } = source;
        return descriptor;
      }),
      isScreenSharing: hidden.size > 0 ? screenShareIds.length > 0 : state.isScreenSharing,
      isSharingScreenAudio: visible.some(source => source.audio)
        || (!sources.some(source => source.audio)
          && screenShareIds.some(id => !sources.some(source => source.shareId === id)) && state.isSharingScreenAudio),
    };
  }

  public canWatchScreen(publisherSessionId: string, viewerSessionId: string, shareId: string, instanceId?: string): boolean {
    const publisher = this.voiceStates.get(publisherSessionId);
    const viewer = this.voiceStates.get(viewerSessionId);
    if (!publisher || !viewer || publisher.channelId !== viewer.channelId || !publisher.screenShareIds?.includes(shareId)) return false;
    const source = publisher.nativeScreenShares?.find(source => source.shareId === shareId);
    return source ? (!instanceId || source.instanceId === instanceId)
      && this.canSeeScreenSource(publisher, source, viewer.userId) : !instanceId;
  }

  public reconcileScreenSubscriptions(): void {
    for (const [key, watch] of this.legacyScreenViewers) {
      if (!this.canWatchScreen(watch.targetSessionId, watch.fromSessionId, watch.streamId)
        || this.voiceStates.get(watch.targetSessionId)?.nativeScreenShares?.some(source => source.shareId === watch.streamId))
        this.legacyScreenViewers.delete(key);
    }
    for (const [key, { request }] of this.nativeScreenSubscriptions) {
      if (this.canWatchScreen(request.publisherSessionId, request.fromSessionId, request.shareId, request.sourceInstanceId)) continue;
      this.nativeScreenSubscriptions.delete(key);
      this.screenSubscriptionRevoked?.(request);
    }
  }
  private nativeScreenSubscriptions = new Map<string, {
    request: Readonly<Extract<NativeScreenSignalPayload, { action: 'watch' }>>;
    generation: number | null;
  }>();

  constructor(
    private channelRepo: IChannelRepository,
    private voiceRestrictions: IVoiceRestrictionRepository,
  ) {}

  public setVoiceMembershipListener(listener: (() => void) | undefined): void {
    this.voiceMembershipListener = listener;
  }

  public async joinVoiceChannel(
    sessionId: string,
    userId: string,
    channelId: string,
    initialMuted?: boolean,
    initialDeafened?: boolean
  ): Promise<{
    success: boolean;
    errorCode?: ProtocolErrorCode;
    errorMessage?: string;
    voiceState?: VoiceParticipantState;
    previousVoiceState?: VoiceParticipantState;
    existingParticipants?: VoiceParticipantState[];
  }> {
    const channel = await this.channelRepo.findById(channelId);
    if (!channel || channel.type !== 'VOICE') {
      return {
        success: false,
        errorCode: ProtocolErrorCode.CHANNEL_NOT_FOUND,
        errorMessage: 'Canal de voz não encontrado',
      };
    }

    // Check channel capacity (excluding this session's own possibly-lingering
    // state, e.g. when reconnecting into the same channel during the grace period).
    const currentInChannel = this.getParticipantsInChannel(channelId);
    const othersInChannel = currentInChannel.filter((p) => p.sessionId !== sessionId);
    if (othersInChannel.length >= channel.maxParticipants) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.CHANNEL_FULL,
        errorMessage: `Canal de voz está cheio (${channel.maxParticipants} participantes max).`,
      };
    }

    // If this session was already in another voice channel, leave first
    const previousState = this.voiceStates.get(sessionId);
    const existingParticipants = othersInChannel;

    const resolvedMuted = initialMuted !== undefined ? initialMuted : (previousState?.isMuted ?? false);
    const resolvedDeafened = initialDeafened !== undefined ? initialDeafened : (previousState?.isDeafened ?? false);

    // Changing channels ends any screen share (#565): a share belongs to the
    // room it started in, so carrying it over would leave the destination
    // showing the user as "sharing" with no video, while the old room's
    // producers are torn down. Reconnecting into the *same* channel (grace
    // period) is not a change and keeps the share alive.
    const isChannelChange = previousState !== undefined && previousState.channelId !== channelId;
    const restrictions = this.voiceRestrictions.getForUser(userId);

    const newState: VoiceParticipantState = {
      sessionId,
      userId,
      channelId,
      isMuted: resolvedMuted,
      isDeafened: resolvedDeafened,
      ...restrictions,
      isSpeaking: false,
      isCameraOn: previousState?.isCameraOn ?? false,
      isScreenSharing: isChannelChange ? false : (previousState?.isScreenSharing ?? false),
      isSharingScreenAudio: isChannelChange ? false : (previousState?.isSharingScreenAudio ?? false),
      screenShareIds: isChannelChange ? [] : (previousState?.screenShareIds ?? []),
      nativeScreenShares: isChannelChange ? [] : (previousState?.nativeScreenShares ?? []),
    };

    this.dropNativeScreenSubscriptionsFor(sessionId);
    this.voiceStates.set(sessionId, newState);
    this.voiceMembershipListener?.();
    Logger.info('WEBRTC', `Session ${sessionId} joined voice channel ${channelId}`);

    return {
      success: true,
      voiceState: newState,
      previousVoiceState: previousState,
      existingParticipants,
    };
  }

  public leaveVoiceChannel(sessionId: string): VoiceParticipantState | null {
    const current = this.voiceStates.get(sessionId);
    if (current) {
      this.voiceStates.delete(sessionId);
      this.dropNativeScreenSubscriptionsFor(sessionId);
      this.voiceMembershipListener?.();
      Logger.info('WEBRTC', `Session ${sessionId} left voice channel ${current.channelId}`);
      return current;
    }
    return null;
  }

  public updateVoiceState(
    sessionId: string,
    updates: Partial<VoiceParticipantState>
  ): VoiceParticipantState | null {
    const current = this.voiceStates.get(sessionId);
    if (!current) return null;

    const updated: VoiceParticipantState = {
      ...current,
      ...updates,
      sessionId: current.sessionId,
      userId: current.userId,
      channelId: current.channelId,
      serverMuted: current.serverMuted,
      serverDeafened: current.serverDeafened,
    };
    if (updated.serverMuted || updated.serverDeafened) updated.isSpeaking = false;

    // #253: a participant may broadcast more than one screen at a time, so
    // `screenShareIds` is the real state and `isScreenSharing` is derived from
    // it. Normalising here keeps the two in sync regardless of which field the
    // client sent, and keeps the boolean correct for clients that predate the
    // list.
    if (updates.screenShareIds !== undefined) {
      updated.screenShareIds = SignalingService.sanitizeShareIds(updates.screenShareIds);
      updated.isScreenSharing = updated.screenShareIds.length > 0;
    } else if (updates.isScreenSharing === false) {
      updated.screenShareIds = [];
    }
    updated.nativeScreenShares = (updated.nativeScreenShares ?? [])
      .filter(source => updated.screenShareIds?.includes(source.shareId))
      .map(source => {
        const previous = current.nativeScreenShares?.find(value => value.shareId === source.shareId);
        return previous?.audience ? { ...source, audience: previous.audience } : source;
      });
    const withdrawn = new Set((current.nativeScreenShares ?? [])
      .filter(source => !updated.nativeScreenShares?.some(value => value.shareId === source.shareId))
      .map(source => source.shareId));
    updated.screenShareIds = (updated.screenShareIds ?? []).filter(id => !withdrawn.has(id));
    if (withdrawn.size > 0) {
      updated.isScreenSharing = updated.screenShareIds.length > 0;
      if (!updated.isScreenSharing || current.nativeScreenShares?.some(source => source.audio && withdrawn.has(source.shareId))) {
        updated.isSharingScreenAudio = updated.nativeScreenShares.some(source => source.audio);
      }
    }
    this.voiceStates.set(sessionId, updated);
    this.reconcileScreenSubscriptions();
    return updated;
  }

  public setServerMuted(userId: string, muted: boolean): VoiceParticipantState[] {
    return this.setServerRestriction(userId, 'serverMuted', muted);
  }

  public setServerDeafened(userId: string, deafened: boolean): VoiceParticipantState[] {
    return this.setServerRestriction(userId, 'serverDeafened', deafened);
  }

  private setServerRestriction(
    userId: string,
    restriction: keyof VoiceRestrictions,
    value: boolean,
  ): VoiceParticipantState[] {
    const restrictions = { ...this.voiceRestrictions.getForUser(userId), [restriction]: value };
    // Persist before touching the roster: a failed write must not look like successful moderation.
    this.voiceRestrictions.save(userId, restrictions);
    return this.getSessionsOfUser(userId).map((state) => {
      const updated = { ...state, ...restrictions, isSpeaking: false };
      this.voiceStates.set(state.sessionId, updated);
      return updated;
    });
  }

  /**
   * Share ids are relayed verbatim to every other client, which uses them to
   * build DOM ids and attributes. Only MediaStream-shaped ids are accepted so a
   * malicious client cannot inject markup into other people's stage.
   */
  private static sanitizeShareIds(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((id): id is string => typeof id === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(id))
      .slice(0, SignalingService.MAX_SCREEN_SHARES);
  }

  public getVoiceState(sessionId: string): VoiceParticipantState | undefined {
    return this.voiceStates.get(sessionId);
  }

  public getVoiceRestrictions(userId: string): VoiceRestrictions {
    return this.voiceRestrictions.getForUser(userId);
  }

  /** Every voice session of a person, since they may be in from several devices (#309). */
  public getSessionsOfUser(userId: string): VoiceParticipantState[] {
    return Array.from(this.voiceStates.values()).filter((s) => s.userId === userId);
  }

  public getParticipantsInChannel(channelId: string): VoiceParticipantState[] {
    const list: VoiceParticipantState[] = [];
    for (const state of this.voiceStates.values()) {
      if (state.channelId === channelId) {
        list.push(state);
      }
    }
    return list;
  }

  public getAllVoiceStates(): Record<string, VoiceParticipantState> {
    const obj: Record<string, VoiceParticipantState> = {};
    for (const [sessionId, state] of this.voiceStates.entries()) {
      obj[sessionId] = state;
    }
    return obj;
  }

  public clearAllVoiceStates(): VoiceParticipantState[] {
    const list = Array.from(this.voiceStates.values());
    this.voiceStates.clear();
    this.nativeScreenSubscriptions.clear();
    this.screenPeerEpochs.clear();
    this.legacyScreenViewers.clear();
    if (list.length) this.voiceMembershipListener?.();
    return list;
  }

  public validateSignalRouting(signal: Pick<WebRtcSignalPayload, 'fromSessionId' | 'targetSessionId'>): boolean {
    const fromState = this.voiceStates.get(signal.fromSessionId);
    const targetState = this.voiceStates.get(signal.targetSessionId);

    if (!fromState || !targetState) {
      return false;
    }

    // Peers must be in the same voice channel to exchange WebRTC signals
    return fromState.channelId === targetState.channelId;
  }

  private dropNativeScreenSubscriptionsFor(sessionId: string): void {
    this.screenPeerEpochs.delete(sessionId);
    for (const peers of this.screenPeerEpochs.values()) peers.delete(sessionId);
    for (const [key, watch] of this.legacyScreenViewers) {
      if (watch.fromSessionId === sessionId || watch.targetSessionId === sessionId) this.legacyScreenViewers.delete(key);
    }
    for (const [key, subscription] of this.nativeScreenSubscriptions) {
      if (subscription.request.fromSessionId === sessionId || subscription.request.publisherSessionId === sessionId) {
        this.nativeScreenSubscriptions.delete(key);
        this.screenSubscriptionRevoked?.(subscription.request);
      }
    }
  }

  public getNativeScreenViewers(publisherSessionId: string, shareId: string, sourceInstanceId: string): string[] {
    return [...this.nativeScreenSubscriptions.values()].flatMap(({ request, generation }) =>
      generation !== null && request.publisherSessionId === publisherSessionId && request.shareId === shareId
        && request.sourceInstanceId === sourceInstanceId
        && this.canWatchScreen(publisherSessionId, request.fromSessionId, shareId, sourceInstanceId)
        ? [request.fromSessionId] : []);
  }

  /** Called only after authenticated signaling has been authorized and forwarded. */
  public trackScreenSignal(signal: WebRtcSignalPayload): void {
    const { fromSessionId: from, targetSessionId: target } = signal;
    if (signal.signalType === 'offer' || signal.signalType === 'answer') {
      if (!signal.subscriptionId) return;
      let peers = this.screenPeerEpochs.get(from);
      if (!peers) this.screenPeerEpochs.set(from, peers = new Map());
      if (peers.get(target) === signal.subscriptionId) return;
      peers.set(target, signal.subscriptionId);
      for (const [key, watch] of this.legacyScreenViewers) {
        if ((watch.fromSessionId === from && watch.targetSessionId === target)
          || (watch.fromSessionId === target && watch.targetSessionId === from)) this.legacyScreenViewers.delete(key);
      }
    } else if (signal.signalType === 'screen-watch') {
      const parsed = screenWatchSignalSchema.safeParse(signal);
      if (!parsed.success) return;
      const watch = parsed.data;
      if (this.screenPeerEpochs.get(target)?.get(from) !== watch.subscriptionId
        || this.screenPeerEpochs.get(from)?.get(target) !== watch.watcherSubscriptionId) return;
      const key = JSON.stringify([target, from, watch.streamId]);
      if ((this.legacyScreenViewers.get(key)?.subscriptionRevision ?? 0) >= watch.subscriptionRevision) return;
      this.legacyScreenViewers.set(key, watch);
    } else if (signal.signalType === 'user-left') {
      this.screenPeerEpochs.get(from)?.delete(target);
      this.screenPeerEpochs.get(target)?.delete(from);
      for (const [key, watch] of this.legacyScreenViewers) {
        if ((watch.fromSessionId === from && watch.targetSessionId === target)
          || (watch.fromSessionId === target && watch.targetSessionId === from)) this.legacyScreenViewers.delete(key);
      }
    }
  }

  public getLegacyScreenViewers(publisherSessionId: string, shareId: string): string[] {
    return [...this.legacyScreenViewers.values()].filter(watch => watch.watching
      && watch.targetSessionId === publisherSessionId && watch.streamId === shareId
      && this.canWatchScreen(publisherSessionId, watch.fromSessionId, shareId)).map(watch => watch.fromSessionId);
  }

  public authorizeNativeScreenSignal(signal: NativeScreenSignalPayload):
    { success: true; forward?: false } | { success: false; code: ProtocolErrorCode; message: string } {
    const reject = (message: string) => ({ success: false as const, code: ProtocolErrorCode.PERMISSION_DENIED, message });
    const viewerId = signal.fromSessionId === signal.publisherSessionId ? signal.targetSessionId : signal.fromSessionId;
    const key = JSON.stringify([signal.publisherSessionId, viewerId, signal.shareId]);
    const current = this.nativeScreenSubscriptions.get(key);
    if (signal.action === 'stop' && this.voiceStates.get(viewerId)?.channelId === signal.channelId
      && (!current || current.request.subscriptionId !== signal.subscriptionId
        || current.request.sourceInstanceId !== signal.sourceInstanceId)) {
      // Expired leases are already stopped; never forward an old Stop to a replacement source.
      return { success: true, forward: false };
    }
    const publisher = this.voiceStates.get(signal.publisherSessionId);
    if (!this.validateSignalRouting(signal) || publisher?.channelId !== signal.channelId) {
      return reject('A transmissão pertence a outra chamada.');
    }
    const source = publisher.nativeScreenShares?.find(value =>
      value.shareId === signal.shareId && value.instanceId === signal.sourceInstanceId);
    if (!source || !publisher.screenShareIds?.includes(source.shareId)) {
      return reject('A fonte desta transmissão não está mais disponível.');
    }
    if (!this.canWatchScreen(signal.publisherSessionId, viewerId, signal.shareId, signal.sourceInstanceId)) {
      return reject('A transmissão não está disponível.');
    }
    if (signal.action === 'watch') {
      if (current?.request.subscriptionId === signal.subscriptionId) {
        return current.request.sourceInstanceId === signal.sourceInstanceId
          && current.request.quality === signal.quality && current.request.backend === signal.backend
          ? { success: true } : reject('Uma assinatura existente não pode mudar de identidade.');
      }
      if (!current && [...this.nativeScreenSubscriptions.values()]
        .filter(value => value.request.fromSessionId === viewerId).length >= 64) {
        return reject('O limite de transmissões assistidas foi atingido.');
      }
      this.nativeScreenSubscriptions.set(key, { request: Object.freeze({ ...signal }), generation: null });
      return { success: true };
    }
    if (!current || current.request.subscriptionId !== signal.subscriptionId
      || current.request.sourceInstanceId !== signal.sourceInstanceId) {
      return reject('A assinatura desta transmissão expirou.');
    }
    if (signal.action === 'stop' || signal.action === 'closed') {
      this.nativeScreenSubscriptions.delete(key);
      return { success: true };
    }
    if (signal.action === 'accepted') {
      if (signal.quality !== current.request.quality || signal.backend !== current.request.backend
        || (current.generation !== null && current.generation !== signal.generation)) {
        return reject('A resposta não corresponde ao perfil solicitado.');
      }
      current.generation = signal.generation;
      return { success: true };
    }
    if (signal.action === 'capture-mode') {
      return signal.generation === current.generation
        ? { success: true } : reject('O modo de captura não pertence à assinatura confirmada.');
    }
    if (signal.control.generation !== current.generation) {
      return reject('O controle nativo não pertence à assinatura confirmada.');
    }
    if ('kind' in signal.control && signal.control.kind === 'audio' && !source.audio) {
      return reject('Esta transmissão não publicou áudio.');
    }
    return { success: true };
  }
}
