import { MessageType, nativePollSchema, type NativePoll } from '@monky/shared';
import type { NetworkClient } from '../core/NetworkClient';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { renderImageCarousel } from './ImageCarousel';

export function renderNativePoll(
  poll: NativePoll,
  canVote: boolean,
  formatTime: (value: number) => string,
  imageBaseUrl = '',
): string {
  const closed = poll.closedAt !== null || (poll.closesAt !== null && poll.closesAt <= Date.now());
  const total = Math.max(0, poll.totalVotes);
  const options = poll.options.map(option => {
    const selected = poll.myVoteOptionIds?.includes(option.id) ?? false;
    const percent = total > 0 ? option.votes / total * 100 : 0;
    return `<button type="button" class="native-poll-option${selected ? ' native-poll-option--selected' : ''}${option.emoji ? ' native-poll-option--emoji' : ''}"
      data-native-poll="${escapeHtml(poll.id)}" data-native-poll-option="${escapeHtml(option.id)}"
      aria-pressed="${selected}" ${closed || !canVote ? 'disabled' : ''}>
      <span class="native-poll-option-fill" style="width:${percent.toFixed(2)}%"></span>
      ${option.emoji ? `<span class="native-poll-option-emoji" aria-hidden="true">${escapeHtml(option.emoji)}</span>` : ''}
      <span class="native-poll-option-label">${escapeHtml(option.label)}</span>
      <span class="native-poll-option-result">${option.votes} · ${Math.round(percent)}%</span>
    </button>`;
  }).join('');
  const limit = poll.maxVoters === null ? '' : ` · ${t('poll.voterLimit', { count: poll.maxVoters })}`;
  const deadline = poll.closesAt === null ? '' : ` · ${t('poll.closesAt', { time: formatTime(poll.closesAt) })}`;
  return `<section class="native-poll" data-native-poll-card="${escapeHtml(poll.id)}" data-poll-multiple="${poll.allowMultiple}">
    ${renderImageCarousel(poll.imageUrls, imageBaseUrl, poll.question)}
    <header class="native-poll-header">
      <span class="material-symbols-outlined md-20" aria-hidden="true">poll</span>
      <h3>${escapeHtml(poll.question)}</h3>
      ${poll.audience.visibility === 'private' ? `<span class="community-private-badge"><span class="material-symbols-outlined md-16">lock</span>${t('audience.privateBadge')}</span>` : ''}
      ${poll.liveAction ? `<span class="native-poll-live">${t('poll.liveAction')}</span>` : ''}
    </header>
    ${poll.allowMultiple ? `<p class="native-poll-hint">${t('poll.multipleAllowed')}</p>` : ''}
    <div class="native-poll-options">${options}</div>
    ${poll.allowMultiple && !closed && canVote ? `<button type="button" class="btn btn-primary native-poll-confirm"
      data-native-poll-confirm="${escapeHtml(poll.id)}" ${poll.myVoteOptionIds?.length ? '' : 'disabled'}>
      ${t('poll.confirmAnswers')}</button>` : ''}
    <p class="native-poll-error" data-native-poll-error role="alert" hidden></p>
    <footer class="native-poll-footer">
      <span>${t(total === 1 ? 'poll.oneVote' : 'poll.voteCount', { count: total })}${limit}${deadline}</span>
      <strong>${closed ? t('poll.closed') : t('poll.open')}</strong>
    </footer>
  </section>`;
}

export async function submitNativePollVote(
  client: NetworkClient,
  pollId: string,
  optionIds: string[],
): Promise<NativePoll> {
  const result: unknown = await client.sendRequest(MessageType.POLL_VOTE, { id: pollId, optionIds });
  return nativePollSchema.parse(result);
}
