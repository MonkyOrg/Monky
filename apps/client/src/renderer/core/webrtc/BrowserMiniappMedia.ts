import {
  MessageType, botScreenSchema, botScreenRemovedSchema, nativeScreenProducerSchema, nativeScreenSignalAckSchema,
  nativeScreenSourceSchema, nativeScreenSignalSchema, nativeScreenRpcMethodSchema, compatibleScreenProfile,
  type BotScreen, type NativeScreenCall, type NativeScreenSignalPayload, type NativeScreenSource, type NativeScreenRpcMethod,
} from '@monky/shared';
import { BrowserScreenSubscription } from './BrowserScreenSubscription';
import { createNativeScreenCallConfig, type NativeScreenCallContext } from './nativeScreen/NativeScreenCall';
import { browserScreenProfile } from '../../platform/web/webScreen/browserScreenProfile';
import { WebScreenPublisher } from '../../platform/web/webScreen/webScreenPublisher';
import { clientLog } from '../ClientLogService';

declare const MediaStreamTrackProcessor: {
  new(options: { track: MediaStreamTrack; maxBufferSize: number }): { readable: ReadableStream<VideoFrame> };
} | undefined;

type BrowserScreen = Extract<BotScreen, { kind: 'browser' }>;
export interface BrowserMiniappMediaHandle { close(): void }
interface Entry {
  readonly screen: BrowserScreen;
  readonly context: NativeScreenCallContext;
  readonly connectionId: string;
  readonly config: NativeScreenCall;
  readonly stream: MediaStream;
  readonly onError: (error: unknown) => void;
  unbind: () => void;
  publisher: WebScreenPublisher | null;
  receiver: BrowserScreenSubscription | null;
  source: NativeScreenSource | null;
  published: boolean;
  retired: boolean;
  cancelFrame: (() => void) | null;
}
const cancelled = (): DOMException => new DOMException('The browser broadcast was retired.', 'AbortError');

/** Only the browser's tab track enters the existing screen publisher/signaling, never desktop capture. */
export class BrowserMiniappMedia {
  private readonly entries = new Set<Entry>();
  private readonly retirements = new Set<Promise<void>>();

  constructor(private readonly context: () => NativeScreenCallContext | null) {}

  localSources(): NativeScreenSource[] {
    return [...this.entries].flatMap(entry => !entry.retired && entry.published && entry.publisher && entry.source ? [entry.source] : []);
  }

  private current(entry: Entry): void {
    if (entry.retired || !entry.context.isCurrent() || entry.context.client.getConnectionId() !== entry.connectionId)
      throw cancelled();
  }

  private create(screen: BrowserScreen, stream: MediaStream, onError: Entry['onError'], signal?: AbortSignal): Entry {
    const context = this.context();
    if (!context?.isCurrent() || context.channelId !== screen.channelId || signal?.aborted) throw cancelled();
    const entry: Entry = {
      screen, context, stream, connectionId: context.client.getConnectionId(), onError,
      config: createNativeScreenCallConfig(context),
      unbind: () => {}, publisher: null, receiver: null, source: null, published: false, retired: false, cancelFrame: null,
    };
    this.entries.add(entry);
    const unbindNetwork = context.client.onEvent((event, value) => {
      if (!context.isCurrent() || context.client.getConnectionId() !== entry.connectionId) {
        this.fail(entry, cancelled());
        return;
      }
      void this.receive(entry, event, value).catch(error => this.fail(entry, error));
    });
    const aborted = (): void => this.close(entry);
    signal?.addEventListener('abort', aborted, { once: true });
    entry.unbind = () => { unbindNetwork(); signal?.removeEventListener('abort', aborted); };
    return entry;
  }

