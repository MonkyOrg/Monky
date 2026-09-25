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

export type NativeScreenCaptureEncoder = 'auto' | 'h264_texture_amf' | 'obs_nvenc_h264_tex'
  | 'obs_x264' | 'av1_texture_amf' | 'obs_nvenc_av1_tex' | 'monky_aom_av1';
export type NativeScreenCaptureTarget =
  | { kind: 'window' | 'game'; hwnd: number; expectedProcessId: number; expectedProcessCreationTime100ns: string }
  | { kind: 'monitor'; deviceId: string; deviceName: string; bounds: { x: number; y: number; width: number; height: number } };

export type LegacyNativeWindowCaptureTarget = { kind?: never; hwnd: number; expectedProcessId: number };

/** Validates exact keys and returns the same input; cloning/freezing belongs to capture preparation. */
export function validateCaptureTarget<T extends NativeScreenCaptureTarget | LegacyNativeWindowCaptureTarget>(target: T): T;
export function validateCaptureTarget(target: unknown): NativeScreenCaptureTarget | LegacyNativeWindowCaptureTarget;

export interface NativeScreenCaptureCapability {
  readonly encoderId: Exclude<NativeScreenCaptureEncoder, 'auto'>;
  readonly codec: 'h264' | 'av1';
  readonly mode: 'hardware' | 'software';
  readonly adapterIndex: 0;
  readonly adapterLuid: string;
  readonly vendorId: number;
  readonly deviceId: number;
  readonly probe: 'obs-amf-test' | 'nvenc-d3d11-session' | 'software-encoder';
  readonly probeVerified: true;
  readonly textureInput: boolean;
  readonly dynamicBitrate: true;
  readonly hardwareSessionConfirmed: boolean;
  readonly hardwareQualified: false;
}

export interface NativeScreenCaptureSnapshot {
  readonly nativeClosed: boolean;
  readonly forcedTermination: boolean;
}

export interface NativeScreenCaptureProbeOptions {
  host: NativeScreenRuntime['host'];
  runtime: NativeScreenRuntime['obs'];
  runId: string;
  runDirectory: string;
  video: { width: number; height: number; fps: number; bitrateKbps: number; scaleMode?: 'stretch' | 'fit' };
  encoder?: NativeScreenCaptureEncoder;
}

export interface NativeScreenCaptureProbeResult extends NativeScreenCaptureCapability {
  readonly encoderInitialized: true;
  readonly hardwareSessionConfirmed: false;
  readonly sourceCaptured: false;
  readonly captureKinds: readonly ['window', 'monitor', 'game'];
  readonly video: Readonly<NativeScreenCaptureProbeOptions['video']>;
}

/**
 * Performs real source-free initialization of the selected encoder, not a static capability lookup.
 * Resolves only after native retirement and child exit; does not prove source/game compatibility
 * or encoded frames. The caller owns cleanup of the private nonce-bound run directory.
 */
export function probeCaptureCapabilities(
  options: NativeScreenCaptureProbeOptions, signal?: AbortSignal,
): Promise<NativeScreenCaptureProbeResult>;

export class CaptureBridge {
  constructor(options: NativeScreenCaptureProbeOptions & {
    isSourcePaused?: () => boolean;
    onError: (error: Error) => void;
    onPacket: (frame: NativeScreenPreviewFrame) => undefined | false;
    onNotice: (notice: unknown) => undefined;
  });
  readonly child?: import('node:child_process').ChildProcess;
  /** Probes the explicitly selected target/settings, without source pixels or a production encoder. */
  prepare(target: NativeScreenCaptureTarget | LegacyNativeWindowCaptureTarget, signal?: AbortSignal): Promise<unknown>;
  start(target: NativeScreenCaptureTarget | LegacyNativeWindowCaptureTarget, signal?: AbortSignal): Promise<unknown>;
  getCapabilities(): NativeScreenCaptureCapability | null;
  setBitrate(bitrateKbps: number): Promise<{
    kind: 'bitrate-settings'; sequence: number; bitrateKbps: number; settingsAccepted: true;
    hardwareApplicationConfirmed: false; fpsApplied: null;
  }>;
  requestKeyFrame(): Promise<{
    kind: 'idr-request'; sequence: number; keyframeConfirmed: false; mode: 'next-real-idr'; maximumWaitMs: 1500;
  }>;
  snapshot(): NativeScreenCaptureSnapshot;
  stop(): Promise<NativeScreenCaptureSnapshot>;
}

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
  readonly capture: {
    readonly captureKinds: readonly import('@monky/shared').NativeScreenCaptureKind[];
    readonly encoders: readonly Exclude<NativeScreenCaptureEncoder, 'auto'>[];
    readonly requiresHardwareProbe: true;
    readonly hardwareQualified: false;
  };
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

