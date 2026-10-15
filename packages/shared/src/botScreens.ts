import { z } from 'zod';
import type { BotLocale } from './botLocales.js';
import type { BotScreenStorage } from './botStorage.js';

export const BOT_SCREEN_LIMITS = {
  htmlBytes: 128 * 1024,
  stateBytes: 64 * 1024,
  actionBytes: 8 * 1024,
  jsonDepth: 12,
  jsonNodes: 8192,
  activePerChannel: 4,
  activePerBot: 16,
  activePerServer: 64,
  actionsPerSecond: 8,
  actionsPerScreenPerSecond: 40,
} as const;

export type BotScreenJson = null | boolean | number | string | BotScreenJson[] | { [key: string]: BotScreenJson };

/** Validate iteratively before serialization: neither cycles nor excessive depth may overflow the stack. */
export function isBotScreenJson(value: unknown, maxBytes: number = BOT_SCREEN_LIMITS.stateBytes): value is BotScreenJson {
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const encoder = new TextEncoder();
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > BOT_SCREEN_LIMITS.jsonNodes || entry.depth > BOT_SCREEN_LIMITS.jsonDepth) return false;
    const item = entry.value;
    if (item === null || typeof item === 'boolean') bytes += 5;
    else if (typeof item === 'number') {
      if (!Number.isFinite(item)) return false;
      bytes += 24;
    } else if (typeof item === 'string') {
      if (item.length > maxBytes) return false;
      bytes += encoder.encode(JSON.stringify(item)).byteLength;
    } else if (typeof item === 'object') {
      if (seen.has(item)) return false;
      seen.add(item);
      if (Array.isArray(item)) {
        if (item.length > BOT_SCREEN_LIMITS.jsonNodes) return false;
        bytes += item.length + 2;
        for (const child of item) pending.push({ value: child, depth: entry.depth + 1 });
      } else {
        if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) return false;
        const keys = Object.keys(item);
        if (keys.length > BOT_SCREEN_LIMITS.jsonNodes) return false;
        for (const key of keys) {
          if (key.length > 256 || key === '__proto__' || key === 'constructor' || key === 'prototype') return false;
          const descriptor = Object.getOwnPropertyDescriptor(item, key);
          if (!descriptor || !('value' in descriptor)) return false;
          bytes += encoder.encode(JSON.stringify(key)).byteLength + 2;
          pending.push({ value: descriptor.value, depth: entry.depth + 1 });
        }
        bytes += 2;
      }
    } else return false;
    if (bytes > maxBytes) return false;
  }
  return encoder.encode(JSON.stringify(value)).byteLength <= maxBytes;
}

