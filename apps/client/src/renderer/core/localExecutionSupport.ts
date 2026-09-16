import {
  commandLocalMetadataSchema, localRuntimeSourceFailureSchema,
  type LocalCapabilityId, type LocalExecutionFailure, type LocalExecutionMutationResult,
  type LocalRuntimeSourceFailure, type SlashCommand,
} from '@monky/shared';
import { t } from '../i18n';

export type LocalExecutionApi = Pick<Window['api'],
  'setLocalExecutionConnection' | 'prepareLocalExecution' | 'startLocalExecutionTask' |
  'readLocalExecutionFrames' | 'acknowledgeLocalExecutionFrames' | 'setLocalExecutionPaused' |
  'cancelLocalExecutionRequest' | 'cancelLocalExecutionTask' | 'onLocalExecutionTaskFailed' |
  'onLocalExecutionChanged'>;

export class LocalExecutionError extends Error {
  public readonly reason: LocalExecutionFailure;
  public readonly sourceFailure?: LocalRuntimeSourceFailure;

  constructor(reason: LocalExecutionFailure, sourceFailure?: LocalRuntimeSourceFailure) {
    const cancellation = reason === 'cancelled' || reason === 'permission_revoked';
    const parsed = sourceFailure === undefined || cancellation ? undefined : localRuntimeSourceFailureSchema.safeParse(sourceFailure);
    const validatedReason = parsed && !parsed.success ? 'invalid_request' : reason;
    super(t(`localExecution.failure.${validatedReason}`));
    this.name = 'LocalExecutionError';
    this.reason = validatedReason;
    if (parsed?.success) this.sourceFailure = Object.freeze(parsed.data);
  }
}

export function localFailure(error: unknown): LocalExecutionFailure {
  if (error instanceof LocalExecutionError) return error.reason;
  if (error instanceof DOMException && error.name === 'AbortError') return 'cancelled';
  return 'transport_failed';
}

export function toLocalExecutionError(error: unknown): LocalExecutionError {
  return error instanceof LocalExecutionError ? error : new LocalExecutionError(localFailure(error));
}

export function getLocalExecutionApi(): LocalExecutionApi | null {
  const api = typeof window === 'undefined' ? undefined : window.api;
  if (!api) return null;
  const methods: ReadonlyArray<keyof LocalExecutionApi> = [
    'setLocalExecutionConnection', 'prepareLocalExecution', 'startLocalExecutionTask',
    'readLocalExecutionFrames', 'acknowledgeLocalExecutionFrames', 'setLocalExecutionPaused',
    'cancelLocalExecutionRequest', 'cancelLocalExecutionTask', 'onLocalExecutionTaskFailed',
    'onLocalExecutionChanged',
  ];
  return methods.every((method) => typeof api[method] === 'function') ? api : null;
}

export function requireLocalMutation(result: LocalExecutionMutationResult): void {
  if (result.status === 'failed') throw new LocalExecutionError(result.reason, result.sourceFailure);
  if (result.status === 'cancelled') throw new LocalExecutionError('cancelled');
}

export function commandLocalCapabilities(command: SlashCommand): LocalCapabilityId[] {
  const parsed = commandLocalMetadataSchema.safeParse({
    localCapabilities: command.localCapabilities, botPublicKey: command.botPublicKey,
  });
  if (!parsed.success) throw new LocalExecutionError('invalid_request');
  return parsed.data.localCapabilities ?? [];
}

export function commandLocalIdentity(command: SlashCommand): { botId: string; botName: string; botPublicKey: string } {
  const parsed = commandLocalMetadataSchema.safeParse({
    localCapabilities: command.localCapabilities, botPublicKey: command.botPublicKey,
  });
  if (!parsed.success || !parsed.data.botPublicKey) {
    throw new LocalExecutionError('invalid_request');
  }
  return { botId: command.botId, botName: command.botName, botPublicKey: parsed.data.botPublicKey };
}

/** Cancels one observer without cancelling another composer's shared preparation. */
export function observeWithSignal<T>(result: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(new DOMException('Local execution cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    result.then((value) => {
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) resolve(value);
    }, (error: unknown) => {
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) reject(error);
    });
    if (signal.aborted) abort();
  });
}
