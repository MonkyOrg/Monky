/** The server refused a bot request; `code` is the protocol error code when the server sent one. */
export class BotRequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = 'BotRequestError';
  }
}
