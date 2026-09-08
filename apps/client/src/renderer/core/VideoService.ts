import { QUALITY_PRESETS, QualityProfile, QualityPresetType } from '@monky/shared';
import { appEvents } from './EventBus';
import { settingsStore } from '../stores/settingsStore';
import { clientLog } from './ClientLogService';

export class VideoService {
  private cameraStream: MediaStream | null = null;
  /**
   * Active screen shares keyed by share id (#253). The share id is the
   * MediaStream id, which is also what gets announced to peers over
   * `screen-video-meta`, so the same handle identifies the share locally,
   * on the wire and in the remote UI.
   */
  private screenStreams: Map<string, MediaStream> = new Map();
  /** Maps stream id → desktop source id so the picker can hide active shares. */
  private screenSourceIds: Map<string, string> = new Map();
  private currentPreset: QualityPresetType = settingsStore.qualityPreset;

  public setQualityPreset(preset: QualityPresetType): void {
    this.currentPreset = preset;
  }

  /**
   * Applies the quality preset dynamically to current preset and updates
   * constraints on any active camera or screen share tracks.
   */
  public async applyQualityPreset(preset: QualityPresetType): Promise<void> {
    this.currentPreset = preset;
    const profile = this.getProfile();
    const isHighFps = profile.screenFps >= 60 || preset === 'GAMING' || preset === 'ULTRA';

    if (this.cameraStream) {
      const cameraTrack = this.cameraStream.getVideoTracks()[0];
      if (cameraTrack && cameraTrack.readyState === 'live') {
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

    for (const [shareId, stream] of this.screenStreams.entries()) {
      const screenTrack = stream.getVideoTracks()[0];
      if (screenTrack && screenTrack.readyState === 'live') {
        screenTrack.contentHint = isHighFps ? 'motion' : 'detail';
        try {
          await screenTrack.applyConstraints({
            width: { max: profile.screenWidth },
            height: { max: profile.screenHeight },
            frameRate: { max: profile.screenFps },
          });
        } catch (err) {
          clientLog.warn('SCREEN_SHARE', 'Failed to apply constraints to screen track', { shareId, error: String(err) });
        }
      }
    }
  }

  public getProfile(): QualityProfile {
    if (this.currentPreset === 'CUSTOM') return settingsStore.customProfile;
    return QUALITY_PRESETS[this.currentPreset] || QUALITY_PRESETS.NORMAL;
  }

  public async startCamera(deviceId?: string): Promise<MediaStream> {
    this.stopCamera();

    const profile = this.getProfile();
    const targetDeviceId = deviceId || settingsStore.selectedCameraId || undefined;
    clientLog.info('VIDEO', 'Starting camera', {
      deviceId: targetDeviceId || 'default',
      resolution: `${profile.cameraWidth}x${profile.cameraHeight}@${profile.cameraFps}fps`,
    });

    // Try exact constraints first so the preset delivers what it promises.
    // If the hardware can't match, fall back to ideal (best-effort).
    const exactVideo: MediaTrackConstraints = {
      deviceId: targetDeviceId ? { exact: targetDeviceId } : undefined,
      width: { exact: profile.cameraWidth },
      height: { exact: profile.cameraHeight },
      frameRate: { exact: profile.cameraFps },
    };
    const idealVideo: MediaTrackConstraints = {
      deviceId: targetDeviceId ? { exact: targetDeviceId } : undefined,
      width: { ideal: profile.cameraWidth },
      height: { ideal: profile.cameraHeight },
      frameRate: { ideal: profile.cameraFps, max: profile.cameraFps },
    };
    const idealVideoNoDevice: MediaTrackConstraints = {
      width: { ideal: profile.cameraWidth },
      height: { ideal: profile.cameraHeight },
      frameRate: { ideal: profile.cameraFps, max: profile.cameraFps },
    };

    // Attempt chain: exact → ideal (same device) → ideal (any device)
    try {
      this.cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: exactVideo });
    } catch {
      clientLog.info('VIDEO', 'Exact camera constraints not met, falling back to ideal');
      try {
        this.cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: idealVideo });
      } catch (err: any) {
        if (targetDeviceId) {
          clientLog.warn('VIDEO', 'Could not open specific camera, falling back to default', { error: err.message });
          this.cameraStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: idealVideoNoDevice });
        } else {
          throw err;
        }
      }
    }
    appEvents.emit('local.camera_started', this.cameraStream);
    return this.cameraStream;
  }

  public stopCamera(): void {
    if (this.cameraStream) {
      clientLog.info('VIDEO', 'Stopping camera');
      this.cameraStream.getTracks().forEach((t) => t.stop());
      this.cameraStream = null;
      appEvents.emit('local.camera_stopped');
    }
  }

  public async startScreenShare(sourceId?: string): Promise<MediaStream> {
    const profile = this.getProfile();
    clientLog.info('SCREEN_SHARE', 'Starting screen share', {
      hasSourceId: !!sourceId,
      resolution: `${profile.screenWidth}x${profile.screenHeight}@${profile.screenFps}fps`,
    });
    let stream: MediaStream;

    if (sourceId) {
      // A minimized window has no surface for the WGC capturer to start on, so a
      // fullscreen game that got minimized when the user alt-tabbed to open the
      // picker must be restored (foregrounded) before getUserMedia (#560).
      if (sourceId.startsWith('window:')) {
        try {
          const restored = await window.api?.prepareScreenShareWindow?.(sourceId);
          if (restored) await new Promise((resolve) => setTimeout(resolve, 350));
        } catch (e) {
          clientLog.warn('SCREEN_SHARE', 'Failed to restore window before capture', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Electron desktopCapturer — try exact (min=max) first, fallback to max-only
      const exactConstraints: any = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            minWidth: profile.screenWidth,
            maxWidth: profile.screenWidth,
            minHeight: profile.screenHeight,
            maxHeight: profile.screenHeight,
            minFrameRate: profile.screenFps,
            maxFrameRate: profile.screenFps,
          },
        },
      };
      try {
        stream = await (navigator.mediaDevices as any).getUserMedia(exactConstraints);
      } catch {
        clientLog.info('SCREEN_SHARE', 'Exact screen constraints not met, falling back to max-only');
        const fallbackConstraints: any = {
          audio: false,
          video: {
            mandatory: {
              chromeMediaSource: 'desktop',
              chromeMediaSourceId: sourceId,
              maxWidth: profile.screenWidth,
              maxHeight: profile.screenHeight,
              maxFrameRate: profile.screenFps,
            },
          },
        };
        stream = await (navigator.mediaDevices as any).getUserMedia(fallbackConstraints);
      }
    } else {
      // Standard DisplayMedia fallback
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { exact: profile.screenWidth },
            height: { exact: profile.screenHeight },
            frameRate: { exact: profile.screenFps },
          },
          audio: false,
        });
      } catch {
        clientLog.info('SCREEN_SHARE', 'Exact display constraints not met, falling back to ideal');
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: profile.screenWidth },
            height: { ideal: profile.screenHeight },
            frameRate: { ideal: profile.screenFps, max: profile.screenFps },
          },
          audio: false,
        });
      }
    }

    const shareId = stream.id;
    this.screenStreams.set(shareId, stream);
    if (sourceId) {
      this.screenSourceIds.set(shareId, sourceId);
    }

    // Auto-detect when user stops sharing via browser UI
    const screenTrack = stream.getVideoTracks()[0];

    // Hint the encoder about the content type so it optimizes correctly:
    // gaming / 60+ fps favors fluid motion, desktop sharing favors sharp detail.
    screenTrack.contentHint = (profile.screenFps >= 60 || this.currentPreset === 'GAMING' || this.currentPreset === 'ULTRA') ? 'motion' : 'detail';

    screenTrack.onended = () => {
      // Fires only when the track ends on its own — e.g. the shared window/app
      // was closed or the user pressed the OS "stop sharing" button — never
      // when we call stopScreenShare() ourselves. Let listeners fully tear the
      // share down (peers, WebRTC sender, UI) before we stop locally (#159).
      appEvents.emit('local.screen_ended_externally', shareId);
      this.stopScreenShare(shareId);
    };

    appEvents.emit('local.screen_started', { shareId, stream });
    return stream;
  }

  /**
   * Stops one screen share, or every active share when no id is given (#253).
   */
  public stopScreenShare(shareId?: string): void {
    const ids = shareId ? [shareId] : [...this.screenStreams.keys()];
    clientLog.info('SCREEN_SHARE', `Stopping screen share(s)`, { shareIds: ids });
    for (const id of ids) {
      const stream = this.screenStreams.get(id);
      if (!stream) continue;
      // Drop the handler first: stopping the track fires `onended` on some
      // platforms, which would re-enter this method and emit a bogus
      // "ended externally" event (#159).
      stream.getVideoTracks().forEach((t) => { t.onended = null; });
      stream.getTracks().forEach((t) => t.stop());
      this.screenStreams.delete(id);
      this.screenSourceIds.delete(id);
      appEvents.emit('local.screen_stopped', id);
    }
  }

  public getCameraStream(): MediaStream | null {
    return this.cameraStream;
  }

  public getScreenStream(shareId: string): MediaStream | null {
    return this.screenStreams.get(shareId) ?? null;
  }

  public getScreenShareIds(): string[] {
    return [...this.screenStreams.keys()];
  }

  public getScreenShareCount(): number {
    return this.screenStreams.size;
  }

  /** Returns the set of desktop source ids currently being shared. */
  public getActiveSourceIds(): Set<string> {
    return new Set(this.screenSourceIds.values());
  }
}

export const videoService = new VideoService();
