import { z } from 'zod';

/**
 * Screen-sharing failures as the person reads them (#490). Main knows the native codes; the renderer
 * only receives the message of a rejected `ipcRenderer.invoke`, so Main writes what the renderer needs
 * after a stable marker and the renderer reads it back here. The technical detail stays in Main's log.
 */

/** The error, its causes and the errors it aggregates, breadth first and bounded. */
export function errorChain(error: unknown): unknown[] {
  const pending: unknown[] = [error], seen = new Set<unknown>();
  while (pending.length && seen.size < 12) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    if (current instanceof AggregateError) {
      const nested: readonly unknown[] = current.errors;
      pending.push(...nested.slice(0, 8));
    }
    if (current instanceof Error && current.cause !== undefined) pending.push(current.cause);
  }
  return [...seen];
}

const nativeCode = /^ERR_[A-Z0-9_]{1,120}$/;
// One per error of a bounded chain.
const MAX_CODES = 12;

/** The native codes (`ERR_*`) found along an error chain, in order and without repetition. */
export function nativeErrorCodes(error: unknown): string[] {
  const codes = new Set<string>();
  for (const current of errorChain(error)) {
    const code: unknown = typeof current === 'object' && current !== null ? Reflect.get(current, 'code') : undefined;
    if (typeof code === 'string' && nativeCode.test(code)) codes.add(code);
  }
  return [...codes];
}

/** Most specific first: when several codes come together, the first category here explains the failure. */
export const SCREEN_SHARE_FAILURE_CATEGORIES = [
  'game', 'permission', 'source-lost', 'files', 'encoder', 'quality', 'capacity', 'interrupted', 'unexpected',
] as const;
export type ScreenShareFailureCategory = typeof SCREEN_SHARE_FAILURE_CATEGORIES[number];

