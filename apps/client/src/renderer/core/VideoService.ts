import { QUALITY_PRESETS, QualityProfile, QualityPresetType, type NativeScreenSource, type NativeScreenCaptureKind } from '@monky/shared';
import { appEvents } from './EventBus';
import { settingsStore } from '../stores/settingsStore';
import { clientLog } from './ClientLogService';
import { cameraEffectsStore } from '../stores/cameraEffectsStore';
import { CameraEffectProcessor } from './cameraEffects/CameraEffectProcessor';
import {
  CameraEffectError, cameraCaptureError, cameraOperationCancelled, isCameraOperationCancelled,
  needsBackgroundImage, type CameraEffectSettings,
} from '../utils/cameraEffects';
import { prepareCameraBackground } from '../utils/cameraBackgroundImage';

export interface CameraState {
  /** Preview readiness; 'starting' can retain the same live, gated outgoing track. */
  readonly status: 'idle' | 'starting' | 'ready' | 'error';
  readonly stream: MediaStream | null;
  readonly publishing: boolean;
  readonly error: CameraEffectError | null;
}

export interface CameraPreviewLease {
  readonly stream: MediaStream;
  release(): void;
}

export interface NativeScreenCapture {
  readonly source: NativeScreenSource;
  readonly desktopSourceId: string;
  readonly captureKind?: NativeScreenCaptureKind;
  readonly preserveAspectRatio?: boolean;
  readonly audioBitrateKbps: number;
}

export class VideoService {
  private cameraStream: MediaStream | null = null;
  private cameraRawStream: MediaStream | null = null;
  private cameraProcessor: CameraEffectProcessor | null = null;
  private announcedCameraStream: MediaStream | null = null;
  private cameraRequested = false;
  private cameraDeviceId: string | undefined;
  private cameraStatus: CameraState['status'] = 'idle';
  private cameraError: CameraEffectError | null = null;
  private cameraOffRequiresConsent = false;
  private cameraEffectChoiceEpoch = 0;
  private cameraJobs: Promise<void> = Promise.resolve();
  private cameraPending: Promise<MediaStream | null> | null = null;
  private readonly cameraPreviewLeases = new Set<symbol>();
  private readonly cameraListeners = new Set<(state: CameraState) => void>();
  private cameraTrackEnded: (() => void) | null = null;
  private cameraCaptureEpoch = 0;
  private cameraSessionEpoch = 0;
  /**
   * Active screen shares keyed by share id (#253). The share id is the
   * MediaStream id, which is also the native source id announced to the call,
   * so the same handle identifies the share locally, on the wire and in the
   * remote UI.
   */
  private screenStreams: Map<string, MediaStream> = new Map();
  /** Maps stream id → desktop source id so the picker can hide active shares. */
  private screenSourceIds: Map<string, string> = new Map();
  /** What each share shows (window title, screen number), to tell several apart. */
  private screenLabels = new Map<string, string>();
  private nativeScreenCaptures = new Map<string, NativeScreenCapture>();
  private currentPreset: QualityPresetType = settingsStore.qualityPreset;
  private readonly stopCameraOnPageHide = () => this.stopCamera();

