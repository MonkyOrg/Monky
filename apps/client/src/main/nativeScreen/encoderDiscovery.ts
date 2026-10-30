import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import {
  getScreenShareProfile, type NativeScreenCapabilities, type NativeScreenVideoProfile,
  type ScreenEncodingAvailability, type ScreenEncodingSelection,
} from '@monky/shared';
import type {
  CaptureBridge, NativeScreenCaptureCapability, NativeScreenCaptureTarget, NativeScreenRuntime,
} from '@monky/screen-share';
import { canonicalDirectory, samePath } from '../canonicalDirectory';
import { isRecord } from '../ipc/guards';
import { selectScreenEncoding } from '../screenEncodingPolicy';
import { ScreenEncodingCache, type ScreenEncodingRequest } from '../screenEncodingCache';
import type { NativeScreenDiagnostics } from './diagnosticLog';
import { diagnosticProfile } from './errorDiagnostics';
import { screenShareModule } from './screenShareModule';

/** Capture runs share one canonical folder: the native helper refuses any redirected component of their path. */
export function captureRoot(): Promise<string> {
  return canonicalDirectory(path.join(app.getPath('userData'), 'native-screen-capture'), true);
}

/**
 * Deletes a capture run folder only while it is still the real folder created under `root`, and any
 * ownership marker the helper wrote names exactly the processes in `owner`.
 */
async function removeOwnedCaptureDirectory(root: string, directory: string, owner: Record<string, unknown>,
  label: string): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(directory), directory)
    || path.dirname(directory) !== root)
    throw new Error(`The ${label} directory changed identity before retirement.`);
  if ((await readdir(directory)).length) {
    const marker: unknown = JSON.parse(await readFile(path.join(directory, '.monky-screen-capture-owner'), 'utf8'));
    if (!isRecord(marker) || Object.entries(owner).some(([key, value]) => marker[key] !== value))
      throw new Error(`The ${label} directory has a different process owner.`);
  }
  await rm(directory, { recursive: true });
}

/** Proves, with the source the user selected and before anything is captured, that the chosen encoder works. */
export class SelectedCaptureProbe {
  private readonly runId = randomBytes(16).toString('hex');
  private readonly directory: string;
  private bridge: CaptureBridge | null = null;
  private child: CaptureBridge['child'] = undefined;
  private exited = false;
  private childClosed = false;
  private sharedHost = false;
  private directoryCreated = false;
  private closeWork: Promise<void> | null = null;
  retired = false;

  constructor(private readonly runtime: NativeScreenRuntime, private readonly root: string,
    private readonly onError: (error: Error) => void) {
    this.directory = path.join(root, `monky-screen-capture-${this.runId}`);
  }

  async prepare(target: NativeScreenCaptureTarget, video: NativeScreenVideoProfile,
    signal: AbortSignal, encoding: ScreenEncodingSelection, preserveAspectRatio = true): Promise<NativeScreenCaptureCapability> {
    let capability: NativeScreenCaptureCapability;
    try {
      signal.throwIfAborted();
      await mkdir(this.directory);
      this.directoryCreated = true;
      signal.throwIfAborted();
      this.sharedHost = target.platform === 'darwin';
      const { width, height, fps, maxBitrateKbps } = video;
      this.bridge = screenShareModule().createCaptureBridge({
        host: this.runtime.host, runtime: this.runtime.obs, runId: this.runId, runDirectory: this.directory,
        encoder: encoding.encoder, video: { width, height, fps, bitrateKbps: maxBitrateKbps,
          scaleMode: preserveAspectRatio ? 'fit' : 'stretch' },
        onError: error => {
          console.warn('[NativeScreen] Selected-source probe failed:', error);
          this.onError(error);
        },
        onPacket: () => { throw new Error('A source-selection probe must not capture pixels.'); }, onNotice() {},
      });
      const preparing = this.bridge.prepare(target, signal);
      this.child = this.bridge.child;
      // Windows owns a dedicated process; macOS owns a lease alongside the picker and other captures.
      if (!this.sharedHost) {
        this.child?.once('exit', () => { this.exited = true; });
        this.child?.once('close', () => { this.childClosed = true; });
      }
      await preparing;
      signal.throwIfAborted();
      const proof = this.bridge.getCapabilities();
      if (!proof || !proof.probeVerified || !proof.dynamicBitrate
        || proof.textureInput !== (encoding.mode === 'hardware'
          || target.platform === 'darwin' && encoding.encoder === 'apple_vt_h264_software')
        || proof.hardwareSessionConfirmed || proof.hardwareQualified || proof.codec !== encoding.codec
        || proof.mode !== encoding.mode || proof.encoderId !== encoding.encoder
        || !this.runtime.capture.encoders.includes(proof.encoderId))
        throw new Error('The selected source did not produce the requested verified, capture-free encoder probe.');
      capability = proof;
    } catch (error) {
      try { await this.close(); }
      catch (cleanupError) {
        if (!this.retired || cleanupError !== error)
          throw new AggregateError([error, cleanupError], 'Selected source probing and retirement failed.');
      }
      throw error;
    }
    await this.close();
    return capability;
  }

