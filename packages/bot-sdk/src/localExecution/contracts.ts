import { localTaskCancellationCauseSchema, localTaskEventSchema, localTaskFailureReasonSchema, ProtocolErrorCode } from '@monky/shared';
import type {
  LocalMediaTrack,
  LocalRequestContext,
  LocalSourceContext,
  LocalTaskCancellationCause,
  LocalTaskEvent,
  LocalTaskFailureReason,
  LocalTaskSpec,
  LocalWirePreviewResult,
  LocalWireTaskResult,
} from '@monky/shared';

export interface LocalExecutionTaskOptions {
  readonly signal?: AbortSignal;
}

export interface LocalStreamOptions extends LocalExecutionTaskOptions {
  readonly voiceChannelId: string;
}

export type LocalMetadataTaskSpec = Exclude<LocalTaskSpec, { operation: 'youtube.stream' }>;
export type LocalMetadataTaskResult = Exclude<LocalWireTaskResult, { operation: 'youtube.stream' }>;
export type LocalExecutionTerminalEvent = Extract<LocalTaskEvent, { state: 'failed' | 'cancelled' }>;

/** An admitted task's terminal event, distinct from an ordinary RPC admission error. */
export class LocalExecutionError extends Error {
  readonly event: Readonly<LocalExecutionTerminalEvent>;

  constructor(event: LocalExecutionTerminalEvent) {
    const parsed = localTaskEventSchema.parse(event);
    if (parsed.state !== 'failed' && parsed.state !== 'cancelled') {
      throw new TypeError('LocalExecutionError requires a failed or cancelled task event');
    }
    super(parsed.state === 'cancelled'
      ? `Local execution cancelled: ${parsed.cause}`
      : `Local execution failed: ${parsed.reason}`);
    this.name = 'LocalExecutionError';
    if (parsed.state === 'failed' && parsed.sourceFailure) Object.freeze(parsed.sourceFailure);
    this.event = Object.freeze(parsed);
  }
}

/** A server rejection before task admission, or a rejected source/control RPC. */
export class LocalExecutionRpcError extends Error {
  readonly reason?: LocalTaskFailureReason;
  readonly cancellationCause?: LocalTaskCancellationCause;

  constructor(readonly code: ProtocolErrorCode, message: string) {
    super(message);
    this.name = 'LocalExecutionRpcError';
    const failure = localTaskFailureReasonSchema.safeParse(message);
    const cancellation = localTaskCancellationCauseSchema.safeParse(message);
    this.reason = failure.success ? failure.data : undefined;
    this.cancellationCause = cancellation.success ? cancellation.data : undefined;
  }
}

export interface LocalOpusStream {
  /** Server wire task ID, never the executor's Main-local task UUID. */
  readonly taskId: string;
  readonly track: LocalMediaTrack;
  readonly frames: AsyncIterable<Uint8Array>;
  /** Aborted with LocalExecutionError on failure/cancellation, not normal EOF/drain. */
  readonly signal: AbortSignal;
  /** Rejects immediately on failure/cancellation; resolves after playback drain and server completion. */
  readonly closed: Promise<void>;
  /** Advance once after playback consumes a frame, never when buffering it. */
  markFrameAdvanced(): void;
  /** Await the matching revision; opposite requests supersede/reject older ones. An 8s timeout fails the task. */
  setPaused(paused: boolean): Promise<void>;
  /**
   * Cancel active work and await teardown, or await server completion after playback
   * has drained. Cancellation remains observable through signal/closed.
   * Does not release a retained source.
   */
  close(): Promise<void>;
}

export interface LocalExecutor {
  execute(
    spec: Extract<LocalTaskSpec, { operation: 'youtube.search' }>, options?: LocalExecutionTaskOptions,
  ): Promise<Extract<LocalWireTaskResult, { operation: 'youtube.search' }>>;
  execute(
    spec: Extract<LocalTaskSpec, { operation: 'youtube.resolve' }>, options?: LocalExecutionTaskOptions,
  ): Promise<Extract<LocalWireTaskResult, { operation: 'youtube.resolve' }>>;
  execute(
    spec: Extract<LocalTaskSpec, { operation: 'youtube.preview' }>, options?: LocalExecutionTaskOptions,
  ): Promise<LocalWirePreviewResult>;
  execute(spec: LocalMetadataTaskSpec, options?: LocalExecutionTaskOptions): Promise<LocalMetadataTaskResult>;
  /** Resolve only after the private peer and reliable data channel are ready. */
  stream(
    spec: Extract<LocalTaskSpec, { operation: 'youtube.stream' }>, options: LocalStreamOptions,
  ): Promise<LocalOpusStream>;
}

export interface LocalExecutionClient {
  /** Interaction contexts capture their original lifetime; source tasks acquire a fresh bot connection. */
  executor(context: LocalRequestContext): LocalExecutor;
  /** Retained metadata outlives this invocation/signal, but never authorizes a replacement human socket. */
  retainSource(
    invocationId: string, url: string, options?: LocalExecutionTaskOptions,
  ): Promise<LocalSourceContext>;
  releaseSource(sourceContextId: string): Promise<void>;
  /**
   * Check the original physical executor's current voice/access without starting
   * client work. Rejects with LocalExecutionRpcError when unavailable; a later
   * stream must still pass fresh admission and consent.
   */
  checkSourceAvailability(
    sourceContextId: string, voiceChannelId: string, options?: LocalExecutionTaskOptions,
  ): Promise<void>;
}

/** Implemented by BotClient; also usable as an adapter dependency. */
export interface LocalExecutionProvider {
  localExecution(serverId: string): LocalExecutionClient;
}
