import { createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import {
  BOT_REACHABILITY_MAX_RESPONSE_BYTES,
  BOT_REACHABILITY_PATH,
  botReachabilityChallenge,
  botReachabilityNonceSchema,
  botReachabilityProofSchema,
} from '@monky/shared';

export const BOT_PUBLIC_KEY_HEADER = 'x-monky-bot-public-key';

export interface BotReachabilityIdentity {
  publicKeyHex: string;
  privateKey: KeyObject;
}

// A process-wide slot: the runner and the bot may load different copies of the SDK.
const RUNTIME_IDENTITY = Symbol.for('@monky/bot-sdk/runtime-identity');
type IdentityHolder = { [RUNTIME_IDENTITY]?: BotReachabilityIdentity };

export function createReachabilityIdentity(publicKeyHex: string, privateKeyPem: string): BotReachabilityIdentity {
  const privateKey = createPrivateKey(privateKeyPem);
  const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('hex');
  if (privateKey.asymmetricKeyType !== 'ed25519' || derived.toLowerCase() !== publicKeyHex.toLowerCase()) {
    throw new Error('The bot private key does not match its public identity.');
  }
  return { publicKeyHex: publicKeyHex.toLowerCase(), privateKey };
}

/** Registered by the runtime CLI runner before the bot entry is loaded. */
export function setRuntimeBotIdentity(identity: BotReachabilityIdentity | undefined): void {
  const holder = globalThis as IdentityHolder;
  if (identity) holder[RUNTIME_IDENTITY] = identity;
  else delete holder[RUNTIME_IDENTITY];
}

export function runtimeBotIdentity(): BotReachabilityIdentity | undefined {
  return (globalThis as IdentityHolder)[RUNTIME_IDENTITY];
}

export function signReachabilityChallenge(nonce: string, privateKey: KeyObject): string {
  return sign(null, Buffer.from(botReachabilityChallenge(nonce), 'utf8'), privateKey).toString('hex');
}

export function verifyReachabilityProof(nonce: string, signatureHex: string, publicKeyHex: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyHex, 'hex'), format: 'der', type: 'spki' });
    return key.asymmetricKeyType === 'ed25519' &&
      verify(null, Buffer.from(botReachabilityChallenge(nonce), 'utf8'), key, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}

function answerProbe(
  request: http.IncomingMessage, response: http.ServerResponse, identity: BotReachabilityIdentity | undefined,
): void {
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' });
    response.end();
    return;
  }
  if (!identity) {
    response.writeHead(404);
    response.end();
    return;
  }
  const nonce = botReachabilityNonceSchema.safeParse(new URL(request.url ?? '/', 'http://probe.invalid').searchParams.get('nonce'));
  if (!nonce.success) {
    response.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({ error: 'Invalid challenge.' }));
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Monky-Bot-Public-Key': identity.publicKeyHex,
  });
  response.end(JSON.stringify({ signature: signReachabilityChallenge(nonce.data, identity.privateKey) }));
}

function isProbeRequest(request: http.IncomingMessage): boolean {
  const target = request.url ?? '';
  return target === BOT_REACHABILITY_PATH || target.startsWith(`${BOT_REACHABILITY_PATH}?`);
}

/**
 * Answers the Monky reachability challenge on an HTTP listener owned by the
 * bot (for example a miniapp server), so `<bot> doctor` and the Monky server
 * can prove that the port reaches this bot. Returns false for other requests.
 */
export function handleReachabilityProbe(
  request: http.IncomingMessage, response: http.ServerResponse, publicKeyHex?: string,
): boolean {
  if (!isProbeRequest(request)) return false;
  const identity = runtimeBotIdentity();
  answerProbe(request, response,
    identity && (!publicKeyHex || identity.publicKeyHex === publicKeyHex.toLowerCase()) ? identity : undefined);
  return true;
}

/** Temporary listener used while a free port is tested from outside. */
export function startReachabilityResponder(
  port: number, host: string, identity: BotReachabilityIdentity,
): Promise<http.Server> {
  const server = http.createServer((request, response) => {
    if (isProbeRequest(request)) answerProbe(request, response, identity);
    else {
      response.writeHead(404);
      response.end();
    }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host, exclusive: true }, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

export type ReachabilityProbeOutcome = 'verified' | 'unverified' | 'unreachable';

/**
 * Sends a fresh challenge to `origin` and verifies the signature. `connectHost`
 * pins the address actually dialed (e.g. 127.0.0.1 for a local check) while the
 * origin's host is kept for the Host header and TLS name.
 */
export function probeReachability(
  origin: string, publicKeyHex: string, options: { timeoutMs?: number; connectHost?: string } = {},
): Promise<ReachabilityProbeOutcome> {
  const url = new URL(origin);
  const nonce = randomBytes(32).toString('hex');
  const client = url.protocol === 'https:' ? https : http;
  const timeoutMs = options.timeoutMs ?? 3_000;
  return new Promise((resolve) => {
    let settled = false;
    let request: http.ClientRequest | undefined;
    const finish = (outcome: ReachabilityProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request?.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('unreachable'), timeoutMs);
    const hostname = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
    try {
      request = client.request({
        protocol: url.protocol,
        hostname: options.connectHost ?? hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${BOT_REACHABILITY_PATH}?nonce=${nonce}`,
        method: 'GET',
        agent: false,
        headers: { Host: url.host, Accept: 'application/json' },
        ...(url.protocol === 'https:' ? { servername: hostname } : {}),
      }, (response) => {
        if (response.statusCode !== 200) { finish('unverified'); return; }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > BOT_REACHABILITY_MAX_RESPONSE_BYTES) finish('unverified');
          else chunks.push(chunk);
        });
        response.on('error', () => finish('unverified'));
        response.on('end', () => {
          try {
            const proof = botReachabilityProofSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            finish(proof.success && verifyReachabilityProof(nonce, proof.data.signature, publicKeyHex) ? 'verified' : 'unverified');
          } catch {
            finish('unverified');
          }
        });
      });
      request.on('error', () => finish('unreachable'));
      request.end();
    } catch {
      finish('unreachable');
    }
  });
}
