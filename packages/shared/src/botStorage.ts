import { z } from 'zod';
import type { BotCapability, BotPermissions } from './botPermissions.js';

const MIB = 1024 * 1024;

export const BOT_STORAGE_LIMITS = {
  /** Base64 inflates an object by a third and the result must still fit one WebSocket message (8 MiB). */
  objectBytes: 4 * MIB,
  keyLength: 200,
  contentTypeLength: 128,
  serverObjects: 10_000,
  deviceObjects: 1_000,
  serverDefaultBytes: 100 * MIB,
  deviceDefaultBytes: 50 * MIB,
  minQuotaBytes: MIB,
  maxQuotaBytes: 100 * 1024 * MIB,
  /** From this share of the quota on, people are warned that saves will soon stop. */
  nearFullRatio: 0.9,
  listPageSize: 100,
  operationsPerSecond: 20,
  /** Server, account and bot combinations kept on one computer. */
  deviceScopes: 512,
} as const;

export const BOT_STORAGE_CAPABILITIES = ['server_storage', 'device_storage'] as const satisfies readonly BotCapability[];
export type BotStorageCapability = typeof BOT_STORAGE_CAPABILITIES[number];

/**
 * Sent by servers when they fetch a bot manifest: the bot features they negotiate. Servers that
 * predate it send nothing, and a manifest for them must not list capabilities they would reject.
 */
export const BOT_MANIFEST_FEATURES_HEADER = 'x-monky-protocol-features';

export function isBotStorageCapability(capability: BotCapability): capability is BotStorageCapability {
  return (BOT_STORAGE_CAPABILITIES as readonly BotCapability[]).includes(capability);
}

/** Peers that did not negotiate `bot-storage` reject these names in their strict capability enum. */
export function withoutBotStorageCapabilities<T extends BotCapability>(capabilities: readonly T[]): T[] {
  return capabilities.filter((capability) => !isBotStorageCapability(capability));
}

export function withoutBotStoragePermissions(permissions: BotPermissions): BotPermissions {
  return {
    ...permissions,
    requested: permissions.requested && withoutBotStorageCapabilities(permissions.requested),
    granted: withoutBotStorageCapabilities(permissions.granted),
  };
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function validSegments(segments: string[]): boolean {
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** Logical names such as `nes/<rom>/slot-1`; files on disk never use them as paths. */
export function isBotStorageKey(value: unknown): value is string {
  return typeof value === 'string' && value.length <= BOT_STORAGE_LIMITS.keyLength && KEY_PATTERN.test(value) &&
    validSegments(value.split('/'));
}

export function isBotStoragePrefix(value: unknown): value is string {
  if (value === '') return true;
  if (typeof value !== 'string' || value.length > BOT_STORAGE_LIMITS.keyLength || !KEY_PATTERN.test(value)) return false;
  const segments = value.split('/');
  return validSegments(value.endsWith('/') ? segments.slice(0, -1) : segments);
}

function isBase64(value: string): boolean {
  if (value.length % 4 !== 0) return false;
  const end = value.endsWith('==') ? value.length - 2 : value.endsWith('=') ? value.length - 1 : value.length;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 43 || code === 47)) {
      return false;
    }
  }
  return true;
}

export function base64ByteLength(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return value.length / 4 * 3 - padding;
}

