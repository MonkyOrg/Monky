import type { NativeScreenDecoderObservation } from '@monky/shared';

export interface NativeDecoderDiagnostics {
  observation: NativeScreenDecoderObservation | null;
  fps: number | null;
  upperBoundFps: number | null;
  reason: 'unavailable' | 'transition' | 'first-observation' | 'cached-observation' | 'overlapping-windows' | null;
}

export class NativeDecoderDiagnosticsSampler {
  private readonly previous = new Map<object, NativeScreenDecoderObservation>();

  public sample(target: object, workers: readonly NativeScreenDecoderObservation[]): NativeDecoderDiagnostics {
    const unavailable = (reason: NativeDecoderDiagnostics['reason'],
      observation: NativeScreenDecoderObservation | null = null): NativeDecoderDiagnostics =>
      ({ observation, fps: null, upperBoundFps: null, reason });
    if (workers.length !== 1) {
      this.previous.delete(target);
      return unavailable(workers.length ? 'transition' : 'unavailable');
    }
    const observation = workers[0], previous = this.previous.get(target);
    this.previous.set(target, observation);
    if (!previous || previous.sessionId !== observation.sessionId) return unavailable('first-observation', observation);
    const frames = observation.completedCallbacks - previous.completedCallbacks;
    const elapsedUs = observation.observedAtSteadyUs - previous.observedAtSteadyUs;
    if (frames < 0 || elapsedUs < 0 || (!elapsedUs && frames)) {
      this.previous.delete(target);
      throw new Error('The native decoder worker counter and its observation clock are inconsistent.');
    }
    if (!elapsedUs) return unavailable('cached-observation', observation);
    // Include the locked copy window and microsecond truncation, not the later IPC/JS read time.
    const longestUs = elapsedUs + previous.snapshotCopyMs * 1000 + 1;
    const shortestUs = elapsedUs - observation.snapshotCopyMs * 1000 - 1;
    if (shortestUs <= 0) return unavailable('overlapping-windows', observation);
    return { observation, fps: frames * 1000000 / longestUs, upperBoundFps: frames * 1000000 / shortestUs, reason: null };
  }

  public retainTargets(targets: ReadonlySet<object>): void {
    for (const target of this.previous.keys()) if (!targets.has(target)) this.previous.delete(target);
  }

  public clear(): void { this.previous.clear(); }
}
