import {
  nativeScreenEventSchema, nativeScreenReplySchema, nativeScreenRpcMethodSchema,
  type NativeScreenEvent, type NativeScreenSignalPayload,
} from '@monky/shared';

type Request = Extract<NativeScreenEvent, { requestId: string }>;
type Without<T> = T extends unknown ? Omit<T, 'requestId' | 'callId'> : never;
type RequestInput = Without<Request>;
interface Pending {
  readonly callId: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export const WEB_SCREEN_REQUEST_TIMEOUT_MS = 15000;

/**
 * The web runtime's side of the conversation the desktop's Main holds with the renderer (#858): events go
 * to the subscribed screen calls, and requests (signaling, SFU RPC) wait at most 15 seconds for their reply.
 * Delivery is asynchronous and in order, as over IPC, so the renderer code above behaves the same.
 */
export class WebScreenBridge {
  private readonly listeners = new Set<(event: NativeScreenEvent) => void>();
  private readonly requests = new Map<string, Pending>();

  public subscribe(listener: (event: NativeScreenEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  public emit(event: NativeScreenEvent): void {
    const parsed = nativeScreenEventSchema.parse(event);
    queueMicrotask(() => {
      for (const listener of [...this.listeners]) {
        try { listener(parsed); }
        catch (error) { console.error('[WebScreen] Screen event observer failed:', error); }
      }
    });
  }

  public request(callId: string, input: RequestInput): Promise<unknown> {
    if (!this.listeners.size) return Promise.reject(new Error('No screen call listens for the request.'));
    if (this.requests.size >= 256) return Promise.reject(new Error('Screen requests exceeded their pending limit.'));
    const requestId = crypto.randomUUID();
    const event = nativeScreenEventSchema.parse({ ...input, requestId, callId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error(`The screen ${input.type} request was not acknowledged.`));
      }, WEB_SCREEN_REQUEST_TIMEOUT_MS);
      this.requests.set(requestId, { callId, resolve, reject, timer });
      this.emit(event);
    });
  }

  public reply(value: unknown): void {
    const reply = nativeScreenReplySchema.parse(value);
    const pending = this.requests.get(reply.requestId);
    if (!pending) return;
    if (pending.callId !== reply.callId) throw new Error('The screen reply belongs to another call.');
    clearTimeout(pending.timer);
    this.requests.delete(reply.requestId);
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(new Error(reply.error));
  }

  public signal(callId: string, signal: NativeScreenSignalPayload): Promise<void> {
    return this.request(callId, { type: 'signal', signal }).then(() => {});
  }

  public rpc(callId: string, channelId: string, method: string, payload: Record<string, unknown>): Promise<unknown> {
    if (payload.channelId !== channelId) return Promise.reject(new Error('Screen SFU RPC escaped its voice channel.'));
    return this.request(callId, { type: 'rpc', method: nativeScreenRpcMethodSchema.parse(method), payload });
  }

  /** Fails what a call can no longer have answered: its connection to the server is gone. */
  public rejectCall(callId: string): void {
    for (const [requestId, pending] of this.requests) {
      if (pending.callId !== callId) continue;
      clearTimeout(pending.timer);
      this.requests.delete(requestId);
      pending.reject(new Error('The screen call lost its connection before acknowledgement.'));
    }
  }
}
