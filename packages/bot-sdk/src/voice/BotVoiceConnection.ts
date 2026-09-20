import { randomUUID } from 'crypto';
import { performance } from 'node:perf_hooks';
import {
  MessageType, botVoiceJoinedSchema, botVoiceLeftSchema, botVoiceSignalSchema, botVoiceTransportSchema,
  voiceRestrictionsUpdatedSchema,
  botVoiceParticipantSchema, botVoiceProducerSchema, botVoiceProducersSchema, botVoiceConsumerSchema, isReceivingBotVoice,
  type BotVoiceAuth, type BotVoiceJoinOptions, type VoiceStateUpdatePayload, type BotVoiceParticipant, type BotVoiceProducer,
} from '@monky/shared';
import type { OpusPeer } from './OpusPeer';
import type { SfuOpusReceiver } from './SfuOpusReceiver';
import type { RtpPacket } from 'werift';
import { VoiceAudioReceiver, type BotVoiceAudioReceiver } from './VoiceAudioReceiver';

export const SPEAKING_HANGOVER_MS = 250;

interface VoiceMessage { type: string; payload?: unknown; requestId?: string }
interface Participant { sessionId: string; userId: string; isBot: boolean; muted: boolean }
interface PendingRequest {
  expected: MessageType;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}
export interface VoiceCallbacks {
  send(message: VoiceMessage): void;
  participants(count: number): void;
  disconnected(reason: string): void;
  error(error: Error): void;
}

/** Encoded Opus only. The application owns decoding, pacing, and its queue. */
export class BotVoiceConnection {
  private readonly peers = new Map<string, OpusPeer>();
  private readonly participants = new Map<string, Participant>();
  private readonly pending = new Map<string, PendingRequest>();
  private readonly retiring = new Set<Promise<void>>();
  private sfu: OpusPeer | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private admitted = false;
  private muted = false;
  private writing = false;
  private speaking = false;
  private activityEpoch = 0;
  private lastAudioAt = 0;
  private speakingTimer?: ReturnType<typeof setTimeout>;
  private count = 0;
  private earlySignals: VoiceMessage[] = [];
  private Peer?: typeof OpusPeer;
  private receiveRequested = false;
  private receiving = false;
  private receiveEpoch = 0;
  private ownState?: BotVoiceParticipant['voiceState'];
  private audioReceiver?: VoiceAudioReceiver;
  private receiveTasks: Promise<void> = Promise.resolve();
  private queuedReception = 0;
  private sfuReceive?: { transportId: string; peer: SfuOpusReceiver; epoch: number; consumed: Set<string> };
  private readonly producers = new Map<string, BotVoiceProducer>();

  constructor(
    readonly channelId: string,
    private readonly auth: BotVoiceAuth,
    private readonly callbacks: VoiceCallbacks,
    private publishAudio = true,
  ) {}

  get humanParticipantCount(): number { return this.count; }
  get isClosed(): boolean { return this.closed; }
  get isReceivingAudio(): boolean { return !this.closed && this.receiving; }
  get receivesAudio(): boolean { return this.receiveRequested; }

