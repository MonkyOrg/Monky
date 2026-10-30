import { createHash } from 'crypto';
import type {
  DmDispatch,
  DmObservedPeer,
  DmRelayItem,
  DmSelfProfileInput,
  DmSelfProfileResult,
} from '@monky/shared';
import { isIdentityPublicKey, normalizeIdentityKey } from './dmCrypto';
import type { DmLedger } from './dmLedger';
import { MAX_CLOCK_SKEW_MS, SELF_REPEAT_WINDOW_MS, type PeerRecord } from './dmModel';
import type { DmOutbox } from './dmOutbox';
import { isRecord, sanitizeAvatar, sanitizeNickname, sanitizeProfileAvatar } from './dmWire';

function profileHash(nickname: string, avatar: string | null): string {
  return createHash('sha256').update(`${nickname}\n${avatar ?? ''}`).digest('hex').slice(0, 16);
}

/** Last-writer-wins with a deterministic tie-break, so every device converges. */
function profileFieldWins(at: number, value: string, currentAt: number, current: string): boolean {
  if (at !== currentAt) return at > currentAt;
  return at > 0 && value !== current && value > current;
}

/**
 * The nickname and picture that travel with the identity (#743). Each field
 * is last-writer-wins on its own clock, so every own device ends with the
 * newest choice; friends get the profile when it changes or, if away, on
 * their next hello. What a friend sends of themselves beats what servers show.
 */
export class DmProfile {
  /** The profile last sent to each own device, so the copies of its hello from other servers do not send it again. */
  private readonly profileSentTo = new Map<string, { key: string; at: number }>();

  constructor(
    private readonly ledger: DmLedger,
    private readonly outbox: DmOutbox,
  ) {}

  /**
   * Merges what the renderer has locally. Fields win by their timestamp, so a
   * value chosen on another device later is kept and handed back for the
   * renderer to apply. Values without a timestamp (profiles saved before the
   * sync existed) only fill an empty profile.
   */
  setSelfProfile(input: DmSelfProfileInput): DmSelfProfileResult {
    const changed = this.mergeOwnProfile(input, 1);
    if (changed) this.ledger.saveState();
    return { profile: { ...this.ledger.state.profile }, dispatch: changed ? this.profileDispatch() : {} };
  }

  /** What a hello to the other own devices tells of this profile: the clock of each field, the picture by hash. */
  summary(): Record<string, unknown> {
    const profile = this.ledger.state.profile;
    return {
      n: profile.nickname,
      na: profile.nicknameAt,
      aa: profile.avatarAt,
      ah: profileHash('', profile.avatar),
    };
  }

  /**
   * Another own device greeted with the summary of its profile (see
   * {@link summary}). A newer nickname of theirs is taken; when this device has
   * a newer field, the answer is its whole profile, once per device and change.
   */
  ownDeviceHello(device: string, prof: unknown): DmRelayItem[] {
    const theirs = isRecord(prof) ? prof : {};
    const theirNicknameAt = typeof theirs.na === 'number' ? theirs.na : 0;
    const theirAvatarAt = typeof theirs.aa === 'number' ? theirs.aa : 0;
    if (typeof theirs.n === 'string' && this.mergeOwnProfile({ nickname: theirs.n, nicknameAt: theirNicknameAt }, 0)) {
      this.ledger.saveState();
      this.ledger.emit({ type: 'self-profile', profile: { ...this.ledger.state.profile } });
    }
    const mine = this.ledger.state.profile;
    const theirAvatarHash = typeof theirs.ah === 'string' ? theirs.ah : '';
    const avatarBehind = mine.avatarAt > theirAvatarAt
      || (mine.avatarAt === theirAvatarAt && mine.avatarAt > 0 && theirAvatarHash !== profileHash('', mine.avatar));
    if (!avatarBehind && mine.nicknameAt <= theirNicknameAt) return [];
    const key = `${mine.nicknameAt}:${mine.avatarAt}`;
    const now = this.ledger.now();
    const last = this.profileSentTo.get(device);
    if (last && last.key === key && now - last.at < SELF_REPEAT_WINDOW_MS) return [];
    this.profileSentTo.set(device, { key, at: now });
    return [this.selfProfileItem()];
  }

  /** The whole profile another own device sent because this one was behind. */
  receiveSelfProfile(data: Record<string, unknown>): DmDispatch {
    const changed = this.mergeOwnProfile({
      nickname: typeof data.nickname === 'string' ? data.nickname : undefined,
      nicknameAt: typeof data.nicknameAt === 'number' ? data.nicknameAt : 0,
      avatar: typeof data.avatar === 'string' || data.avatar === null ? data.avatar : undefined,
      avatarAt: typeof data.avatarAt === 'number' ? data.avatarAt : 0,
    }, 0);
    if (changed) {
      this.ledger.saveState();
      this.ledger.scheduleSnapshot();
      this.ledger.emit({ type: 'self-profile', profile: { ...this.ledger.state.profile } });
    }
    return {};
  }

  /** What a hello to a friend tells of this profile, for them to ask for it when theirs is out of date. */
  helloSummary(): { at: number; h: string } | null {
    const profile = this.friendProfileBody();
    return profile.at > 0 ? { at: profile.at, h: profileHash(profile.nickname, profile.avatar) } : null;
  }

