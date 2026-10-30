import { ProtocolErrorCode, type LogCategory, type ServerErrorPayload } from '@monky/shared';
import { ServiceError } from '../../application/errors';
import { Logger } from '../logger/Logger';

/** How a handler answers an error it did not foresee. */
export interface UnexpectedFailure {
  /** Logged next to the error, and all the client is told. */
  message: string;
  category: LogCategory;
  /** The code such failures have always gone out with; INTERNAL_ERROR by default. */
  code?: ProtocolErrorCode;
}

/**
 * The SERVER_ERROR for an error a handler caught. A ServiceError is a refusal
 * its service worded for the client, so it goes out as it is. Anything else is
 * a failure: it is logged, and the client only hears `failure.message`, since
 * the words of a disk or database error name paths on the server (S-APP-8).
 */
export function toProtocolError(error: unknown, failure: UnexpectedFailure): Pick<ServerErrorPayload, 'code' | 'message'> {
  if (error instanceof ServiceError) return { code: error.code, message: error.message };
  Logger.error(failure.category, failure.message, error);
  return { code: failure.code ?? ProtocolErrorCode.INTERNAL_ERROR, message: failure.message };
}
