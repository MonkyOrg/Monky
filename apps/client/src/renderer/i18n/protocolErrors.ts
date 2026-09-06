import { PROTOCOL_VERSION, ProtocolErrorCode } from '@monky/shared';
import { t, type TranslationKey } from './index';

/**
 * The server always answers with a `ProtocolErrorCode` plus a human message in
 * Portuguese. Since the server can't know the client's language (#16), the
 * client translates the code and only falls back to the server text when the
 * code is unknown — e.g. an older client talking to a newer server.
 */
const ERROR_KEYS: Record<ProtocolErrorCode, TranslationKey> = {
  [ProtocolErrorCode.AUTH_INVALID_PASSWORD]: 'protocolError.authInvalidPassword',
  [ProtocolErrorCode.NICKNAME_ALREADY_EXISTS]: 'protocolError.nicknameAlreadyExists',
  [ProtocolErrorCode.NICKNAME_INVALID]: 'protocolError.nicknameInvalid',
  [ProtocolErrorCode.CHANNEL_NOT_FOUND]: 'protocolError.channelNotFound',
  [ProtocolErrorCode.CHANNEL_FULL]: 'protocolError.channelFull',
  [ProtocolErrorCode.MESSAGE_TOO_LONG]: 'protocolError.messageTooLong',
  [ProtocolErrorCode.RATE_LIMITED]: 'protocolError.rateLimited',
  [ProtocolErrorCode.AUTH_RATE_LIMITED]: 'protocolError.authRateLimited',
  [ProtocolErrorCode.AVATAR_TOO_LARGE]: 'protocolError.avatarTooLarge',
  [ProtocolErrorCode.AVATAR_INVALID_TYPE]: 'protocolError.avatarInvalidType',
  [ProtocolErrorCode.SERVER_FULL]: 'protocolError.serverFull',
  [ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED]: 'protocolError.protocolVersionUnsupported',
  [ProtocolErrorCode.INTERNAL_ERROR]: 'protocolError.internalError',
  [ProtocolErrorCode.UNAUTHORIZED]: 'protocolError.unauthorized',
  [ProtocolErrorCode.PERMISSION_DENIED]: 'protocolError.permissionDenied',
  [ProtocolErrorCode.BAD_REQUEST]: 'protocolError.badRequest',
  [ProtocolErrorCode.ATTACHMENT_TOO_LARGE]: 'protocolError.attachmentTooLarge',
  [ProtocolErrorCode.ATTACHMENT_INVALID_TYPE]: 'protocolError.attachmentInvalidType',
  [ProtocolErrorCode.STORAGE_FULL]: 'protocolError.storageFull',
  [ProtocolErrorCode.TURN_UNAVAILABLE]: 'protocolError.turnUnavailable',
  [ProtocolErrorCode.SFU_UNAVAILABLE]: 'protocolError.sfuUnavailable',
};

/**
 * A server released before #355 had no dedicated code for a version mismatch:
 * the rejection came from the payload schema and arrived as a generic
 * BAD_REQUEST carrying this message. Recognising it is what lets a current
 * client say "the server is the outdated side" instead of "invalid request".
 */
const LEGACY_MISMATCH_MESSAGE = /vers[ãa]o de protocolo/i;
const LEGACY_EXPECTED_VERSION = /esperado:\s*(\d+)/i;

/**
 * The protocol version the server speaks, or `null` when the rejection was not
 * a version mismatch at all. A mismatch with an unknown remote version is
 * reported as `{ serverVersion: null }`.
 */
function detectVersionMismatch(
  code: string | undefined,
  serverMessage: string | undefined,
  serverProtocolVersion: number | undefined
): { serverVersion: number | null } | null {
  if (code === ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED) {
    return { serverVersion: typeof serverProtocolVersion === 'number' ? serverProtocolVersion : null };
  }

  if (code === ProtocolErrorCode.BAD_REQUEST && serverMessage && LEGACY_MISMATCH_MESSAGE.test(serverMessage)) {
    const match = LEGACY_EXPECTED_VERSION.exec(serverMessage);
    return { serverVersion: match ? Number.parseInt(match[1], 10) : null };
  }

  return null;
}

function describeVersionMismatch(serverVersion: number | null): string {
  if (serverVersion === null) return t('protocolError.protocolVersionUnsupported');
  return serverVersion > PROTOCOL_VERSION
    ? t('protocolError.protocolVersionClientOutdated')
    : t('protocolError.protocolVersionServerOutdated');
}

export function translateProtocolError(
  code: string | undefined,
  serverMessage?: string,
  serverProtocolVersion?: number
): string {
  const mismatch = detectVersionMismatch(code, serverMessage, serverProtocolVersion);
  if (mismatch) return describeVersionMismatch(mismatch.serverVersion);

  const key = code ? ERROR_KEYS[code as ProtocolErrorCode] : undefined;
  if (key) return t(key);
  return serverMessage || code || t('protocolError.internalError');
}
