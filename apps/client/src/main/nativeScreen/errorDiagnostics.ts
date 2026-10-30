import { createHash } from 'node:crypto';
import { encodeScreenShareFailure, errorChain, nativeErrorCodes, type NativeScreenVideoProfile } from '@monky/shared';
import { isRecord } from '../ipc/guards';

/** Identifiers and numbers read from a known native error format; never its free text. */
export type NativeErrorDiagnostic = Record<string, string | number | boolean | null>;

const nvencOperations = [
  'LoadLibraryExW', 'GetProcAddress', 'NvEncodeAPICreateInstance', 'nvEncOpenEncodeSessionEx',
  'nvEncGetEncodeGUIDCount', 'nvEncGetEncodeGUIDs', 'nvEncGetEncodeProfileGUIDCount',
  'nvEncGetEncodeProfileGUIDs', 'nvEncGetInputFormatCount', 'nvEncGetInputFormats',
  'nvEncGetEncodeCaps', 'nvEncDestroyEncoder', 'FreeLibrary',
] as const;
const nvencCapabilities = [
  'NV_ENC_CAPS_SUPPORT_DYN_BITRATE_CHANGE', 'NV_ENC_CAPS_WIDTH_MAX', 'NV_ENC_CAPS_HEIGHT_MAX',
] as const;

/**
 * What the log may keep of a native error: the allowlisted fields of the formats Monky knows (macOS status,
 * RTC host exit, AMF level, H.264 color, NVENC operations), each range-checked. Anything else yields nothing.
 */
export function nativeErrorDiagnostics(error: Error): NativeErrorDiagnostic[] {
  if (isRecord(error) && typeof error.code === 'string' && /^ERR_MAC_[A-Z0-9_]{1,80}$/.test(error.code)
    && typeof error.nativeStatus === 'number' && Number.isInteger(error.nativeStatus)
    && error.nativeStatus >= -2147483648 && error.nativeStatus <= 2147483647)
    return [{ kind: 'mac-native-status', code: error.code, nativeStatus: error.nativeStatus }];
  if (isRecord(error) && error.code === 'ERR_RTC_HOST_EXIT' && error.hostExited === true) {
    const exitCode = typeof error.exitCode === 'number' && Number.isInteger(error.exitCode)
      && error.exitCode >= -2147483648 && error.exitCode <= 4294967295 ? error.exitCode : null;
    const signal = typeof error.signal === 'string'
      && ['SIGABRT', 'SIGSEGV', 'SIGTERM', 'SIGKILL', 'SIGBUS', 'SIGILL', 'SIGFPE'].includes(error.signal)
      ? error.signal : null;
    return [{ kind: 'rtc-host-exit', hostExited: true, exitCode,
      exitCodeHex: exitCode === null ? null : `0x${(exitCode >>> 0).toString(16).padStart(8, '0')}`, signal }];
  }
  const message = error.message.slice(0, 8192);
  const amf = /^AMF H264 requires level_idc=(\d{2}) for (\d{1,4})x(\d{1,4})@(\d{1,3}); selected adapter\/runtime reports MaxLevel=(\d{2})(?=$|[.;\s])/.exec(message);
  if (amf) {
    const [requiredLevel, width, height, fps, maximumLevel] = amf.slice(1).map(Number);
    if (requiredLevel < 10 || requiredLevel > 62 || maximumLevel < 10 || maximumLevel > 62
      || width < 2 || width > 3840 || height < 2 || height > 2160 || fps < 1
      || fps > (width === 3840 || height === 2160 ? 120 : 240)) return [];
    return [{ kind: 'amf-h264-level', requiredLevel, maximumLevel, width, height, fps }];
  }
  const color = /^External H264 must retain the admitted BT\.709 limited-range mode: fullRange=(absent|[01]), primaries=(absent|\d{1,3}), transfer=(absent|\d{1,3}), matrix=(absent|\d{1,3})(?=$|[;\s])/.exec(message);
  if (color) {
    const fields = color.slice(1).map(value => value === 'absent' ? null : Number(value));
    if (fields.some(value => value !== null && value > 255)) return [];
    return [{ kind: 'h264-color', fullRange: fields[0] === null ? null : fields[0] === 1,
      primaries: fields[1], transfer: fields[2], matrix: fields[3] }];
  }
  if (!message.startsWith('NVENC ')) return [];
  const diagnostics: NativeErrorDiagnostic[] = [];
  for (const raw of message.split(';').slice(0, 32)) {
    const segment = raw.trim().replace(/^NVENC /, '');
    const api = /^api=(\d{1,2})\.(\d{1,2})$/.exec(segment);
    if (api) { diagnostics.push({ kind: 'nvenc-api', major: Number(api[1]), minor: Number(api[2]) }); continue; }
    const capability = nvencCapabilities.find(name => segment.startsWith(`${name}=`));
    if (capability) {
      const match = /^-?\d{1,10}$/.exec(segment.slice(capability.length + 1));
      if (match && Number(match[0]) >= -2147483648 && Number(match[0]) <= 4294967295)
        diagnostics.push({ kind: 'nvenc-capability', capability, value: Number(match[0]) });
      continue;
    }
    const operation = nvencOperations.find(name => segment === name
      || segment.startsWith(`${name} `) || segment.startsWith(`${name}(`));
    if (!operation) continue;
    const diagnostic: NativeErrorDiagnostic = { kind: 'nvenc-operation', operation };
    for (const field of ['status', 'count', 'bound', 'capacity', 'returned', 'value', 'required',
      'capsVersion', 'functionListVersion', 'openVersion', 'win32']) {
      const match = new RegExp(`(?:^|[\\s,(])${field}=(-?\\d{1,10})(?=$|[\\s,;()])`).exec(segment);
      if (match && Number(match[1]) >= -2147483648 && Number(match[1]) <= 4294967295)
        diagnostic[field] = Number(match[1]);
    }
    for (const field of ['H264', 'Main', 'NV12', 'session']) {
      const match = new RegExp(`(?:^|[\\s,(])${field}=([01])(?=$|[\\s,;)])`).exec(segment);
      if (match) diagnostic[field] = match[1] === '1';
    }
    if (operation === 'nvEncGetEncodeCaps') {
      const capability = nvencCapabilities.find(name => segment.startsWith(`${operation} ${name}(`));
      if (capability) {
        diagnostic.capability = capability;
        const id = /^\((\d{1,3})\)/.exec(segment.slice(operation.length + capability.length + 1));
        if (id) diagnostic.capabilityId = Number(id[1]);
      }
    }
    if (operation === 'NvEncodeAPICreateInstance') {
      const missing = nvencOperations.find(name => segment === `${operation} missing ${name}`);
      if (missing) diagnostic.missingOperation = missing;
    }
    if (operation === 'nvEncDestroyEncoder' && /(?:^|\s)retirement=unconfirmed(?:$|\s)/.test(segment))
      diagnostic.retirementConfirmed = false;
    diagnostics.push(diagnostic);
  }
  return diagnostics;
}

