import { errorChain, nativeErrorCodes, nativeScreenCommandSchema, type NativeScreenCall, type NativeScreenVideoProfile } from '@monky/shared';
import type { NativeScreenEndpointState } from '@monky/screen-share';
import type { ClientLogger } from '../clientLogger';
import { isRecord } from '../ipc/guards';
import {
  diagnosticId, diagnosticProfile, diagnosticState, nativeErrorDiagnostics, type NativeErrorDiagnostic,
} from './errorDiagnostics';

export type DiagnosticData = Record<string, string | number | boolean | null | undefined | NativeScreenVideoProfile
  | readonly string[] | readonly NativeErrorDiagnostic[]>;
export type DiagnosticLevel = 'INFO' | 'WARN' | 'ERROR';

/** The call, source and pipeline a diagnostic is about, as hashes. */
export function callContext(call: { readonly config: Pick<NativeScreenCall, 'callId' | 'mode'> }, shareId?: string,
  pipelineId?: string): DiagnosticData {
  return { call: diagnosticId(call.config.callId), mode: call.config.mode,
    ...(shareId ? { source: diagnosticId(shareId) } : {}),
    ...(pipelineId ? { pipeline: diagnosticId(pipelineId) } : {}) };
}

/**
 * The persistent screen-sharing log of Main. A failure is written once per error and at most every five
 * seconds per kind, with only allowlisted fields: error messages can carry SDP, TURN passwords, paths or
 * window titles. A broken log sink never changes who owns the media.
 */
export class NativeScreenDiagnostics {
  private readonly loggedErrors = new WeakSet<object>();
  private readonly recentFailures = new Map<string, number>();
  private sinkFailureReported = false;

  constructor(private readonly logger?: Pick<ClientLogger, 'write'>) {}

  log(operation: string, data: DiagnosticData = {}, level: DiagnosticLevel = 'INFO'): void {
    try {
      this.logger?.write({ timestamp: new Date().toISOString(), level, category: 'SCREEN_SHARE',
        message: `Native screen ${operation}`, data });
      this.sinkFailureReported = false;
    } catch {
      if (!this.sinkFailureReported) {
        this.sinkFailureReported = true;
        console.error('[NativeScreen] Persistent diagnostic sink failed; media ownership is unchanged.');
      }
    }
  }

  logFailure(operation: string, error: unknown, input?: unknown, context: DiagnosticData = {},
    level: DiagnosticLevel = 'ERROR'): void {
    const command = nativeScreenCommandSchema.safeParse(input);
    if (error instanceof Error && error.name === 'AbortError') {
      if (command.success) this.log('command-cancelled', { ...context, action: command.data.action }, 'WARN');
      return;
    }
    if (isRecord(error) && this.loggedErrors.has(error)) return;
    const diagnostics = new Map<string, NativeErrorDiagnostic>();
    for (const current of errorChain(error)) {
      if (!(current instanceof Error)) continue;
      for (const diagnostic of nativeErrorDiagnostics(current)) {
        if (diagnostics.size >= 64) break;
        diagnostics.set(JSON.stringify(diagnostic), diagnostic);
      }
    }
    // Error messages/stacks can contain SDP, TURN passwords, paths or source titles.
    // Only known native formats contribute allowlisted identifiers/numbers.
    // Keep the existing renderer error contract intact.
    const data: DiagnosticData = { ...context, nativeCodes: nativeErrorCodes(error),
      ...(diagnostics.size ? { nativeDiagnostics: [...diagnostics.values()] } : {}),
      error: error instanceof Error && error.name === 'ZodError' ? 'schema-validation'
        : error instanceof AggregateError ? 'aggregate' : 'operation-failed',
      ...(command.success ? { action: command.data.action,
        ...('callId' in command.data ? { call: diagnosticId(command.data.callId) } : {}),
        ...('shareId' in command.data ? { source: diagnosticId(command.data.shareId) } : {}) } : {}),
      ...(command.success && command.data.action === 'source-add' ? {
        captureKind: command.data.captureKind ?? 'window', audio: command.data.audio,
        video: diagnosticProfile(command.data.video),
      } : {}) };
    const signature = JSON.stringify([operation, data]);
    const now = Date.now(), previous = this.recentFailures.get(signature);
    if (isRecord(error)) this.loggedErrors.add(error);
    if (previous !== undefined && now - previous < 5000) return;
    const oldest = this.recentFailures.keys().next().value;
    if (this.recentFailures.size >= 128 && oldest !== undefined) this.recentFailures.delete(oldest);
    this.recentFailures.set(signature, now);
    // Discovery outcomes (an encoder this GPU lacks) are expected; unproven retirement is not.
    const discovery = command.success && command.data.action === 'probe-encoding' && !(error instanceof AggregateError);
    this.log(`${operation} failed`, data, discovery && level === 'ERROR' ? 'WARN' : level);
  }

  /** Logs each change of a pipeline's capture, transport and peer states, but not every frame. */
  endpointObserver(call: { readonly config: Pick<NativeScreenCall, 'callId' | 'mode'> }, shareId: string, pipelineId: string,
    role: 'publish' | 'receive', quality: string): (state: NativeScreenEndpointState) => void {
    const previous = new Map<string, string>();
    return state => {
      if (state.type === 'frame') return;
      const data: DiagnosticData = { ...callContext(call, shareId, pipelineId), role, quality, type: state.type };
      if (state.type === 'capture-mode') {
        data.captureMode = state.capture.mode;
        data.ready = state.capture.ready;
      } else if (state.type === 'capture' || state.type === 'transport') {
        data.state = diagnosticState(state.state);
      } else if (state.type === 'peer') {
        if (!isRecord(state.state)) return;
        data.state = diagnosticState(state.state.status);
        if (typeof state.state.remoteSessionId === 'string') data.viewer = diagnosticId(state.state.remoteSessionId);
        if (isRecord(state.state.nativeState)) data.connection = diagnosticState(state.state.nativeState.connectionState);
      }
      const signature = JSON.stringify(data);
      const key = `${state.type}:${data.viewer ?? ''}`;
      if (previous.get(key) === signature) return;
      const oldest = previous.keys().next().value;
      if (previous.size >= 128 && oldest !== undefined) previous.delete(oldest);
      previous.set(key, signature);
      this.log('pipeline-state', data);
    };
  }

  /** Forgets the recent failures; called when the service that owned this log is disposed. */
  clear(): void {
    this.recentFailures.clear();
  }
}