export type NativeScreenEndpointState =
  | { type: 'peer'; state: unknown }
  | { type: 'transport'; state: string }
  | { type: 'capture'; state: string }
  | { type: 'capture-mode'; capture: import('@monky/shared').NativeScreenCaptureStatus }
  | { type: 'capture-fallback' | 'frame' | 'closed' };

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
  target?: NativeScreenCaptureTarget | LegacyNativeWindowCaptureTarget;
  captureEncoder?: NativeScreenCaptureEncoder;
  preserveAspectRatio?: boolean;
  captureDirectory?: string;
  isSourcePaused?: () => boolean;
  assertSourceCurrent?: () => void;
  onPreview?: (frame: NativeScreenPreviewFrame) => void;
  destination?: { frame: WebFrameMain; presentationId: string };
  send?: (remoteSessionId: string, control: NativeScreenP2pControl) => Promise<void>;
  rpc?: (type: MessageType, payload: Readonly<Record<string, unknown>>) => Promise<unknown>;
  onError: (error: Error, context?: unknown) => void;
  onState: (state: NativeScreenEndpointState) => void;
  onDiagnostic: (error: Error) => void;
}

export interface NativeScreenEndpointSnapshot {
  role: 'publish' | 'receive';
  mode: 'p2p' | 'sfu';
  pipelineId: string;
  profile: Readonly<NativeScreenVideoProfile>;
  captureState: 'waiting' | 'starting' | 'running' | 'stopping' | 'closed';
  captureMode: import('@monky/shared').NativeScreenCaptureMode | null;
  demand: number;
  previewDemand: boolean;
  closing: boolean;
  nativeClosed: boolean;
  closed: boolean;
  capturePid: number | null;
  flow: Readonly<Record<string, unknown>> | null;
  captureRetirement: Readonly<Record<string, unknown>> | null;
  gameCaptureRetirement: Readonly<Record<string, unknown>> | null;
  presentation: Readonly<Record<string, unknown>> | null;
  routes: Readonly<Record<string, unknown>> | null;
  audioInput: Readonly<Record<string, unknown>> | null;
  audioOutput: Readonly<Record<string, unknown>> | null;
  errors: readonly { code: string | null; message: string }[];
}

export function loadRuntime(directory?: string): NativeScreenRuntime;
export function loadCaptureRuntime(directory?: string): Pick<NativeScreenRuntime, 'host' | 'obs' | 'capture'>;
export class NativeScreenEndpoint {
  constructor(options: NativeScreenEndpointOptions);
  readonly ready: Promise<void>;
  setDemand(count: number, preview?: boolean): Promise<void>;
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

export interface NativeScreenPreviewFrame { data: Uint8Array; timestampUs: number; keyframe: boolean; codec?: 'av1' }
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
  onState: (state: { shareId: string; pipelineId: string; quality: ScreenShareQuality; state: NativeScreenEndpointState }) => void;
  onPreview?: (packet: { frame: NativeScreenPreviewFrame; pipelineId: string; video: NativeScreenVideoProfile;
    captureMode: import('@monky/shared').NativeScreenCaptureMode | null } | null) => void;
}
export interface NativeScreenPublisherSnapshot {
  source: NativeScreenSource;
  previewEnabled: boolean;
  stopping: boolean;
  closed: boolean;
  viewers: number;
  pipelines: readonly {
    pipelineId: string; quality: ScreenShareQuality; viewers: number; endpoint: NativeScreenEndpointSnapshot;
  }[];
}
export class NativeScreenPublisher {
  constructor(options: NativeScreenPublisherOptions);
  setPreviewEnabled(enabled: boolean): Promise<void>;
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
  } & ({
    type: 'connecting' | 'playing' | 'unavailable' | 'closed'; reason?: import('@monky/shared').NativeScreenFailure;
  } | { type: 'capture-mode'; mode: import('@monky/shared').NativeScreenCaptureMode })) => void;
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
    onState: (state: import('@monky/shared').NativeScreenPreviewState) => void; onError: (error: Error) => void;
  });
  readonly info: import('@monky/shared').NativeScreenPreviewInfo;
  readonly closed: boolean;
  offer(frame: NativeScreenPreviewFrame, pipelineId: string, video: NativeScreenVideoProfile): void;
  reset(state?: 'waiting' | 'paused'): void;
  close(): void;
}

export function registerNativeAudioPortReceiver(
  ipcRenderer: IpcRenderer, protocol: typeof import('@monky/shared'),
  options: { workletUrl: string; onError: (error: Error) => void },
): { getStats(): Readonly<Record<string, unknown>>; dispose(): Promise<void> };
