export type MediaErrorCode =
  | 'input' | 'unsupported' | 'tools' | 'runtime' | 'unavailable'
  | 'recovery_failed' | 'timeout' | 'busy' | 'cancelled';

/** Consumers can extend the code vocabulary without creating a second error identity. */
export class MediaError<Code extends string = MediaErrorCode> extends Error {
  constructor(readonly code: Code, readonly detail?: string) {
    super(code);
    this.name = 'MediaError';
  }
}

export const SOURCE_RECOVERY_FAILURE_LIMIT = 5;

export class SourceRecoveryError extends MediaError {
  constructor(readonly attempts = SOURCE_RECOVERY_FAILURE_LIMIT) {
    super('recovery_failed', `Audio did not advance after ${attempts} consecutive recovery attempts.`);
    this.name = 'SourceRecoveryError';
  }
}

export function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new MediaError('cancelled');
}
