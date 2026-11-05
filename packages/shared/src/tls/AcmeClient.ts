import { createHash, createPublicKey, sign, type KeyObject } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AutoTlsFailure } from './errors';

/**
 * A minimal ACME client (RFC 8555) for one job: a certificate for one IP
 * address (RFC 8738), validated over HTTP-01, with an optional certificate
 * profile. Requests are signed with ES256 using `node:crypto` only.
 */

interface Directory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
}

interface Problem {
  type?: string;
  detail?: string;
  subproblems?: Problem[];
}

interface Order {
  status: string;
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: Problem;
}

interface Challenge {
  type: string;
  url: string;
  token: string;
  status: string;
  error?: Problem;
}

interface Authorization {
  status: string;
  challenges: Challenge[];
}

interface AcmeResponse {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
}

export interface Http01Publisher {
  publish(token: string, keyAuthorization: string): void;
  withdraw(token: string): void;
}

export interface AcmeClientOptions {
  directoryUrl: string;
  accountKey: KeyObject;
  /** Account URL from an earlier registration with this key, if known. */
  accountUrl?: string | null;
  signal: AbortSignal;
}

export interface IpCertificateRequest {
  ip: string;
  profile?: string;
  csr: Buffer;
  challenges: Http01Publisher;
}

const PROBLEM_PREFIX = 'urn:ietf:params:acme:error:';
/** Problems meaning the CA could not reach or read the challenge from the internet. */
const UNREACHABLE_PROBLEMS = new Set(['connection', 'unauthorized', 'incorrectResponse', 'tls', 'dns']);

export function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asProblem(value: unknown): Problem | undefined {
  if (!isRecord(value)) return undefined;
  return {
    type: typeof value.type === 'string' ? value.type : undefined,
    detail: typeof value.detail === 'string' ? value.detail : undefined,
    subproblems: Array.isArray(value.subproblems) ? value.subproblems.map(asProblem).filter((item): item is Problem => !!item) : undefined,
  };
}

function problemFailure(problem: Problem | undefined, fallback: string): AutoTlsFailure {
  const type = problem?.type?.startsWith(PROBLEM_PREFIX) ? problem.type.slice(PROBLEM_PREFIX.length) : '';
  const detail = problem?.detail ? `${type || 'error'}: ${problem.detail}` : fallback;
  const nested = problem?.subproblems?.map((item) => item.type?.slice(PROBLEM_PREFIX.length) ?? '') ?? [];
  if (type === 'rateLimited') return new AutoTlsFailure('rate-limited', detail);
  if (UNREACHABLE_PROBLEMS.has(type) || nested.some((item) => UNREACHABLE_PROBLEMS.has(item))) {
    return new AutoTlsFailure('unreachable', detail);
  }
  return new AutoTlsFailure('rejected', detail);
}

function parseOrder(value: unknown): Order {
  if (!isRecord(value) || typeof value.status !== 'string' || typeof value.finalize !== 'string'
    || !Array.isArray(value.authorizations) || !value.authorizations.every((item) => typeof item === 'string')) {
    throw new AutoTlsFailure('rejected', 'The CA answered with an invalid order.');
  }
  return {
    status: value.status, authorizations: value.authorizations, finalize: value.finalize,
    certificate: typeof value.certificate === 'string' ? value.certificate : undefined,
    error: asProblem(value.error),
  };
}

function parseAuthorization(value: unknown): Authorization {
  if (!isRecord(value) || typeof value.status !== 'string' || !Array.isArray(value.challenges)) {
    throw new AutoTlsFailure('rejected', 'The CA answered with an invalid authorization.');
  }
  const challenges: Challenge[] = [];
  for (const item of value.challenges) {
    if (!isRecord(item) || typeof item.type !== 'string' || typeof item.url !== 'string'
      || typeof item.status !== 'string') continue;
    challenges.push({
      type: item.type, url: item.url, status: item.status,
      token: typeof item.token === 'string' ? item.token : '', error: asProblem(item.error),
    });
  }
  return { status: value.status, challenges };
}

