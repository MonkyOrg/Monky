import {
  MessageType,
  nativePollSchema,
  nativePollVotersSchema,
  type NativePoll,
  type NativePollVoter,
  type NativePollVoters,
} from '@monky/shared';
import type { NetworkClient } from '../core/NetworkClient';
import { t } from '../i18n';
import { getAvatarUrl } from '../utils/avatar';
import { escapeHtml } from '../utils/html';
import { renderLoadingError, renderLoadingSkeleton } from '../utils/loadingSkeleton';
import { scrollWithin } from '../utils/scroll';
import { motionDuration, reducedMotion } from '../utils/surfaceMotion';
import { openCommunityModal } from './CommunityModal';
import { renderImageCarousel } from './ImageCarousel';

const VISIBLE_VOTER_AVATARS = 3;

/** Resolves a voter's current name and picture; the payload keeps them as of the last poll update. */
export type NativePollVoterProfile = (voter: NativePollVoter) => NativePollVoter;

export interface NativePollRenderOptions {
  /** Answers chosen while the vote is in flight. The card ignores further votes until it settles. */
  pendingSelection?: readonly string[];
  /** Creation preview: the votes list cannot be opened. */
  preview?: boolean;
  profile?: NativePollVoterProfile;
}

export function nativePollVoterProfile(
  members: ReadonlyMap<string, { nickname: string; avatarUrl?: string | null }>,
): NativePollVoterProfile {
  return voter => {
    const member = members.get(voter.userId);
    return member ? { ...voter, userNickname: member.nickname, userAvatarUrl: member.avatarUrl ?? null } : voter;
  };
}

const sameVoter: NativePollVoterProfile = voter => voter;
const voterName = (voter: NativePollVoter) => voter.userNickname || t('poll.unknownVoter');

function votersTooltip(option: NativePoll['options'][number], profile: NativePollVoterProfile): string {
  const names = (option.voters ?? []).map(voter => voterName(profile(voter))).join(', ');
  const remaining = option.votes - (option.voters?.length ?? 0);
  return `${option.label}\n${remaining > 0 ? t('poll.votersAndMore', { names, count: remaining }) : names}`;
}

export function isNativePollClosed(poll: Pick<NativePoll, 'closedAt' | 'closesAt'>, now = Date.now()): boolean {
  return poll.closedAt !== null || (poll.closesAt !== null && poll.closesAt <= now);
}