/**
 * What the renderer is told about a failure: the messages of the error, its causes and its aggregated errors,
 * and the code of a game capture the system refused, which the renderer explains to the user.
 */
export function errorDetails(error: unknown): { message: string; code?: 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE' } {
  const messages = new Set<string>();
  let code: 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE' | undefined;
  for (const current of errorChain(error)) {
    if (isRecord(current) && current.code === 'ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE') code = current.code;
    messages.add(current instanceof Error ? current.message : String(current));
  }
  return { message: [...messages].join(' / ').slice(0, 4096) || 'Native screen operation failed.',
    ...(code ? { code } : {}) };
}

/** A failure whose message Main already wrote for the person, in the app's language. */
export class NativeScreenNotice extends Error {
  override readonly name = 'NativeScreenNotice';
  constructor(message: string, readonly code?: string) { super(message); }
}

/**
 * The error a renderer `invoke` should reject with. Electron carries only the message across, so the native
 * codes and a notice for the person go after a marker the renderer reads; the error stays the cause.
 * A failure with neither is returned as is.
 */
export function rendererFailure(error: unknown): unknown {
  const chain = errorChain(error);
  const codes = nativeErrorCodes(error);
  const notice = chain.find((current): current is NativeScreenNotice => current instanceof NativeScreenNotice)?.message;
  if (!codes.length && !notice) return error instanceof AggregateError ? new Error(errorDetails(error).message, { cause: error }) : error;
  const message = error instanceof AggregateError ? errorDetails(error).message
    : error instanceof Error ? error.message : String(error);
  return new Error(encodeScreenShareFailure(message, { codes, ...(notice ? { notice: notice.slice(0, 1024) } : {}) }),
    { cause: error });
}

/** A call, source or viewer as the log names it: a short hash, never the id itself. */
export const diagnosticId = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);
export const diagnosticProfile = ({ width, height, fps, maxBitrateKbps }: NativeScreenVideoProfile): NativeScreenVideoProfile =>
  ({ width, height, fps, maxBitrateKbps });
export const diagnosticState = (value: unknown): string => typeof value === 'string'
  && ['waiting', 'starting', 'running', 'stopping', 'closed', 'new', 'connecting', 'connected',
    'disconnected', 'failed', 'completed', 'opening', 'open', 'closing'].includes(value) ? value : 'other';
