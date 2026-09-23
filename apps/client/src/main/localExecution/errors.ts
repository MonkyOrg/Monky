import type { LocalExecutionFailure, LocalExecutionFailureDetails, LocalRuntimeSourceFailure } from '@monky/shared';

export class LocalExecutionError extends Error {
  readonly sourceFailure?: LocalRuntimeSourceFailure;

  constructor(readonly reason: LocalExecutionFailure, options?: ErrorOptions & { sourceFailure?: LocalRuntimeSourceFailure }) {
    super(`Local execution failed: ${reason}`, options);
    this.name = 'LocalExecutionError';
    this.sourceFailure = options?.sourceFailure;
  }
}

export function localFailure(
  error: unknown, fallback: LocalExecutionFailure, signal?: AbortSignal,
): LocalExecutionFailure {
  if (signal?.aborted) {
    return signal.reason instanceof LocalExecutionError ? signal.reason.reason : 'cancelled';
  }
  return error instanceof LocalExecutionError ? error.reason : fallback;
}

export function localFailureDetails(
  error: unknown, fallback: LocalExecutionFailure, signal?: AbortSignal,
): LocalExecutionFailureDetails {
  const reason = localFailure(error, fallback, signal);
  const failure: unknown = signal?.aborted ? signal.reason : error;
  return failure instanceof LocalExecutionError && failure.sourceFailure
    ? { reason, sourceFailure: failure.sourceFailure }
    : { reason };
}