export function renderNativePoll(
  poll: NativePoll,
  canVote: boolean,
  formatTime: (value: number) => string,
  imageBaseUrl = '',
  options: NativePollRenderOptions = {},
): string {
  const closed = isNativePollClosed(poll);
  const total = Math.max(0, poll.totalVotes);
  const pending = options.pendingSelection !== undefined;
  const selection = options.pendingSelection ?? poll.myVoteOptionIds ?? [];
  const profile = options.profile ?? sameVoter;
  // Older servers omit the flag: they never send voters, so nothing can be listed.
  const publicVotes = poll.anonymousVotes === false;
  const answers = poll.options.map(option => {
    const selected = selection.includes(option.id);
    const share = total > 0 ? Math.min(1, option.votes / total) : 0;
    const voters = publicVotes ? (option.voters ?? []).slice(0, VISIBLE_VOTER_AVATARS).map(profile) : [];
    const votes = t(option.votes === 1 ? 'poll.oneVote' : 'poll.voteCount', { count: option.votes });
    const count = `<span class="native-poll-tally-count" data-native-poll-count aria-hidden="true">${option.votes}</span>`;
    // Like WhatsApp, the count sits beside the voters' avatars; with voters it opens the complete list.
    const tally = voters.length ? `<button type="button" class="native-poll-tally native-poll-voters"
      data-native-poll-voters="${escapeHtml(poll.id)}" data-native-poll-voters-option="${escapeHtml(option.id)}"
      data-tooltip="${escapeHtml(votersTooltip(option, profile))}"
      aria-label="${escapeHtml(`${votes}. ${t('poll.viewVotesFor', { option: option.label })}`)}" ${options.preview ? 'disabled' : ''}>
      <span class="native-poll-voter-avatars" aria-hidden="true">${voters.map(voter => `<img class="native-poll-voter-avatar"
        src="${escapeHtml(getAvatarUrl(voter.userAvatarUrl))}" alt="" data-fallback="avatar">`).join('')}</span>${count}
    </button>` : `<span class="native-poll-tally">${count}<span class="native-poll-sr">${escapeHtml(votes)}</span></span>`;
    return `<div class="native-poll-answer">
      <button type="button" class="native-poll-option${selected ? ' native-poll-option--selected' : ''}"
        data-native-poll="${escapeHtml(poll.id)}" data-native-poll-option="${escapeHtml(option.id)}"
        aria-pressed="${selected}" ${closed || !canVote ? 'disabled' : ''} ${pending ? 'aria-disabled="true"' : ''}>
        <span class="native-poll-option-fill" data-native-poll-fill="${escapeHtml(option.id)}" data-share="${share.toFixed(4)}"
          style="transform:scaleX(${share.toFixed(4)})"></span>
        ${option.emoji ? `<span class="native-poll-option-emoji" aria-hidden="true">${escapeHtml(option.emoji)}</span>` : ''}
        <span class="native-poll-option-label">${escapeHtml(option.label)}</span>
      </button>
      ${tally}
    </div>`;
  }).join('');
  const limit = poll.maxVoters === null ? '' : ` · ${t('poll.voterLimit', { count: poll.maxVoters })}`;
  const deadline = poll.closesAt === null ? '' : ` · ${t('poll.closesAt', { time: formatTime(poll.closesAt) })}`;
  return `<section class="native-poll" data-native-poll-card="${escapeHtml(poll.id)}"
    data-poll-multiple="${poll.allowMultiple}" ${pending ? 'aria-busy="true"' : ''}>
    ${renderImageCarousel(poll.imageUrls, imageBaseUrl, poll.question)}
    <header class="native-poll-header">
      <span class="material-symbols-outlined md-20" aria-hidden="true">poll</span>
      <h3>${escapeHtml(poll.question)}</h3>
      ${poll.audience.visibility === 'private' ? `<span class="community-private-badge"><span class="material-symbols-outlined md-16">lock</span>${t('audience.privateBadge')}</span>` : ''}
      ${poll.anonymousVotes ? `<span class="community-private-badge native-poll-anonymous"><span class="material-symbols-outlined md-16" aria-hidden="true">visibility_off</span>${t('poll.anonymousBadge')}</span>` : ''}
      ${poll.liveAction ? `<span class="native-poll-live">${t('poll.liveAction')}</span>` : ''}
    </header>
    ${poll.allowMultiple ? `<p class="native-poll-hint">${t('poll.multipleAllowed')}</p>` : ''}
    <div class="native-poll-options">${answers}</div>
    <footer class="native-poll-footer">
      <span>${t(total === 1 ? 'poll.oneVote' : 'poll.voteCount', { count: total })}${limit}${deadline}</span>
      <span class="native-poll-footer-end">
        ${publicVotes ? `<button type="button" class="native-poll-view-votes" data-native-poll-voters="${escapeHtml(poll.id)}"
          ${options.preview ? 'disabled' : ''}><span class="material-symbols-outlined md-16" aria-hidden="true">groups</span>${t('poll.viewVotes')}</button>` : ''}
        <strong>${closed ? t('poll.closed') : t('poll.open')}</strong>
      </span>
    </footer>
  </section>`;
}

/**
 * Clicking an answer adds it to the member's vote and clicking it again removes it.
 * Single-answer polls swap to the newly clicked answer.
 */
export function nextNativePollSelection(poll: NativePoll, optionId: string): string[] {
  const current = poll.myVoteOptionIds ?? [];
  if (current.includes(optionId)) return current.filter(id => id !== optionId);
  return poll.allowMultiple ? [...current, optionId] : [optionId];
}

export async function submitNativePollVote(
  client: NetworkClient,
  pollId: string,
  optionIds: string[],
): Promise<NativePoll> {
  const result: unknown = await client.sendRequest(MessageType.POLL_VOTE, { id: pollId, optionIds });
  return nativePollSchema.parse(result);
}

/** The requester's current view of a poll, including the audience they are allowed to see. */
export async function fetchNativePoll(client: NetworkClient, pollId: string): Promise<NativePoll> {
  const result: unknown = await client.sendRequest(MessageType.POLL_GET, { id: pollId });
  return nativePollSchema.parse(result);
}

/** Re-rendering a poll replaces its buttons; this keeps keyboard focus on the same control. */
export function capturePollFocus(container: Element): string | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !container.contains(active)) return null;
  if (active.dataset.nativePollOption) return `[data-native-poll-option="${CSS.escape(active.dataset.nativePollOption)}"]`;
  if (active.dataset.nativePollVotersOption) {
    return `[data-native-poll-voters-option="${CSS.escape(active.dataset.nativePollVotersOption)}"]`;
  }
  return active.matches('.native-poll-view-votes') ? '.native-poll-view-votes' : null;
}

export function restorePollFocus(container: ParentNode, selector: string | null): void {
  if (selector) container.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true });
}

const barKey = (fill: HTMLElement) =>
  `${fill.closest<HTMLElement>('[data-native-poll-card]')?.dataset.nativePollCard ?? ''}\n${fill.dataset.nativePollFill ?? ''}`;

