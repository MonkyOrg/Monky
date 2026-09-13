import { randomInt } from 'crypto';
import {
  MediaStream, MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket, SessionDescription,
} from 'werift';
import type { BotVoiceAuth, BotVoiceSignal, BotVoiceTransportOptions } from '@monky/shared';

type VoiceCandidate = NonNullable<BotVoiceSignal['candidate']>;

export const OPUS_PAYLOAD_TYPE = 111;
export const opusCodec = () => new RTCRtpCodecParameters({
  mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: OPUS_PAYLOAD_TYPE,
  parameters: 'minptime=10;useinbandfec=1;stereo=1',
});

/** One primary microphone m-line; no soundboard or chat media transport. */
export class OpusPeer {
  readonly pc: RTCPeerConnection;
  readonly track = new MediaStreamTrack({ kind: 'audio' });
  readonly sender;
  private sequence = randomInt(65536);
  private timestamp = randomInt(0x100000000);
  private tasks: Promise<void> = Promise.resolve();
  private queued = 0;
  private closed = false;
  private closing?: Promise<void>;
  private failureReported = false;
  private candidateCount = 0;
  private pendingCandidates: VoiceCandidate[] = [];
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<void>;
  private timer: ReturnType<typeof setTimeout>;

  constructor(
    iceServers: BotVoiceAuth['iceServers'],
    private readonly failed: (error: Error) => void,
    private readonly signal?: (signal: Pick<BotVoiceSignal, 'signalType' | 'sdp'>) => void,
  ) {
    this.pc = new RTCPeerConnection({
      codecs: {
        audio: [opusCodec()],
        // Chromium always offers its camera m-line, even without a camera.
        // Match its codec metadata so we can answer that line as inactive.
        video: ['VP8', 'VP9', 'H264', 'AV1'].map((codec) => new RTCRtpCodecParameters({
          mimeType: `video/${codec}`, clockRate: 90000,
        })),
      },
      iceServers, bundlePolicy: 'max-bundle',
    });
    this.sender = this.pc.addTrack(this.track, new MediaStream([this.track]));
    this.pc.getTransceivers()[0].direction = 'sendonly';
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // Every peer has an observer even when created by a later roster event.
    void this.ready.catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
    this.timer = setTimeout(() => this.fail(new Error('Voice ICE/DTLS connection timed out.')), 20000);
    this.pc.connectionStateChange.subscribe((state) => {
      if (this.closed || this.failureReported) return;
      if (state === 'connected') {
        clearTimeout(this.timer);
        this.readyResolve();
      } else if (state === 'failed' || state === 'disconnected') {
        this.fail(new Error(`Voice transport ${state}.`));
      }
    });
  }

  get isClosed(): boolean { return this.closed; }
  get isReady(): boolean {
    return !this.closed && !this.failureReported && this.pc.connectionState === 'connected' &&
      this.sender.dtlsTransport.state === 'connected' && this.sender.codec !== undefined && !this.sender.stopped;
  }

  private fail(error: Error): void {
    if (this.closed || this.failureReported) return;
    this.failureReported = true;
    clearTimeout(this.timer);
    const reason = error.message.replace(/https?:\/\/\S+/gi, '[url]').replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').slice(0, 256);
    const failure = new Error(`${reason} (connection=${this.pc.connectionState}, ice=${this.pc.iceConnectionState}, signaling=${this.pc.signalingState})`);
    this.readyReject(failure);
    this.failed(failure);
  }

  enqueue(task: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Voice peer is closed.'));
    if (this.queued >= 128) return Promise.reject(new Error('Voice signaling queue exceeded.'));
    this.queued++;
    const next = this.tasks.then(async () => {
      if (!this.closed) await task();
    });
    this.tasks = next.catch((error: unknown) => this.fail(
      error instanceof Error ? error : new Error(String(error)),
    )).finally(() => { this.queued--; });
    return next;
  }