  public constructor() {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', this.stopCameraOnPageHide);
    }
  }

  public setQualityPreset(preset: QualityPresetType): void {
    this.currentPreset = preset;
  }

  /**
   * Applies the quality preset dynamically to current preset and updates
   * constraints on an active camera. Native screen sources follow the profile
   * through their own owner.
   */
  public async applyQualityPreset(preset: QualityPresetType): Promise<void> {
    this.currentPreset = preset;
    const profile = this.getProfile();

    this.cameraProcessor?.setProfile(profile);
    if (this.cameraRawStream) {
      const cameraTracks = new Set([
        ...this.cameraRawStream.getVideoTracks(),
        ...(!this.cameraProcessor ? this.cameraStream?.getVideoTracks() ?? [] : []),
      ]);
      for (const cameraTrack of cameraTracks) {
        if (cameraTrack.readyState !== 'live') continue;
        try {
          await cameraTrack.applyConstraints({
            width: { ideal: profile.cameraWidth },
            height: { ideal: profile.cameraHeight },
            frameRate: { ideal: profile.cameraFps, max: profile.cameraFps },
          });
        } catch (err) {
          clientLog.warn('VIDEO', 'Failed to apply constraints to camera track', { error: String(err) });
        }
      }
    }
  }

  public getProfile(): QualityProfile {
    if (this.currentPreset === 'CUSTOM') return settingsStore.customProfile;
    return QUALITY_PRESETS[this.currentPreset] || QUALITY_PRESETS.NORMAL;
  }

  public async startCamera(deviceId?: string): Promise<MediaStream> {
    const session = this.cameraSessionEpoch;
    this.cameraRequested = true;
    const target = deviceId || settingsStore.selectedCameraId || undefined;
    if (this.cameraDeviceId !== target) {
      try {
        await this.setCameraDevice(target ?? '');
      } catch (error) {
        if (!isCameraOperationCancelled(error) || !this.cameraRequested || session !== this.cameraSessionEpoch) throw error;
      }
    }
    const stream = await this.ensureCamera(() => this.cameraRequested && session === this.cameraSessionEpoch);
    if (!this.cameraRequested || session !== this.cameraSessionEpoch || this.cameraStream !== stream) throw cameraOperationCancelled();
    this.announceCamera();
    this.notifyCameraState();
    return stream;
  }

  public stopCamera(): void {
    this.cameraCaptureEpoch++;
    this.cameraSessionEpoch++;
    this.cameraPending = null;
    this.cameraRequested = false;
    this.cameraPreviewLeases.clear();
    const announced = this.announcedCameraStream !== null;
    this.announcedCameraStream = null;
    this.releaseCameraCapture();
    this.cameraStatus = 'idle';
    this.cameraError = null;
    this.notifyCameraState();
    if (announced) appEvents.emit('local.camera_stopped');
  }

  public async acquireCameraPreview(signal?: AbortSignal): Promise<CameraPreviewLease> {
    if (signal?.aborted) throw cameraOperationCancelled();
    const token = Symbol('camera-preview');
    this.cameraPreviewLeases.add(token);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', release);
      if (this.cameraPreviewLeases.delete(token) && !this.hasCameraDemand()) this.stopCamera();
    };
    signal?.addEventListener('abort', release, { once: true });
    try {
      const target = settingsStore.selectedCameraId || undefined;
      if (!this.cameraRawStream && !this.cameraPending) this.cameraDeviceId = target;
      const stream = await this.ensureCamera(() => this.cameraPreviewLeases.has(token));
      if (released || !this.cameraPreviewLeases.has(token)) throw cameraOperationCancelled();
      return { stream, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  public async setCameraDevice(deviceId: string): Promise<void> {
    const target = deviceId || undefined;
    if (this.cameraDeviceId === target && this.cameraStatus === 'ready') return;
    this.cameraDeviceId = target;
    await this.scheduleCameraChange(undefined, true);
  }

  public async setCameraEffects(patch: Partial<CameraEffectSettings>): Promise<void> {
    const choice = patch.mode ? ++this.cameraEffectChoiceEpoch : this.cameraEffectChoiceEpoch;
    if (patch.mode && patch.mode !== 'off') this.cameraOffRequiresConsent = true;
    await this.scheduleCameraChange(async () => {
      await cameraEffectsStore.update(patch);
      if (patch.mode === 'off' && choice === this.cameraEffectChoiceEpoch) this.cameraOffRequiresConsent = false;
    });
  }

  public async setCameraBackgroundImage(file: File, signal?: AbortSignal): Promise<void> {
    await this.scheduleCameraChange(async () => {
      const image = await prepareCameraBackground(file, signal);
      if (signal?.aborted) throw cameraOperationCancelled();
      await cameraEffectsStore.setImage(image);
    });
  }

  public async removeCameraBackgroundImage(): Promise<void> {
    await this.scheduleCameraChange(async () => { await cameraEffectsStore.removeImage(); });
  }

  public getCameraState(): CameraState {
    return {
      status: this.cameraStatus,
      stream: this.cameraStatus === 'ready' ? this.cameraStream : null,
      publishing: this.announcedCameraStream !== null,
      error: this.cameraError,
    };
  }

  public subscribeCameraState(listener: (state: CameraState) => void): () => void {
    this.cameraListeners.add(listener);
    listener(this.getCameraState());
    return () => this.cameraListeners.delete(listener);
  }

  public dispose(): void {
    this.stopCamera();
    this.cameraListeners.clear();
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', this.stopCameraOnPageHide);
    }
  }

  private hasCameraDemand(): boolean {
    return this.cameraRequested || this.cameraPreviewLeases.size > 0;
  }

  private async ensureCamera(stillRequested: () => boolean): Promise<MediaStream> {
    while (this.hasCameraDemand() && stillRequested()) {
      if (this.cameraStatus === 'ready' && this.cameraStream?.getVideoTracks()[0]?.readyState === 'live') {
        return this.cameraStream;
      }
      const pending = this.cameraPending ?? this.scheduleCameraChange();
      try {
        const stream = await pending;
        if (stream && this.cameraStream === stream && stillRequested()) return stream;
      } catch (error) {
        if (!isCameraOperationCancelled(error) || !this.hasCameraDemand() || !stillRequested()
          || !this.cameraPending || this.cameraPending === pending) throw error;
      }
    }
    throw cameraOperationCancelled();
  }

  private scheduleCameraChange(
    change?: () => Promise<void>,
    replaceDevice = false,
  ): Promise<MediaStream | null> {
    const epoch = ++this.cameraCaptureEpoch;
    if (this.cameraProcessor && !this.cameraProcessor.isStarted) {
      this.cameraProcessor.stop();
      this.cameraProcessor = null;
    } else {
      this.cameraProcessor?.suspend();
    }
    if (!this.cameraProcessor) this.cameraStream?.getTracks().forEach((track) => track.stop());
    if (replaceDevice) this.releaseCameraCapture();
    this.cameraStatus = this.hasCameraDemand() ? 'starting' : 'idle';
    this.cameraError = null;
    this.notifyCameraState();
    const operation = this.cameraJobs.then(async () => {
      if (change) await change();
      this.assertCameraEpoch(epoch);
      if (!this.hasCameraDemand()) return null;
      return this.buildCameraOutput(epoch);
    }).catch((error: unknown) => {
      if (isCameraOperationCancelled(error)) {
        if (epoch === this.cameraCaptureEpoch) this.stopCamera();
        throw error;
      }
      const failure = cameraCaptureError(error);
      if (epoch === this.cameraCaptureEpoch) this.failCamera(failure);
      throw failure;
    }).finally(() => {
      if (this.cameraPending === operation) this.cameraPending = null;
    });
    this.cameraPending = operation;
    this.cameraJobs = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async buildCameraOutput(epoch: number): Promise<MediaStream> {
    const snapshot = await cameraEffectsStore.load();
    this.assertCameraEpoch(epoch);
    if (snapshot.settings.mode !== 'off') this.cameraOffRequiresConsent = true;
    else if (this.cameraOffRequiresConsent) throw new CameraEffectError('privacyBlocked');
    if (needsBackgroundImage(snapshot.settings) && !snapshot.image) throw new CameraEffectError('imageMissing');
    if (!this.cameraRawStream) {
      const raw = await this.captureCamera(epoch);
      if (epoch !== this.cameraCaptureEpoch || !this.hasCameraDemand()) {
        raw.getTracks().forEach((track) => track.stop());
        throw cameraOperationCancelled();
      }
      this.cameraRawStream = raw;
      this.cameraTrackEnded = () => {
        if (this.cameraRawStream === raw) this.failCamera(new CameraEffectError('device'));
      };
      raw.getVideoTracks()[0].addEventListener('ended', this.cameraTrackEnded);
    }
    const raw = this.cameraRawStream;
    let output: MediaStream;
    if (snapshot.settings.mode === 'off') {
      this.cameraProcessor?.stop();
      this.cameraProcessor = null;
      this.cameraStream?.getTracks().forEach((track) => track.stop());
      // A track clone shares the same hardware capture. It lets an Off → effect
      // transition stop the published raw track without feeding black into inference.
      output = new MediaStream(raw.getVideoTracks().map((track) => track.clone()));
    } else if (this.cameraProcessor) {
      this.cameraProcessor.setProfile(this.getProfile());
      output = await this.cameraProcessor.update(snapshot);
    } else {
      const processor = new CameraEffectProcessor(raw, this.getProfile(), (error) => {
        if (this.cameraProcessor === processor) this.failCamera(error);
      });
      this.cameraProcessor = processor;
      output = await processor.start(snapshot);
    }
    this.assertCameraEpoch(epoch);
    this.cameraStream = output;
    this.cameraStatus = 'ready';
    this.cameraError = null;
    this.announceCamera();
    this.notifyCameraState();
    return output;
  }

  private async captureCamera(epoch: number): Promise<MediaStream> {
    const profile = this.getProfile();
    const target = this.cameraDeviceId;
    clientLog.info('VIDEO', 'Starting camera', {
      deviceId: target || 'default',
      resolution: `${profile.cameraWidth}x${profile.cameraHeight}@${profile.cameraFps}fps`,
    });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: target ? { exact: target } : undefined,
          width: { exact: profile.cameraWidth },
          height: { exact: profile.cameraHeight },
          frameRate: { exact: profile.cameraFps },
        },
      });
    } catch (error) {
      this.assertCameraEpoch(epoch);
      if (!(error instanceof DOMException) || error.name !== 'OverconstrainedError') throw error;
      clientLog.info('VIDEO', 'Exact camera constraints not met, falling back to ideal on the same device');
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: target ? { exact: target } : undefined,
          width: { ideal: profile.cameraWidth },
          height: { ideal: profile.cameraHeight },
          frameRate: { ideal: profile.cameraFps, max: profile.cameraFps },
        },
      });
    }
    if (epoch !== this.cameraCaptureEpoch || !this.hasCameraDemand()) {
      stream.getTracks().forEach((track) => track.stop());
      throw cameraOperationCancelled();
    }
    if (!stream.getVideoTracks()[0]) {
      stream.getTracks().forEach((track) => track.stop());
      throw new CameraEffectError('device');
    }
    return stream;
  }

  private assertCameraEpoch(epoch: number): void {
    if (epoch !== this.cameraCaptureEpoch) throw cameraOperationCancelled();
  }

  private announceCamera(): void {
    if (!this.cameraRequested || !this.cameraStream) return;
    const previousStream = this.announcedCameraStream;
    this.announcedCameraStream = this.cameraStream;
    if (!previousStream) appEvents.emit('local.camera_started', this.cameraStream);
    else if (previousStream !== this.cameraStream) {
      appEvents.emit('local.camera_replaced', { stream: this.cameraStream, previousStream });
    }
  }

  private notifyCameraState(): void {
    const state = this.getCameraState();
    for (const listener of this.cameraListeners) {
      try {
        listener(state);
      } catch (error) {
        clientLog.warn('VIDEO', 'Camera state listener failed', { error: String(error) });
      }
    }
    appEvents.emit('camera.state_changed', state);
  }

  private failCamera(error: CameraEffectError): void {
    const publishing = this.cameraRequested;
    clientLog.error('VIDEO', 'Camera stopped without an unprocessed fallback', { code: error.code, error: String(error.cause ?? error) });
    this.stopCamera();
    this.cameraStatus = 'error';
    this.cameraError = error;
    this.notifyCameraState();
    // Preview owners already display state.error inline; only publication needs a global notice.
    if (publishing) appEvents.emit('camera.effects_error', error);
  }

  private releaseCameraCapture(): void {
    this.cameraProcessor?.stop();
    this.cameraProcessor = null;
    this.cameraStream?.getTracks().forEach((track) => track.stop());
    this.cameraStream = null;
    if (this.cameraRawStream) {
      const track = this.cameraRawStream.getVideoTracks()[0];
      if (this.cameraTrackEnded) track?.removeEventListener('ended', this.cameraTrackEnded);
      this.cameraTrackEnded = null;
      this.cameraRawStream.getTracks().forEach((rawTrack) => rawTrack.stop());
      this.cameraRawStream = null;
    }
  }

  public registerNativeScreenShare(stream: MediaStream, capture: NativeScreenCapture): void {
    if (stream.id !== capture.source.shareId || stream.getTracks().length || this.screenStreams.has(stream.id))
      throw new Error('A native screen descriptor cannot replace a browser capture or a current source.');
    this.screenStreams.set(stream.id, stream);
    this.screenSourceIds.set(stream.id, capture.desktopSourceId);
    this.nativeScreenCaptures.set(stream.id, capture);
    appEvents.emit('local.screen_started', { shareId: stream.id, stream });
  }

  public updateNativeScreenCapture(capture: NativeScreenCapture): void {
    if (!this.nativeScreenCaptures.has(capture.source.shareId))
      throw new DOMException('The native screen source was removed.', 'AbortError');
    this.nativeScreenCaptures.set(capture.source.shareId, capture);
  }

  public getNativeScreenCapture(shareId: string): NativeScreenCapture | null {
    return this.nativeScreenCaptures.get(shareId) ?? null;
  }

  public getNativeScreenCaptures(): readonly NativeScreenCapture[] {
    return [...this.nativeScreenCaptures.values()];
  }

  /**
   * Stops one screen share, or every active share when no id is given (#253).
   */
  public stopScreenShare(shareId?: string): void {
    const ids = shareId ? [shareId] : [...this.screenStreams.keys()];
    clientLog.info('SCREEN_SHARE', `Stopping screen share(s)`, { shareIds: ids });
    for (const id of ids) {
      if (!this.screenStreams.has(id)) continue;
      // Native preview tracks are borrowed from preload: their presentation owner
      // stops decoder output and drains the writer before ending the generator.
      this.screenStreams.delete(id);
      this.screenSourceIds.delete(id);
      this.screenLabels.delete(id);
      this.nativeScreenCaptures.delete(id);
      appEvents.emit('local.screen_stopped', id);
    }
  }

  public getCameraStream(): MediaStream | null {
    return this.announcedCameraStream ? this.cameraStream : null;
  }

  public getScreenStream(shareId: string): MediaStream | null {
    return this.screenStreams.get(shareId) ?? null;
  }

  public getScreenShareIds(): string[] {
    return [...this.screenStreams.keys()];
  }

  /** Returns the set of desktop source ids currently being shared. */
  public getActiveSourceIds(): Set<string> {
    return new Set(this.screenSourceIds.values());
  }

  public getScreenSourceId(shareId: string): string | null {
    return this.screenSourceIds.get(shareId) ?? null;
  }

  /** Names a live share so a choice between several shares can show what each one is. */
  public setScreenShareLabel(shareId: string, label: string): void {
    const name = label.trim();
    if (name && this.screenStreams.has(shareId)) this.screenLabels.set(shareId, name);
  }

  public getScreenShareLabel(shareId: string): string | null {
    return this.screenLabels.get(shareId) ?? null;
  }
}

export const videoService = new VideoService();
