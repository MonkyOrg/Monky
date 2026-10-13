import { createSocket } from 'node:dgram';
import { createServer, isIP } from 'node:net';
import type { BotLocale } from '@monky/shared';
import { probeReachability } from '../reachability';
import type { BotPortProtocol } from '../tooling/requirements';
import { CliError, cliText } from './locale';

/** `this-bot`: the port answers the signed challenge as this bot, so reconfiguring it is not a conflict. */
export type PortUse = 'free' | 'this-bot';

/** One of the ports this bot listens on, with the value that applies to it. */
export interface OwnPort {
  id: string;
  protocol: BotPortProtocol;
  port: number;
  /** Variable that sets the port; absent for the manifest port. */
  env?: string;
}

export function getManifestBindHost(previousEnv?: {
  MONKY_SERVE_HOST?: unknown;
  env?: Record<string, unknown>;
}): string {
  const host = process.env.MONKY_SERVE_HOST ?? previousEnv?.MONKY_SERVE_HOST ??
    previousEnv?.env?.MONKY_SERVE_HOST ?? '0.0.0.0';
  if (typeof host !== 'string') throw new Error('MONKY_SERVE_HOST must contain a hostname or IP.');
  return host || '0.0.0.0';
}

/** Address used to reach a listener bound to `bindHost` from this machine. */
export function localConnectHost(bindHost: string): string {
  const host = bindHost.startsWith('[') && bindHost.endsWith(']') ? bindHost.slice(1, -1) : bindHost;
  if (host === '0.0.0.0' || host === '') return '127.0.0.1';
  if (host === '::' || /^0*:(?:0*:)*0*$/.test(host)) return '::1';
  return host;
}

/** Port number held by a declared port variable; null when the value is not a valid port. */
export function portFromValue(value: string | undefined): number | null {
  if (value === undefined || !/^\d{1,5}$/.test(value)) return null;
  const port = Number(value);
  return port >= 1 && port <= 65535 ? port : null;
}

async function answersAsThisBot(port: number, bindHost: string, publicKeyHex: string): Promise<boolean> {
  return await probeReachability(`http://127.0.0.1:${port}`, publicKeyHex, { connectHost: localConnectHost(bindHost) }) === 'verified';
}

function bindManifestPort(port: number, host: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (error: NodeJS.ErrnoException): void => resolve(error);
    server.once('error', onError);
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => {
        server.off('error', onError);
        if (error) reject(error);
        else resolve(null);
      });
    });
  });
}

/**
 * With `publicKeyHex`, a port held by this bot's running process (identity
 * confirmed by a signed challenge) is accepted, as when setup is run again.
 */
export async function assertManifestPortAvailable(
  port: number,
  cliName: string,
  host = getManifestBindHost(),
  locale: BotLocale = 'pt-BR',
  publicKeyHex?: string,
): Promise<PortUse> {
  const error = await bindManifestPort(port, host);
  if (!error) return 'free';
  if (error.code === 'EADDRINUSE') {
    if (publicKeyHex && await answersAsThisBot(port, host, publicKeyHex)) return 'this-bot';
    throw new Error(cliText(locale,
      `A porta ${port} j\u00e1 est\u00e1 em uso por um bot ou outro servi\u00e7o. ` +
      `Escolha outra porta. Se for este bot, execute "${cliName} stop" antes de continuar.`,
      `Port ${port} is already in use by a bot or another service. ` +
      `Choose another port. If it is this bot, run "${cliName} stop" before continuing.`
    ));
  }
  const code = error.code && /^[A-Z0-9_]{1,40}$/.test(error.code) ? ` (${error.code})` : '';
  throw new Error(cliText(locale, `Não foi possível usar a porta ${port}. Verifique o host e as permissões.`,
    `Could not use port ${port}. Check the host and permissions.`) + code);
}

/** Rejects a port another of this bot's own ports already uses with the same protocol. */
export function assertNoOwnPortConflict(candidate: OwnPort, others: readonly OwnPort[]): void {
  const other = others.find((entry) => entry.id !== candidate.id && entry.protocol === candidate.protocol && entry.port === candidate.port);
  if (!other) return;
  const owner = other.env ? `"${other.id}" (${other.env})` : `"${other.id}"`;
  const label = `${candidate.protocol.toUpperCase()} ${candidate.port}`;
  throw new CliError(`A porta ${label} já é usada por ${owner} deste bot. Cada porta do bot precisa ser diferente.`,
    `Port ${label} is already used by this bot's ${owner}. Each of the bot's ports must be different.`);
}

/** Checks a declared port with the bind host the bot uses; never reserves it. */
export async function assertDeclaredPortAvailable(
  target: OwnPort & { host: string }, cliName: string, publicKeyHex?: string,
): Promise<PortUse> {
  const label = `${target.protocol.toUpperCase()} ${target.port} ("${target.id}")`;
  const bind = await checkPortBind(target.protocol, target.port, target.host);
  if (bind.state === 'free') return 'free';
  if (bind.state === 'error') {
    throw new CliError(`Não foi possível usar a porta ${label} em ${target.host} (${bind.code}). Verifique o endereço de escuta e as permissões.`,
      `Could not use port ${label} on ${target.host} (${bind.code}). Check the listening address and permissions.`);
  }
  if (target.protocol === 'tcp' && publicKeyHex && await answersAsThisBot(target.port, target.host, publicKeyHex)) return 'this-bot';
  const udp = target.protocol === 'udp';
  throw new CliError(
    `A porta ${label} já está em uso por um bot ou outro serviço${udp ? ' (o dono de uma porta UDP não pode ser confirmado)' : ''}. ` +
    `Escolha outra porta. Se for este bot, execute "${cliName} stop" antes de continuar.`,
    `Port ${label} is already in use by a bot or another service${udp ? ' (the owner of a UDP port cannot be confirmed)' : ''}. ` +
    `Choose another port. If it is this bot, run "${cliName} stop" before continuing.`);
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
