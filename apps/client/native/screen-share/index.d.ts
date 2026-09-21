import type {
  MessageType, NativeScreenSource, NativeScreenP2pControl, NativeScreenVideoProfile, ScreenShareQuality,
  NativeScreenAudioPreferences, NativeScreenEndpointDiagnostics,
} from '@monky/shared';
import type { IpcRenderer, MessageChannelMain, WebContents, WebFrameMain } from 'electron';

type PacketCaptureModule = Pick<typeof import('@monky/screen-audio'), 'createPacketCapture'>;
type PacketCapture = ReturnType<PacketCaptureModule['createPacketCapture']>;
type PacketCaptureSelection = Pick<import('@monky/screen-audio').PacketCaptureOptions,
  'includeWindowId' | 'excludePid' | 'expectedProcessId'>;

export type { NativeScreenAudioPreferences } from '@monky/shared';

export interface NativeScreenAudioOptions extends NativeScreenAudioPreferences {
  output: {
    webContents: WebContents;
    frame: WebFrameMain;
    expectedUrl: string;
    createMessageChannel: () => MessageChannelMain;
    timeoutMs?: number;
  };
  captureModule?: PacketCaptureModule;
  captureHub?: NativePcmCaptureHub;
  maxBitrateBps?: number;
}

export class NativePcmCaptureHub {
  constructor(captureModule: PacketCaptureModule, selection: PacketCaptureSelection, onError: (error: Error) => void);
  static matches(hub: unknown, captureModule: PacketCaptureModule, selection: PacketCaptureSelection): boolean;
  subscribe(selection: PacketCaptureSelection,
    onEvent: Parameters<PacketCaptureModule['createPacketCapture']>[1]): {
      readonly kind: 'native-pcm-subscription';
      readonly ready: PacketCapture['ready'];
      readonly detached: Promise<void>;
      detach(): Promise<void>;
      getStats(): {
        kind: 'native-pcm-subscription'; detached: boolean; captureClosed: boolean;
        capture: ReturnType<PacketCapture['getStats']> | null;
      };
    };
  close(): Promise<void>;
  waitUntilIdle(): Promise<void>;
  getStats(): {
    kind: 'native-pcm-capture-owner'; captureStarts: number; subscriptions: number;
    captureClosed: boolean; closed: boolean; capture: ReturnType<PacketCapture['getStats']> | null;
  };
}

export interface NativeScreenRuntime {
  readonly rtc: {
    capabilities(): Readonly<Record<string, unknown>>;
    createEngine(options: Readonly<Record<string, unknown>>, onEvent: (event: unknown) => void): unknown;
  };
  readonly host: { readonly kind: 'verified-native-screen-capture-host'; readonly executable: string; readonly sha256: string };
  readonly obs: {
    readonly kind: 'verified-stock-obs-runtime'; readonly version: string;
    readonly stockDirectory: string; readonly binaryDirectory: string;
  };
}

export interface NativeScreenEndpointOptions {
  runtime: NativeScreenRuntime;
  textures: typeof import('electron').sharedTexture;
  role: 'publish' | 'receive';
  mode: 'p2p' | 'sfu';
  sessionId: string;
  publisherSessionId: string;
  channelId: string;
  pipelineId: string;
  source: NativeScreenSource;
  quality: ScreenShareQuality;
  audio?: NativeScreenAudioOptions;
  target?: { hwnd: number; expectedProcessId: number };
  captureDirectory?: string;
  isSourcePaused?: () => boolean;
  onPreview?: (frame: NativeScreenPreviewFrame) => void;
  destination?: { frame: WebFrameMain; presentationId: string };
  send?: (remoteSessionId: string, control: NativeScreenP2pControl) => Promise<void>;
  rpc?: (type: MessageType, payload: Readonly<Record<string, unknown>>) => Promise<unknown>;
  onError: (error: Error, context?: unknown) => void;
  onState: (state:
    | { type: 'peer'; state: unknown }
    | { type: 'transport'; state: string }
    | { type: 'capture'; state: string }
    | { type: 'frame' | 'closed' }
  ) => void;
  onDiagnostic: (error: Error) => void;
}

