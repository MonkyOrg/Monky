import {
  LIMITS,
  MessageType,
  normalizePublicKeyHex,
  type DmApi,
  type DmDispatch,
  type DmIncomingRelayItem,
  type DmRelayItem,
  type DmRelayDeliverPayload,
  type UserSummary,
} from '@monky/shared';
import { clientLog } from './ClientLogService';
import { sessionManager, type ServerSession } from './SessionManager';

const TICK_MS = 3_000;
const OUTGOING_EVERY_MS = 20_000;
const BLIND_HELLO_EVERY_MS = 5 * 60_000;
const SENDER_TTL_MS = 10 * 60_000;
const DELIVER_EVENT = `message.${MessageType.DM_RELAY_DELIVER}`;

interface Link {
  key: string;
  session: ServerSession;
  off: () => void;
  ready: boolean;
  /** Friends seen as online members of this server at the last tick. */
  visibleFriends: Set<string>;
  /** Identities that delivered something here recently (covers invisible friends). */
  senders: Map<string, number>;
  lastBlindHello: number;
  observed: Map<string, string>;
}

function relayReady(session: ServerSession): boolean {
  const details = session.serverStore.serverDetails;
  return session.client.getStatus() === 'CONNECTED'
    && !!details?.protocol?.features.includes('dm-relay')
    && details.dmRelayEnabled !== false;
}

function identityOf(user: UserSummary): string | null {
  if (!user.publicKey || user.isBot) return null;
  try {
    return normalizePublicKeyHex(user.publicKey);
  } catch {
    return null;
  }
}

function itemLength(item: DmRelayItem): number {
  return item.data.length + item.to.length + 16;
}

/**
 * Moves end-to-end encrypted DM items over every connected server that has the
 * relay on (#743). The main process decides what to send; this only knows who
 * is reachable where. Servers never store anything, so delivery happens while
 * both people share a server, and the outbox in the main process retries.
 */
