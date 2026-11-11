import { z } from 'zod';

export const MINIAPP_BROWSER_CHROME_HEIGHT = 112;

const id = z.string().min(1).max(128);
export const miniappBrowserOpenSchema = z.object({
  requestId: z.string().uuid(),
  serverKey: z.string().min(1).max(1024),
  channelId: id, botId: id, screenId: id, instanceId: id,
  viewerId: id, viewerSessionId: id,
  policyVersion: z.literal(1),
  title: z.string().min(1).max(200),
  locale: z.enum(['pt-BR', 'en']),
}).strict();
export type MiniappBrowserOpen = z.infer<typeof miniappBrowserOpenSchema>;
export const miniappBrowserBoundsSchema = z.object({
  x: z.number().finite().min(-100_000).max(100_000),
  y: z.number().finite().min(-100_000).max(100_000),
  width: z.number().finite().min(0).max(100_000),
  height: z.number().finite().min(0).max(100_000),
}).strict();
export type MiniappBrowserBounds = z.infer<typeof miniappBrowserBoundsSchema>;
export const MINIAPP_BROWSER_COLOR_KEYS = [
  '--bg-primary', '--bg-sidebar', '--bg-card', '--bg-hover', '--bg-active', '--bg-input',
  '--text-primary', '--text-secondary', '--text-muted', '--border-color', '--accent-primary', '--accent-hover', '--danger', '--warning',
] as const;
export const miniappBrowserAppearanceSchema = z.object({
  fontFamily: z.string().min(1).max(256),
  colors: z.record(z.enum(MINIAPP_BROWSER_COLOR_KEYS), z.string().min(1).max(128)),
}).strict();
export type MiniappBrowserAppearance = z.infer<typeof miniappBrowserAppearanceSchema>;
export const miniappBrowserOwnerCommandSchema = z.discriminatedUnion('action', [
  z.object({ requestId: z.string().uuid(), action: z.literal('close') }).strict(),
  z.object({ requestId: z.string().uuid(), action: z.literal('visibility'), visible: z.boolean() }).strict(),
  z.object({ requestId: z.string().uuid(), action: z.literal('locale'), locale: z.enum(['pt-BR', 'en']) }).strict(),
  z.object({ requestId: z.string().uuid(), action: z.literal('volume'), volume: z.number().min(0).max(2) }).strict(),
  z.object({ requestId: z.string().uuid(), action: z.literal('broadcasting'), active: z.boolean() }).strict(),
  z.object({ requestId: z.string().uuid(), action: z.literal('placement'), bounds: miniappBrowserBoundsSchema,
    clip: miniappBrowserBoundsSchema, visible: z.boolean() }).strict(),
  z.object({ requestId: z.string().uuid(), action: z.literal('appearance'), appearance: miniappBrowserAppearanceSchema }).strict(),
]);
export type MiniappBrowserOwnerCommand = z.infer<typeof miniappBrowserOwnerCommandSchema>;
export const miniappBrowserControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('navigate'), url: z.string().max(8192) }).strict(),
  z.object({ action: z.enum(['state', 'back', 'forward', 'reload', 'stop', 'close']) }).strict(),
]);
export type MiniappBrowserControl = z.infer<typeof miniappBrowserControlSchema>;
export type MiniappBrowserFailure = 'invalid-url' | 'navigation-failed' | 'permission-denied' | 'popup-denied' | 'download-denied'
  | 'broadcast-unavailable';
/** Only the local, trusted toolbar receives this. Never send it over a server connection. */
export interface MiniappBrowserState {
  url: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  locale: 'pt-BR' | 'en';
  failure: MiniappBrowserFailure | null;
  failureId: number;
  appearance: MiniappBrowserAppearance | null;
  broadcasting: boolean;
}

/** Explicit schemes only, no embedded credentials or privileged application origins. */
export function miniappBrowserUrl(value: string, privilegedOrigins: readonly string[] = []): string | null {
  if (value.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password ||
        privilegedOrigins.includes(url.origin)) return null;
    return url.href;
  } catch { return null; }
}

/** Address-bar input may omit HTTPS; navigation and resource guards still require explicit URLs. */
export function miniappBrowserAddress(value: string, privilegedOrigins: readonly string[] = []): string | null {
  const address = value.trim();
  if (!address || address.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(address)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address) || /^https?:/i.test(address)) {
    return miniappBrowserUrl(address, privilegedOrigins);
  }
  if (/^[/?#]/.test(address)) return null;
  const normalized = miniappBrowserUrl(`https://${address}`, privilegedOrigins);
  if (!normalized) return null;
  const { hostname } = new URL(normalized);
  const domain = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.?$/i;
  return hostname === 'localhost' || /^\[[a-f0-9:]+\]$/i.test(hostname) || domain.test(hostname) ? normalized : null;
}