  close(): Promise<void> {
    if (this.closeWork) return this.closeWork;
    const work = this.retire();
    this.closeWork = work;
    void work.catch(() => { if (!this.retired && this.closeWork === work) this.closeWork = null; });
    return work;
  }

  private async retire(): Promise<void> {
    let failure: unknown;
    if (this.bridge) {
      try { await this.bridge.stop(); }
      catch (error) { failure = error; }
      const snapshot = this.bridge.snapshot();
      if (this.sharedHost) {
        try {
          screenShareModule().assertMacCaptureBridgeClosed(this.bridge);
          if (!snapshot.nativeClosed || snapshot.forcedTermination)
            throw new Error('The original macOS selected-source probe has not proved clean lease retirement.');
        } catch (error) {
          throw failure ? new AggregateError([failure, error], 'Selected-source lease retirement failed.') : error;
        }
      } else if (this.child && (!this.exited || !this.childClosed || !snapshot.nativeClosed || snapshot.forcedTermination)) {
        const error = new Error('The original selected-source probe has not proved native process retirement.');
        throw failure ? new AggregateError([failure, error], error.message) : error;
      }
    }
    if (this.directoryCreated) {
      await removeOwnedCaptureDirectory(this.root, this.directory,
        { runId: this.runId, parentProcessId: process.pid, helperProcessId: this.child?.pid }, 'selected-source probe');
      this.directoryCreated = false;
    }
    this.retired = true;
    if (failure) throw failure;
  }
}

/** What discovery needs from the service: the verified runtime, and when the displays last changed. */
export interface EncoderDiscoveryHost {
  capabilities(): Promise<NativeScreenCapabilities>;
  runtime(): NativeScreenRuntime;
  /** Counts display changes: a discovery made before one is not reused after it. */
  displayGeneration(): number;
}

/**
 * Which encoder a request can use, proven by a capture-free probe of each candidate and remembered for later
 * admissions. Discoveries run one at a time, at most four at once; a probe whose retirement could not be
 * proved blocks every later discovery, since a hardware session may still be open.
 */
export class EncoderDiscovery {
  readonly cache = new ScreenEncodingCache();
  private abortController = new AbortController();
  private readonly jobs = new Set<Promise<ScreenEncodingAvailability>>();
  private queue: Promise<unknown> = Promise.resolve();
  private retirementFailure: unknown;
  private readonly verifications = new Map<string, AbortController>();

  constructor(private readonly host: EncoderDiscoveryHost, private readonly diagnostics: NativeScreenDiagnostics) {}

