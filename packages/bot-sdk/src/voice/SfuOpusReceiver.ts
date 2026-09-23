import { MediaStreamTrack, RTCPeerConnection, RtpPacket } from 'werift';
import type { BotVoiceConsumer, BotVoiceTransportOptions } from '@monky/shared';
import { opusCodec } from './OpusPeer';

export const voiceRtpCapabilities = {
  codecs: [{
    kind: 'audio', mimeType: 'audio/opus', preferredPayloadType: 111, clockRate: 48000, channels: 2,
    parameters: { useinbandfec: 1, stereo: 1 }, rtcpFeedback: [],
  }],
  headerExtensions: [],
};

/** A separate SFU receive transport, containing human microphones only. */
export class SfuOpusReceiver {
  readonly pc = new RTCPeerConnection({
    codecs: { audio: [opusCodec()] }, iceServers: [], bundlePolicy: 'max-bundle',
  });
  private readonly consumers = new Map<string, BotVoiceConsumer>();
  private readonly slots: Array<BotVoiceConsumer | undefined> = [undefined];
  private readonly tracks = new Map<MediaStreamTrack, () => void>();
  private readonly subscriptions: Array<() => void> = [];
  private tasks: Promise<void> = Promise.resolve();
  private queued = 0;
  private version = 0;
  private nextSlot = 0;
  private closed = false;
  private closing?: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  readonly ready: Promise<void>;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly transport: BotVoiceTransportOptions,
    private readonly packet: (sessionId: string, packet: RtpPacket) => void,
    private readonly failed: (error: Error) => void,
  ) {
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    void this.ready.catch((error: unknown) => { if (!this.closed) this.failed(toError(error)); });
    this.timer = setTimeout(() => this.rejectReady(new Error('Voice receive ICE/DTLS connection timed out.')), 20000);
    this.subscriptions.push(this.pc.connectionStateChange.subscribe((state) => {
      if (this.closed) return;
      if (state === 'connected') { clearTimeout(this.timer); this.resolveReady(); }
      else if (state === 'failed' || state === 'disconnected') this.failed(new Error(`Voice receive transport ${state}.`));
    }).unSubscribe);
    this.subscriptions.push(this.pc.onTrack.subscribe((track) => {
      if (this.closed || track.stopped || track.kind !== 'audio' || this.tracks.has(track)) return;
      const subscription = track.onReceiveRtp.subscribe((packet) => {
        if (this.closed) return;
        const consumer = [...this.consumers.values()].find((entry) =>
          entry.rtpParameters.encodings[0].ssrc === packet.header.ssrc &&
          entry.rtpParameters.codecs[0].payloadType === packet.header.payloadType);
        if (consumer) this.packet(consumer.producerSessionId, packet);
      });
      this.tracks.set(track, subscription.unSubscribe);
    }).unSubscribe);
  }

  async prepare(): Promise<{
    role: 'client'; fingerprints: Array<{ algorithm: string; value: string }>;
  }> {
    await this.negotiate();
    const dtls = this.pc.dtlsTransports[0];
    if (!dtls || this.closed) throw new Error('Voice receive transport closed during preparation.');
    return { role: 'client', fingerprints: dtls.localParameters.fingerprints };
  }

  add(consumer: BotVoiceConsumer): Promise<void> {
    if (this.consumers.has(consumer.producerId)) return Promise.resolve();
    if (this.consumers.size >= 1000 || this.nextSlot >= 1032) return Promise.reject(new Error('Voice consumer limit exceeded.'));
    if ([...this.consumers.values()].some((entry) =>
      entry.rtpParameters.encodings[0].ssrc === consumer.rtpParameters.encodings[0].ssrc)) {
      return Promise.reject(new Error('Duplicate voice consumer SSRC.'));
    }
    this.consumers.set(consumer.producerId, consumer);
    // werift reuses inactive transceivers even when their mids remain in SDP.
    // Retain retired m-lines, stop their receivers, and periodically recycle.
    this.slots[this.nextSlot++] = consumer;
    return this.negotiate();
  }

  get needsRestart(): boolean { return this.nextSlot - this.consumers.size >= 32; }

  remove(producerId: string): Promise<void> {
    const consumer = this.consumers.get(producerId);
    if (!consumer) return Promise.resolve();
    this.consumers.delete(producerId);
    this.releaseTracks(consumer.rtpParameters.encodings[0].ssrc);
    return Promise.resolve();
  }

  removeSession(sessionId: string): Promise<void> {
    const removals = [...this.consumers.values()].filter((entry) => entry.producerSessionId === sessionId);
    return Promise.all(removals.map((entry) => this.remove(entry.producerId))).then(() => undefined);
  }

  private releaseTracks(ssrc: number): void {
    for (const [track, unsubscribe] of this.tracks) {
      if (track.ssrc !== ssrc) continue;
      unsubscribe();
      track.stop();
      this.tracks.delete(track);
    }
    for (const receiver of this.pc.getReceivers()) {
      if (receiver.track.ssrc === ssrc) receiver.stop();
    }
  }

  private negotiate(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Voice receive transport is closed.'));
    if (this.queued >= 128) return Promise.reject(new Error('Voice consumer negotiation queue exceeded.'));
    this.queued++;
    const next = this.tasks.then(async () => {
      if (this.closed) return;
      await this.pc.setRemoteDescription({ type: 'offer', sdp: this.offerSdp() });
      if (this.closed) return;
      for (const transceiver of this.pc.getTransceivers()) transceiver.direction = 'recvonly';
      await this.pc.setLocalDescription(await this.pc.createAnswer());
    });
    this.tasks = next.catch((error: unknown) => {
      if (!this.closed) this.failed(toError(error));
    }).finally(() => { this.queued--; });
    return next;
  }

  private offerSdp(): string {
    const fingerprint = this.transport.dtlsParameters.fingerprints.find((entry) => entry.algorithm === 'sha-256');
    if (!fingerprint) throw new Error('SFU is missing its SHA-256 certificate fingerprint.');
    const candidates = this.transport.iceCandidates.map((candidate) =>
      `a=candidate:${candidate.foundation} 1 ${candidate.protocol.toUpperCase()} ${candidate.priority} ${candidate.ip} ${candidate.port} typ host${candidate.tcpType ? ` tcptype ${candidate.tcpType}` : ''}`);
    return [
      'v=0', `o=monky 1 ${++this.version} IN IP4 0.0.0.0`, 's=-', 't=0 0', 'a=ice-lite',
      `a=group:BUNDLE ${this.slots.map((_, index) => index).join(' ')}`, 'a=msid-semantic:WMS *',
      ...this.slots.flatMap((consumer, index) => {
        const pt = consumer?.rtpParameters.codecs[0].payloadType ?? 111;
        const ssrc = consumer?.rtpParameters.encodings[0].ssrc;
        return [
          `m=audio 9 UDP/TLS/RTP/SAVPF ${pt}`, 'c=IN IP4 0.0.0.0', `a=mid:${index}`,
          consumer ? 'a=sendonly' : 'a=inactive', 'a=rtcp-mux', 'a=rtcp-rsize',
          `a=ice-ufrag:${this.transport.iceParameters.usernameFragment}`, `a=ice-pwd:${this.transport.iceParameters.password}`,
          `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`, 'a=setup:passive',
          `a=rtpmap:${pt} opus/48000/2`, `a=fmtp:${pt} minptime=10;useinbandfec=1;stereo=1`,
          ...(ssrc ? [`a=msid:voice-${ssrc} mic-${ssrc}`, `a=ssrc:${ssrc} cname:monky`,
            `a=ssrc:${ssrc} msid:voice-${ssrc} mic-${ssrc}`] : []),
          ...candidates, 'a=end-of-candidates',
        ];
      }),
      '',
    ].join('\r\n');
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.timer);
    this.rejectReady(new Error('Voice receive transport closed.'));
    for (const unsubscribe of this.subscriptions.splice(0)) unsubscribe();
    for (const [track, unsubscribe] of this.tracks) { unsubscribe(); track.stop(); }
    this.tracks.clear();
    this.consumers.clear();
    this.slots.length = 0;
    return this.closing = this.pc.close();
  }
}

function toError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }
