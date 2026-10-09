import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { botManifestSchema, type BotLocale } from '@monky/shared';
import type { BotConfig, CliContext, MarketplaceBotConfig } from './config';
import { cliText } from './locale';
import { findProcess } from './pm2';
import { BOT_PUBLIC_KEY_HEADER } from '../reachability';

const REQUEST_TIMEOUT_MS = 1_500;
const STARTUP_TIMEOUT_MS = 10_000;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export class ManifestReadinessError extends Error {
  constructor(message: string, readonly retryable = false) {
    super(message);
    this.name = 'ManifestReadinessError';
  }
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error &&
    typeof error.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(error.code) ? error.code : 'UNKNOWN';
}

/** Address used to reach a listener bound to `bindHost` from this machine. */
export function localConnectHost(bindHost: string): string {
  const host = bindHost.startsWith('[') && bindHost.endsWith(']') ? bindHost.slice(1, -1) : bindHost;
  if (host === '0.0.0.0' || host === '') return '127.0.0.1';
  if (host === '::' || /^0*:(?:0*:)*0*$/.test(host)) return '::1';
  return host;
}

export function manifestUrl(config: Pick<MarketplaceBotConfig, 'publicHost' | 'servePort'>): string {
  const host = config.publicHost.includes(':') && !config.publicHost.startsWith('[') ? `[${config.publicHost}]` : config.publicHost;
  return `http://${host}:${config.servePort}/manifest`;
}

export interface ManifestReadiness {
  url: string;
  /** False when the bot entry ignores MONKY_BOT_NAME; the manifest still belongs to this bot. */
  nameMatches: boolean;
}

/**
 * Confirms that the local listener on the manifest port is this bot: valid SDK
 * manifest, the configured registration URL and this bot's key.
 */
export async function verifyManifest(
  config: MarketplaceBotConfig, publicKeyHex: string, bindHost: string, locale: BotLocale, timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<ManifestReadiness> {
  const host = localConnectHost(bindHost);
  const endpoint = `${host.includes(':') ? `[${host}]` : host}:${config.servePort}`;
  const failure = (pt: string, en: string, retryable = false): ManifestReadinessError => new ManifestReadinessError(
    cliText(locale, `Manifest local em ${endpoint}: ${pt}`, `Local manifest at ${endpoint}: ${en}`), retryable);
  const expectedRegistration = new URL('register', manifestUrl(config)).href;
  let nameMatches = false;
  await new Promise<void>((resolve, reject) => {
    let request: http.ClientRequest | undefined;
    let finished = false;
    const finish = (error?: ManifestReadinessError): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      request?.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(failure('tempo limite de resposta excedido.', 'response timed out.', true)), timeoutMs);
    try {
      request = http.get({
        hostname: host, port: config.servePort, path: '/manifest', agent: false,
        headers: { Accept: 'application/json' }, maxHeaderSize: 16 * 1024,
      }, (incoming) => {
        incoming.on('error', () => finish(failure('resposta interrompida.', 'response interrupted.', true)));
        incoming.on('aborted', () => finish(failure('resposta interrompida.', 'response interrupted.', true)));
        if (incoming.statusCode !== 200) {
          finish(failure(`resposta HTTP ${incoming.statusCode ?? 'inválida'}.`, `HTTP ${incoming.statusCode ?? 'invalid'} response.`,
            incoming.statusCode === 503));
          return;
        }
        if (incoming.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
          finish(failure('o serviço não retornou um manifest JSON.', 'the service did not return a JSON manifest.'));
          return;
        }
        const servedKey = incoming.headers[BOT_PUBLIC_KEY_HEADER];
        if (typeof servedKey !== 'string' || servedKey.toLowerCase() !== publicKeyHex.toLowerCase()) {
          finish(failure('a porta é atendida por outro serviço ou por outra identidade de bot.',
            'the port is served by another service or another bot identity.'));
          return;
        }
        if (Number(incoming.headers['content-length']) > MAX_MANIFEST_BYTES) {
          finish(failure('a resposta excede o limite de 8 MiB.', 'the response exceeds the 8 MiB limit.'));
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_MANIFEST_BYTES) finish(failure('a resposta excede o limite de 8 MiB.', 'the response exceeds the 8 MiB limit.'));
          else chunks.push(chunk);
        });
        incoming.on('end', () => {
          if (finished) return;
          let json: unknown;
          try {
            json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            finish(failure('a resposta contém JSON inválido.', 'the response contains invalid JSON.'));
            return;
          }
          const manifest = botManifestSchema.safeParse(json);
          if (!manifest.success) {
            finish(failure('o JSON não atende ao contrato do manifest do SDK.', 'the JSON does not satisfy the SDK manifest contract.'));
            return;
          }
          nameMatches = manifest.data.name === config.botName;
          let registration: string;
          try {
            registration = new URL(manifest.data.registrationUrl).href;
          } catch {
            finish(failure('a URL de registro é inválida.', 'the registration URL is invalid.'));
            return;
          }
          if (registration !== expectedRegistration) {
            finish(failure('a URL de registro não corresponde ao host público e à porta configurados.',
              'the registration URL does not match the configured public host and port.'));
            return;
          }
          finish();
        });
      });
      request.on('error', (error: Error) => finish(failure(
        `não foi possível acessar o serviço (${errorCode(error)}).`, `could not reach the service (${errorCode(error)}).`, true)));
    } catch {
      finish(failure('não foi possível consultar o endereço de escuta.', 'could not query the listening address.'));
    }
  });
  return { url: manifestUrl(config), nameMatches };
}