  private async send(entry: Entry, signal: NativeScreenSignalPayload): Promise<void> {
    const retiring = signal.action === 'closed' || signal.action === 'stop';
    if (!retiring) this.current(entry);
    else if (entry.context.client.getStatus() !== 'CONNECTED' || entry.context.client.getConnectionId() !== entry.connectionId) throw cancelled();
    const ack = nativeScreenSignalAckSchema.parse(await entry.context.client.sendRequest<unknown>(MessageType.NATIVE_SCREEN_SIGNAL, signal)
      .catch(error => {
        clientLog.logError('SCREEN_SHARE', `Browser signaling request failed (${signal.action})`, error);
        throw error;
      }));
    if (!retiring) this.current(entry);
    if (ack.subscriptionId !== signal.subscriptionId) throw new Error('Browser signaling acknowledged another subscription.');
  }

  private async rpc<T = unknown>(entry: Entry, method: MessageType, payload: Record<string, unknown>): Promise<T> {
    const retiring = method === MessageType.SFU_PRODUCER_CLOSED || method === MessageType.SFU_CONSUMER_CLOSED
      || method === MessageType.SFU_CLOSE_WEBRTC_TRANSPORT;
    if (!retiring) this.current(entry);
    else if (entry.context.client.getStatus() !== 'CONNECTED' || entry.context.client.getConnectionId() !== entry.connectionId) throw cancelled();
    if (payload.channelId !== entry.screen.channelId) throw new Error('Browser media escaped its room.');
    const result = await entry.context.client.relayRequest<T>(nativeScreenRpcMethodSchema.parse(method), payload).catch(error => {
      clientLog.logError('SCREEN_SHARE', `Browser media request failed (${method})`, error);
      throw error;
    });
    if (!retiring) this.current(entry);
    return result;
  }

  private async receive(entry: Entry, event: string, value: unknown): Promise<void> {
    if (entry.retired) return;
    if (event === `message.${MessageType.BOT_SCREEN_REMOVED}`) {
      const result = botScreenRemovedSchema.safeParse(value);
      const removed = result.success ? result.data : null;
      if (removed?.id === entry.screen.id && removed.instanceId === entry.screen.instanceId
        && removed.channelId === entry.screen.channelId) this.close(entry, false);
      return;
    }
    if (event === `message.${MessageType.NATIVE_SCREEN_SIGNAL}`) {
      const signal = nativeScreenSignalSchema.parse(value);
      if (!entry.source || signal.channelId !== entry.screen.channelId || signal.targetSessionId !== entry.config.sessionId
        || signal.publisherSessionId !== entry.screen.hostSessionId || signal.shareId !== entry.source.shareId
        || signal.sourceInstanceId !== entry.source.instanceId) return;
      if (entry.publisher) {
        if (!entry.context.participants.getInVoiceChannel(entry.screen.channelId)
          .some(peer => (peer.user.sessionId || peer.user.id) === signal.fromSessionId))
          throw new Error('The browser viewer left the room.');
        await entry.publisher.receive(signal);
      } else await entry.receiver?.receive(signal);
    } else if (event === `message.${MessageType.SFU_NEW_PRODUCER}`) {
      const producer = nativeScreenProducerSchema.safeParse(value);
      if (producer.success) await entry.receiver?.addProducer(producer.data);
    } else if (event === `message.${MessageType.SFU_PRODUCER_CLOSED}` && value && typeof value === 'object'
      && 'producerId' in value && typeof value.producerId === 'string') {
      await entry.receiver?.removeProducer(value.producerId);
    } else if (entry.publisher) {
      await entry.publisher.setParticipants(entry.context.participants.getInVoiceChannel(entry.screen.channelId)
        .map(peer => peer.user.sessionId || peer.user.id));
    }
  }