export class AcmeClient {
  /** How often an order or authorization is polled, unless the CA says otherwise. */
  static POLL_INTERVAL_MS = 2_000;
  /** Validation normally takes seconds; past this the attempt counts as failed. */
  static POLL_TIMEOUT_MS = 120_000;

  private directory: Directory | null = null;
  private nonce: string | null = null;
  private accountUrl: string | null;
  private readonly jwk: { crv: string; kty: string; x: string; y: string };

  constructor(private readonly options: AcmeClientOptions) {
    this.accountUrl = options.accountUrl ?? null;
    const jwk = createPublicKey(options.accountKey).export({ format: 'jwk' });
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.x || !jwk.y) throw new Error('The ACME account key must be ECDSA P-256.');
    this.jwk = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y };
  }

  /** RFC 7638 thumbprint: the members in lexical order, no whitespace. */
  public thumbprint(): string {
    const { crv, kty, x, y } = this.jwk;
    return base64url(createHash('sha256').update(JSON.stringify({ crv, kty, x, y })).digest());
  }

  /** Registers the key, or finds the account it already has. */
  public async ensureAccount(): Promise<string> {
    if (this.accountUrl) return this.accountUrl;
    const directory = await this.loadDirectory();
    const response = await this.post(directory.newAccount, { termsOfServiceAgreed: true }, { useJwk: true });
    const location = response.headers.get('location');
    if (!location) throw new AutoTlsFailure('rejected', 'The CA did not return an account URL.');
    this.accountUrl = location;
    return location;
  }

  /** Orders, validates and downloads a certificate chain (PEM) for `request.ip`. */
  public async obtainIpCertificate(request: IpCertificateRequest): Promise<string> {
    await this.ensureAccount();
    const directory = await this.loadDirectory();
    const created = await this.post(directory.newOrder, {
      identifiers: [{ type: 'ip', value: request.ip }],
      ...(request.profile ? { profile: request.profile } : {}),
    });
    const orderUrl = created.headers.get('location');
    if (!orderUrl) throw new AutoTlsFailure('rejected', 'The CA did not return an order URL.');
    let order = parseOrder(created.body);

    for (const url of order.authorizations) await this.authorize(url, request.challenges);

    order = await this.pollOrder(orderUrl, (status) => status !== 'pending');
    if (order.status !== 'ready') throw problemFailure(order.error, `The order is ${order.status}, not ready.`);
    order = parseOrder((await this.post(order.finalize, { csr: base64url(request.csr) })).body);
    order = await this.pollOrder(orderUrl, (status) => status !== 'processing' && status !== 'ready');
    if (order.status !== 'valid' || !order.certificate) throw problemFailure(order.error, `The order is ${order.status}, not valid.`);

    const certificate = await this.post(order.certificate, null, { accept: 'application/pem-certificate-chain' });
    if (!certificate.text.includes('-----BEGIN CERTIFICATE-----')) {
      throw new AutoTlsFailure('rejected', 'The CA returned no certificate.');
    }
    return certificate.text;
  }

  private async authorize(url: string, challenges: Http01Publisher): Promise<void> {
    let authorization = parseAuthorization((await this.post(url, null)).body);
    if (authorization.status === 'valid') return;
    const challenge = authorization.challenges.find((item) => item.type === 'http-01');
    if (!challenge || !challenge.token) throw new AutoTlsFailure('rejected', 'The CA offered no HTTP-01 challenge.');
    challenges.publish(challenge.token, `${challenge.token}.${this.thumbprint()}`);
    try {
      await this.post(challenge.url, {});
      authorization = await this.poll(url, parseAuthorization, (status) => status !== 'pending');
    } finally {
      challenges.withdraw(challenge.token);
    }
    if (authorization.status !== 'valid') {
      const failed = authorization.challenges.find((item) => item.type === 'http-01');
      throw problemFailure(failed?.error, `The authorization is ${authorization.status}.`);
    }
  }

  private pollOrder(url: string, done: (status: string) => boolean): Promise<Order> {
    return this.poll(url, parseOrder, done);
  }

  private async poll<T extends { status: string }>(
    url: string, parse: (value: unknown) => T, done: (status: string) => boolean,
  ): Promise<T> {
    const deadline = Date.now() + AcmeClient.POLL_TIMEOUT_MS;
    for (;;) {
      const response = await this.post(url, null);
      const value = parse(response.body);
      if (done(value.status)) return value;
      if (Date.now() >= deadline) throw new AutoTlsFailure('unreachable', `The CA did not finish validating in time (${value.status}).`);
      const retryAfter = Number(response.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : AcmeClient.POLL_INTERVAL_MS;
      await delay(wait, undefined, { signal: this.options.signal });
    }
  }

  private async loadDirectory(): Promise<Directory> {
    if (this.directory) return this.directory;
    const response = await this.request(this.options.directoryUrl, { method: 'GET' });
    const body = response.body;
    if (!isRecord(body) || typeof body.newNonce !== 'string' || typeof body.newAccount !== 'string'
      || typeof body.newOrder !== 'string') {
      throw new AutoTlsFailure('network', 'The ACME directory is invalid.');
    }
    this.directory = { newNonce: body.newNonce, newAccount: body.newAccount, newOrder: body.newOrder };
    return this.directory;
  }

  private async takeNonce(): Promise<string> {
    const saved = this.nonce;
    this.nonce = null;
    if (saved) return saved;
    const directory = await this.loadDirectory();
    const response = await this.request(directory.newNonce, { method: 'HEAD' });
    const nonce = response.headers.get('replay-nonce');
    if (!nonce) throw new AutoTlsFailure('network', 'The CA did not return a nonce.');
    return nonce;
  }

  /** Signed POST; `payload === null` is POST-as-GET. A stale nonce is retried once, as RFC 8555 §6.5 expects. */
  private async post(
    url: string, payload: object | null, options: { useJwk?: boolean; accept?: string } = {}, retried = false,
  ): Promise<AcmeResponse> {
    const header = {
      alg: 'ES256',
      nonce: await this.takeNonce(),
      url,
      ...(options.useJwk || !this.accountUrl ? { jwk: this.jwk } : { kid: this.accountUrl }),
    };
    const protectedHeader = base64url(JSON.stringify(header));
    const body = payload === null ? '' : base64url(JSON.stringify(payload));
    const signature = sign('sha256', Buffer.from(`${protectedHeader}.${body}`), {
      key: this.options.accountKey, dsaEncoding: 'ieee-p1363',
    });
    const response = await this.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/jose+json', ...(options.accept ? { accept: options.accept } : {}) },
      body: JSON.stringify({ protected: protectedHeader, payload: body, signature: base64url(signature) }),
    });
    if (response.status < 400) return response;
    const problem = asProblem(response.body);
    if (!retried && problem?.type === `${PROBLEM_PREFIX}badNonce`) return this.post(url, payload, options, true);
    throw problemFailure(problem, `The CA answered ${response.status}.`);
  }

  private async request(url: string, init: RequestInit): Promise<AcmeResponse> {
    let response: Response;
    let text: string;
    const controller = new AbortController();
    const abort = (): void => controller.abort(this.options.signal.reason);
    if (this.options.signal.aborted) abort();
    this.options.signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('The ACME request timed out.')), 30_000);
    try {
      response = await fetch(url, {
        ...init,
        headers: { 'user-agent': 'Monky-ACME/1', ...init.headers },
        signal: controller.signal,
      });
      text = init.method === 'HEAD' ? '' : await response.text();
    } catch (error) {
      if (this.options.signal.aborted) throw error;
      throw new AutoTlsFailure('network', error instanceof Error ? error.message : String(error));
    } finally {
      clearTimeout(timer);
      this.options.signal.removeEventListener('abort', abort);
    }
    const nonce = response.headers.get('replay-nonce');
    if (nonce) this.nonce = nonce;
    let body: unknown = null;
    if (/json/.test(response.headers.get('content-type') ?? '')) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (init.method === 'GET' && response.status >= 400) {
      throw new AutoTlsFailure('network', `The ACME directory answered ${response.status}.`);
    }
    return { status: response.status, headers: response.headers, body, text };
  }
}