export async function waitForManifest(
  config: MarketplaceBotConfig, publicKeyHex: string, bindHost: string, locale: BotLocale, cliName: string,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<ManifestReadiness> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await verifyManifest(config, publicKeyHex, bindHost, locale,
        Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())));
    } catch (error: unknown) {
      if (!(error instanceof ManifestReadinessError) || !error.retryable) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ManifestReadinessError(cliText(locale,
          `O manifest não ficou pronto no prazo. Consulte "${cliName} logs". ${error.message}`,
          `The manifest did not become ready in time. Check "${cliName} logs". ${error.message}`));
      }
      await delay(Math.min(200, remaining));
    }
  }
}

/**
 * Success is announced only after PM2 reports this profile's process online
 * and, in marketplace mode, the manifest answers with this bot's identity.
 */
export async function confirmRuntimeReady(
  context: CliContext, config: BotConfig, publicKeyHex: string, bindHost: string, starting = true,
): Promise<ManifestReadiness | null> {
  const readiness = config.mode === 'marketplace'
    ? await (starting ? waitForManifest(config, publicKeyHex, bindHost, context.locale, context.cliName)
      : verifyManifest(config, publicKeyHex, bindHost, context.locale))
    : null;
  const processInfo = findProcess(context);
  if (processInfo?.pm2_env?.status !== 'online' || !processInfo.pid) {
    throw new ManifestReadinessError(cliText(context.locale,
      `O PM2 não confirmou ${context.displayName} online. Consulte "${context.cliName} logs"; a inicialização não foi confirmada.`,
      `PM2 did not confirm ${context.displayName} online. Check "${context.cliName} logs"; startup was not confirmed.`));
  }
  return readiness;
}

export function printReadiness(context: CliContext, readiness: ManifestReadiness | null): void {
  if (!readiness) return;
  console.log(`Manifest: ${readiness.url}`);
  console.log(cliText(context.locale,
    `Manifest verificado nesta máquina. Acesso externo (firewall/NAT) só se comprova de fora: use "${context.cliName} doctor".`,
    `Manifest verified on this machine. External access (firewall/NAT) can only be proven from outside: use "${context.cliName} doctor".`));
  if (!readiness.nameMatches) {
    console.log(cliText(context.locale,
      'Aviso: o nome no manifest difere do configurado; a entrada do bot deve usar MONKY_BOT_NAME.',
      'Warning: the manifest name differs from the configured one; the bot entry should use MONKY_BOT_NAME.'));
  }
}
