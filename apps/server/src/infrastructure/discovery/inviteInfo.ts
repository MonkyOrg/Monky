import { LIMITS, type ServerInviteInfoPayload } from '@monky/shared';
import type { IServerRepository } from '../../domain/repositories';
import { getPublicIp, scanServerNetworkInterfaces } from './ServerIpScanner';

export interface InviteInfoSource {
  serverRepo: Pick<IServerRepository, 'getServer'>;
  /** The port the server listens on, once it does. */
  port: () => number | null;
  fallbackName?: string;
  /** The same lookup automatic TLS uses, so both name one address. */
  publicIp?: () => Promise<string | null>;
  /** Address the automatic TLS certificate covers right now (#860). */
  secureAddress?: () => string | null;
}

/** What the invite screen offers, the same over the WebSocket and the local HTTP fallback. */
export async function describeServerInvite(source: InviteInfoSource): Promise<ServerInviteInfoPayload> {
  const [server, interfaces] = await Promise.all([
    source.serverRepo.getServer(),
    (source.publicIp ?? getPublicIp)().then((ip) => scanServerNetworkInterfaces(ip)),
  ]);
  const secure = source.secureAddress?.() ?? null;
  return {
    port: source.port() ?? LIMITS.DEFAULT_PORT,
    serverName: server?.name || source.fallbackName || 'Monky Server',
    networkInterfaces: secure
      ? interfaces.map((item) => item.address === secure ? { ...item, secure: true as const } : item)
      : interfaces,
  };
}
