import { createSocket } from 'node:dgram';
import { createServer, isIP } from 'node:net';
import type { BotLocale } from '@monky/shared';
import { cliText } from './locale';

export function getManifestBindHost(previousEnv?: {
  MONKY_SERVE_HOST?: unknown;
  env?: Record<string, unknown>;
}): string {
  const host = process.env.MONKY_SERVE_HOST ?? previousEnv?.MONKY_SERVE_HOST ??
    previousEnv?.env?.MONKY_SERVE_HOST ?? '0.0.0.0';
  if (typeof host !== 'string') throw new Error('MONKY_SERVE_HOST must contain a hostname or IP.');
  return host || '0.0.0.0';
}

export function assertManifestPortAvailable(
  port: number,
  cliName: string,
  host = getManifestBindHost(),
  locale: BotLocale = 'pt-BR',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(cliText(locale,
          `A porta ${port} j\u00e1 est\u00e1 em uso por um bot ou outro servi\u00e7o. ` +
          `Escolha outra porta. Se for este bot, execute "${cliName} stop" antes de continuar.`,
          `Port ${port} is already in use by a bot or another service. ` +
          `Choose another port. If it is this bot, run "${cliName} stop" before continuing.`
        )));
        return;
      }
      const code = error.code && /^[A-Z0-9_]{1,40}$/.test(error.code) ? ` (${error.code})` : '';
      reject(new Error(cliText(locale, `Não foi possível usar a porta ${port}. Verifique o host e as permissões.`,
        `Could not use port ${port}. Check the host and permissions.`) + code));
    };
    server.once('error', onError);
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => {
        server.off('error', onError);
        if (error) reject(error);
        else resolve();
      });
    });
  });
}

export type PortBindResult = { state: 'free' } | { state: 'in-use' } | { state: 'error'; code: string };

function bindOnce(protocol: 'tcp' | 'udp', port: number, host: string): Promise<PortBindResult> {
  const failure = (error: NodeJS.ErrnoException): PortBindResult => error.code === 'EADDRINUSE'
    ? { state: 'in-use' }
    : { state: 'error', code: error.code && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'UNKNOWN' };
  if (protocol === 'udp') {
    return new Promise((resolve) => {
      const socket = createSocket({ type: isIP(host) === 6 ? 'udp6' : 'udp4', reuseAddr: false });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        try { socket.close(); } catch { /* the socket never started */ }
        resolve(failure(error));
      });
      socket.bind({ port, address: host, exclusive: true }, () => socket.close(() => resolve({ state: 'free' })));
    });
  }
  return new Promise((resolve) => {
    const server = createServer((socket) => socket.destroy());
    server.once('error', (error: NodeJS.ErrnoException) => resolve(failure(error)));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve({ state: 'free' })));
  });
}

/**
 * Briefly binds the port and releases it; never reserves it. A wildcard host is
 * checked on both families: on Windows a listener on `::` (Node's default) does
 * not stop a separate bind on `0.0.0.0`.
 */
export async function checkPortBind(protocol: 'tcp' | 'udp', port: number, host: string): Promise<PortBindResult> {
  const unwrapped = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const wildcard = unwrapped === '' || unwrapped === '0.0.0.0' || unwrapped === '::';
  const ipv4 = await bindOnce(protocol, port, wildcard ? '0.0.0.0' : unwrapped);
  if (!wildcard || ipv4.state !== 'free') return ipv4;
  const ipv6 = await bindOnce(protocol, port, '::');
  return ipv6.state === 'error' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL', 'EPROTONOSUPPORT', 'EINVAL'].includes(ipv6.code) ? ipv4 : ipv6;
}