export class DmTransport {
  private readonly links = new Map<string, Link>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastOutgoing = 0;
  private me: string | null = null;
  private friends = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly api: DmApi) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const link of this.links.values()) link.off();
    this.links.clear();
  }

  /** Kept in sync by the DM store from each snapshot. */
  setIdentity(me: string | null, friends: Iterable<string>): void {
    this.me = me;
    const next = new Set(friends);
    const added = [...next].filter((peer) => !this.friends.has(peer));
    this.friends = next;
    if (added.length > 0) this.tick();
  }

  /** Identities reachable through at least one relay-enabled server right now. */
  reachablePeers(): Set<string> {
    const peers = new Set<string>();
    for (const link of this.links.values()) {
      if (!link.ready) continue;
      for (const peer of this.linkPeers(link)) peers.add(peer);
    }
    return peers;
  }

  isReachable(peer: string): boolean {
    return [...this.links.values()].some((link) => link.ready && this.linkPeers(link).has(peer));
  }

  /** Online human members (with an identity) across connected servers. */
  onlineIdentities(): Map<string, UserSummary> {
    const users = new Map<string, UserSummary>();
    for (const session of sessionManager.getAll()) {
      if (session.client.getStatus() !== 'CONNECTED') continue;
      for (const member of session.serverStore.serverDetails?.members ?? []) {
        const identity = identityOf(member);
        if (identity && identity !== this.me && member.status !== 'DISCONNECTED' && !users.has(identity)) {
          users.set(identity, member);
        }
      }
    }
    return users;
  }

  execute(dispatch: DmDispatch | null | undefined, originKey?: string): void {
    if (!dispatch) return;
    const origin = originKey ? this.links.get(originKey) : undefined;
    if (dispatch.reply?.length) {
      if (origin?.ready) this.send(origin, dispatch.reply);
      else this.route(dispatch.reply, undefined);
    }
    if (dispatch.broadcast?.length) {
      for (const link of this.links.values()) {
        if (link.ready) this.send(link, dispatch.broadcast);
      }
    }
    if (dispatch.peers) {
      for (const items of Object.values(dispatch.peers)) {
        if (items.length) this.route(items, origin);
      }
    }
  }

  /** Forces a delivery round now (e.g. right after reconnecting). */
  flushSoon(): void {
    this.lastOutgoing = 0;
    this.tick();
  }

  private serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private call(run: () => Promise<{ ok: true; value: DmDispatch } | { ok: false; error: { message: string } }>, originKey?: string): void {
    void this.serialize(run).then((result) => {
      if (result.ok) this.execute(result.value, originKey);
      else clientLog.warn('DM', `Relay operation failed: ${result.error.message}`);
    }).catch((error: unknown) => {
      clientLog.warn('DM', 'Relay operation threw', { error: error instanceof Error ? error.message : String(error) });
    });
  }

  private linkPeers(link: Link): Set<string> {
    const peers = new Set<string>();
    for (const member of link.session.serverStore.serverDetails?.members ?? []) {
      const identity = identityOf(member);
      if (identity && identity !== this.me && member.status !== 'DISCONNECTED') peers.add(identity);
    }
    const now = Date.now();
    for (const [peer, seenAt] of link.senders) {
      if (now - seenAt > SENDER_TTL_MS) link.senders.delete(peer);
      else peers.add(peer);
    }
    return peers;
  }

  /** One server per recipient is enough; the outbox retries on another later. */
  private route(items: DmRelayItem[], origin: Link | undefined): void {
    const byRecipient = new Map<string, DmRelayItem[]>();
    for (const item of items) {
      const list = byRecipient.get(item.to) ?? [];
      list.push(item);
      byRecipient.set(item.to, list);
    }
    for (const [recipient, list] of byRecipient) {
      if (recipient === this.me) {
        for (const link of this.links.values()) if (link.ready) this.send(link, list);
        continue;
      }
      const target = this.pickLink(recipient, origin);
      if (target) this.send(target, list);
    }
  }

  private pickLink(peer: string, origin: Link | undefined): Link | null {
    if (origin?.ready && this.linkPeers(origin).has(peer)) return origin;
    let best: Link | null = null;
    let bestScore = -1;
    for (const link of this.links.values()) {
      if (!link.ready) continue;
      const peers = this.linkPeers(link);
      if (!peers.has(peer)) continue;
      const score = link.senders.get(peer) ?? 0;
      if (score > bestScore) {
        best = link;
        bestScore = score;
      }
    }
    return best;
  }

  private send(link: Link, items: DmRelayItem[]): void {
    if (link.session.client.getStatus() !== 'CONNECTED') return;
    let batch: DmRelayItem[] = [];
    let size = 0;
    const flush = () => {
      if (batch.length === 0) return;
      link.session.client.send(MessageType.DM_RELAY_SEND, { relayId: crypto.randomUUID(), items: batch });
      batch = [];
      size = 0;
    };
    for (const item of items) {
      const length = itemLength(item);
      if (batch.length >= LIMITS.DM_RELAY_MAX_ITEMS || size + length > LIMITS.DM_RELAY_TOTAL_DATA_MAX_LENGTH) flush();
      batch.push(item);
      size += length;
    }
    flush();
  }

  private attach(session: ServerSession): Link {
    const link: Link = {
      key: session.key,
      session,
      off: () => undefined,
      ready: false,
      visibleFriends: new Set(),
      senders: new Map(),
      lastBlindHello: 0,
      observed: new Map(),
    };
    link.off = session.client.onEvent((event, data) => {
      if (event === DELIVER_EVENT) this.deliver(link, data);
      else if (event === 'network.disconnected' || event === 'network.disposed') link.ready = false;
    });
    return link;
  }

  private deliver(link: Link, data: unknown): void {
    const payload = data as Partial<DmRelayDeliverPayload> | null;
    if (!payload || typeof payload.from !== 'string' || typeof payload.data !== 'string' || typeof payload.kind !== 'string') return;
    let from: string;
    try {
      from = normalizePublicKeyHex(payload.from);
    } catch {
      return;
    }
    if (from !== this.me) link.senders.set(from, Date.now());
    const item: DmIncomingRelayItem = { from, kind: payload.kind, data: payload.data };
    this.call(() => this.api.ingest(item), link.key);
  }

  private tick(): void {
    const sessions = sessionManager.getAll();
    const keys = new Set(sessions.map((session) => session.key));
    for (const [key, link] of this.links) {
      if (!keys.has(key) || link.session !== sessionManager.get(key)) {
        link.off();
        this.links.delete(key);
      }
    }
    for (const session of sessions) {
      if (!this.links.has(session.key)) this.links.set(session.key, this.attach(session));
    }
    if (!this.me) return;

    const now = Date.now();
    for (const link of this.links.values()) {
      const ready = relayReady(link.session);
      if (!ready) {
        link.ready = false;
        link.visibleFriends.clear();
        continue;
      }
      const invisible = link.session.serverStore.currentUser?.invisible === true;
      if (!link.ready) {
        link.ready = true;
        link.senders.clear();
        link.visibleFriends.clear();
        const nickname = link.session.serverStore.currentUser?.nickname;
        if (nickname) void this.api.setSelfNickname(nickname);
        // Own-device sync always; invisible users also knock on every friend,
        // because nobody can see them to start the conversation.
        this.callOn(link, () => this.api.hello(invisible));
        if (invisible) link.lastBlindHello = now;
        this.lastOutgoing = 0;
      } else if (invisible && now - link.lastBlindHello > BLIND_HELLO_EVERY_MS) {
        link.lastBlindHello = now;
        this.callOn(link, () => this.api.hello(true));
      }
      this.observe(link);
      const peers = this.linkPeers(link);
      for (const friend of this.friends) {
        const visible = peers.has(friend);
        if (visible && !link.visibleFriends.has(friend)) {
          link.visibleFriends.add(friend);
          this.call(() => this.api.helloTo(friend), link.key);
          this.call(() => this.api.outgoing([friend], true), link.key);
        } else if (!visible) {
          link.visibleFriends.delete(friend);
        }
      }
    }

    if (now - this.lastOutgoing >= OUTGOING_EVERY_MS) {
      this.lastOutgoing = now;
      const reachable = [...this.reachablePeers()];
      if (reachable.length > 0) this.call(() => this.api.outgoing(reachable, false));
    }
  }

  /** Hello items are addressed to me/friends but belong on this server only. */
  private callOn(link: Link, run: () => Promise<{ ok: true; value: DmDispatch } | { ok: false; error: { message: string } }>): void {
    void this.serialize(run).then((result) => {
      if (!result.ok) return;
      const items = [...(result.value.broadcast ?? []), ...(result.value.reply ?? [])];
      if (items.length && link.ready) this.send(link, items);
      if (result.value.peers) this.execute({ peers: result.value.peers }, link.key);
    }).catch(() => undefined);
  }

  /** Keeps friend nicknames/avatars fresh from what servers show. */
  private observe(link: Link): void {
    const base = link.session.client.getHttpBaseUrl();
    for (const member of link.session.serverStore.serverDetails?.members ?? []) {
      const identity = identityOf(member);
      if (!identity || identity === this.me) continue;
      const avatar = member.avatarUrl
        ? (member.avatarUrl.startsWith('/') && base ? `${base}${member.avatarUrl}` : member.avatarUrl)
        : null;
      const signature = `${member.nickname}\n${avatar ?? ''}`;
      if (link.observed.get(identity) === signature) continue;
      link.observed.set(identity, signature);
      void this.api.observePeer({ publicKey: identity, nickname: member.nickname, avatar });
    }
  }
}
