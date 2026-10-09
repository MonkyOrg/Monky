import {
  LIMITS,
  PROTOCOL_VERSION,
  botDiagnosticRequestSchema,
  negotiateProtocol,
  type BotDiagnosticResult,
  type BotReachabilityResult,
} from '@monky/shared';
import type { RateLimiter } from '../../infrastructure/security/RateLimiter';
import { probeBotReachability, type ReachabilityProbeOutcome } from '../../infrastructure/network/ReachabilityProber';
import type { BotService } from './BotService';

export type BotDiagnosticOutcome =
  | { kind: 'invalid' }
  | { kind: 'rate_limited' }
  | { kind: 'result'; result: BotDiagnosticResult };

export interface BotDiagnosticOptions {
  /** Every reachability answer is sent at the same moment, hiding probe timing. */
  responseWindowMs: number;
  maxConcurrent: number;
  perMinute: number;
  perHour: number;
  probe: (origin: string, options: { requesterIp: string; publicKeyHex: string }) => Promise<ReachabilityProbeOutcome>;
}

const DEFAULT_OPTIONS: BotDiagnosticOptions = {
  responseWindowMs: 6_000,
  maxConcurrent: 4,
  perMinute: 4,
  perHour: 30,
  probe: probeBotReachability,
};

/**
 * Lets a bot operator check, before authenticating, whether a Monky server
 * accepts the bot credential and can reach the bot's own public ports. It is
 * deliberately useless as a scanner: only valid credentials, few targets,
 * public or own addresses, cryptographic proof and a fixed response time.
 */
export class BotDiagnosticService {
  private active = 0;
  private readonly options: BotDiagnosticOptions;

  constructor(
    private readonly bots: Pick<BotService, 'inspectCredential' | 'serverName'>,
    private readonly rateLimiter: RateLimiter,
    options: Partial<BotDiagnosticOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async diagnose(payload: unknown, requesterIp: string): Promise<BotDiagnosticOutcome> {
    const parsed = botDiagnosticRequestSchema.safeParse(payload);
    if (!parsed.success) return { kind: 'invalid' };
    const request = parsed.data;
    const credential = await this.inspect(request.botToken, request.publicKey, requesterIp);
    if (!credential) return { kind: 'rate_limited' };
    const base = {
      serverProtocolVersion: PROTOCOL_VERSION,
      protocol: negotiateProtocol(request.protocolVersion, request.protocolOffer, 'bot'),
      credential: credential.state,
    };
    if (!('botId' in credential)) {
      return { kind: 'result', result: { ...base, reachability: request.targets.map(({ id }) => ({ id, status: 'skipped', reason: 'credential' })) } };
    }
    const { botId, verifyKey } = credential;
    const serverName = (await this.bots.serverName())?.slice(0, 200);
    const named = { ...base, ...(serverName ? { serverName } : {}) };
    if (!request.targets.length) return { kind: 'result', result: { ...named, reachability: [] } };
    const skipAll = (reason: 'rate_limited' | 'busy'): BotDiagnosticOutcome => ({
      kind: 'result', result: { ...named, reachability: request.targets.map(({ id }) => ({ id, status: 'skipped', reason })) },
    });
    if (!this.rateLimiter.peek(`bot-diagnostic:${botId}`, this.options.perMinute, 60_000) ||
        !this.rateLimiter.peek(`bot-diagnostic-hour:${botId}`, this.options.perHour, 3_600_000)) {
      return skipAll('rate_limited');
    }
    if (this.active >= this.options.maxConcurrent) return skipAll('busy');
    this.rateLimiter.checkLimit(`bot-diagnostic:${botId}`, this.options.perMinute, 60_000);
    this.rateLimiter.checkLimit(`bot-diagnostic-hour:${botId}`, this.options.perHour, 3_600_000);
    this.active++;
    const deadline = Date.now() + this.options.responseWindowMs;
    try {
      const reachability = await Promise.all(request.targets.map(async ({ id, origin }): Promise<BotReachabilityResult> => {
        try {
          const outcome = await this.options.probe(origin, { requesterIp, publicKeyHex: verifyKey });
          return outcome.status === 'skipped' ? { id, status: 'skipped', reason: outcome.reason } : { id, status: outcome.status };
        } catch {
          return { id, status: 'unverified' };
        }
      }));
      const remaining = deadline - Date.now();
      if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
      return { kind: 'result', result: { ...named, reachability } };
    } finally {
      this.active--;
    }
  }

  private async inspect(token: string, publicKey: string, requesterIp: string): Promise<CredentialState | null> {
    const key = `auth:${requesterIp}`;
    const release = this.rateLimiter.reserve(key, LIMITS.RATE_LIMIT_MAX_AUTH_ATTEMPTS, LIMITS.RATE_LIMIT_AUTH_WINDOW_MS);
    if (!release) return null;
    try {
      const credential = await this.bots.inspectCredential(token, publicKey);
      // Only failed guesses spend the authentication quota shared with AUTH_CONNECT.
      if (!('botId' in credential)) {
        this.rateLimiter.checkLimit(key, LIMITS.RATE_LIMIT_MAX_AUTH_ATTEMPTS, LIMITS.RATE_LIMIT_AUTH_WINDOW_MS);
      }
      return credential;
    } finally {
      release();
    }
  }
}

type CredentialState = Awaited<ReturnType<BotService['inspectCredential']>>;
