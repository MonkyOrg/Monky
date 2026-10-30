import type { NativeScreenSource } from '@monky/shared';
import { videoService } from '../../core/VideoService';
import { webRtcManager } from '../../core/WebRtcManager';
import { NativeDecoderDiagnosticsSampler } from '../../core/webrtc/nativeDecoderDiagnostics';
import { VideoDiagnosticsSampler } from '../../core/webrtc/videoDiagnostics';
import { t } from '../../i18n';
import { settingsStore } from '../../stores/settingsStore';
import { reportError } from '../../utils/feedback';
import { showCopyToast } from '../CopyToast';
import { showAlert } from '../Dialog';
import { formatVideoTelemetry, serializeVideoTelemetry, type VideoTelemetrySnapshot } from '../VideoTelemetry';
import { remoteScreenStream, sidOf, type ParticipantStageTile } from './stageTiles';

const MAX_TELEMETRY_SAMPLES = 20;
const REFRESH_INTERVAL_MS = 1500;

/**
 * The video numbers over the stage's tiles (#340, #493): sampled while enabled and some
 * video plays, kept per tile with a short history for the report a tile copies.
 */
export class StageTelemetryMonitor {
  private interval: number | null = null;
  private epoch = 0;
  private refreshInFlight = false;
  private snapshots = new Map<string, VideoTelemetrySnapshot>();
  private readonly history = new Map<string, VideoTelemetrySnapshot[]>();
  private readonly historySources = new Map<string, string>();
  private readonly sampler = new VideoDiagnosticsSampler();
  private readonly decoderSampler = new NativeDecoderDiagnosticsSampler();
  private readonly nativeTargets = new Map<string, object>();
  private readonly endpoints = new Map<object, number>();
  private nextEndpoint = 1;
  private copyRequest = 0;
  private clearToast: (() => void) | null = null;

  /** `root` holds the tiles' overlays, copy buttons and videos; `tiles` says which tiles to measure now. */
  constructor(private readonly root: HTMLElement, private readonly tiles: () => ParticipantStageTile[]) {}

  /** Telemetry is keyed by tile, so each share reports its own numbers (#340). */
  text(tileKey: string): string {
    const snapshot = this.snapshots.get(tileKey);
    return snapshot
      ? formatVideoTelemetry(snapshot, settingsStore.screenShareTelemetryMode)
      : t('stage.telemetryCollecting');
  }

  async copy(tileKey: string, button: HTMLButtonElement): Promise<void> {
    const snapshot = this.snapshots.get(tileKey);
    if (!snapshot || !settingsStore.screenShareTelemetryEnabled) {
      void showAlert({ message: t('stage.telemetryCollecting') });
      return;
    }
    const request = ++this.copyRequest;
    this.clearToast?.();
    this.clearToast = null;
    try {
      await navigator.clipboard.writeText(serializeVideoTelemetry(snapshot, navigator.userAgent, this.history.get(tileKey)));
    } catch (error) {
      console.warn('[StageTelemetry] Could not copy video diagnostics', error);
      if (request === this.copyRequest && button.isConnected) reportError(t('stage.telemetryCopyFailed'));
      return;
    }
    if (request === this.copyRequest && button.isConnected) {
      this.clearToast = showCopyToast(t('stage.telemetryCopied'));
    }
  }

  applyOverlays(): void {
    this.root.querySelectorAll<HTMLButtonElement>('.stage-diagnostics-btn').forEach(button => {
      button.hidden = !settingsStore.screenShareTelemetryEnabled;
      const snapshot = this.snapshots.get(button.dataset.diagnosticsKey ?? '');
      button.title = snapshot
        ? `${formatVideoTelemetry(snapshot, 'complete')}\n\n${t('stage.telemetryCopy')}`
        : t('stage.telemetryCopy');
    });
    const overlays = this.root.querySelectorAll('.telemetry-overlay');
    overlays.forEach((overlay) => {
      overlay.classList.remove(
        'position-top-left',
        'position-top-right',
        'position-bottom-left',
        'position-bottom-right'
      );
      overlay.classList.add(`position-${settingsStore.screenShareTelemetryPosition}`);
      overlay.classList.toggle('is-hidden', !settingsStore.screenShareTelemetryEnabled);
      const tileKey = overlay.getAttribute('data-telemetry-key');
      if (tileKey) {
        overlay.textContent = this.text(tileKey);
      }
    });
  }