  async host(screen: BrowserScreen, stream: MediaStream, onError: Entry['onError'], signal?: AbortSignal): Promise<BrowserMiniappMediaHandle> {
    if ([...this.entries].some(entry => !entry.retired && entry.screen.instanceId === screen.instanceId
      && entry.config.sessionId === screen.hostSessionId)) {
      stream.getTracks().forEach(track => track.stop());
      throw new Error('The browser already owns a capture.');
    }
    let entry: Entry;
    try { entry = this.create(screen, stream, onError, signal); }
    catch (error) { stream.getTracks().forEach(track => track.stop()); throw error; }
    try {
      if (entry.config.sessionId !== screen.hostSessionId) throw new Error('Only the invoking session may host this browser.');
      const [video] = stream.getVideoTracks();
      if (!video || video.readyState !== 'live' || stream.getAudioTracks().length) throw new Error('The browser must supply only its site video.');
      await this.firstFrame(entry, video);
      this.current(entry);
      const source = nativeScreenSourceSchema.parse({
        shareId: `browser-${screen.instanceId}`, instanceId: screen.instanceId, audio: false, codec: 'h264',
        video: compatibleScreenProfile(browserScreenProfile({
          width: 1920, height: 1080, fps: 30, maxBitrateKbps: 6000,
        }, video.getSettings())),
      });
      entry.source = source;
      entry.publisher = new WebScreenPublisher({
        call: entry.config, source, format: 'compatible', audioBitrateKbps: 128,
        capture: { sourceId: source.shareId, label: 'Browser', captureKind: 'window', audio: false,
          video, audioTrack: null, ended: false },
        signal: signal => this.send(entry, signal), rpc: (method, payload) => this.rpc(entry, method, payload),
        onError: error => this.fail(entry, error),
      });
      const ended = (): void => this.fail(entry, new Error('The browser tab capture ended.'));
      video.addEventListener('ended', ended, { once: true });
      const previousUnbind = entry.unbind;
      entry.unbind = () => { previousUnbind(); video.removeEventListener('ended', ended); };
      const result = botScreenSchema.parse(await entry.context.client.sendRequest<unknown>(MessageType.BOT_BROWSER_PUBLISH, {
        id: screen.id, instanceId: screen.instanceId, source,
      }).catch(error => {
        clientLog.logError('SCREEN_SHARE', 'Browser publication request failed', error);
        throw error;
      }));
      this.current(entry);
      if (result.kind !== 'browser' || result.id !== screen.id || result.instanceId !== screen.instanceId
        || result.hostSessionId !== entry.config.sessionId || JSON.stringify(result.broadcastSource) !== JSON.stringify(source))
        throw new Error('The server did not confirm this browser publication.');
      entry.published = true;
      entry.context.announceSources();
      await entry.publisher.setParticipants(entry.context.participants.getInVoiceChannel(screen.channelId)
        .map(peer => peer.user.sessionId || peer.user.id));
      this.current(entry);
      return { close: () => this.close(entry) };
    } catch (error) { this.close(entry); throw error; }
  }

  async watch(screen: BrowserScreen, onStream: (stream: MediaStream) => void, onError: Entry['onError'],
    signal?: AbortSignal, onClosed?: () => void): Promise<BrowserMiniappMediaHandle> {
    if (!screen.broadcastSource) throw new Error('The browser host has not published yet.');
    const entry = this.create(screen, new MediaStream(), onError, signal);
    entry.source = screen.broadcastSource;
    try {
      if (entry.config.sessionId === screen.hostSessionId) throw new Error('The host cannot subscribe as a viewer.');
      entry.receiver = new BrowserScreenSubscription({
        call: entry.config, publisherSessionId: screen.hostSessionId, source: screen.broadcastSource,
        quality: 'source', muted: true, send: signal => this.send(entry, signal),
        rpc: <T>(method: NativeScreenRpcMethod, payload: Record<string, unknown>) => this.rpc<T>(entry, method, payload),
        onTrack: track => {
          if (entry.retired || !entry.context.isCurrent()) { track.stop(); return; }
          if (track.kind !== 'video') { track.stop(); this.fail(entry, new Error('The browser published undeclared audio.')); return; }
          entry.stream.addTrack(track);
          onStream(entry.stream);
        },
        onCaptureMode: () => {},
        onUnavailable: reason => {
          if (reason === 'source-unavailable' && onClosed) {
            this.close(entry, false);
            onClosed();
          } else this.fail(entry, new Error(`The browser broadcast is unavailable: ${reason}`));
        },
        onError: error => this.fail(entry, error),
      });
      await entry.receiver.start();
      this.current(entry);
      return { close: () => this.close(entry) };
    } catch (error) { this.close(entry); throw error; }
  }

