import type http from 'http';
import type { ServerInviteInfoPayload } from '@monky/shared';
import type { AvatarStorageService } from '../security/AvatarStorageService';
import { Logger } from '../logger/Logger';
import { GET_OR_HEAD, sendJson, sendStatus, type HttpRoute } from './HttpRouter';
import { decodePathSegment, serveFile } from './serveFile';

export interface PublicRouteOptions {
  avatars: AvatarStorageService;
  /** What a visitor sees before joining: who is online and whether there is room. */
  preview: () => Promise<object>;
  /** Addresses this host can be reached at, for the invite screen. */
  inviteInfo: () => Promise<ServerInviteInfoPayload>;
}

/** Routes anyone who reaches the port may call, without an account. */
export function publicRoutes(options: PublicRouteOptions): HttpRoute[] {
  return [
    {
      methods: GET_OR_HEAD,
      path: '/health',
      handle: (_req, res) => sendJson(res, 200, { status: 'ok', time: Date.now() }),
    },
    {
      methods: GET_OR_HEAD,
      path: '/preview',
      handle: async (_req, res) => {
        let preview: object;
        try {
          preview = await options.preview();
        } catch (error) {
          Logger.error('NETWORK', 'Failed to prepare the public server preview.', error);
          sendStatus(res, 500);
          return;
        }
        sendJson(res, 200, preview);
      },
    },
    {
      methods: GET_OR_HEAD,
      path: '/invite-info',
      // Members get the same data over the WebSocket. Over anonymous HTTP it
      // handed every LAN and VPN address of the host to whoever reached the
      // port, so only the host's own app keeps this fallback (S-WS-11).
      handle: async (req, res) => {
        if (!isLocalRequest(req)) {
          sendStatus(res, 404);
          return;
        }
        sendJson(res, 200, await options.inviteInfo());
      },
    },
    {
      methods: GET_OR_HEAD,
      path: '/avatars/',
      handle: async (req, res, target) => {
        const name = decodePathSegment(target.pathname, '/avatars/');
        const avatar = name === null ? null : options.avatars.getAvatarFile(name);
        if (!avatar) {
          sendStatus(res, 404);
          return;
        }
        await serveFile(req, res, avatar, { cacheControl: 'public, max-age=86400', inline: true });
      },
    },
  ];
}

/**
 * A loopback peer that no proxy forwarded: a reverse proxy on this machine
 * connects from loopback too, but on behalf of whoever reached it.
 */
export function isLocalRequest(req: Pick<http.IncomingMessage, 'headers'> & { socket: { remoteAddress?: string } }): boolean {
  const { headers } = req;
  if (headers.forwarded || headers['x-forwarded-for'] || headers['x-real-ip']) return false;
  const address = req.socket.remoteAddress ?? '';
  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
  return ipv4 === '::1' || ipv4.startsWith('127.');
}
