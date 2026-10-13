import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import {
  MessageType, ProtocolErrorCode, botDiagnosticResultSchema, type BotDiagnosticRequest, type BotDiagnosticResult,
} from '@monky/shared';

export type ServerDiagnosticOutcome =
  | { kind: 'result'; result: BotDiagnosticResult }
  /** The server predates protocol 37 and answered the message as malformed. */
  | { kind: 'unsupported' }
  | { kind: 'rate-limited' }
  | { kind: 'error'; code: string };

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'CONNECTION_FAILED';
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Asks a Monky server to check the bot credential and probe its public ports.
 * Uses a separate unauthenticated connection, so a running bot keeps its session.
 */
export function requestServerDiagnostic(
  serverUrl: string, request: BotDiagnosticRequest, timeoutMs = 30_000,
): Promise<ServerDiagnosticOutcome> {
  const requestId = randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    let socket: WebSocket | undefined;
    const finish = (outcome: ServerDiagnosticOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch { socket?.terminate(); }
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ kind: 'error', code: 'TIMEOUT' }), timeoutMs);
    try {
      socket = new WebSocket(serverUrl, { handshakeTimeout: 10_000, maxPayload: 256 * 1024, perMessageDeflate: false });
    } catch (error: unknown) {
      finish({ kind: 'error', code: errorCode(error) });
      return;
    }
    socket.on('open', () => {
      socket?.send(JSON.stringify({ type: MessageType.BOT_DIAGNOSTIC, requestId, payload: request }));
    });
    socket.on('message', (data) => {
      let message: unknown;
      try {
        message = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (!record(message) || message.requestId !== requestId) return;
      if (message.type === MessageType.BOT_DIAGNOSTIC_RESULT) {
        const parsed = botDiagnosticResultSchema.safeParse(message.payload);
        finish(parsed.success ? { kind: 'result', result: parsed.data } : { kind: 'error', code: 'INVALID_RESPONSE' });
        return;
      }
      if (message.type === MessageType.SERVER_ERROR && record(message.payload)) {
        const code = message.payload.code;
        if (code === ProtocolErrorCode.BAD_REQUEST) finish({ kind: 'unsupported' });
        else if (code === ProtocolErrorCode.AUTH_RATE_LIMITED || code === ProtocolErrorCode.RATE_LIMITED) finish({ kind: 'rate-limited' });
        else finish({ kind: 'error', code: typeof code === 'string' && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'SERVER_ERROR' });
      }
    });
    socket.on('error', (error) => finish({ kind: 'error', code: errorCode(error) }));
    socket.on('close', () => finish({ kind: 'error', code: 'CLOSED' }));
  });
}