  offer(): Promise<void> {
    return this.enqueue(async () => {
      const offer = await this.pc.createOffer();
      if (this.closed) return;
      await this.pc.setLocalDescription(offer);
      const sdp = this.pc.localDescription;
      if (!this.closed && sdp) this.signal?.({ signalType: 'offer', sdp: { type: 'offer', sdp: sdp.sdp } });
    });
  }

  accept(signal: BotVoiceSignal, polite: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (signal.signalType === 'candidate') {
        if (++this.candidateCount > 256) throw new Error('Voice ICE candidate limit exceeded.');
        if (signal.candidate) {
          if (signal.candidate.candidate && signal.candidate.sdpMid == null && signal.candidate.sdpMLineIndex == null) {
            throw new Error('Voice ICE candidate is missing its media identity.');
          }
          if (!await this.applyCandidate(signal.candidate) && !this.closed) {
            if (this.pendingCandidates.length >= 256) throw new Error('Voice pending ICE candidate limit exceeded.');
            this.pendingCandidates.push(signal.candidate);
          }
        }
        return;
      }
      if (!signal.sdp) return;
      if (signal.signalType === 'offer') {
        if (this.pc.signalingState !== 'stable') {
          if (!polite) return;
          await this.pc.setLocalDescription({ type: 'rollback' });
          if (this.closed) return;
        }
        await this.pc.setRemoteDescription(signal.sdp);
        if (this.closed) return;
        await this.flushCandidates();
        if (this.closed) return;
        for (const transceiver of this.pc.getTransceivers()) {
          transceiver.direction = transceiver.sender === this.sender ? 'sendonly' : 'inactive';
        }
        this.candidateCount = 0;
        const answer = await this.pc.createAnswer();
        if (this.closed) return;
        await this.pc.setLocalDescription(answer);
        const sdp = this.pc.localDescription;
        if (!this.closed && sdp) this.signal?.({ signalType: 'answer', sdp: { type: 'answer', sdp: sdp.sdp } });
      } else if (signal.signalType === 'answer' && this.pc.signalingState === 'have-local-offer') {
        await this.pc.setRemoteDescription(signal.sdp);
        if (this.closed) return;
        await this.flushCandidates();
        this.candidateCount = 0;
      }
    });
  }

  private async applyCandidate(candidate: VoiceCandidate): Promise<boolean> {
    const description = this.pc.remoteDescription;
    if (!description) return false;
    const remote = SessionDescription.parse(description.sdp);
    const index = candidate.sdpMid != null
      ? remote.media.findIndex((media) => media.rtp.muxId === candidate.sdpMid)
      : candidate.sdpMLineIndex ?? undefined;
    let usernameFragment = candidate.usernameFragment ?? undefined;
    if (usernameFragment === undefined) {
      const fields = candidate.candidate.trim().split(/\s+/);
      // Extension key/value pairs follow the eight required ICE candidate fields.
      for (let i = 8; i + 1 < fields.length; i += 2) {
        if (fields[i] === 'ufrag') { usernameFragment = fields[i + 1]; break; }
      }
    }
    const media = index === undefined ? remote.media : remote.media[index] ? [remote.media[index]] : [];
    if (!media.length || (usernameFragment && !media.some((entry) => entry.iceParams?.usernameFragment === usernameFragment))) {
      return false;
    }
    // Locally rejected m-lines do not require ICE candidates.
    const local = this.pc.localDescription;
    if (index !== undefined && this.pc.signalingState === 'stable' && local?.type === 'answer' &&
        SessionDescription.parse(local.sdp).media[index]?.port === 0) return true;
    await this.pc.addIceCandidate({
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid ?? undefined,
      sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
      usernameFragment: usernameFragment ?? undefined,
    });
    return true;
  }

  private async flushCandidates(): Promise<void> {
    // Glare can discard an offer with more m-lines than the winning answer.
    // Letting werift buffer those candidates poisons setRemoteDescription.
    // Keep them bounded here until their MID and ICE generation are applicable.
    const pending = this.pendingCandidates;
    this.pendingCandidates = [];
    for (const candidate of pending) {
      if (this.closed) return;
      if (!await this.applyCandidate(candidate) && !this.closed) this.pendingCandidates.push(candidate);
    }
  }

  async prepareSfu(options: BotVoiceTransportOptions): Promise<{
    dtlsParameters: { role: 'client'; fingerprints: { algorithm: string; value: string }[] };
    rtpParameters: {
      codecs: { mimeType: string; payloadType: number; clockRate: number; channels: number; parameters: { useinbandfec: number; stereo: number }; rtcpFeedback: never[] }[];
      encodings: { ssrc: number }[]; rtcp: { cname: string; reducedSize: boolean }; headerExtensions: never[];
    };
    answer: string;
  }> {
    this.pc.getTransceivers()[0].direction = 'sendonly';
    await this.pc.setLocalDescription(await this.pc.createOffer());
    if (this.closed) throw new Error('Voice peer closed while gathering ICE.');
    const fingerprint = options.dtlsParameters.fingerprints.find((entry) => entry.algorithm === 'sha-256');
    if (!fingerprint) throw new Error('SFU is missing its SHA-256 certificate fingerprint.');
    const mid = this.pc.getTransceivers()[0].mid;
    const candidates = options.iceCandidates.map((candidate) =>
      `a=candidate:${candidate.foundation} 1 ${candidate.protocol.toUpperCase()} ${candidate.priority} ${candidate.ip} ${candidate.port} typ host${candidate.tcpType ? ` tcptype ${candidate.tcpType}` : ''}`);
    const answer = [
      'v=0', 'o=monky 1 1 IN IP4 0.0.0.0', 's=-', 't=0 0', 'a=ice-lite',
      `a=group:BUNDLE ${mid}`, `m=audio 9 UDP/TLS/RTP/SAVPF ${OPUS_PAYLOAD_TYPE}`, 'c=IN IP4 0.0.0.0',
      `a=mid:${mid}`, 'a=recvonly', 'a=rtcp-mux', 'a=rtcp-rsize',
      `a=ice-ufrag:${options.iceParameters.usernameFragment}`, `a=ice-pwd:${options.iceParameters.password}`,
      `a=fingerprint:${fingerprint.algorithm} ${fingerprint.value}`, 'a=setup:passive',
      `a=rtpmap:${OPUS_PAYLOAD_TYPE} opus/48000/2`, `a=fmtp:${OPUS_PAYLOAD_TYPE} minptime=10;useinbandfec=1;stereo=1`,
      ...candidates, 'a=end-of-candidates', '',
    ].join('\r\n');
    return {
      dtlsParameters: { role: 'client', fingerprints: this.sender.dtlsTransport.localParameters.fingerprints },
      rtpParameters: {
        codecs: [{
          mimeType: 'audio/opus', payloadType: OPUS_PAYLOAD_TYPE, clockRate: 48000, channels: 2,
          parameters: { useinbandfec: 1, stereo: 1 }, rtcpFeedback: [],
        }],
        encodings: [{ ssrc: this.sender.ssrc }], rtcp: { cname: this.pc.cname, reducedSize: true },
        headerExtensions: [],
      },
      answer,
    };
  }

  async write(frame: Uint8Array): Promise<void> {
    await this.ready;
    if (!this.isReady) throw new Error('Voice transport is not connected.');
    this.sequence = (this.sequence + 1) & 0xffff;
    this.timestamp = (this.timestamp + 960) >>> 0;
    await this.sender.sendRtp(new RtpPacket(new RtpHeader({
      payloadType: OPUS_PAYLOAD_TYPE, sequenceNumber: this.sequence, timestamp: this.timestamp, ssrc: this.sender.ssrc,
    }), Buffer.from(frame)));
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.pendingCandidates = [];
    clearTimeout(this.timer);
    this.readyReject(new Error('Voice peer closed.'));
    this.track.stop();
    return this.closing = this.pc.close();
  }
}
