import { randomUUID } from 'node:crypto';
import type { BrowserWindow, WebFrameMain } from 'electron';
import {
  NATIVE_SCREEN_EVENT, nativeScreenEventSchema, nativeScreenReplySchema, nativeScreenRpcMethodSchema,
  type MessageType, type NativeScreenCall, type NativeScreenEvent, type NativeScreenSignalPayload,
} from '@monky/shared';
import { windowContents, type IpcRegistry } from '../ipc/registry';

type RendererRequest = Extract<NativeScreenEvent, { requestId: string }>;
type RequestInput = Omit<Extract<RendererRequest, { type: 'signal' }>, 'requestId' | 'callId'>
  | Omit<Extract<RendererRequest, { type: 'rpc' }>, 'requestId' | 'callId'>
  | Omit<Extract<RendererRequest, { type: 'presentation-stop' }>, 'requestId' | 'callId'>;

/** What the bridge needs of a call: the document that joined it and whether that document or the remote side is gone. */
export interface BridgedCall {
  readonly config: Pick<NativeScreenCall, 'callId' | 'channelId'>;
  readonly frame: WebFrameMain;
  readonly documentUrl: string;
  readonly documentRetired: boolean;
  readonly remoteUnavailable: boolean;
}

type PendingRequest = {
  call: BridgedCall; type: RendererRequest['type'];
  resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout;
};

/** A document's address without its fragment: in-page navigation keeps the document a call belongs to. */
export function documentIdentity(value: string): string {
  const url = new URL(value);
  url.hash = '';
  return url.href;
}

/**
 * Main's side of the conversation with the renderer document of a call. Events go out through the window's
 * IPC registry; requests (signaling, SFU RPC, the end of a presentation) wait at most 15 seconds for the reply
 * of that same document, and fail at once when the document is gone.
 */
export class RendererBridge {
  private readonly requests = new Map<string, PendingRequest>();

  /** `ipc` must be the registry of `window`, whose main frame joined the calls. */
  constructor(private readonly window: BrowserWindow, private readonly ipc: IpcRegistry) {}

  /** Requests still waiting for the renderer. */
  get pending(): number {
    return this.requests.size;
  }

  /** Whether the document that joined `call` is still the window's main frame. */
  hasFrame(call: BridgedCall): boolean {
    const contents = windowContents(this.window);
    return !call.documentRetired && !!contents
      && !call.frame.isDestroyed() && !call.frame.detached && call.frame.url.length > 0
      && contents.mainFrame === call.frame && documentIdentity(call.frame.url) === call.documentUrl;
  }

  emit(call: BridgedCall, event: NativeScreenEvent): void {
    if (this.hasFrame(call)) this.ipc.send('main', NATIVE_SCREEN_EVENT, nativeScreenEventSchema.parse(event));
  }

  request(call: BridgedCall, input: RequestInput): Promise<unknown> {
    if (!this.hasFrame(call)) return Promise.reject(new Error('The native screen Renderer document is unavailable.'));
    if (call.remoteUnavailable && input.type !== 'presentation-stop')
      return Promise.reject(new Error('The disconnected native screen call cannot acknowledge remote media cleanup.'));
    if (this.requests.size >= 256) return Promise.reject(new Error('Native screen IPC exceeded its pending-request limit.'));
    const requestId = randomUUID();
    const event = nativeScreenEventSchema.parse({ ...input, requestId, callId: call.config.callId });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(requestId);
        reject(new Error(`Native screen Renderer ${input.type} did not acknowledge its request.`));
      }, 15000);
      this.requests.set(requestId, { call, type: input.type, resolve, reject, timer });
      try {
        if (!this.ipc.send('main', NATIVE_SCREEN_EVENT, event))
          throw new Error('The native screen Renderer document is unavailable.');
      } catch (error) {
        clearTimeout(timer);
        this.requests.delete(requestId);
        reject(error);
      }
    });
  }

  /** Settles the request a renderer reply answers; a reply from another call or document is refused. */
  reply(value: unknown): void {
    const reply = nativeScreenReplySchema.parse(value);
    const pending = this.requests.get(reply.requestId);
    if (!pending) {
      console.warn('[NativeScreen] Ignored an expired Renderer response.');
      return;
    }
    if (pending.call.config.callId !== reply.callId || !this.hasFrame(pending.call))
      throw new Error('Native screen response belongs to a different call or Renderer document.');
    clearTimeout(pending.timer);
    this.requests.delete(reply.requestId);
    if (reply.ok) pending.resolve(reply.value);
    else pending.reject(new Error(reply.error));
  }

  /** Signaling that the renderer relays to the server. */
  send(call: BridgedCall, signal: NativeScreenSignalPayload): Promise<void> {
    return this.request(call, { type: 'signal', signal }).then(() => {});
  }

  /** An SFU request that the renderer makes on the call's voice channel. */
  rpc(call: BridgedCall, type: MessageType, payload: Readonly<Record<string, unknown>>): Promise<unknown> {
    const method = nativeScreenRpcMethodSchema.parse(type);
    if (payload.channelId !== call.config.channelId) return Promise.reject(new Error('Native SFU RPC escaped its voice channel.'));
    return this.request(call, { type: 'rpc', method, payload });
  }

  /** Fails what can no longer be answered: requests of a retired document, or remote acknowledgements of a lost call. */
  rejectUnavailable(): void {
    for (const [id, pending] of this.requests) {
      if (!this.hasFrame(pending.call) || (pending.call.remoteUnavailable && pending.type !== 'presentation-stop')) {
        clearTimeout(pending.timer); this.requests.delete(id);
        pending.reject(new Error('The native screen document or remote connection was retired before acknowledgement.'));
      }
    }
  }
}
