import { networkClient } from '../core/NetworkClient';

const DEFAULT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="64" height="64"><rect width="24" height="24" fill="#1c232d" rx="12"/><circle cx="12" cy="8" r="4" fill="#9da7b3"/><path d="M4 20c0-4.418 3.582-8 8-8s8 3.582 8 8" fill="#9da7b3"/></svg>`;

export const DEFAULT_AVATAR_URL = `data:image/svg+xml;base64,${btoa(DEFAULT_AVATAR_SVG)}`;

/** Avatar files a server stores: `/avatars/<prefix><uuid>.<ext>`. */
const SERVER_AVATAR_PATH = /^\/avatars\/[A-Za-z0-9._-]+$/;
/** Pictures the app inlines: cropped PNGs, DM thumbnails and SVG placeholders. */
const INLINE_AVATAR = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
/** A web address with a host; quotes, angle brackets and spaces would leave the HTML attribute. */
const WEB_AVATAR = /^https?:\/\/[^\s"'<>`/?#][^\s"'<>`]*$/i;

/**
 * Where an avatar is drawn from: a file the server stores (`/avatars/<name>`,
 * resolved against `baseUrl`), a web address or a picture inlined by the app.
 * Anything else — a local file, a script address or a value carrying markup —
 * gives the default silhouette, so a hostile server cannot reach past the
 * picture even where a template forgot to escape it.
 */
export function resolveAvatarUrl(url: string | null | undefined, baseUrl: string): string {
  const value = typeof url === 'string' ? url.trim() : '';
  if (INLINE_AVATAR.test(value)) return value;
  // Relative paths must be resolved against the server that sent them.
  const candidate = SERVER_AVATAR_PATH.test(value) ? `${baseUrl}${value}` : value;
  return WEB_AVATAR.test(candidate) ? candidate : DEFAULT_AVATAR_URL;
}

/** Avatar address for the server on screen; see `resolveAvatarUrl`. */
export function getAvatarUrl(url?: string | null): string {
  return resolveAvatarUrl(url, networkClient.getHttpBaseUrl());
}

/**
 * Saved-server icons must be persisted as absolute URLs. `getAvatarUrl` resolves
 * relative `/avatars/...` paths against the *currently connected* server, so a
 * stored relative path made every other server in the rail request its icon from
 * the wrong host and render broken (#312).
 */
export function toAbsoluteServerIconUrl(
  host: string,
  port: number,
  iconUrl?: string | null
): string | null {
  if (!iconUrl || iconUrl.trim().length === 0) return null;
  if (!iconUrl.startsWith('/')) return iconUrl;
  const cleanHost = host.trim().replace(/^wss?:\/\//, '').replace(/^https?:\/\//, '');
  return `http://${cleanHost}:${port}${iconUrl}`;
}

/**
 * Extensão real do arquivo de avatar, para salvar a foto ampliada com o nome
 * certo. O servidor aceita png, jpeg e webp, então um `.png` fixo entregaria um
 * arquivo com a extensão errada (#406). A query string é descartada antes da
 * busca, e `png` fica como último recurso quando a URL não diz nada.
 */
export function avatarFileExtension(avatarUrl?: string | null): string {
  return (avatarUrl || '').split('?')[0].match(/\.([a-z0-9]{1,5})$/i)?.[1] ?? 'png';
}