const byCategory: Readonly<Record<ScreenShareFailureCategory, readonly string[]>> = {
  game: ['ERR_SCREEN_CAPTURE_GAME_UNAVAILABLE'],
  permission: ['ERR_MAC_SCREEN_PERMISSION'],
  'source-lost': [
    'ERR_SCREEN_CAPTURE_SOURCE_LOST', 'ERR_SCREEN_CAPTURE_SOURCE_IDENTITY', 'ERR_SCREEN_CAPTURE_SOURCE_INITIALIZATION',
    'ERR_SCREEN_CAPTURE_MONITOR_LOST', 'ERR_SCREEN_CAPTURE_MONITOR_CHANGED', 'ERR_SCREEN_CAPTURE_MONITOR_IDENTITY',
    'ERR_SCREEN_CAPTURE_PROCESS_IDENTITY', 'ERR_SCREEN_CAPTURE_HOOK_IDENTITY', 'ERR_SCREEN_CAPTURE_SOURCE',
    'ERR_MAC_SOURCE_LOST', 'ERR_MAC_SOURCE_CHANGED', 'ERR_MAC_SOURCE_IDENTITY', 'ERR_MAC_SOURCE_UNAVAILABLE',
    'ERR_MAC_CAPTURE_SOURCE_CHANGED',
  ],
  files: [
    'ERR_SCREEN_CAPTURE_PATH', 'ERR_SCREEN_CAPTURE_RUNTIME_PATH', 'ERR_SCREEN_CAPTURE_RUNTIME_INTEGRITY',
    'ERR_SCREEN_CAPTURE_MODULE_PATH', 'ERR_SCREEN_CAPTURE_MODULE_OPEN', 'ERR_SCREEN_CAPTURE_MODULE_INIT',
    'ERR_SCREEN_CAPTURE_LIBRARY_LOAD', 'ERR_SCREEN_CAPTURE_DLL_SEARCH', 'ERR_SCREEN_CAPTURE_ABI',
    'ERR_SCREEN_CAPTURE_RUN_DIRECTORY', 'ERR_SCREEN_CAPTURE_STARTUP_MODE', 'ERR_SCREEN_CAPTURE_CORE',
    'ERR_MAC_AV1_RUNTIME', 'ERR_MAC_AV1_RUNTIME_PATH', 'ERR_MAC_HOST_START', 'ERR_SCREEN_AUDIO_UNAVAILABLE',
  ],
  encoder: [
    'ERR_SCREEN_CAPTURE_ENCODER_UNAVAILABLE', 'ERR_SCREEN_CAPTURE_ENCODER_UNSUPPORTED',
    'ERR_SCREEN_CAPTURE_ENCODER_INITIALIZATION', 'ERR_SCREEN_CAPTURE_ENCODER_REROUTE',
    'ERR_SCREEN_CAPTURE_AMF_UNAVAILABLE', 'ERR_SCREEN_CAPTURE_NVENC_UNAVAILABLE',
    'ERR_SCREEN_CAPTURE_SOFTWARE_UNAVAILABLE', 'ERR_SCREEN_CAPTURE_NO_ENCODER', 'ERR_SCREEN_CAPTURE_DEVICE',
    'ERR_MAC_VIDEO_ENCODER_UNSUPPORTED', 'ERR_MAC_AV1_HARDWARE_UNSUPPORTED', 'ERR_MAC_AV1_INITIALIZATION',
    'ERR_MAC_VIDEO_SESSION', 'ERR_MAC_VIDEO_METAL_UNAVAILABLE', 'ERR_MAC_VIDEO_MODE_CHANGED',
  ],
  quality: [
    'ERR_SCREEN_CAPTURE_AMF_LEVEL_UNSUPPORTED', 'ERR_SCREEN_CAPTURE_AV1', 'ERR_SCREEN_CAPTURE_H264',
    'ERR_SCREEN_CAPTURE_BITRATE', 'ERR_SCREEN_CAPTURE_VIDEO',
    'ERR_MAC_VIDEO_PROFILE_UNSUPPORTED', 'ERR_MAC_VIDEO_BITRATE', 'ERR_MAC_AV1_BITRATE', 'ERR_RTC_ENCODED_FORMAT',
  ],
  capacity: ['ERR_SCREEN_CAPACITY'],
  interrupted: [
    'ERR_SCREEN_CAPTURE_TIMEOUT', 'ERR_SCREEN_CAPTURE_FIRST_AU_TIMEOUT', 'ERR_SCREEN_CAPTURE_BACKPRESSURE',
    'ERR_SCREEN_CAPTURE_QUEUE', 'ERR_SCREEN_CAPTURE_PIPE', 'ERR_SCREEN_CAPTURE_WORKER',
    'ERR_SCREEN_CAPTURE_UNEXPECTED_STOP', 'ERR_SCREEN_CAPTURE_PARENT_LOST', 'ERR_SCREEN_CAPTURE_OUTPUT_STOPPED',
    'ERR_SCREEN_CAPTURE_CLOSED', 'ERR_SCREEN_CAPTURE_STA', 'ERR_SCREEN_CAPTURE_STDIN_EOF',
    'ERR_MAC_HOST_TIMEOUT', 'ERR_MAC_HOST_EXIT', 'ERR_MAC_HOST_PIPE', 'ERR_MAC_MEDIA_PIPE', 'ERR_MAC_CAPTURE_FIRST_FRAME',
    'ERR_MAC_CAPTURE_STOPPED', 'ERR_MAC_CAPTURE_OUTPUT_BACKPRESSURE', 'ERR_MAC_VIDEO_BACKPRESSURE', 'ERR_RTC_HOST_EXIT',
  ],
  // Broken internal contracts: nothing the person can fix, so they read the generic explanation.
  unexpected: [
    'ERR_SCREEN_CAPTURE_PROTOCOL', 'ERR_SCREEN_CAPTURE_ARGUMENT', 'ERR_SCREEN_CAPTURE_DIAGNOSTIC',
    'ERR_SCREEN_CAPTURE_DIAGNOSTICS', 'ERR_SCREEN_CAPTURE_FAILURE_RECORD', 'ERR_SCREEN_CAPTURE_LOG_CALLBACK',
    'ERR_SCREEN_CAPTURE_STDERR', 'ERR_SCREEN_CAPTURE_STDERR_LIMIT', 'ERR_SCREEN_CAPTURE_STDIN',
    'ERR_SCREEN_CAPTURE_STDOUT', 'ERR_SCREEN_CAPTURE_STDOUT_LIMIT', 'ERR_SCREEN_CAPTURE_STOCK_LOG_LIMIT',
    'ERR_SCREEN_CAPTURE_TEXT', 'ERR_SCREEN_CAPTURE_TIMESTAMP', 'ERR_SCREEN_CAPTURE_PACKET',
    'ERR_SCREEN_CAPTURE_ENCODER_PACKET', 'ERR_SCREEN_CAPTURE_BUFFER_LIMIT', 'ERR_SCREEN_CAPTURE_OUTPUT',
    'ERR_SCREEN_CAPTURE_OUTPUT_CALLBACK', 'ERR_SCREEN_CAPTURE_PROBE_ISOLATION', 'ERR_SCREEN_CAPTURE_PARENT',
    'ERR_SCREEN_CAPTURE_INITIALIZATION', 'ERR_SCREEN_CAPTURE_RETIREMENT', 'ERR_SCREEN_CAPTURE_CANVAS',
    'ERR_SCREEN_CAPTURE_CLOCK', 'ERR_SCREEN_CAPTURE_NATIVE', 'ERR_SCREEN_CAPTURE_SETTINGS',
    // macOS host, capture and VideoToolbox contract checks, the self-tests and retirement bookkeeping.
    'ERR_MAC_ARGUMENT', 'ERR_MAC_CANCELLED', 'ERR_MAC_CLOSED', 'ERR_MAC_CREDITS', 'ERR_MAC_ENUMERATION',
    'ERR_MAC_HOST_KILL', 'ERR_MAC_NATIVE', 'ERR_MAC_OWNERSHIP', 'ERR_MAC_PLATFORM', 'ERR_MAC_PROVIDER_CLOSED',
    'ERR_MAC_RETIRED_WITH_ERRORS', 'ERR_MAC_SOURCE_LIMIT', 'ERR_MAC_TEST_DISPLAY', 'ERR_MAC_TEST_WINDOW',
    'ERR_MAC_THUMBNAIL_CAPTURE', 'ERR_MAC_THUMBNAIL_SIZE',
    'ERR_MAC_AV1_ENCODE', 'ERR_MAC_AV1_KEYFRAME', 'ERR_MAC_AV1_OUTPUT', 'ERR_MAC_AV1_PIXEL_LOCK', 'ERR_MAC_AV1_PLANES',
    'ERR_MAC_AV1_SEQUENCE', 'ERR_MAC_AV1_STRIDE',
    'ERR_MAC_CAPTURE_ATTACHMENTS', 'ERR_MAC_CAPTURE_CANCELLED', 'ERR_MAC_CAPTURE_CLOSING', 'ERR_MAC_CAPTURE_COMMAND',
    'ERR_MAC_CAPTURE_ENCODER_RETIREMENT', 'ERR_MAC_CAPTURE_FAILURE_OBSERVER', 'ERR_MAC_CAPTURE_FRAME',
    'ERR_MAC_CAPTURE_FRAME_STATUS', 'ERR_MAC_CAPTURE_MEDIA_PIPE', 'ERR_MAC_CAPTURE_MONITOR', 'ERR_MAC_CAPTURE_OPTIONS',
    'ERR_MAC_CAPTURE_OUTPUT', 'ERR_MAC_CAPTURE_OUTPUT_RETIREMENT', 'ERR_MAC_CAPTURE_RETIREMENT', 'ERR_MAC_CAPTURE_SAMPLE',
    'ERR_MAC_CAPTURE_START', 'ERR_MAC_CAPTURE_STATE', 'ERR_MAC_CAPTURE_STOP', 'ERR_MAC_CAPTURE_WRITER_RETIREMENT',
    'ERR_MAC_DECODE_BITSTREAM', 'ERR_MAC_DECODE_BLOCK', 'ERR_MAC_DECODE_BLOCK_COPY', 'ERR_MAC_DECODE_CALLBACK',
    'ERR_MAC_DECODE_CALLBACKS_PENDING', 'ERR_MAC_DECODE_CLOSED', 'ERR_MAC_DECODE_DRAIN', 'ERR_MAC_DECODE_FORMAT',
    'ERR_MAC_DECODE_FORMAT_CHANGED', 'ERR_MAC_DECODE_FRAME', 'ERR_MAC_DECODE_FRAME_DROPPED', 'ERR_MAC_DECODE_FRAMES_PENDING',
    'ERR_MAC_DECODE_HARDWARE_PROPERTY', 'ERR_MAC_DECODE_INPUT', 'ERR_MAC_DECODE_NAL', 'ERR_MAC_DECODE_OPTIONS',
    'ERR_MAC_DECODE_OUTPUT', 'ERR_MAC_DECODE_PARAMETER_SETS', 'ERR_MAC_DECODE_SAMPLE', 'ERR_MAC_DECODE_SESSION',
    'ERR_MAC_DECODE_TEST_COUNT', 'ERR_MAC_DECODE_TEST_LOCK', 'ERR_MAC_DECODE_TEST_ORDER', 'ERR_MAC_DECODE_TEST_PIXELS',
    'ERR_MAC_DECODE_TEST_UNLOCK', 'ERR_MAC_DECODE_TIMESTAMP', 'ERR_MAC_DECODE_WAIT',
    'ERR_MAC_VIDEO_BITSTREAM', 'ERR_MAC_VIDEO_BLOCK', 'ERR_MAC_VIDEO_CALLBACK', 'ERR_MAC_VIDEO_CALLBACK_IDENTITY',
    'ERR_MAC_VIDEO_CALLBACKS_PENDING', 'ERR_MAC_VIDEO_CLOSED', 'ERR_MAC_VIDEO_CODEC', 'ERR_MAC_VIDEO_COMPLETE_FRAME',
    'ERR_MAC_VIDEO_CONTENT_RECT', 'ERR_MAC_VIDEO_DRAIN', 'ERR_MAC_VIDEO_ENCODE', 'ERR_MAC_VIDEO_FRAME_DROPPED',
    'ERR_MAC_VIDEO_FRAME_REORDERING', 'ERR_MAC_VIDEO_HARDWARE_PROBE', 'ERR_MAC_VIDEO_IDENTIFIERS', 'ERR_MAC_VIDEO_NAL',
    'ERR_MAC_VIDEO_OPTIONS', 'ERR_MAC_VIDEO_PACKET_SIZE', 'ERR_MAC_VIDEO_PARAMETER_SETS', 'ERR_MAC_VIDEO_PIXEL_FORMAT',
    'ERR_MAC_VIDEO_PREPARE', 'ERR_MAC_VIDEO_PROBE_BUFFER', 'ERR_MAC_VIDEO_PROBE_DUPLICATE', 'ERR_MAC_VIDEO_PROBE_LOCK',
    'ERR_MAC_VIDEO_PROBE_UNLOCK', 'ERR_MAC_VIDEO_PROFILE_UNVERIFIED', 'ERR_MAC_VIDEO_PROPERTY', 'ERR_MAC_VIDEO_SAMPLE',
    'ERR_MAC_VIDEO_SCALE_BUFFER', 'ERR_MAC_VIDEO_SCALE_COLOR', 'ERR_MAC_VIDEO_SCALE_COMPLETE', 'ERR_MAC_VIDEO_SCALE_CONTEXT',
    'ERR_MAC_VIDEO_SCALE_POOL', 'ERR_MAC_VIDEO_SCALE_SUBMIT', 'ERR_MAC_VIDEO_TEST_BUFFER', 'ERR_MAC_VIDEO_TEST_CALLBACK',
    'ERR_MAC_VIDEO_TEST_LOCK', 'ERR_MAC_VIDEO_TEST_OUTPUT', 'ERR_MAC_VIDEO_TEST_TIMESTAMPS', 'ERR_MAC_VIDEO_TEST_UNLOCK',
    'ERR_MAC_VIDEO_TIMESTAMP', 'ERR_MAC_VIDEO_TIMESTAMP_ORDER',
  ],
};

