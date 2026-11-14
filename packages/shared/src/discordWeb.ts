import { z } from 'zod';

/** The official Discord web app, shown as is: Monky never injects into or scripts the page. */
export const DISCORD_WEB_HOME = 'https://discord.com/app';

const DISCORD_HOSTS = ['discord.com', 'discordapp.com'];

/** Only HTTPS pages of Discord itself may load in the embedded Discord page. */
export function discordWebUrl(value: string): string | null {
  if (value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    return DISCORD_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`)) ? url.href : null;
  } catch { return null; }
}

/** Pages of Discord's signed-in app, which show its server list down the left side. */
const APP_PATHS = /^\/(?:channels|store|shop|discovery|guild-discovery|quest-home|activities)(?:\/|$)/;

/**
 * Whether Monky may cut the page in two, server list in Monky's rail and the
 * rest in its main area. Judged from the address alone: login and other
 * standalone pages stay whole.
 */
export function discordWebShowsServers(value: string): boolean {
  const href = discordWebUrl(value);
  return href !== null && APP_PATHS.test(new URL(href).pathname);
}

/** A side of the page, in Monky's CSS pixels. */
const pageSize = z.number().int().min(1).max(16384);
/** A point on the page, in Monky's CSS pixels. */
const pageCoordinate = z.number().finite().min(-16384).max(32768);
const modifiers = z.array(z.enum(['shift', 'control', 'alt', 'meta', 'isautorepeat',
  'leftbuttondown', 'middlebuttondown', 'rightbuttondown'])).max(8);

export const discordWebCommandSchema = z.discriminatedUnion('action', [
  /** The page's size, and whether Monky shows it: a hidden page stops painting. */
  z.object({ action: z.literal('layout'), width: pageSize, height: pageSize, visible: z.boolean() }).strict(),
  z.object({ action: z.literal('mouse'), type: z.enum(['down', 'up', 'move', 'enter', 'leave']),
    x: pageCoordinate, y: pageCoordinate, button: z.enum(['left', 'middle', 'right']).optional(),
    clickCount: z.number().int().min(0).max(3).optional(), modifiers }).strict(),
  z.object({ action: z.literal('wheel'), x: pageCoordinate, y: pageCoordinate,
    deltaX: z.number().finite().min(-10000).max(10000), deltaY: z.number().finite().min(-10000).max(10000), modifiers }).strict(),
  /** `keyCode` is an Electron accelerator key name, or the typed text for `char`. */
  z.object({ action: z.literal('key'), type: z.enum(['down', 'up', 'char']), keyCode: z.string().min(1).max(32),
    modifiers }).strict(),
  z.object({ action: z.literal('close') }).strict(),
]);
export type DiscordWebCommand = z.infer<typeof discordWebCommandSchema>;

/** A repainted part of the Discord page, as the main process hands it to Monky's window. */
export interface DiscordWebFrame {
  /** The whole page image, in device pixels. */
  width: number;
  height: number;
  /** The repainted rectangle inside it. */
  x: number;
  y: number;
  patchWidth: number;
  patchHeight: number;
  /** BGRA pixels of the rectangle, row by row. */
  pixels: Uint8Array;
}
