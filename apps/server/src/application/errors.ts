import type { ProtocolErrorCode } from '@monky/shared';

/**
 * A refusal a service words for the client: its code and message go out as
 * they are. Each area keeps its own subclass, with the constructor it always
 * had, and the WebSocket layer answers all of them through toProtocolError.
 * Anything thrown that is not one of these is a failure, which the client only
 * hears about in general terms (S-APP-8).
 */
export class ServiceError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string) {
    super(message);
  }
}