  /** Samples while telemetry is enabled and some video plays; otherwise stops and clears the overlays. */
  sync(): void {
    if (!settingsStore.screenShareTelemetryEnabled || this.tiles().length === 0) {
      this.stop();
      this.applyOverlays();
      return;
    }

    if (this.interval !== null) {
      this.applyOverlays();
      return;
    }

    const tick = () => {
      void this.refresh();
    };

    tick();
    this.interval = window.setInterval(tick, REFRESH_INTERVAL_MS);
  }

  private async refresh(): Promise<void> {
    if (this.refreshInFlight || !settingsStore.screenShareTelemetryEnabled) {
      return;
    }

    const epoch = this.epoch;
    this.refreshInFlight = true;
    try {
      const videoTiles = this.tiles();
      if (videoTiles.length === 0) {
        this.stop();
        this.applyOverlays();
        return;
      }

      const targets = new Set<object>();
      const samples = await Promise.all(videoTiles.map(async tile => ({
        key: tile.key,
        sourceKey: this.nativeSource(tile)?.instanceId ?? this.track(tile)?.id,
        snapshot: await this.collect(tile, epoch, targets),
      })));
      if (epoch !== this.epoch) return;

      const nextSnapshots = new Map<string, VideoTelemetrySnapshot>();
      for (const sample of samples) {
        if (sample.snapshot && sample.sourceKey) {
          nextSnapshots.set(sample.key, sample.snapshot);
          const history = this.historySources.get(sample.key) === sample.sourceKey
            ? this.history.get(sample.key) ?? [] : [];
          history.push(sample.snapshot);
          if (history.length > MAX_TELEMETRY_SAMPLES) history.shift();
          this.history.set(sample.key, history);
          this.historySources.set(sample.key, sample.sourceKey);
        }
      }
      for (const key of this.history.keys()) {
        if (!nextSnapshots.has(key)) {
          this.history.delete(key);
          this.historySources.delete(key);
        }
      }
      this.snapshots = nextSnapshots;
      this.sampler.retainTargets(targets);
      this.decoderSampler.retainTargets(targets);
      for (const [key, target] of this.nativeTargets) {
        if (!targets.has(target)) this.nativeTargets.delete(key);
      }
      for (const target of this.endpoints.keys()) {
        if (!targets.has(target)) this.endpoints.delete(target);
      }
      this.applyOverlays();
    } finally {
      if (epoch === this.epoch) this.refreshInFlight = false;
    }
  }

  private track(tile: ParticipantStageTile): MediaStreamTrack | null {
    if (tile.kind === 'voice') return null;
    const stream = tile.local
      ? tile.kind === 'camera' ? videoService.getCameraStream()
        : tile.shareId ? videoService.getScreenStream(tile.shareId) : null
      : tile.kind === 'camera' ? tile.p.remoteStream : remoteScreenStream(tile);
    return stream?.getVideoTracks()[0] ?? null;
  }

  private endpoint(target: object): number {
    let endpoint = this.endpoints.get(target);
    if (endpoint === undefined) {
      endpoint = this.nextEndpoint++;
      this.endpoints.set(target, endpoint);
    }
    return endpoint;
  }

  private nativeTarget(key: string, targets: Set<object>): object {
    let target = this.nativeTargets.get(key);
    if (!target) { target = {}; this.nativeTargets.set(key, target); }
    targets.add(target);
    return target;
  }