export interface NativeScreenEndpointSnapshot {
  role: 'publish' | 'receive';
  mode: 'p2p' | 'sfu';
  pipelineId: string;
  profile: Readonly<NativeScreenVideoProfile>;
  captureState: 'waiting' | 'starting' | 'running' | 'stopping' | 'closed';
  demand: number;
  closing: boolean;
  nativeClosed: boolean;
  closed: boolean;
  capturePid: number | null;
  flow: Readonly<Record<string, unknown>> | null;
  captureRetirement: Readonly<Record<string, unknown>> | null;
  presentation: Readonly<Record<string, unknown>> | null;
  routes: Readonly<Record<string, unknown>> | null;
  audioInput: Readonly<Record<string, unknown>> | null;
  audioOutput: Readonly<Record<string, unknown>> | null;
  errors: readonly { code: string | null; message: string }[];
}

export function loadRuntime(directory?: string): NativeScreenRuntime;
export class NativeScreenEndpoint {
  constructor(options: NativeScreenEndpointOptions);
  readonly ready: Promise<void>;
  setDemand(count: number): Promise<void>;
  connectPeer(remoteSessionId: string, configuration: {
    connectionId: string; generation: number;
    iceServers: readonly { urls: string[]; username?: string; credential?: string }[];
  }): Promise<number>;
  receiveControl(remoteSessionId: string, control: NativeScreenP2pControl): Promise<unknown>;
  closePeer(remoteSessionId: string): Promise<void>;
  stopWatching(): Promise<void>;
  setAudioPreferences(preferences: Pick<NativeScreenAudioPreferences, 'muted' | 'volume'>): Promise<void>;
  addRemoteProducer(value: unknown): Promise<void>;
  removeRemoteProducer(producerId: string): Promise<void>;
  stats(): Promise<NativeScreenEndpointSnapshot & { capture: unknown; rtc: unknown }>;
  diagnostics(): Promise<NativeScreenEndpointDiagnostics>;
  snapshot(): NativeScreenEndpointSnapshot;
  close(): Promise<NativeScreenEndpointSnapshot>;
}