  /** Whether the profile a friend's hello tells of (see {@link helloSummary}) is newer than the one this device has. */
  outdated(record: PeerRecord, prof: unknown): boolean {
    return isRecord(prof) && typeof prof.h === 'string' && typeof prof.at === 'number'
      && prof.h !== record.profileHash && prof.at > (record.profileAt ?? 0);
  }

  /** The friend asked for this profile. */
  answerRequest(record: PeerRecord): DmDispatch {
    const body = this.friendProfileBody();
    return body.at > 0 ? { reply: [this.outbox.envelopeItem(record, 'profile', body, 'file')] } : {};
  }

  /** A friend's profile, applied when newer than the one this device has of them. */
  applyFriendProfile(record: PeerRecord, data: Record<string, unknown>): void {
    const at = typeof data.at === 'number' && Number.isFinite(data.at) ? Math.min(data.at, this.ledger.now() + MAX_CLOCK_SKEW_MS) : 0;
    if (at <= 0 || at <= (record.profileAt ?? 0)) return;
    const rawNickname = typeof data.nickname === 'string' ? data.nickname : '';
    const rawAvatar = typeof data.avatar === 'string' ? data.avatar : null;
    record.nickname = sanitizeNickname(rawNickname, record.nickname);
    const avatar = sanitizeProfileAvatar(rawAvatar);
    if (avatar) {
      record.avatar = avatar;
      record.profileAvatar = true;
    } else if (record.profileAvatar) {
      // They removed the picture: let what servers show fill it again.
      record.avatar = null;
      record.profileAvatar = false;
    }
    record.profileAt = at;
    record.profileHash = profileHash(rawNickname, rawAvatar);
    this.ledger.changed();
  }

  /** What a server shows of a peer: kept only where the friend did not send their own. */
  observePeer(observed: DmObservedPeer): void {
    if (!isIdentityPublicKey(observed?.publicKey)) return;
    const peer = normalizeIdentityKey(observed.publicKey);
    const record = this.ledger.state.peers[peer];
    if (!record) return;
    let dirty = false;
    // What the friend sent us beats what servers show.
    if (observed.nickname !== undefined && !(record.profileAt && record.profileAt > 0)) {
      const nickname = sanitizeNickname(observed.nickname, record.nickname);
      if (nickname !== record.nickname) {
        record.nickname = nickname;
        dirty = true;
      }
    }
    if (observed.avatar !== undefined && !record.profileAvatar) {
      const avatar = sanitizeAvatar(observed.avatar);
      if (avatar !== record.avatar) {
        record.avatar = avatar;
        dirty = true;
      }
    }
    if (dirty) this.ledger.changed();
  }

  private mergeOwnProfile(input: DmSelfProfileInput, minimumAt: number): boolean {
    const profile = this.ledger.state.profile;
    const limit = this.ledger.now() + MAX_CLOCK_SKEW_MS;
    const stamp = (at: unknown): number =>
      typeof at === 'number' && Number.isFinite(at) && at > 0 ? Math.min(at, limit) : 0;
    let changed = false;
    if (input.nickname !== undefined) {
      const nickname = sanitizeNickname(input.nickname, '');
      const at = nickname ? Math.max(stamp(input.nicknameAt), minimumAt) : 0;
      if (nickname && profileFieldWins(at, nickname, profile.nicknameAt, profile.nickname)) {
        profile.nickname = nickname;
        profile.nicknameAt = at;
        changed = true;
      }
    }
    if (input.avatar !== undefined) {
      const avatar = input.avatar === null ? null : sanitizeProfileAvatar(input.avatar);
      // A picture that does not fit is ignored rather than read as "no picture".
      if (input.avatar === null || avatar !== null) {
        const at = avatar ? Math.max(stamp(input.avatarAt), minimumAt) : stamp(input.avatarAt);
        if (profileFieldWins(at, avatar ?? '', profile.avatarAt, profile.avatar ?? '')) {
          profile.avatar = avatar;
          profile.avatarAt = at;
          changed = true;
        }
      }
    }
    if (changed) this.ledger.observeStamp(Math.max(profile.nicknameAt, profile.avatarAt));
    return changed;
  }

  private selfProfileItem(): DmRelayItem {
    return this.outbox.selfItem('profile', { ...this.ledger.state.profile }, 'file');
  }

  private friendProfileBody(): { nickname: string; avatar: string | null; at: number } {
    const profile = this.ledger.state.profile;
    return {
      nickname: this.ledger.myNickname(),
      avatar: profile.avatar,
      at: Math.max(profile.nicknameAt, profile.avatarAt),
    };
  }

  /** New profile: own devices get it now; friends now if reachable, otherwise on their next hello. */
  private profileDispatch(): DmDispatch {
    const peers: Record<string, DmRelayItem[]> = {};
    const body = this.friendProfileBody();
    if (body.at > 0) {
      for (const record of Object.values(this.ledger.state.peers)) {
        if (record.relation !== 'friend' || record.blocked || !record.cert) continue;
        peers[record.publicKey] = [this.outbox.envelopeItem(record, 'profile', body, 'file')];
      }
    }
    const dispatch: DmDispatch = { broadcast: [this.selfProfileItem()] };
    if (Object.keys(peers).length > 0) dispatch.peers = peers;
    return dispatch;
  }
}