/** Bar fills as currently shown, including one still animating, so a re-render can move on from there. */
export function capturePollBars(container: ParentNode): Map<string, number> {
  const bars = new Map<string, number>();
  for (const fill of container.querySelectorAll<HTMLElement>('[data-native-poll-fill]')) {
    // The computed width ignores the scale transform, so the ratio is the visible fill.
    const width = Number.parseFloat(getComputedStyle(fill).width);
    if (width > 0) bars.set(barKey(fill), Math.round(fill.getBoundingClientRect().width / width * 10_000) / 10_000);
  }
  return bars;
}

/** Grows or shrinks each re-rendered bar from its previous fill. New polls and reduced motion appear at once. */
export function animatePollBars(container: ParentNode, previous: ReadonlyMap<string, number>): void {
  if (previous.size === 0 || reducedMotion()) return;
  const duration = motionDuration('panel');
  if (duration <= 0) return;
  for (const fill of container.querySelectorAll<HTMLElement>('[data-native-poll-fill]')) {
    const from = previous.get(barKey(fill));
    const to = Number(fill.dataset.share);
    if (from === undefined || !Number.isFinite(to) || Math.abs(from - to) < 0.001) continue;
    fill.animate([{ transform: `scaleX(${from})` }, { transform: `scaleX(${to})` }],
      { duration, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  }
}

export function openNativePollVoters(
  client: NetworkClient,
  poll: NativePoll,
  config: {
    optionId?: string;
    profile?: NativePollVoterProfile;
    /** Reloads the list when the poll changes while it is open. */
    subscribe?: (listener: (poll: NativePoll) => void) => () => void;
  } = {},
): ReturnType<typeof openCommunityModal> {
  const modal = openCommunityModal(t('poll.votesTitle'));
  const card = modal.element.querySelector<HTMLElement>('.community-modal');
  card?.classList.add('native-poll-voters-modal');
  const profile = config.profile ?? sameVoter;
  let current = poll;
  let request = 0;

  const render = (result: NativePollVoters) => {
    const voters = new Map(result.options.map(option => [option.id, option.voters]));
    modal.content.innerHTML = `<p class="native-poll-voters-question">${escapeHtml(current.question)}</p>
      <div class="native-poll-voters-list">${current.options.map(option => {
        const list = (voters.get(option.id) ?? []).map(profile);
        return `<section class="native-poll-voters-group" data-native-poll-voters-group="${escapeHtml(option.id)}">
          <h3>
            ${option.emoji ? `<span class="native-poll-voters-emoji" aria-hidden="true">${escapeHtml(option.emoji)}</span>` : ''}
            <span class="native-poll-voters-label">${escapeHtml(option.label)}</span>
            <span class="native-poll-voters-count">${t(list.length === 1 ? 'poll.oneVote' : 'poll.voteCount', { count: list.length })}</span>
          </h3>
          ${list.length ? `<ul>${list.map(voter => `<li data-native-poll-voter="${escapeHtml(voter.userId)}">
            <img src="${escapeHtml(getAvatarUrl(voter.userAvatarUrl))}" alt="" data-fallback="avatar">
            <span>${escapeHtml(voterName(voter))}</span></li>`).join('')}</ul>`
            : `<p class="native-poll-voters-empty">${t('poll.noVotersForOption')}</p>`}
        </section>`;
      }).join('')}</div>`;
  };

  const load = (initial: boolean) => {
    const id = ++request;
    if (initial) modal.content.innerHTML = renderLoadingSkeleton('lines', 4);
    void client.sendRequest(MessageType.POLL_VOTERS, { id: current.id })
      .then((result: unknown) => {
        if (modal.signal.aborted || id !== request) return;
        render(nativePollVotersSchema.parse(result));
        const target = initial && config.optionId ? modal.content.querySelector<HTMLElement>(
          `[data-native-poll-voters-group="${CSS.escape(config.optionId)}"]`) : null;
        if (card && target) scrollWithin(card, target, 12);
      })
      .catch((error: unknown) => {
        if (modal.signal.aborted || id !== request) return;
        // A failed refresh keeps the last complete list instead of replacing it with an error.
        if (!initial) { console.warn('[Poll] Could not refresh voters.', error); return; }
        modal.content.innerHTML = renderLoadingError(error instanceof Error ? error.message : t('poll.votersFailed'));
      });
  };

  modal.content.addEventListener('click', event => {
    if (event.target instanceof Element && event.target.closest('[data-loading-retry]')) load(true);
  }, { signal: modal.signal });
  const unsubscribe = config.subscribe?.(updated => {
    if (updated.id !== current.id || updated.revision <= current.revision) return;
    current = updated;
    load(false);
  });
  if (unsubscribe) modal.signal.addEventListener('abort', unsubscribe, { once: true });
  load(true);
  return modal;
}
