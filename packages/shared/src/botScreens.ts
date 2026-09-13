import { z } from 'zod';

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
export const botScreenUpdateSchema = botScreenPatchSchema.extend({ id }).strict();
export const botScreenIdSchema = z.object({ id }).strict();
export const botScreenListSchema = z.object({ channelId: id }).strict();
export const botScreenSchema = botScreenCreateSchema.omit({ invocationId: true }).extend({
  id, botId: id, revision, createdAt: z.number().int().nonnegative().safe(),
}).strict();
export const botScreenListResultSchema = z.object({
  channelId: id, screens: z.array(botScreenSchema).max(BOT_SCREEN_LIMITS.activePerChannel),
}).strict();
export const botScreenActionSchema = z.object({
  id, action: z.string().min(1).max(64).regex(/^[a-zA-Z][a-zA-Z0-9_.:-]*$/),
  payload: botScreenActionJsonSchema, revision, actionId: id,
}).strict();
export const botScreenActionEventSchema = botScreenActionSchema.omit({ id: true }).extend({
  screenId: id, channelId: id, userId: id, userNickname: z.string().min(1).max(128),
}).strict();
export const botScreenRemovedSchema = z.object({ id, channelId: id }).strict();
export type BotScreen = z.infer<typeof botScreenSchema>;
export type BotScreenCreate = z.infer<typeof botScreenCreateSchema>;
export type BotScreenPatch = z.infer<typeof botScreenPatchSchema>;
export type BotScreenAction = z.infer<typeof botScreenActionSchema>;
export type BotScreenActionEvent = z.infer<typeof botScreenActionEventSchema>;
export type BotScreenRemoved = z.infer<typeof botScreenRemovedSchema>;
