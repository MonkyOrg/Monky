import {
  ProtocolErrorCode,
  VoiceParticipantState,
  WebRtcSignalPayload,
} from '@monky/shared';
import { IChannelRepository } from '../../domain/repositories';
import { Logger } from '../../infrastructure/logger/Logger';

export class SignalingService {
  /** Hard cap on simultaneous screen shares per participant (#253). */
  private static readonly MAX_SCREEN_SHARES = 2;

  // Map of sessionId -> VoiceParticipantState. Keyed per connection, not per
  // person, so the same user can be in voice from two devices at once (#309).
  private voiceStates: Map<string, VoiceParticipantState> = new Map();

  constructor(private channelRepo: IChannelRepository) {}

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

    const newState: VoiceParticipantState = {
      sessionId,
      userId,
      channelId,
      isMuted: resolvedMuted,
      isDeafened: resolvedDeafened,
      serverMuted: previousState?.serverMuted ?? false,
      serverDeafened: previousState?.serverDeafened ?? false,
      isSpeaking: false,
      isCameraOn: previousState?.isCameraOn ?? false,
      isScreenSharing: isChannelChange ? false : (previousState?.isScreenSharing ?? false),
      isSharingScreenAudio: isChannelChange ? false : (previousState?.isSharingScreenAudio ?? false),
      screenShareIds: isChannelChange ? [] : (previousState?.screenShareIds ?? []),
    };

    this.voiceStates.set(sessionId, newState);
    Logger.info('WEBRTC', `Session ${sessionId} joined voice channel ${channelId}`);

    return {
      success: true,
      voiceState: newState,
      existingParticipants,
    };
  }

  public leaveVoiceChannel(sessionId: string): VoiceParticipantState | null {
    const current = this.voiceStates.get(sessionId);
    if (current) {
      this.voiceStates.delete(sessionId);
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
    };

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

    this.voiceStates.set(sessionId, updated);
    return updated;
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
    return list;
  }

  public validateSignalRouting(signal: WebRtcSignalPayload): boolean {
    const fromState = this.voiceStates.get(signal.fromSessionId);
    const targetState = this.voiceStates.get(signal.targetSessionId);

    if (!fromState || !targetState) {
      return false;
    }

    // Peers must be in the same voice channel to exchange WebRTC signals
    return fromState.channelId === targetState.channelId;
  }
}
