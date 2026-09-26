import type { DesktopSource } from '@monky/shared';

export type MacCaptureTarget =
  | Readonly<{ platform: 'darwin'; kind: 'window'; windowId: number;
      expectedProcessId: number; expectedProcessStartTimeUs: string }>
  | Readonly<{ platform: 'darwin'; kind: 'monitor'; displayId: number; displayUuid: string;
      bounds: Readonly<{ x: number; y: number; width: number; height: number }> }>;

export interface MacScreenProvider {
  capabilities(options?: { signal?: AbortSignal }): Promise<Readonly<{
    platform: 'darwin'; minimumMacOS: '14.0'; enumeration: 'ScreenCaptureKit';
    thumbnails: 'SCScreenshotManager'; capture: false; encoder: null;
    transport: false; receive: false; audio: false;
  }>>;
  listSources(options?: { signal?: AbortSignal }): Promise<DesktopSource[]>;
  thumbnail(sourceId: string, options?: { signal?: AbortSignal; width?: number; height?: number }): Promise<Buffer>;
  resolveTarget(sourceId: string, kind: 'window' | 'monitor', options?: { signal?: AbortSignal }): Promise<MacCaptureTarget>;
  close(): Promise<void>;
}

export interface MacCaptureRuntime {
  readonly kind: 'verified-screencapturekit-host';
  readonly executable: string;
  readonly minimumMacOS: '14.0';
  readonly arch: 'arm64' | 'x64';
}

export function createMacScreenProvider(options?: {
  directory?: string; excludeProcessIds?: readonly number[];
}): MacScreenProvider;
export function loadMacCaptureRuntime(directory?: string): MacCaptureRuntime;
/** Fails closed until an actual compatible macOS RTC/presentation backend exists. */
export function loadMacRuntime(options?: { directory?: string }): never;
export function validateMacTarget(value: unknown): MacCaptureTarget;
export class MacVideoCapture {
  constructor(options: {
    target: MacCaptureTarget;
    video: { width: number; height: number; fps: number; bitrateKbps: number; scaleMode?: 'fit' | 'stretch' };
    mode: 'hardware' | 'software';
    onPacket(frame: { frameId: number; timestampUs: number; durationUs: number; keyframe: boolean;
      data: Buffer; codec: 'h264'; ntpTimeMs: -1 }): void | false;
    onError(error: Error): void;
    directory?: string;
  });
  start(options?: { signal?: AbortSignal }): Promise<{
    codec: 'h264'; mode: 'hardware' | 'software'; firstAccessUnitObserved: true; hardwareSessionConfirmed: boolean;
  }>;
  setBitrate(bitrateKbps: number): Promise<{
    bitrateKbps: number; settingsAccepted: true; hardwareApplicationConfirmed: false; fpsApplied: null;
  }>;
  requestKeyFrame(): Promise<{ mode: 'next-real-idr'; keyframeConfirmed: false; maximumWaitMs: 1500 }>;
  resumePackets(): void;
  close(): Promise<{ nativeClosed: true; hostExited: true; retiredWithErrors: boolean }>;
}