const id = z.string().min(1).max(128);
const timestamp = z.number().int().nonnegative().safe();
const count = z.number().int().nonnegative().safe();
export const botStorageKeySchema = z.string().refine(isBotStorageKey, 'Invalid storage key');
export const botStoragePrefixSchema = z.string().refine(isBotStoragePrefix, 'Invalid storage prefix');
export const botStorageContentTypeSchema = z.string().max(BOT_STORAGE_LIMITS.contentTypeLength)
  .regex(/^[A-Za-z0-9][\w!#$&^.+-]*\/[A-Za-z0-9][\w!#$&^.+-]*(?:\s*;\s*[\w!#$&^.+-]+=[\w!#$&^.+-]+)*$/);
/** Base64 bytes of one object. */
export const botStorageDataSchema = z.string().max(Math.ceil(BOT_STORAGE_LIMITS.objectBytes / 3) * 4)
  .refine((value) => isBase64(value) && base64ByteLength(value) <= BOT_STORAGE_LIMITS.objectBytes, 'Invalid storage data');
export const botStorageQuotaSchema = z.number().int().min(BOT_STORAGE_LIMITS.minQuotaBytes).max(BOT_STORAGE_LIMITS.maxQuotaBytes);

export const BOT_STORAGE_LEVELS = ['ok', 'near_full', 'full'] as const;
export const botStorageLevelSchema = z.enum(BOT_STORAGE_LEVELS);
export type BotStorageLevel = z.infer<typeof botStorageLevelSchema>;

/** `full` also covers a write that was just refused for lack of space, even below 100%. */
export function botStorageLevel(usedBytes: number, maxBytes: number, refused = false): BotStorageLevel {
  if (refused || usedBytes >= maxBytes) return 'full';
  return usedBytes >= maxBytes * BOT_STORAGE_LIMITS.nearFullRatio ? 'near_full' : 'ok';
}

export const botStorageUsageSchema = z.object({
  usedBytes: count,
  maxBytes: botStorageQuotaSchema,
  objectCount: count,
  maxObjects: z.number().int().positive().max(BOT_STORAGE_LIMITS.serverObjects),
  level: botStorageLevelSchema,
}).strict();
export type BotStorageUsage = z.infer<typeof botStorageUsageSchema>;

export const botStorageObjectInfoSchema = z.object({
  key: botStorageKeySchema,
  sizeBytes: z.number().int().min(0).max(BOT_STORAGE_LIMITS.objectBytes),
  contentType: botStorageContentTypeSchema.nullable(),
  updatedAt: timestamp,
}).strict();
export type BotStorageObjectInfo = z.infer<typeof botStorageObjectInfoSchema>;
export const botStorageObjectSchema = botStorageObjectInfoSchema.extend({ data: botStorageDataSchema }).strict()
  .refine((object) => base64ByteLength(object.data) === object.sizeBytes, 'Storage data does not match its size');
export type BotStorageObject = z.infer<typeof botStorageObjectSchema>;

// Bot -> server (`server_storage`).
export const botStoragePutSchema = z.object({
  key: botStorageKeySchema,
  data: botStorageDataSchema,
  contentType: botStorageContentTypeSchema.optional(),
}).strict();
export type BotStoragePut = z.infer<typeof botStoragePutSchema>;
export const botStorageKeyRequestSchema = z.object({ key: botStorageKeySchema }).strict();
export const botStorageListSchema = z.object({
  prefix: botStoragePrefixSchema.optional(),
  /** Continue after this key, as returned in `next`. */
  after: botStorageKeySchema.optional(),
  limit: z.number().int().min(1).max(BOT_STORAGE_LIMITS.listPageSize).optional(),
}).strict();
export type BotStorageList = z.infer<typeof botStorageListSchema>;
export const botStorageUsageRequestSchema = z.object({}).strict();

// Server -> bot.
export const botStorageGetResultSchema = z.object({
  key: botStorageKeySchema,
  object: botStorageObjectSchema.nullable(),
}).strict().refine((result) => result.object === null || result.object.key === result.key, 'Storage result addresses another key');
export const botStorageDeletedSchema = z.object({ key: botStorageKeySchema, deleted: z.boolean() }).strict();
export const botStorageListResultSchema = z.object({
  objects: z.array(botStorageObjectInfoSchema).max(BOT_STORAGE_LIMITS.listPageSize),
  next: botStorageKeySchema.nullable(),
}).strict();
export type BotStorageListResult = z.infer<typeof botStorageListResultSchema>;

// Client <-> server (`bot-storage`).
export const botStorageInfoGetSchema = z.object({ botId: id }).strict();
export const botStorageClearSchema = botStorageInfoGetSchema;
export const botStorageLimitUpdateSchema = botStorageInfoGetSchema.extend({ maxBytes: botStorageQuotaSchema }).strict();
export type BotStorageLimitUpdate = z.infer<typeof botStorageLimitUpdateSchema>;
const capabilityState = { requested: z.boolean(), granted: z.boolean() };
const grantedAfterRequest = (state: { requested: boolean; granted: boolean }): boolean => state.requested || !state.granted;
export const botStorageInfoSchema = z.object({
  botId: id,
  /** Only for people who can manage bots; everyone else gets null and sees only their own computer. */
  server: z.object({ ...capabilityState, usage: botStorageUsageSchema }).strict().refine(grantedAfterRequest).nullable(),
  device: z.object(capabilityState).strict().refine(grantedAfterRequest),
}).strict();
export type BotStorageInfo = z.infer<typeof botStorageInfoSchema>;
/** Server -> people who can manage bots: the bot's server storage crossed a warning level. */
export const botStorageLevelEventSchema = z.object({ botId: id, usage: botStorageUsageSchema }).strict();
export type BotStorageLevelEvent = z.infer<typeof botStorageLevelEventSchema>;

// Storage on the computer running a miniapp (client main process).
export const BOT_DEVICE_STORAGE_DECISIONS = ['ask', 'always', 'never'] as const;
export const botDeviceStorageDecisionSchema = z.enum(BOT_DEVICE_STORAGE_DECISIONS);
export type BotDeviceStorageDecision = z.infer<typeof botDeviceStorageDecisionSchema>;
/** What a person chose when opening one miniapp view. */
export const BOT_DEVICE_STORAGE_GRANTS = ['none', 'session', 'always'] as const;
export const botDeviceStorageGrantSchema = z.enum(BOT_DEVICE_STORAGE_GRANTS);
export type BotDeviceStorageGrant = z.infer<typeof botDeviceStorageGrantSchema>;

const displayName = z.string().trim().min(1).max(200);
const serverUrl = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return (url.protocol === 'ws:' || url.protocol === 'wss:') && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}, 'Invalid server URL');
/** Data is kept apart per server, account and bot, like the bot preferences of that person. */
export const botDeviceStorageScopeSchema = z.object({
  serverUrl,
  serverId: id,
  serverName: displayName,
  userId: id,
  botId: id,
  botName: displayName,
}).strict();
export type BotDeviceStorageScope = z.infer<typeof botDeviceStorageScopeSchema>;
export const botDeviceStorageScopeIdSchema = z.string().regex(/^[a-f0-9]{64}$/);