  async join(options: BotVoiceJoinOptions = {}): Promise<void> {
    this.receiveRequested = options.receiveAudio === true;
    try {
      this.Peer = (await import('./OpusPeer')).OpusPeer;
      if (this.closed) throw new Error('Voice join cancelled.');
      const response = await this.request(MessageType.VOICE_JOIN, {
        ...options, channelId: this.channelId, isMuted: false, isDeafened: false,
      }, MessageType.VOICE_USER_JOINED);
      if (this.closed) throw new Error('Voice join cancelled.');
      const joined = botVoiceJoinedSchema.parse(response);
      if (joined.channelId !== this.channelId || joined.sessionId !== this.auth.currentUser.sessionId || !joined.participants) {
        throw new Error('Invalid voice admission acknowledgement.');
      }
      this.admitted = true;
      if (this.receiveRequested && (!joined.voiceState.receivesVoice || joined.voiceState.botVoicePermissions?.receive === false)) {
        throw new Error('Server did not authorize microphone reception.');
      }
      this.publishAudio = this.publishAudio && joined.voiceState.botVoicePermissions?.publish !== false;
      this.ownState = joined.voiceState;
      this.muted = voiceIsMuted(joined.voiceState);
      this.receiving = this.receiveRequested && isReceivingBotVoice(this.ownState);
      // The response snapshot supersedes broadcasts received during admission.
      this.participants.clear();
      for (const participant of joined.participants) {
        this.rememberParticipant(participant);
      }
      this.updateParticipants();
      if (this.auth.server.voiceMode === 'sfu') {
        if (this.publishAudio) await this.joinSfu();
        if (this.receiving) await this.startSfuReception(this.receiveEpoch);
      }
      else {
        for (const participant of this.participants.values()) this.ensurePeer(participant.sessionId, true);
        for (const signal of this.earlySignals.splice(0)) this.handle(signal);
        let observed: OpusPeer[];
        do {
          observed = [...this.peers.values()];
          await Promise.all([...this.peers.entries()].map(async ([sessionId, peer]) => {
            try { await peer.ready; }
            catch (error) {
              if (this.closed || this.peers.get(sessionId) === peer) throw error;
            }
          }));
          // A leave/rejoin can replace a peer while its old readiness settles.
          // Admission must wait for the replacement, not just the old snapshot.
        } while ([...this.peers.values()].some((peer) => !observed.includes(peer)));
      }
      if (this.closed) throw new Error('Voice join cancelled.');
    } catch (error) {
      await this.stop('join_failed', true);
      throw error;
    }
  }

  receiveAudio({ signal }: { signal?: AbortSignal } = {}): BotVoiceAudioReceiver {
    if (this.closed || !this.admitted) throw new Error('Voice connection is not active.');
    if (!this.receiveRequested) throw new Error('Join with receiveAudio: true and an approved receive_voice capability first.');
    if (signal?.aborted) throw new Error('Voice reception was cancelled.');
    if (this.audioReceiver) throw new Error('Only one audio receiver may own this voice connection at a time.');
    const receiver = new VoiceAudioReceiver(async () => {
      try { if (!this.closed && this.audioReceiver === receiver) await this.setDeafened(true); }
      finally { if (this.audioReceiver === receiver) this.audioReceiver = undefined; }
    }, (error) => this.callbacks.error(error), signal);
    this.audioReceiver = receiver;
    return receiver;
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.updateOwnVoiceState({ isMuted: muted });
  }

  async setDeafened(deafened: boolean): Promise<void> {
    if (deafened && this.ownState) this.applyOwnState({ ...this.ownState, isDeafened: true });
    await this.updateOwnVoiceState({ isDeafened: deafened });
  }

  private async updateOwnVoiceState(update: VoiceStateUpdatePayload): Promise<void> {
    if (this.closed || !this.admitted) throw new Error('Voice connection is not active.');
    if (update.isMuted === true) { this.muted = true; this.stopSpeaking(); }
    try {
      const response = await this.request(MessageType.VOICE_STATE_UPDATE, update, MessageType.VOICE_STATE_CHANGED);
      const state = botVoiceParticipantSchema.shape.voiceState.parse(record(response)?.voiceState);
      if (state.sessionId !== this.auth.currentUser.sessionId || state.channelId !== this.channelId) {
        throw new Error('Invalid voice state acknowledgement.');
      }
      this.applyOwnState(state);
      await this.receiveTasks;
    } catch (error) {
      this.fail(toError(error));
      throw error;
    }
  }

  private rememberParticipant(participant: BotVoiceParticipant): void {
    this.participants.set(participant.voiceState.sessionId, {
      sessionId: participant.voiceState.sessionId, userId: participant.user.id,
      isBot: participant.user.isBot === true, muted: voiceIsMuted(participant.voiceState),
    });
  }

