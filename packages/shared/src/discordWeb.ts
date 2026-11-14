import { z } from 'zod';

/**
 * The official Discord web app, shown as is: Monky never changes, styles or
 * automates the page, and reads from it only where its menus and tooltips are
 * and how far its server list has scrolled.
 */
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

/**
 * Discord's entry address, which its app routes on its own to the server list
 * or to login: until it does, the page's shape is still unknown.
 */
export function discordWebRouting(value: string): boolean {
  const href = discordWebUrl(value);
  return href !== null && /^\/app\/?$/.test(new URL(href).pathname);
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

const pageLength = z.number().finite().min(0).max(16384);

/**
 * One of Discord's own menus or tooltips: where it is on the page, in Monky's
 * CSS pixels, and how round its corners are. Monky draws it whole beside what
 * opened it, even when that sits elsewhere in Monky than on Discord's page.
 * One still fading in or out, or that just appeared or moved, is not `shown`
 * yet: Monky does not draw it, but still keeps it out of the parts of Monky
 * where it does not belong.
 */
export const discordWebPopupSchema = z.object({
  kind: z.enum(['menu', 'tooltip']),
  x: pageCoordinate, y: pageCoordinate, width: pageLength, height: pageLength,
  radius: z.number().finite().min(0).max(64),
  shown: z.boolean(),
}).strict();
export type DiscordWebPopup = z.infer<typeof discordWebPopupSchema>;

export const DISCORD_WEB_MAX_POPUPS = 8;

/** A list's scroll length, in Monky's CSS pixels. */
const scrollLength = z.number().finite().min(0).max(1_000_000);

/**
 * Discord's server list: where its scrolling box is on the page and how far it
 * has scrolled. Monky's rail shows that list shorter than Discord's page does,
 * and scrolls its own window over the list's end so that every server stays
 * within reach. `panel` is how far above the page's bottom Discord's user
 * panel starts covering the list, which grows in a call; null when not found.
 */
export const discordWebServerListSchema = z.object({
  top: pageCoordinate, height: pageLength, scrollTop: scrollLength, scrollHeight: scrollLength,
  panel: pageLength.nullable(),
}).strict();
export type DiscordWebServerList = z.infer<typeof discordWebServerListSchema>;

/**
 * What lies over Discord's page: its menus and tooltips, and whether a modal
 * window is open; and where its server list is, when the page shows one.
 */
export const discordWebLayersSchema = z.object({
  popups: z.array(discordWebPopupSchema).max(DISCORD_WEB_MAX_POPUPS),
  modal: z.boolean(),
  servers: discordWebServerListSchema.nullable(),
}).strict();
export type DiscordWebLayers = z.infer<typeof discordWebLayersSchema>;

/** A repainted part of the Discord page, as the main process hands it to Monky's window. */
export interface DiscordWebFrame extends DiscordWebLayers {
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