export type BotDeviceStorageValue = { kind: 'text'; text: string } | { kind: 'bytes'; bytes: Uint8Array };
export function botDeviceStorageValueBytes(value: BotDeviceStorageValue): number {
  return value.kind === 'text' ? new TextEncoder().encode(value.text).byteLength : value.bytes.byteLength;
}
export const botDeviceStorageValueSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string().max(BOT_STORAGE_LIMITS.objectBytes) }).strict(),
  z.object({ kind: z.literal('bytes'), bytes: z.instanceof(Uint8Array) }).strict(),
]).refine((value) => botDeviceStorageValueBytes(value) <= BOT_STORAGE_LIMITS.objectBytes, 'Value too large');

export const botDeviceStorageRequestSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('get'), key: botStorageKeySchema }).strict(),
  z.object({ op: z.literal('set'), key: botStorageKeySchema, value: botDeviceStorageValueSchema, autosave: z.boolean() }).strict(),
  z.object({ op: z.literal('remove'), key: botStorageKeySchema }).strict(),
  z.object({ op: z.literal('list'), prefix: botStoragePrefixSchema.optional() }).strict(),
  z.object({ op: z.literal('usage') }).strict(),
]);
export type BotDeviceStorageRequest = z.infer<typeof botDeviceStorageRequestSchema>;

export interface BotDeviceStorageKeyInfo {
  key: string;
  sizeBytes: number;
  updatedAt: number;
}