  /**
   * Which encoder a request can use. An admission reuses what an earlier discovery proved; `refresh`, a
   * verification the user asked for, always probes again and replaces what was remembered.
   */
  encoding(request: ScreenEncodingRequest, signal?: AbortSignal, refresh = false): Promise<ScreenEncodingAvailability> {
    if (this.retirementFailure) return Promise.reject(this.retirementFailure);
    const { video, mode, codec, strategy, inspectHardware } = request;
    const abort = signal ? AbortSignal.any([this.abortController.signal, signal]) : this.abortController.signal;
    const remembered = refresh ? null : this.cache.get(request, this.host.displayGeneration());
    if (remembered) return Promise.resolve().then(() => {
      abort.throwIfAborted();
      this.diagnostics.log('encoder-discovery-reused', { encoder: remembered.selection?.encoder ?? null,
        codec: remembered.selection?.codec ?? null, encodingMode: remembered.selection?.mode ?? null,
        video: diagnosticProfile(video) });
      return remembered;
    });
    if (this.jobs.size >= 4) return Promise.reject(new Error('Screen encoder discovery is busy.'));
    // Nothing that starts after this verification may reuse the answer it is replacing.
    if (refresh) this.cache.forget(request);
    const work = this.queue.then(async () => {
      abort.throwIfAborted();
      // An identical discovery queued ahead of this one already answered it.
      const settled = refresh ? null : this.cache.get(request, this.host.displayGeneration());
      if (settled) return settled;
      const displayGeneration = this.host.displayGeneration();
      const capabilities = await this.host.capabilities();
      abort.throwIfAborted();
      if (!capabilities.requiresSelectionProbe && !capabilities.capture)
        throw new Error(`Native screen encoder runtime is unavailable: ${capabilities.reason}.`);
      const runtime = this.host.runtime();
      const skipped: Error[] = [];
      const availability = await selectScreenEncoding(strategy, mode, codec, runtime.capture.encoders, async selection => {
        abort.throwIfAborted();
        const profile = getScreenShareProfile(video, 'source', selection.codec);
        const runId = randomBytes(16).toString('hex');
        const root = await captureRoot();
        const directory = path.join(root, `monky-screen-capture-${runId}`);
        await mkdir(directory);
        let retirementConfirmed = true;
        let capability: NativeScreenCaptureCapability | undefined;
        try {
          const proof = await screenShareModule().probeCaptureCapabilities({
            host: runtime.host, runtime: runtime.obs, runId, runDirectory: directory, encoder: selection.encoder,
            video: { width: profile.width, height: profile.height, fps: profile.fps, bitrateKbps: profile.maxBitrateKbps },
          }, abort);
          if (!proof.encoderInitialized || proof.sourceCaptured || proof.encoderId !== selection.encoder
            || proof.codec !== selection.codec || proof.mode !== selection.mode || proof.hardwareQualified
            || proof.hardwareSessionConfirmed)
            throw new Error('Encoder discovery returned a different or unverified encoder.');
          capability = proof;
        } catch (error) {
          // An aggregate from the native probe means retirement could not be proved.
          retirementConfirmed = !(error instanceof AggregateError);
          if (!retirementConfirmed) this.retirementFailure = error;
          throw error;
        } finally {
          // probeCaptureCapabilities spawns and retires its own helper, so Main can bind only the run and itself.
          if (retirementConfirmed) {
            await removeOwnedCaptureDirectory(root, directory, { runId, parentProcessId: process.pid }, 'encoder-probe');
          }
        }
        abort.throwIfAborted();
        if (capability) this.diagnostics.log('encoder-candidate-ready', {
          encoder: selection.encoder, codec: selection.codec, encodingMode: selection.mode,
          video: diagnosticProfile(profile), adapterIndex: capability.adapterIndex,
          vendorId: capability.vendorId, deviceId: capability.deviceId,
          encoderInitialized: true, retirementConfirmed: true, sourceCaptured: false,
        });
      }, inspectHardware, (selection, error, outcome) => {
        // Only a candidate set aside for the next one counts toward remembering the choice; every refusal is logged.
        if (outcome === 'next-candidate' && error instanceof Error) skipped.push(error);
        this.diagnostics.logFailure('encoder-candidate', error, undefined, {
          encoder: selection.encoder, codec: selection.codec, encodingMode: selection.mode, refusal: outcome,
          retirementConfirmed: true, continuingHardwareDiscovery: outcome === 'next-candidate',
        }, outcome === 'failed' ? 'WARN' : 'INFO');
      });
      this.cache.set(request, displayGeneration, availability, skipped);
      return availability;
    });
    this.queue = work.catch(() => {});
    this.jobs.add(work);
    void work.then(() => this.jobs.delete(work), () => this.jobs.delete(work));
    return work;
  }

  /**
   * What Settings shows: what the encoders can do now, so it never answers from memory; what it proves
   * replaces what later admissions reuse (a driver installed meanwhile, say).
   */
  async verify(probeId: string, request: ScreenEncodingRequest): Promise<ScreenEncodingAvailability> {
    if (this.verifications.has(probeId) || this.verifications.size >= 4)
      throw new Error('Screen encoder discovery already exists or exceeds its request limit.');
    const abort = new AbortController();
    this.verifications.set(probeId, abort);
    try {
      return await this.encoding(request, abort.signal, true);
    } finally { this.verifications.delete(probeId); }
  }

  cancelVerification(probeId: string, reason: unknown): void {
    this.verifications.get(probeId)?.abort(reason);
  }

  /** Stops the discoveries under way, and refuses new ones until `restart()`. */
  abort(reason: unknown): void {
    this.abortController.abort(reason);
  }

  /** Stops the discoveries under way and waits for their probes; fails if one could not prove its retirement. */
  async retire(reason: unknown): Promise<void> {
    this.abortController.abort(reason);
    await Promise.allSettled([...this.jobs]);
    if (this.retirementFailure) throw this.retirementFailure;
  }

  /** Accepts new discoveries again, for a new renderer document. */
  restart(): void {
    this.abortController = new AbortController();
  }
}