/** Every native code with a known category; a code missing here reads as `unexpected`. */
export const SCREEN_SHARE_FAILURE_CODES: ReadonlyMap<string, ScreenShareFailureCategory> = new Map(
  SCREEN_SHARE_FAILURE_CATEGORIES.flatMap(category => byCategory[category].map(code => [code, category] as const)));

/** What a set of native codes means to the person: the most specific category among them. */
export function screenShareFailureCategory(codes: readonly string[]): ScreenShareFailureCategory {
  let best = SCREEN_SHARE_FAILURE_CATEGORIES.length - 1;
  for (const code of codes) {
    const category = SCREEN_SHARE_FAILURE_CODES.get(code);
    if (category) best = Math.min(best, SCREEN_SHARE_FAILURE_CATEGORIES.indexOf(category));
  }
  return SCREEN_SHARE_FAILURE_CATEGORIES[best];
}

/**
 * What Main tells the renderer about a failure: its native codes and, when Main already wrote the
 * message for the person in the app's language, that message.
 */
export const screenShareFailureDetailSchema = z.object({
  codes: z.array(z.string().regex(nativeCode)).max(MAX_CODES),
  notice: z.string().min(1).max(1024).optional(),
}).strict();
export type ScreenShareFailureDetail = z.infer<typeof screenShareFailureDetailSchema>;

const MARKER = ' [monky-screen-failure ';

/** `message` followed by the marker the renderer reads; Electron keeps only the message across `invoke`. */
export function encodeScreenShareFailure(message: string, detail: ScreenShareFailureDetail): string {
  return `${message}${MARKER}${JSON.stringify(screenShareFailureDetailSchema.parse(detail))}]`;
}

/** The detail Main wrote at the end of a message, or null when there is none or it does not validate. */
export function decodeScreenShareFailure(message: string): ScreenShareFailureDetail | null {
  const start = message.lastIndexOf(MARKER);
  if (start === -1 || !message.endsWith(']')) return null;
  try {
    const parsed = screenShareFailureDetailSchema.safeParse(JSON.parse(message.slice(start + MARKER.length, -1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