export type BotDeviceStorageStatus = 'unavailable' | 'granted' | 'denied';
export type BotDeviceStorageFailure = 'unavailable' | 'denied' | 'quota' | 'invalid' | 'failed';
export type BotDeviceStorageResponse =
  | { ok: true; op: 'get'; value: BotDeviceStorageValue | null; usage: BotStorageUsage }
  | { ok: true; op: 'set'; usage: BotStorageUsage }
  | { ok: true; op: 'remove'; removed: boolean; usage: BotStorageUsage }
  | { ok: true; op: 'list'; keys: BotDeviceStorageKeyInfo[]; usage: BotStorageUsage }
  | { ok: true; op: 'usage'; usage: BotStorageUsage }
  | { ok: false; reason: BotDeviceStorageFailure; usage: BotStorageUsage | null };

/** An object a miniapp kept on this computer, as `monkyScreen.storage.list()` returns it. */
export interface BotScreenStorageEntry {
  readonly key: string;
  readonly size: number;
  /** Milliseconds since the epoch. */
  readonly updatedAt: number;
}

export interface BotScreenStorageUsage {
  readonly usedBytes: number;
  readonly maxBytes: number;
  readonly level: BotStorageLevel;
}

/**
 * `window.monkyScreen.storage`: data a miniapp keeps on the computer of the person who opened it,
 * when the bot has `device_storage` and that person allows it. Keys follow the server storage rules.
 * Failures reject with an error named `MonkyStorageError` whose `reason` is `denied`,
 * `unavailable`, `quota`, `too_large`, `invalid`, `busy` or `failed`.
 */
export interface BotScreenStorage {
  /** `unavailable` until Monky connects the document, and whenever nothing may be stored. */
  readonly status: BotDeviceStorageStatus;
  /** Calls back at once with the current status and on every change; returns an unsubscribe function. */
  onStatus(callback: (status: BotDeviceStorageStatus) => void): () => void;
  get(key: string): Promise<string | ArrayBuffer | null>;
  /** With `{ autosave: true }`, a save that cannot happen resolves `false` instead of rejecting. */
  set(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob, options?: { autosave?: boolean }): Promise<boolean>;
  /** Resolves whether the key existed. */
  delete(key: string): Promise<boolean>;
  /** In key order. */
  list(options?: { prefix?: string }): Promise<BotScreenStorageEntry[]>;
  usage(): Promise<BotScreenStorageUsage | null>;
}

export interface BotDeviceStorageDocumentState {
  status: BotDeviceStorageStatus;
  scopeId: string | null;
  usage: BotStorageUsage | null;
}

export interface BotDeviceStorageEntry {
  id: string;
  scope: BotDeviceStorageScope;
  decision: BotDeviceStorageDecision;
  usage: BotStorageUsage;
  updatedAt: number;
}

export const botDeviceStorageDecisionUpdateSchema = z.object({
  scope: botDeviceStorageScopeSchema,
  decision: botDeviceStorageDecisionSchema,
}).strict();
export const botDeviceStorageQuotaUpdateSchema = z.object({
  scope: botDeviceStorageScopeSchema,
  maxBytes: botStorageQuotaSchema,
}).strict();

/** Index kept next to the objects of one server, account and bot on this computer. */
export const botDeviceStorageFileSchema = z.object({
  version: z.literal(1),
  scope: botDeviceStorageScopeSchema,
  decision: botDeviceStorageDecisionSchema,
  maxBytes: botStorageQuotaSchema,
  objects: z.array(z.object({
    key: botStorageKeySchema,
    file: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.bin$/),
    sizeBytes: z.number().int().min(0).max(BOT_STORAGE_LIMITS.objectBytes),
    kind: z.enum(['text', 'bytes']),
    updatedAt: timestamp,
  }).strict()).max(BOT_STORAGE_LIMITS.deviceObjects)
    .refine((objects) => new Set(objects.map((object) => object.key)).size === objects.length &&
      new Set(objects.map((object) => object.file)).size === objects.length, 'Duplicate storage entries'),
  updatedAt: timestamp,
}).strict();
export type BotDeviceStorageFile = z.infer<typeof botDeviceStorageFileSchema>;