  private receivePacket(sessionId: string, packet: RtpPacket): void {
    const participant = this.participants.get(sessionId);
    if (!this.isReceivingAudio || !participant || participant.isBot || participant.muted ||
        sessionId === this.auth.currentUser.sessionId || packet.payload.length === 0 || packet.payload.length > 65535) return;
    this.audioReceiver?.push({
      channelId: this.channelId, sessionId, userId: participant.userId,
      codec: 'opus', clockRate: 48000, channels: 2, opus: Uint8Array.from(packet.payload),
      sequenceNumber: packet.header.sequenceNumber, timestamp: packet.header.timestamp, ssrc: packet.header.ssrc,
      receivedAt: performance.now(),
    });
  }

  private applyOwnState(state: BotVoiceParticipant['voiceState']): void {
    this.ownState = state;
    this.muted = voiceIsMuted(state);
    if (this.muted) this.stopSpeaking();
    const receiving = this.receiveRequested && isReceivingBotVoice(state);
    if (receiving === this.receiving) return;
    this.receiving = receiving;
    const epoch = ++this.receiveEpoch;
    this.audioReceiver?.clear();
    if (this.auth.server.voiceMode === 'sfu') {
      const previous = this.sfuReceive;
      this.sfuReceive = undefined;
      this.producers.clear();
      if (previous) this.retireReceiver(previous.peer);
      if (receiving) this.queueReception(() => this.startSfuReception(epoch), epoch);
    } else {
      for (const [sessionId, peer] of this.peers) {
        void peer.setReceiving(receiving).catch((error: unknown) => this.failPeer(sessionId, peer, toError(error)));
      }
    }
  }

  private queueReception(operation: () => Promise<void>, epoch = this.receiveEpoch): void {
    if (this.queuedReception >= 128) {
      this.fail(new Error('Voice reception update queue exceeded.'));
      return;
    }
    this.queuedReception++;
    this.receiveTasks = this.receiveTasks.then(async () => {
      if (!this.closed && this.receiving && epoch === this.receiveEpoch) await operation();
    }).catch((error: unknown) => {
      if (!this.closed && this.receiving && epoch === this.receiveEpoch && !(error instanceof VoiceSourceClosedError)) {
        this.fail(toError(error));
      }
    }).finally(() => { this.queuedReception--; });
  }