const id = z.string().min(1).max(128);
const revision = z.number().int().nonnegative().safe();
export const botScreenStateSchema = z.custom<BotScreenJson>((value) => isBotScreenJson(value));
export const botScreenActionJsonSchema = z.custom<BotScreenJson>((value) => isBotScreenJson(value, BOT_SCREEN_LIMITS.actionBytes));
export const botScreenCreateSchema = z.object({
  id: id.optional(),
  channelId: id,
  title: z.string().trim().min(1).max(200),
  html: z.string().min(1).max(BOT_SCREEN_LIMITS.htmlBytes)
    .refine((html) => new TextEncoder().encode(html).byteLength <= BOT_SCREEN_LIMITS.htmlBytes),
  state: botScreenStateSchema,
  invocationId: id.optional(),
}).strict();
export const botScreenPatchSchema = z.object({ state: botScreenStateSchema, expectedRevision: revision }).strict();
export const botScreenIdSchema = z.object({ id }).strict();
/** A logical ID can be reused, but operations must address the exact server-created instance. */
export const botScreenRefSchema = botScreenIdSchema.extend({ instanceId: id }).strict();
export const botScreenUpdateSchema = botScreenPatchSchema.merge(botScreenRefSchema).strict();
export const botScreenListSchema = z.object({ channelId: id }).strict();
export const botScreenSchema = botScreenCreateSchema.omit({ invocationId: true }).extend({
  id, instanceId: id, botId: id, creatorUserId: id.optional(), revision,
  createdAt: z.number().int().nonnegative().safe(),
}).strict();
export const botScreenListResultSchema = z.object({
  channelId: id, screens: z.array(botScreenSchema).max(BOT_SCREEN_LIMITS.activePerChannel),
}).strict();
export const botScreenActionSchema = z.object({
  id, instanceId: id, action: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_.:-]*$/),
  payload: botScreenActionJsonSchema, revision, actionId: id,
}).strict();
export const botScreenActionEventSchema = botScreenActionSchema.omit({ id: true }).extend({
  screenId: id, channelId: id, userId: id, userNickname: z.string().min(1).max(128),
}).strict();
export const botScreenRemovedSchema = z.discriminatedUnion('reason', [
  botScreenRefSchema.extend({ channelId: id, reason: z.literal('ended'), endedByUserId: id }).strict(),
  botScreenRefSchema.extend({ channelId: id, reason: z.literal('closed') }).strict(),
  botScreenRefSchema.extend({ channelId: id, reason: z.literal('access_revoked') }).strict(),
  botScreenRefSchema.extend({ channelId: id, reason: z.literal('bot_disconnected') }).strict(),
  botScreenRefSchema.extend({ channelId: id, reason: z.literal('view_revoked') }).strict(),
]);
export type BotScreen = z.infer<typeof botScreenSchema>;
export type BotScreenRef = z.infer<typeof botScreenRefSchema>;
export type BotScreenCreate = z.infer<typeof botScreenCreateSchema>;
export type BotScreenPatch = z.infer<typeof botScreenPatchSchema>;
export type BotScreenAction = z.infer<typeof botScreenActionSchema>;
export type BotScreenActionEvent = z.infer<typeof botScreenActionEventSchema>;
export type BotScreenRemoved = z.infer<typeof botScreenRemovedSchema>;

/** A close this viewer asked for: **Leave miniapp** (`leave`) or **End miniapp** for everyone (`end`). */
export type BotScreenBeforeCloseReason = 'leave' | 'end';
/**
 * Why a view is closing. `ended`: the instance is gone (ended by someone else, closed by the bot,
 * bot disconnected or without access to the room). `revoked`: this view lost access (left or
 * switched rooms or servers, disconnected, lost permission or left the stage).
 */
export type BotScreenCloseReason = BotScreenBeforeCloseReason | 'ended' | 'revoked';

export interface BotScreenBeforeCloseEvent {
  readonly reason: BotScreenBeforeCloseReason;
}

export interface BotScreenCloseEvent {
  readonly reason: BotScreenCloseReason;
}

/** The local person who opened the view; `locale` follows their language setting. */
export interface BotScreenViewer {
  readonly id: string;
  readonly nickname: string;
  readonly locale: BotLocale;
}

/**
 * `window.monkyScreen` inside a miniapp document. Clients released before the lifecycle hooks
 * lack `onBeforeClose`/`onClose`: call them as `monkyScreen.onClose?.(...)`.
 */
export interface BotScreenBridge {
  readonly viewer: BotScreenViewer;
  /** Delivers the current state at once and every update; returns an unsubscribe function. */
  onState(callback: (state: BotScreenJson, revision: number) => void): () => void;
  /** Whether the bridge accepted the intent, not whether the bot accepted the action. */
  sendAction(action: string, payload: BotScreenJson): boolean;
  /**
   * Runs, in registration order, before a close this person asked for; the view stays visible
   * and may ask anything. Resolving `false` keeps it open. Revocations never wait for it.
   */
  onBeforeClose(handler: (event: BotScreenBeforeCloseEvent) => boolean | void | Promise<boolean | void>): () => void;
  /**
   * Runs on every close, while the view is already hidden, muted and cut from state and actions.
   * The document is kept for at most 5 seconds so the handlers can finish, e.g. saving; `storage`
   * keeps working meanwhile.
   */
  onClose(handler: (event: BotScreenCloseEvent) => void | Promise<void>): () => void;
  /**
   * Data kept on this computer, when the bot has `device_storage` and the person allows it.
   * Missing in clients released before bot storage.
   */
  readonly storage?: BotScreenStorage;
}