  private nativeSource(tile: ParticipantStageTile): NativeScreenSource | null {
    if (tile.kind !== 'screen' || !tile.shareId) return null;
    return tile.local
      ? videoService.getNativeScreenCapture(tile.shareId)?.source ?? null
      : webRtcManager.getNativeScreenSource(sidOf(tile.p), tile.shareId);
  }

  private async collect(
    tile: ParticipantStageTile,
    epoch: number,
    targets: Set<object>
  ): Promise<VideoTelemetrySnapshot | null> {
    const track = this.track(tile);
    const nativeSource = this.nativeSource(tile);
    if ((!track || track.readyState !== 'live') && !nativeSource) return null;
    const isLocal = tile.local;
    const profile = videoService.getProfile();
    const settings = isLocal && !nativeSource ? track?.getSettings() : null;
    const isCamera = tile.kind === 'camera';
    const snapshot: VideoTelemetrySnapshot = {
      kind: isLocal ? 'sender' : 'receiver',
      media: isCamera ? 'camera' : 'screen',
      transport: webRtcManager.isSfuMode() ? 'sfu' : 'p2p',
      sampledAt: new Date().toISOString(),
      documentVisibility: document.visibilityState,
      requested: nativeSource ? { width: nativeSource.video.width, height: nativeSource.video.height,
        fps: nativeSource.video.fps, bitrateKbps: nativeSource.video.maxBitrateKbps } : isLocal ? {
        width: isCamera ? profile.cameraWidth : profile.screenWidth,
        height: isCamera ? profile.cameraHeight : profile.screenHeight,
        fps: isCamera ? profile.cameraFps : profile.screenFps,
        bitrateKbps: isCamera ? profile.cameraBitrateKbps : profile.screenBitrateKbps,
      } : null,
      capture: settings && track ? {
        width: settings.width ?? null,
        height: settings.height ?? null,
        configuredFps: settings.frameRate ?? null,
        contentHint: track.contentHint,
        readyState: track.readyState,
      } : null,
      streams: [],
      playback: null,
      readErrors: 0,
    };

    const videos = Array.from(this.root.querySelectorAll<HTMLVideoElement>('[data-video-tile-key]'))
      .filter(video => video.dataset.videoTileKey === tile.key);
    const video = videos.find(element => !element.closest('.stage-mini-card')) ?? videos[0];
    if (track && video?.srcObject instanceof MediaStream
      && video.srcObject.getVideoTracks().some(playingTrack => playingTrack.id === track.id)
      && typeof video.getVideoPlaybackQuality === 'function') {
      targets.add(video);
      const quality = video.getVideoPlaybackQuality();
      snapshot.playback = this.sampler.samplePlayback(video, {
        timestampMs: performance.now(),
        totalFrames: quality.totalVideoFrames,
        droppedFrames: quality.droppedVideoFrames,
        sourceKey: track.id,
        width: video.videoWidth,
        height: video.videoHeight,
        paused: video.paused,
      });
    }

    if (nativeSource && tile.shareId) {
      try {
        const diagnostics = await webRtcManager.getScreenVideoDiagnostics(sidOf(tile.p), tile.shareId);
        if (epoch !== this.epoch || this.nativeSource(tile)?.instanceId !== nativeSource.instanceId) return null;
        if (this.track(tile) !== track) snapshot.playback = null;
        if (!diagnostics) return snapshot;
        if (diagnostics.source.instanceId !== nativeSource.instanceId) return null;
        snapshot.nativeScreen = { receiver: isLocal ? null : diagnostics.backend,
          waitingForViewers: diagnostics.backend === 'native' && diagnostics.viewers === 0, decoders: [] };
        if (diagnostics.backend === 'browser') {
          const { target, reports, profile: selected } = diagnostics;
          snapshot.requested = { width: selected.width, height: selected.height, fps: selected.fps, bitrateKbps: selected.maxBitrateKbps };
          targets.add(target);
          if (reports) snapshot.streams = this.sampler.sampleInbound(target, reports, nativeSource.instanceId)
            .map(data => ({ endpoint: this.endpoint(target), data }));
        } else {
          for (const observation of diagnostics.endpoints) {
            snapshot.readErrors += observation.readErrors;
            const selected = observation.profile;
            if (!isLocal) {
              snapshot.requested = { width: selected.width, height: selected.height, fps: selected.fps, bitrateKbps: selected.maxBitrateKbps };
              const target = this.nativeTarget(`decoder:${observation.pipelineId}`, targets);
              snapshot.nativeScreen.decoders.push({ endpoint: this.endpoint(target),
                data: this.decoderSampler.sample(target, observation.decoders) });
            }
            for (const observationRtp of observation.rtp) {
              const target = this.nativeTarget(`rtp:${observation.pipelineId}:${observationRtp.id}`, targets);
              const reports = new Map(observationRtp.reports.map(report => [report.id, report]));
              const streams = isLocal
                ? this.sampler.sampleOutbound(target, reports, {
                  encodings: [{ maxBitrate: selected.maxBitrateKbps * 1000, maxFramerate: selected.fps }],
                }, nativeSource.instanceId)
                : this.sampler.sampleInbound(target, reports, nativeSource.instanceId);
              snapshot.streams.push(...streams.map(data => ({ endpoint: this.endpoint(target), data })));
            }
          }
        }
      } catch (error) {
        if (epoch === this.epoch) {
          snapshot.readErrors++;
          console.warn('[StageTelemetry] Could not read native screen diagnostics', error);
        }
      }
      if (this.track(tile) !== track) snapshot.playback = null;
      return epoch === this.epoch && this.nativeSource(tile)?.instanceId === nativeSource.instanceId
        ? snapshot : null;
    }

    if (!track) return null;
    if (isLocal) {
      const getSenders = (): RTCRtpSender[] => isCamera ? webRtcManager.getCameraSenders() : [];
      const streams = await Promise.all(getSenders().map(async sender => {
        targets.add(sender);
        const endpoint = this.endpoint(sender);
        const sendingTrack = sender.track;
        try {
          const stats = await sender.getStats();
          if (epoch !== this.epoch || sender.track !== sendingTrack
            || this.track(tile) !== track || !getSenders().includes(sender)) return [];
          return this.sampler.sampleOutbound(sender, stats, sender.getParameters(), track.id)
            .map(data => ({ endpoint, data }));
        } catch (error) {
          if (epoch === this.epoch) {
            snapshot.readErrors++;
            console.warn('[StageTelemetry] Could not read sender diagnostics', error);
          }
          return [];
        }
      }));
      snapshot.streams = streams.flat();
    } else {
      const receiver = webRtcManager.getReceiverForTrack(sidOf(tile.p), track.id);
      if (receiver) {
        targets.add(receiver);
        const endpoint = this.endpoint(receiver);
        try {
          const stats = await receiver.getStats();
          if (epoch !== this.epoch || this.track(tile) !== track
            || webRtcManager.getReceiverForTrack(sidOf(tile.p), track.id) !== receiver) return null;
          snapshot.streams = this.sampler.sampleInbound(receiver, stats, track.id)
            .map(data => ({ endpoint, data }));
        } catch (error) {
          if (epoch === this.epoch) {
            snapshot.readErrors++;
            console.warn('[StageTelemetry] Could not read receiver diagnostics', error);
          }
        }
      }
    }
    return epoch === this.epoch && this.track(tile) === track ? snapshot : null;
  }

  /** Stops sampling but keeps the numbers, for a re-render of the same stage. */
  pause(): void {
    this.epoch++;
    this.refreshInFlight = false;
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.copyRequest++;
    this.clearToast?.();
    this.clearToast = null;
  }

  /** Stops sampling and forgets every reading. */
  stop(): void {
    this.pause();
    this.snapshots.clear();
    this.history.clear();
    this.historySources.clear();
    this.sampler.clear();
    this.decoderSampler.clear();
    this.nativeTargets.clear();
    this.endpoints.clear();
    this.nextEndpoint = 1;
  }
}
