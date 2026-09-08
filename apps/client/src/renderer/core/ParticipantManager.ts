import { UserSummary, VoiceParticipantState, VoiceRosterParticipant } from '@monky/shared';
import { appEvents, EventBus } from './EventBus';
import { createActiveProxy } from './activeProxy';

export interface ParticipantViewModel {
  user: UserSummary;
  voiceState?: VoiceParticipantState;
  remoteStream?: MediaStream;
  /** Remote screen streams keyed by share id (#253). */
  remoteScreenStreams: Map<string, MediaStream>;
  isSpeaking: boolean;
  isReconnecting?: boolean;
  /** True when all WebRTC recovery attempts with this peer have been exhausted. */
  peerConnectionFailed?: boolean;
  /**
   * True while the WebRTC link with this peer is still being negotiated (#433).
   *
   * Silence during the handshake is indistinguishable from a broken call, so
   * this fills the gap between joining and the first connected state — and it
   * comes back during a recovery, when media really has stopped flowing.
   */
  isConnecting?: boolean;
  /**
   * True when media with this peer is going through the server's TURN relay
   * instead of a direct link (#425).
   *
   * Worth surfacing because a relayed call costs the host bandwidth and adds
   * latency, so the operator benefits from seeing when it is being used.
   */
  isRelayed?: boolean;
}

export class ParticipantManager {
  /** See ServerStore.bus: background servers get a silent bus (#400). */
  public bus: EventBus = appEvents;

  /**
   * Keyed by sessionId: the same person may be connected from several devices
   * at once, and each connection is its own voice participant (#309).
   */
  private participants: Map<string, ParticipantViewModel> = new Map();
  private updateScheduled = false;

  /** Falls back to the user id so a payload without a session still resolves. */
  private static keyOf(user: UserSummary): string {
    return user.sessionId || user.id;
  }

  /**
   * Coalesces multiple rapid mutations (e.g. voice state + stream + speaking
   * changes during a voice join) into a single 'participants.updated' emit per
   * animation frame, avoiding redundant full re-renders of the sidebars.
   */
  private scheduleUpdate(): void {
    if (this.updateScheduled) return;
    this.updateScheduled = true;
    const flush = () => {
      this.updateScheduled = false;
      this.bus.emit('participants.updated');
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(flush);
    } else {
      setTimeout(flush, 0);
    }
  }

  public setUsers(users: UserSummary[]): void {
    for (const u of users) {
      this.addUser(u);
    }
  }

  public addUser(user: UserSummary): void {
    const key = ParticipantManager.keyOf(user);
    const existing = this.participants.get(key);
    if (existing) {
      existing.user = user;
      // A (re)join means the user is connected again.
      existing.isReconnecting = false;
    } else {
      this.participants.set(key, {
        user,
        isSpeaking: false,
        remoteScreenStreams: new Map(),
      });
    }
    this.scheduleUpdate();
  }

  public setReconnecting(sessionId: string, reconnecting: boolean): void {
    const participant = this.participants.get(sessionId);
    if (participant && participant.isReconnecting !== reconnecting) {
      participant.isReconnecting = reconnecting;
      this.scheduleUpdate();
    }
  }

  public setPeerConnectionFailed(sessionId: string, failed: boolean): void {
    const participant = this.participants.get(sessionId);
    if (participant && participant.peerConnectionFailed !== failed) {
      participant.peerConnectionFailed = failed;
      this.scheduleUpdate();
    }
  }

  public setPeerConnecting(sessionId: string, connecting: boolean): void {
    const participant = this.participants.get(sessionId);
    if (participant && participant.isConnecting !== connecting) {
      participant.isConnecting = connecting;
      this.scheduleUpdate();
    }
  }

  public setPeerRelayed(sessionId: string, relayed: boolean): void {
    const participant = this.participants.get(sessionId);
    if (participant && participant.isRelayed !== relayed) {
      participant.isRelayed = relayed;
      this.scheduleUpdate();
    }
  }

  public removeUser(sessionId: string): void {
    this.participants.delete(sessionId);
    this.scheduleUpdate();
  }

  public updateUser(user: UserSummary): void {
    // A profile change (nickname/avatar) reaches us without a session, so it
    // has to be mirrored onto every connection of that person (#309).
    let changed = false;
    for (const participant of this.participants.values()) {
      if (participant.user.id === user.id) {
        participant.user = { ...user, sessionId: participant.user.sessionId, connectedAt: participant.user.connectedAt };
        changed = true;
      }
    }
    if (changed) {
      this.scheduleUpdate();
    } else {
      this.addUser(user);
    }
  }

