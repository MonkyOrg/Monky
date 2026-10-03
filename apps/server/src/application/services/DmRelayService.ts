import {
  LIMITS,
  MessageType,
  ProtocolErrorCode,
  type DmRelayDeliverPayload,
  type DmRelaySendPayload,
  type ProtocolMessage,
  dmRelaySendSchema,
  normalizePublicKeyHex,
} from '@monky/shared';

export interface DmRelaySocketState {
  bufferedAmount: number;
  readyState: number;
}

export interface DmRelaySession {
  ws: DmRelaySocketState;
  user?: { publicKey?: string };
  protocol?: { features: readonly string[] };
  sessionId?: string;
  isBot?: boolean;
}

export interface DmRelayTransport<TSession extends DmRelaySession> {
  isCurrent(session: TSession): boolean;
  send(session: TSession, message: ProtocolMessage): void;
}

export interface DmRelayError {
  code: ProtocolErrorCode;
  message: string;
  relayId?: string;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

interface SessionBuckets {
  items: Bucket;
  bytes: Bucket;
}

export class DmRelayService<TSession extends DmRelaySession = DmRelaySession> {
  private readonly sessionsByPublicKey = new Map<string, Set<TSession>>();
  private readonly publicKeyBySession = new WeakMap<object, string>();
  private readonly buckets = new WeakMap<object, SessionBuckets>();

  constructor(
    private readonly transport: DmRelayTransport<TSession>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public register(session: TSession): void {
    this.unregister(session);
    if (session.isBot || !session.user?.publicKey) return;
    const publicKey = normalizePublicKeyHex(session.user.publicKey);
    let sessions = this.sessionsByPublicKey.get(publicKey);
    if (!sessions) {
      sessions = new Set();
      this.sessionsByPublicKey.set(publicKey, sessions);
    }
    sessions.add(session);
    this.publicKeyBySession.set(session, publicKey);
  }

  public unregister(session: TSession): void {
    const publicKey = this.publicKeyBySession.get(session);
    if (!publicKey) return;
    const sessions = this.sessionsByPublicKey.get(publicKey);
    sessions?.delete(session);
    if (sessions?.size === 0) this.sessionsByPublicKey.delete(publicKey);
    this.publicKeyBySession.delete(session);
  }

  public relay(
    sender: TSession,
    payload: unknown,
    options: { enabled: boolean; requestId?: string },
  ): DmRelayError | null {
    const relayId = this.extractRelayId(payload);
    const senderPublicKey = sender.user?.publicKey ? normalizePublicKeyHex(sender.user.publicKey) : undefined;
    if (!senderPublicKey || sender.isBot) {
      return { code: ProtocolErrorCode.PERMISSION_DENIED, message: 'Apenas membros humanos podem usar o relay de DMs.', relayId };
    }
    if (!sender.protocol?.features.includes('dm-relay')) {
      return { code: ProtocolErrorCode.FEATURE_REQUIRES_UPDATE, message: 'Mensagens diretas exigem cliente e servidor atualizados.', relayId };
    }
    if (!options.enabled) {
      return { code: ProtocolErrorCode.DM_RELAY_DISABLED, message: 'O relay de mensagens diretas está desabilitado neste servidor.', relayId };
    }

    const parsed = dmRelaySendSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        code: ProtocolErrorCode.BAD_REQUEST,
        message: parsed.error.errors[0]?.message || 'Relay de DM inválido.',
        relayId,
      };
    }

    const sendPayload = parsed.data satisfies DmRelaySendPayload;
    const dataLength = sendPayload.items.reduce((sum, item) => sum + item.data.length, 0);
    if (!this.consume(sender, sendPayload.items.length, dataLength)) {
      return {
        code: ProtocolErrorCode.RATE_LIMITED,
        message: 'Muitas mensagens diretas em pouco tempo. Aguarde um momento.',
        relayId: sendPayload.relayId,
      };
    }

    for (const item of sendPayload.items) {
      const recipients = this.sessionsByPublicKey.get(item.to);
      if (!recipients) continue;
      for (const recipient of recipients) {
        if (recipient === sender || recipient.isBot || !this.transport.isCurrent(recipient) ||
            !recipient.protocol?.features.includes('dm-relay') ||
            normalizePublicKeyHex(recipient.user?.publicKey ?? '') !== item.to) continue;
        if (item.kind === 'file' && recipient.ws.bufferedAmount > LIMITS.DM_RELAY_FILE_BACKPRESSURE_BYTES) continue;
        const deliver: DmRelayDeliverPayload = { from: senderPublicKey, kind: item.kind, data: item.data };
        this.transport.send(recipient, { type: MessageType.DM_RELAY_DELIVER, payload: deliver });
      }
    }

    this.transport.send(sender, {
      type: MessageType.DM_RELAY_ACK,
      requestId: options.requestId,
      payload: { relayId: sendPayload.relayId, accepted: sendPayload.items.length },
    });
    return null;
  }

  private extractRelayId(payload: unknown): string | undefined {
    return payload !== null && typeof payload === 'object' && 'relayId' in payload &&
      typeof payload.relayId === 'string' && payload.relayId.length > 0 && payload.relayId.length <= 128
      ? payload.relayId : undefined;
  }

  private consume(session: TSession, items: number, bytes: number): boolean {
    const now = this.now();
    let buckets = this.buckets.get(session);
    if (!buckets) {
      buckets = {
        items: { tokens: LIMITS.DM_RELAY_RATE_ITEMS_BURST, updatedAt: now },
        bytes: { tokens: LIMITS.DM_RELAY_RATE_BYTES_BURST, updatedAt: now },
      };
      this.buckets.set(session, buckets);
    }
    this.refill(buckets.items, LIMITS.DM_RELAY_RATE_ITEMS_BURST, LIMITS.DM_RELAY_RATE_ITEMS_PER_SECOND, now);
    this.refill(buckets.bytes, LIMITS.DM_RELAY_RATE_BYTES_BURST, LIMITS.DM_RELAY_RATE_BYTES_PER_SECOND, now);
    if (buckets.items.tokens < items || buckets.bytes.tokens < bytes) return false;
    buckets.items.tokens -= items;
    buckets.bytes.tokens -= bytes;
    return true;
  }

  private refill(bucket: Bucket, burst: number, perSecond: number, now: number): void {
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(burst, bucket.tokens + elapsed * perSecond);
    bucket.updatedAt = now;
  }
}