  private firstFrame(entry: Entry, videoTrack: MediaStreamTrack): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof MediaStreamTrackProcessor !== 'function') throw new Error('The browser cannot inspect captured video frames.');
      // Inspect a disposable clone without relying on a hidden video compositor
      // or taking ownership of the original track supplied to the publisher.
      const probe = videoTrack.clone();
      let reader: ReadableStreamDefaultReader<VideoFrame>;
      try { reader = new MediaStreamTrackProcessor({ track: probe, maxBufferSize: 1 }).readable.getReader(); }
      catch (error) { probe.stop(); throw error; }
      let done = false;
      const finish = (error?: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        entry.cancelFrame = null;
        videoTrack.removeEventListener('ended', ended);
        probe.stop();
        void reader.cancel().then(() => {
          reader.releaseLock();
          if (error) reject(error); else resolve();
        }, cleanupError => {
          reader.releaseLock();
          reject(new AggregateError(error ? [error, cleanupError] : [cleanupError], 'Browser frame probe cleanup failed.'));
        });
      };
      const ended = (): void => finish(new Error('The browser capture ended before its first frame.'));
      const timer = setTimeout(() => finish(new Error('The browser capture produced no video frame.')), 15000);
      entry.cancelFrame = () => finish(cancelled());
      videoTrack.addEventListener('ended', ended, { once: true });
      void reader.read().then(result => {
        const frame = result.value;
        const valid = !!frame && frame.displayWidth > 0 && frame.displayHeight > 0;
        frame?.close();
        if (done) return;
        if (!valid) { finish(new Error('The browser capture ended without a video frame.')); return; }
        try { this.current(entry); finish(); } catch (error) { finish(error); }
      }, finish);
    });
  }

  private fail(entry: Entry, error: unknown): void {
    if (entry.retired) return;
    this.close(entry);
    entry.onError(error);
  }

  private close(entry: Entry, requestEnd = true): void {
    if (entry.retired) return;
    entry.retired = true;
    entry.unbind();
    entry.cancelFrame?.();
    this.entries.delete(entry);
    entry.stream.getTracks().forEach(track => track.stop());
    const current = entry.context.isCurrent() && entry.context.client.getConnectionId() === entry.connectionId;
    const end = requestEnd && entry.config.sessionId === entry.screen.hostSessionId && current
      ? entry.context.client.sendRequest<unknown>(MessageType.BOT_SCREEN_END, {
        id: entry.screen.id, instanceId: entry.screen.instanceId,
      }) : undefined;
    const retirement = Promise.all([
      entry.publisher?.close('source-unavailable', requestEnd && current), entry.receiver?.close(true), end,
    ]).then(() => {});
    this.retirements.add(retirement);
    void retirement.then(() => this.retirements.delete(retirement), error => {
      this.retirements.delete(retirement);
      console.error('[Browser miniapp] Media cleanup failed.', error);
    });
    if (current) entry.context.announceSources();
  }

  retire(screen: BotScreen, requestEnd = false): void {
    for (const entry of this.entries) if (entry.screen.id === screen.id && entry.screen.instanceId === screen.instanceId
      && entry.screen.channelId === screen.channelId) this.close(entry, requestEnd);
  }

  closeAll(): Promise<void> {
    for (const entry of [...this.entries]) this.close(entry);
    return Promise.all([...this.retirements]).then(() => {});
  }

  playing(screen: BotScreen): void {
    for (const entry of this.entries) if (!entry.retired && entry.screen.instanceId === screen.instanceId)
      entry.receiver?.playing();
  }
}