  public updateVoiceState(voiceState: VoiceParticipantState): void {
    const participant = this.participants.get(voiceState.sessionId);
    if (participant) {
      participant.voiceState = voiceState;
      participant.isSpeaking = voiceState.isSpeaking;
      this.scheduleUpdate();
    }
  }

  public reconcileVoiceChannel(channelId: string, roster: VoiceRosterParticipant[]): void {
    const present = new Set(roster.map((p) => p.voiceState.sessionId));
    for (const p of this.getInVoiceChannel(channelId)) {
      if (p.voiceState && !present.has(p.voiceState.sessionId)) {
        this.removeVoiceState(p.voiceState.sessionId);
      }
    }
    for (const { user, voiceState } of roster) {
      if (voiceState.channelId !== channelId) continue;
      this.addUser(user);
      this.updateVoiceState(voiceState);
    }
  }

  public removeVoiceState(sessionId: string): void {
    const participant = this.participants.get(sessionId);
    if (participant) {
      participant.voiceState = undefined;
      participant.isSpeaking = false;
      // Every peer-link indicator describes a WebRTC link, and there is no link
      // to somebody who is not in a call. Keeping them would carry a stale
      // "relayed" or "no direct connection" badge into the member list (#466).
      participant.isConnecting = false;
      participant.peerConnectionFailed = false;
      participant.isRelayed = false;
      this.scheduleUpdate();
    }
  }

  public setRemoteStream(sessionId: string, stream: MediaStream): void {
    const participant = this.participants.get(sessionId);
    if (participant) {
      participant.remoteStream = stream;
      this.scheduleUpdate();
    }
  }

  public setRemoteScreenStream(sessionId: string, shareId: string, stream: MediaStream): void {
    const participant = this.participants.get(sessionId);
    if (participant) {
      participant.remoteScreenStreams.set(shareId, stream);
      this.scheduleUpdate();
    }
  }

  public removeRemoteScreenStream(sessionId: string, shareId: string): void {
    const participant = this.participants.get(sessionId);
    if (participant && participant.remoteScreenStreams.delete(shareId)) {
      this.scheduleUpdate();
    }
  }

  public setSpeaking(sessionId: string, speaking: boolean): void {
    const participant = this.participants.get(sessionId);
    if (participant && participant.isSpeaking !== speaking) {
      participant.isSpeaking = speaking;
      this.bus.emit('participants.speaking_changed', { sessionId, speaking });
    }
  }

  public get(sessionId: string): ParticipantViewModel | undefined {
    return this.participants.get(sessionId);
  }

  /** Every live connection of a person, oldest first (#309). */
  public getSessionsOfUser(userId: string): ParticipantViewModel[] {
    return this.getAll()
      .filter((p) => p.user.id === userId)
      .sort((a, b) => (a.user.connectedAt || 0) - (b.user.connectedAt || 0));
  }

  /**
   * A single representative connection of a person, preferring one that is in a
   * voice channel — used by views that list people rather than sessions (#309).
   */
  public getByUserId(userId: string): ParticipantViewModel | undefined {
    const sessions = this.getSessionsOfUser(userId);
    return sessions.find((p) => p.voiceState) || sessions[0];
  }

  /** Only flags a person as reconnecting when every device of theirs is (#309). */
  public isUserReconnecting(userId: string): boolean {
    const sessions = this.getSessionsOfUser(userId);
    return sessions.length > 0 && sessions.every((p) => p.isReconnecting);
  }

  /**
   * Adds a `(2)`, `(3)` … suffix when the same person is connected from more
   * than one device, so voice lists stay unambiguous. The suffix disappears on
   * its own once a single session is left (#309).
   */
  public displayName(participant: ParticipantViewModel): string {
    const sessions = this.getSessionsOfUser(participant.user.id);
    if (sessions.length < 2) return participant.user.nickname;
    const index = sessions.findIndex((p) => ParticipantManager.keyOf(p.user) === ParticipantManager.keyOf(participant.user));
    return index <= 0 ? participant.user.nickname : `${participant.user.nickname} (${index + 1})`;
  }

  public getAll(): ParticipantViewModel[] {
    return Array.from(this.participants.values());
  }

  public getInVoiceChannel(channelId: string): ParticipantViewModel[] {
    return this.getAll().filter((p) => p.voiceState?.channelId === channelId);
  }

  public clear(): void {
    this.participants.clear();
    this.scheduleUpdate();
  }
}

export function createParticipantManager(): ParticipantManager {
  return new ParticipantManager();
}

let activeParticipantManager = createParticipantManager();

export function setActiveParticipantManager(manager: ParticipantManager): void {
  activeParticipantManager = manager;
}

export const participantManager = createActiveProxy<ParticipantManager>(() => activeParticipantManager);