export interface NativeScreenPreviewFrame { data: Uint8Array; timestampUs: number; keyframe: boolean }
type PublisherEndpointOptions = Pick<NativeScreenEndpointOptions, 'source' | 'quality' | 'pipelineId' | 'send' | 'onError' | 'onState' | 'onPreview'>;
type SubscriptionEndpointOptions = PublisherEndpointOptions & { presentationId: string };
export interface NativeScreenPublisherOptions {
  sessionId: string;
  channelId: string;
  mode: 'p2p' | 'sfu';
  source: NativeScreenSource;
  iceServers: readonly { urls: readonly string[]; username?: string; credential?: string }[];
  createEndpoint: (options: PublisherEndpointOptions) => NativeScreenEndpoint;
  send: (signal: import('@monky/shared').NativeScreenSignalPayload) => Promise<void>;
  onError: (error: Error, context?: unknown) => void;
  onState: (state: { shareId: string; pipelineId: string; quality: ScreenShareQuality; state: unknown }) => void;
  onPreview?: (packet: { frame: NativeScreenPreviewFrame; pipelineId: string; video: NativeScreenVideoProfile } | null) => void;
}
export interface NativeScreenPublisherSnapshot {
  source: NativeScreenSource;
  stopping: boolean;
  closed: boolean;
  viewers: number;
  pipelines: readonly {
    pipelineId: string; quality: ScreenShareQuality; viewers: number; endpoint: NativeScreenEndpointSnapshot;
  }[];
}
export class NativeScreenPublisher {
  constructor(options: NativeScreenPublisherOptions);
  receive(signal: import('@monky/shared').NativeScreenSignalPayload): Promise<void>;
  setParticipants(sessionIds: readonly string[]): Promise<void>;
  close(reason?: import('@monky/shared').NativeScreenFailure): Promise<void>;
  snapshot(): NativeScreenPublisherSnapshot;
  diagnostics(): Promise<NativeScreenEndpointDiagnostics[]>;
  /** Local native owners only; does not assert that an unreachable SFU acknowledged cleanup. */
  assertLocallyClosed(): void;
}
export interface NativeScreenSubscriptionOptions {
  sessionId: string;
  publisherSessionId: string;
  channelId: string;
  mode: 'p2p' | 'sfu';
  source: NativeScreenSource;
  quality: ScreenShareQuality;
  backend?: 'native' | 'browser';
  presentationId?: string;
  iceServers: readonly { urls: readonly string[]; username?: string; credential?: string }[];
  createEndpoint: (options: SubscriptionEndpointOptions) => NativeScreenEndpoint;
  retirePresentation: (presentationId: string) => Promise<unknown>;
  send: (signal: import('@monky/shared').NativeScreenSignalPayload) => Promise<void>;
  onError: (error: Error) => void;
  onState: (state: {
    subscriptionId: string; presentationId: string; quality: ScreenShareQuality;
    type: 'connecting' | 'playing' | 'unavailable' | 'closed'; reason?: import('@monky/shared').NativeScreenFailure;
  }) => void;
}
export class NativeScreenSubscription {
  constructor(options: NativeScreenSubscriptionOptions);
  readonly subscriptionId: string;
  readonly presentationId: string;
  start(): Promise<void>;
  receive(signal: import('@monky/shared').NativeScreenSignalPayload): Promise<void>;
  addRemoteProducer(value: import('@monky/shared').NativeScreenProducer): Promise<void>;
  removeRemoteProducer(producerId: string): Promise<void>;
  setAudioPreferences(preferences: Pick<NativeScreenAudioPreferences, 'muted' | 'volume'>): Promise<void>;
  close(notify?: boolean): Promise<void>;
  /** Local native owners only; does not assert that an unreachable SFU acknowledged cleanup. */
  assertLocallyClosed(): void;
  diagnostics(): Promise<NativeScreenEndpointDiagnostics[]>;
  snapshot(): {
    subscriptionId: string; presentationId: string; quality: ScreenShareQuality;
    generation: number | null; stopping: boolean; closed: boolean; endpoint: NativeScreenEndpointSnapshot | null;
  };
}

export interface NativeScreenPresentationController {
  attach(input: import('@monky/shared').NativeScreenPresentation): Promise<void>;
  attachPreview(input: import('@monky/shared').NativeScreenPresentation): Promise<void>;
  stop(presentationId: string): Promise<void>;
  sample(presentationId: string): Promise<import('@monky/shared').NativeScreenPresentationSample | null>;
  close(): Promise<void>;
}
export function createNativeScreenPresentation(
  textures: typeof import('electron').sharedTexture, document: Document,
  onError: (presentationId: string | null, error: Error) => void,
  ipcRenderer?: IpcRenderer,
): NativeScreenPresentationController;

export class NativeScreenPreviewBridge {
  constructor(options: {
    frame: WebFrameMain; info: import('@monky/shared').NativeScreenPreviewInfo;
    createMessageChannel: () => MessageChannelMain;
    onState: (state: 'waiting' | 'playing' | 'unavailable') => void; onError: (error: Error) => void;
  });
  readonly info: import('@monky/shared').NativeScreenPreviewInfo;
  offer(frame: NativeScreenPreviewFrame, pipelineId: string, video: NativeScreenVideoProfile): void;
  reset(): void;
  close(): void;
}

export function registerNativeAudioPortReceiver(
  ipcRenderer: IpcRenderer, protocol: typeof import('@monky/shared'),
  options: { workletUrl: string; onError: (error: Error) => void },
): { getStats(): Readonly<Record<string, unknown>>; dispose(): Promise<void> };