  private async startSfuReception(epoch: number): Promise<void> {
    const current = () => !this.closed && this.receiving && epoch === this.receiveEpoch;
    try {
      const response = await this.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
        { channelId: this.channelId, direction: 'recv' }, MessageType.SFU_WEBRTC_TRANSPORT_CREATED);
      if (!current()) return;
      const { transportOptions } = botVoiceTransportSchema.parse(response);
      const { SfuOpusReceiver, voiceRtpCapabilities } = await import('./SfuOpusReceiver');
      if (!current()) return;
      const peer = new SfuOpusReceiver(transportOptions, (sessionId, packet) => {
        if (current() && this.sfuReceive?.peer === peer) this.receivePacket(sessionId, packet);
      }, (error) => { if (current() && this.sfuReceive?.peer === peer) this.fail(error); });
      const receiving = { transportId: transportOptions.id, peer, epoch, consumed: new Set<string>() };
      this.sfuReceive = receiving;
      const dtlsParameters = await peer.prepare();
      if (!current()) return;
      await this.request(MessageType.SFU_CONNECT_WEBRTC_TRANSPORT, {
        channelId: this.channelId, transportId: transportOptions.id, dtlsParameters,
      }, MessageType.SFU_WEBRTC_TRANSPORT_CONNECTED);
      if (!current()) return;
      await peer.ready;
      const list = await this.request(MessageType.SFU_GET_PRODUCERS, { channelId: this.channelId }, MessageType.SFU_PRODUCERS_LIST);
      if (!current()) return;
      const snapshot = botVoiceProducersSchema.parse(list);
      if (snapshot.channelId !== this.channelId) throw new Error('Invalid voice producer snapshot.');
      this.participants.clear();
      for (const participant of snapshot.participants) this.rememberParticipant(participant);
      this.updateParticipants();
      for (const producer of snapshot.producers) this.producers.set(producer.producerId, producer);
      for (const producer of this.producers.values()) {
        if (!current()) return;
        try { await this.consumeSfu(producer, receiving, voiceRtpCapabilities); }
        catch (error) { if (!(error instanceof VoiceSourceClosedError)) throw error; }
      }
    } catch (error) {
      if (current()) throw error;
    }
  }

  private async consumeSfu(
    producer: BotVoiceProducer, receiving: NonNullable<BotVoiceConnection['sfuReceive']>,
    capabilities?: typeof import('./SfuOpusReceiver')['voiceRtpCapabilities'],
  ): Promise<void> {
    const current = () => !this.closed && this.receiving && this.sfuReceive === receiving &&
      this.producers.get(producer.producerId) === producer &&
      this.participants.get(producer.producerSessionId)?.isBot === false;
    if (!current() || receiving.consumed.has(producer.producerId)) return;
    if (receiving.peer.needsRestart) {
      const epoch = ++this.receiveEpoch;
      this.sfuReceive = undefined;
      this.producers.clear();
      this.audioReceiver?.clear();
      this.retireReceiver(receiving.peer);
      try { await this.startSfuReception(epoch); }
      catch (error) {
        if (!this.closed && this.receiving && epoch === this.receiveEpoch) this.fail(toError(error));
        throw error;
      }
      return;
    }
    const rtpCapabilities = capabilities ?? (await import('./SfuOpusReceiver')).voiceRtpCapabilities;
    if (!current()) return;
    const response = await this.request(MessageType.SFU_CONSUME, {
      channelId: this.channelId, transportId: receiving.transportId, producerId: producer.producerId, rtpCapabilities,
    }, MessageType.SFU_CONSUMED);
    if (!current()) return;
    const consumer = botVoiceConsumerSchema.parse(response);
    if (consumer.channelId !== this.channelId || consumer.producerId !== producer.producerId ||
        consumer.producerSessionId !== producer.producerSessionId) throw new Error('Invalid microphone consumer identity.');
    receiving.consumed.add(producer.producerId);
    await receiving.peer.add(consumer);
  }

  private retireReceiver(peer: SfuOpusReceiver): void {
    const closing = peer.close().catch((error: unknown) => this.callbacks.error(toError(error)));
    this.retiring.add(closing);
    void closing.then(() => { this.retiring.delete(closing); });
  }

  private async joinSfu(): Promise<void> {
    const response = await this.request(MessageType.SFU_CREATE_WEBRTC_TRANSPORT,
      { channelId: this.channelId, direction: 'send' }, MessageType.SFU_WEBRTC_TRANSPORT_CREATED);
    if (this.closed) throw new Error('Voice join cancelled.');
    const { transportOptions } = botVoiceTransportSchema.parse(response);
    const Peer = this.Peer;
    if (!Peer) throw new Error('Voice transport has not been loaded.');
    const peer = new Peer(this.auth.iceServers, (error) => this.fail(error));
    this.sfu = peer;
    const { dtlsParameters, rtpParameters, answer } = await peer.prepareSfu(transportOptions);
    await this.request(MessageType.SFU_CONNECT_WEBRTC_TRANSPORT, {
      channelId: this.channelId, transportId: transportOptions.id, dtlsParameters,
    }, MessageType.SFU_WEBRTC_TRANSPORT_CONNECTED);
    await peer.pc.setRemoteDescription({ type: 'answer', sdp: answer });
    await peer.ready;
    await this.request(MessageType.SFU_PRODUCE, {
      channelId: this.channelId, transportId: transportOptions.id,
      kind: 'audio', rtpParameters, appData: { mediaType: 'mic' },
    }, MessageType.SFU_PRODUCED);
  }

  private ensurePeer(sessionId: string, initiate = false): OpusPeer | undefined {
    if (this.closed || !this.admitted || !this.participants.has(sessionId) ||
        this.participants.get(sessionId)?.isBot || sessionId === this.auth.currentUser.sessionId) return undefined;
    const existing = this.peers.get(sessionId);
    if (existing) return existing;
    if (this.peers.size >= 1000) throw new Error('Voice peer limit exceeded.');
    const Peer = this.Peer;
    if (!Peer) throw new Error('Voice transport has not been loaded.');
    const peer = new Peer(this.auth.iceServers, (error) => this.failPeer(sessionId, peer, error), (signal) => {
      if (!this.closed && !peer.isClosed && this.peers.get(sessionId) === peer) this.callbacks.send({
        type: MessageType.RTC_SIGNAL,
        payload: { ...signal, fromSessionId: this.auth.currentUser.sessionId, targetSessionId: sessionId },
      });
    }, { publish: this.publishAudio, receive: this.receiving, packet: (packet) => {
      if (this.peers.get(sessionId) === peer) this.receivePacket(sessionId, packet);
    } });
    this.peers.set(sessionId, peer);
    // Admission's joining participant offers; existing members wait for it.
    // Session IDs still determine politeness when offers genuinely collide.
    if (initiate) {
      void peer.offer().catch((error: unknown) => this.failPeer(sessionId, peer, toError(error)));
    }
    return peer;
  }

  private failPeer(sessionId: string, peer: OpusPeer, error: Error): void {
    if (this.closed || peer.isClosed || this.peers.get(sessionId) !== peer) return;
    this.retirePeer(peer);
    if (!this.sfu?.isReady && ![...this.peers.values()].some((entry) => entry.isReady)) this.stopSpeaking();
    // Keep the failed entry until a fresh offer or roster lifecycle replaces it.
    // A candidate alone must not start an unbounded reconnect/timeout loop.
    this.callbacks.error(new Error(`Voice P2P peer ${sessionId}: ${error.message}`));
  }

  private retirePeer(peer: OpusPeer): void {
    if (peer.isClosed) return;
    const closing = peer.close().catch((error: unknown) => {
      this.callbacks.error(new Error(`Voice peer cleanup failed: ${toError(error).message}`));
    });
    this.retiring.add(closing);
    void closing.then(() => { this.retiring.delete(closing); });
  }

  handle(message: VoiceMessage): boolean {
    const pending = message.requestId ? this.pending.get(message.requestId) : undefined;
    if (pending?.expected === MessageType.SFU_CONSUMED && message.type === MessageType.SFU_PRODUCER_CLOSED) {
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId!);
      pending.reject(new VoiceSourceClosedError());
    }
    if (pending && (message.type === pending.expected || message.type === MessageType.SERVER_ERROR)) {
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId!);
      if (message.type === MessageType.SERVER_ERROR) {
        const payload = record(message.payload);
        pending.reject(new Error(typeof payload?.message === 'string' ? payload.message : 'Voice request rejected.'));
      } else pending.resolve(message.payload);
      return true;
    }
    if (this.closed) return false;
    try {
      if (message.type === MessageType.ADMIN_MOVE_USER &&
          record(message.payload)?.targetSessionId === this.auth.currentUser.sessionId) {
        void this.stop('moved', true).catch((error: unknown) => this.callbacks.error(toError(error)));
        return true;
      }
      if (message.type === MessageType.VOICE_USER_JOINED) {
        const payload = record(message.payload);
        if (typeof payload?.channelId === 'string' && payload.channelId !== this.channelId) {
          if (payload.sessionId === this.auth.currentUser.sessionId) this.fail(new Error('Bot was moved to another voice channel.'));
          return true;
        }
        const joined = botVoiceJoinedSchema.parse(message.payload);
        this.rememberParticipant(joined);
        if (this.admitted && this.auth.server.voiceMode === 'p2p') this.ensurePeer(joined.sessionId);
        this.updateParticipants();
        return true;
      }
      if (message.type === MessageType.VOICE_USER_LEFT) {
        const left = botVoiceLeftSchema.parse(message.payload);
        if (left.channelId !== this.channelId) return true;
        if (left.sessionId === this.auth.currentUser.sessionId) {
          void this.stop('removed', false).catch((error: unknown) => this.callbacks.error(toError(error)));
        } else {
          this.participants.delete(left.sessionId);
          this.audioReceiver?.clear(left.sessionId);
          for (const [id, producer] of this.producers) {
            if (producer.producerSessionId === left.sessionId) {
              this.producers.delete(id);
              this.sfuReceive?.consumed.delete(id);
            }
          }
          if (this.sfuReceive) {
            const receiver = this.sfuReceive;
            this.queueReception(() => receiver.peer.removeSession(left.sessionId));
          }
          const peer = this.peers.get(left.sessionId);
          this.peers.delete(left.sessionId);
          if (peer) this.retirePeer(peer);
          if (!this.sfu?.isReady && ![...this.peers.values()].some((entry) => entry.isReady)) this.stopSpeaking();
          this.updateParticipants();
        }
        return true;
      }
      if (message.type === MessageType.RTC_SIGNAL) {
        if (this.auth.server.voiceMode !== 'p2p') return true;
        if (!this.admitted) {
          if (this.earlySignals.length >= 128) throw new Error('Voice signaling queue exceeded.');
          this.earlySignals.push(message);
          return true;
        }
        const signal = botVoiceSignalSchema.parse(message.payload);
        if (signal.targetSessionId !== this.auth.currentUser.sessionId ||
            !this.participants.has(signal.fromSessionId)) return true;
        let peer = this.peers.get(signal.fromSessionId);
        if (signal.signalType === 'offer' && (!peer || peer.isClosed)) {
          this.peers.delete(signal.fromSessionId);
          peer = this.ensurePeer(signal.fromSessionId, false);
        }
        if (peer) void peer.accept(signal, this.auth.currentUser.sessionId.localeCompare(signal.fromSessionId) < 0)
          .catch((error: unknown) => this.failPeer(signal.fromSessionId, peer, toError(error)));
        return true;
      }
      if (message.type === MessageType.VOICE_RESTRICTIONS_UPDATED) {
        const restrictions = voiceRestrictionsUpdatedSchema.parse(message.payload);
        if (restrictions.userId === this.auth.currentUser.id) {
          if (this.ownState) this.applyOwnState({ ...this.ownState, ...restrictions });
        }
        for (const participant of this.participants.values()) {
          if (participant.userId === restrictions.userId && (restrictions.serverMuted || restrictions.serverDeafened)) {
            participant.muted = true;
            this.audioReceiver?.clear(participant.sessionId);
          }
        }
        return true;
      }
      if (message.type === MessageType.VOICE_STATE_CHANGED) {
        const parsed = botVoiceParticipantSchema.shape.voiceState.safeParse(record(message.payload)?.voiceState);
        if (parsed.success && parsed.data.channelId === this.channelId) {
          const state = parsed.data;
          if (state.sessionId === this.auth.currentUser.sessionId) this.applyOwnState(state);
          const participant = this.participants.get(state.sessionId);
          if (participant) {
            participant.muted = voiceIsMuted(state);
            if (participant.muted) this.audioReceiver?.clear(state.sessionId);
          }
        }
        return true;
      }
      if (message.type === MessageType.SFU_NEW_PRODUCER && this.auth.server.voiceMode === 'sfu' && this.receiving) {
        const parsed = botVoiceProducerSchema.safeParse(message.payload);
        if (parsed.success && parsed.data.channelId === this.channelId && !this.producers.has(parsed.data.producerId)) {
          if (this.producers.size >= 1000) throw new Error('Voice producer limit exceeded.');
          const producer = parsed.data;
          this.producers.set(producer.producerId, producer);
          this.queueReception(async () => {
            if (this.sfuReceive) await this.consumeSfu(producer, this.sfuReceive);
          });
        }
        return true;
      }
      if (message.type === MessageType.SFU_PRODUCER_CLOSED) {
        const payload = record(message.payload);
        if (payload?.channelId === this.channelId && typeof payload.producerId === 'string') {
          const producerId = payload.producerId;
          const producer = this.producers.get(producerId);
          this.producers.delete(producerId);
          this.sfuReceive?.consumed.delete(producerId);
          if (producer) this.audioReceiver?.clear(producer.producerSessionId);
          if (producer) this.queueReception(async () => { await this.sfuReceive?.peer.remove(producerId); });
        }
        return true;
      }
      if (message.type === MessageType.SERVER_SETTINGS_UPDATED) {
        const mode = record(message.payload)?.voiceMode;
        if (mode && mode !== this.auth.server.voiceMode) {
          void this.stop('mode_changed', true).catch((error: unknown) => this.callbacks.error(toError(error)));
        }
      }
      if (message.type === MessageType.SERVER_SHUTDOWN) {
        void this.disconnect('server_shutdown').catch((error: unknown) => this.callbacks.error(toError(error)));
      }
    } catch (error) { this.fail(toError(error)); }
    return false;
  }

  private updateParticipants(): void {
    const count = [...this.participants.values()].filter((entry) =>
      !entry.isBot && entry.sessionId !== this.auth.currentUser.sessionId).length;
    if (count === this.count) return;
    this.count = count;
    this.callbacks.participants(count);
  }

  private request(type: MessageType, payload: unknown, expected: MessageType): Promise<unknown> {
    if (this.closed && type !== MessageType.VOICE_LEAVE) return Promise.reject(new Error('Voice connection closed.'));
    if (this.pending.size >= 16) return Promise.reject(new Error('Too many pending voice requests.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Voice request ${type} timed out.`));
      }, 20000);
      this.pending.set(requestId, { expected, resolve, reject, timer });
      try { this.callbacks.send({ type, requestId, payload }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  async writeOpus(frame: Uint8Array): Promise<void> {
    if (this.closed || !this.admitted) throw new Error('Voice connection is not active.');
    if (!this.publishAudio) throw new Error('This voice connection is receive-only; publish_voice is not granted.');
    if (this.writing) throw new Error('Await writeOpus before writing the next frame.');
    validateOpus(frame);
    // Moderation suppresses transmission, not the application's playback clock.
    if (this.muted) return;
    const activityEpoch = this.activityEpoch;
    this.writing = true;
    try {
      // A newcomer still negotiating ICE must not pause audio for listeners
      // already connected. Initial admission waits for its original peers.
      let delivered = 0;
      if (this.sfu) {
        const peer = this.sfu;
        await peer.write(frame);
        if (this.sfu === peer && peer.isReady) delivered++;
      } else {
        const recipients = [...this.peers.entries()].filter(([, peer]) => peer.isReady);
        let failure: Error | undefined;
        await Promise.all(recipients.map(async ([sessionId, peer]) => {
          try {
            await peer.write(frame);
            if (this.peers.get(sessionId) === peer && peer.isReady) delivered++;
          }
          catch (error: unknown) {
            if (this.closed || this.peers.get(sessionId) !== peer) return;
            failure ??= toError(error);
            this.failPeer(sessionId, peer, toError(error));
          }
        }));
        if (failure && delivered === 0) throw failure;
      }
      if (delivered > 0 && !this.closed && !this.muted && this.activityEpoch === activityEpoch) {
        this.markAudioActivity();
      }
    } finally { this.writing = false; }
  }

  private publishSpeaking(isSpeaking: boolean): void {
    try {
      this.callbacks.send({
        type: MessageType.VOICE_STATE_UPDATE,
        payload: { isSpeaking } satisfies VoiceStateUpdatePayload,
      });
    } catch (error: unknown) {
      this.callbacks.error(new Error(`Voice activity signaling failed: ${toError(error).message.slice(0, 256)}`));
    }
  }

  private setSpeaking(speaking: boolean): void {
    if (this.speaking === speaking) return;
    this.speaking = speaking;
    if (!this.closed && this.admitted) this.publishSpeaking(speaking);
  }

  private markAudioActivity(): void {
    // Encoded Opus cannot reveal amplitude here. This is transmission activity,
    // not microphone capture or a fabricated voice-activity detector.
    this.lastAudioAt = performance.now();
    this.setSpeaking(true);
    if (!this.speaking || this.closed || this.muted || this.speakingTimer) return;
    const epoch = this.activityEpoch;
    const expire = (): void => {
      if (this.closed || epoch !== this.activityEpoch) return;
      const remaining = this.lastAudioAt + SPEAKING_HANGOVER_MS - performance.now();
      if (remaining > 0) {
        this.speakingTimer = setTimeout(expire, remaining);
        this.speakingTimer.unref();
      } else {
        this.speakingTimer = undefined;
        this.setSpeaking(false);
      }
    };
    this.speakingTimer = setTimeout(expire, SPEAKING_HANGOVER_MS);
    this.speakingTimer.unref();
  }

  /** End outbound activity immediately on pause/stop without changing mute preferences. */
  stopSpeaking(): void {
    this.activityEpoch++;
    clearTimeout(this.speakingTimer);
    this.speakingTimer = undefined;
    this.setSpeaking(false);
  }

  close(): Promise<void> { return this.stop('left', true); }

  /** Called by BotClient when signaling is no longer usable. */
  disconnect(reason: string): Promise<void> {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Voice signaling disconnected.'));
    }
    this.pending.clear();
    return this.stop(reason, false);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.callbacks.error(error);
    void this.stop('transport_failed', true, error).catch((failure: unknown) => this.callbacks.error(toError(failure)));
  }

  private stop(reason: string, notify: boolean, failure?: Error): Promise<void> {
    if (this.closing) return this.closing;
    const wasSpeaking = this.speaking;
    this.closed = true;
    this.receiving = false;
    this.receiveEpoch++;
    this.audioReceiver?.finish(failure);
    this.audioReceiver = undefined;
    this.producers.clear();
    if (this.sfuReceive) this.retireReceiver(this.sfuReceive.peer);
    this.sfuReceive = undefined;
    this.stopSpeaking();
    if (notify && wasSpeaking && this.admitted) this.publishSpeaking(false);
    this.earlySignals = [];
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(`Voice disconnected: ${reason}.`));
    }
    this.pending.clear();
    // Start remote leave before cleanup; callbacks retain this object until it settles.
    const leave = notify
      ? this.request(MessageType.VOICE_LEAVE, { channelId: this.channelId }, MessageType.VOICE_USER_LEFT)
      : Promise.resolve();
    const peers = [...this.peers.values(), ...(this.sfu ? [this.sfu] : [])];
    this.peers.clear();
    this.sfu = undefined;
    for (const peer of peers) this.retirePeer(peer);
    this.closing = Promise.allSettled([leave, ...this.retiring]).then((results) => {
      const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failure) throw failure.reason;
    })
      .finally(() => this.callbacks.disconnected(reason));
    return this.closing;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
class VoiceSourceClosedError extends Error {
  constructor() { super('Microphone producer closed during subscription.'); }
}
function voiceIsMuted(state: BotVoiceParticipant['voiceState']): boolean {
  return !!(state.isMuted || state.isDeafened || state.serverMuted || state.serverDeafened);
}

export function validateOpus(frame: Uint8Array): void {
  if (!(frame instanceof Uint8Array) || frame.length < 1 || frame.length > 1275) {
    throw new Error('Expected one raw Opus packet (1–1275 bytes).');
  }
  const toc = frame[0];
  const config = toc >> 3;
  const samples = config >= 16 ? 120 << (config & 3)
    : config >= 12 ? 480 << (config & 1)
    : (config & 3) === 3 ? 2880 : 480 << (config & 3);
  const code = toc & 3;
  const count = code === 0 ? 1 : code === 3 ? (frame[1] ?? 0) & 0x3f : 2;
  if (count === 0 || count * samples !== 960) throw new Error('Opus packet must contain exactly 20 ms at 48 kHz.');
}
