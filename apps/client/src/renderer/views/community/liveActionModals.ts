import {
  MessageType, Permission, survivingNativePollSelection, type LiveAction, type NativeLiveForm, type NativePoll,
} from '@monky/shared';
import { getLanguage, t } from '../../i18n';
import { reportError } from '../../utils/feedback';
import { html } from '../../utils/html';
import { renderKeyedList } from '../../utils/keyedList';
import type { CommunityModal } from '../CommunityModal';
import { contextMenu } from '../ContextMenu';
import { showInfoToast } from '../CopyToast';
import { showConfirm } from '../Dialog';
import { imageCarouselNavigationButton, imageCarouselPresentationClass, moveImageCarousel } from '../ImageCarousel';
import { openNativeLiveFormWizard } from '../NativeLiveFormWizard';
import { openNativePollWizard } from '../NativePollWizard';
import {
  animatePollBars, capturePollBars, capturePollFocus, fetchNativePoll, isNativePollClosed, nativePollVoterProfile,
  nextNativePollSelection, openNativePollVoters, renderNativePoll, restorePollFocus, submitNativePollVote,
} from '../nativePoll';
import { canCreateLiveAction, canManageLiveItem, liveActionChannels } from './communityAccess';
import { assetUrl, followFeed, keepPlace, type CommunityContext } from './communityContext';
import { renderLiveItemCard } from './communityMarkup';
import { openBotLiveAction, openNativeFormResponse } from './liveFormModal';
import { openNativeFormResults } from './nativeFormResults';

/** Ends a live action, poll or form for everyone, after asking; the dialog it was chosen from closes. */
function closeLiveItem(modal: CommunityModal, button: HTMLButtonElement, close: () => Promise<unknown>): void {
  if (button.disabled || modal.signal.aborted || !button.isConnected) return;
  button.disabled = true;
  void modal.run(async () => {
    try {
      if (!await showConfirm({
        message: t('community.confirmCloseLiveAction'),
        confirmLabel: t('community.closeLiveAction'),
        variant: 'danger',
        signal: modal.signal,
      })) return;
      await close();
      if (!modal.signal.aborted) {
        showInfoToast(t('community.liveActionClosed'));
        modal.close();
      }
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  });
}

function canEditPoll(ctx: CommunityContext, poll: NativePoll): boolean {
  const { server } = ctx.feed;
  return !isNativePollClosed(poll) && server.serverDetails?.protocol?.features.includes('poll-edit') === true &&
    (server.currentUser?.id === poll.creatorUserId || server.hasPermission(Permission.MANAGE_SERVER));
}

function editPoll(ctx: CommunityContext, poll: NativePoll): void {
  const { feed } = ctx;
  // The snapshot may be a refresh behind; edit from the current poll so warnings use real counts.
  void fetchNativePoll(feed.client, poll.id).then(current => {
    if (isNativePollClosed(current)) return;
    ctx.track(openNativePollWizard(feed.client, feed.server, current.channelId, { edit: current }));
  }, (error: unknown) => reportError(error instanceof Error ? error.message : t('poll.editLoadFailed')));
}

/** The server's running live actions, polls and forms, with a way to start one. */
export function openActions(ctx: CommunityContext): void {
  const { feed } = ctx;
  const { server } = feed;
  const modal = ctx.modal(t('community.liveActions'));
  modal.card.classList.add('event-list-modal', 'live-action-list-modal');
  const header = modal.card.querySelector('.modal-header');
  if (canCreateLiveAction(server) && header) {
    const create = document.createElement('button');
    create.className = 'btn btn-primary';
    create.dataset.createLiveAction = '';
    create.textContent = t('liveAction.create');
    header.insertBefore(create, header.querySelector('[data-community-close]'));
    create.addEventListener('click', () => openCreateLiveAction(ctx), { signal: modal.signal });
  }
  let shown: string | null = null;
  const render = () => {
    const actions = feed.snapshot?.liveActions ?? [];
    const polls = feed.snapshot?.polls ?? [];
    const forms = feed.snapshot?.nativeForms ?? [];
    const count = actions.length + polls.length + forms.length;
    const heading = String(html`<span class="material-symbols-outlined md-24" aria-hidden="true">bolt</span>${t(count === 1 ? 'community.oneLiveAction' : 'community.liveActionCount', { count })}`);
    const channel = (id: string) => server.getChannel(id)?.name ?? '';
    const items = count ? [
      ...actions.map(action => ({ key: `action:${action.id}`, html: String(renderLiveItemCard({
        item: 'data-live-action-card', open: 'data-live-action', menu: canManageLiveItem(server, action) ? 'action' : null,
        id: action.id, kind: t('community.liveActions'), title: action.title, summary: action.description,
        channel: channel(action.channelId), private: action.audience.visibility === 'private',
        image: action.imageUrls[0]
          ? { url: assetUrl(feed, action.imageUrls[0]), className: imageCarouselPresentationClass(action.imagePresentation) }
          : undefined,
      })) })),
      ...polls.map(poll => ({ key: `poll:${poll.id}`, html: String(renderLiveItemCard({
        item: 'data-live-poll-card', open: 'data-live-poll', menu: canManageLiveItem(server, poll) ? 'poll' : null,
        id: poll.id, kind: t('poll.liveAction'), title: poll.question,
        summary: t(poll.totalVotes === 1 ? 'poll.oneVote' : 'poll.voteCount', { count: poll.totalVotes }),
        channel: channel(poll.channelId), private: poll.audience.visibility === 'private',
        image: poll.imageUrls[0] ? { url: assetUrl(feed, poll.imageUrls[0]) } : undefined,
      })) })),
      ...forms.map(form => ({ key: `form:${form.id}`, html: String(renderLiveItemCard({
        item: 'data-native-live-form-card', open: 'data-native-live-form', menu: canManageLiveItem(server, form) ? 'form' : null,
        id: form.id, kind: t('liveForm.kind'), title: form.form.title,
        summary: form.form.description ?? t('liveForm.noDescription'),
        channel: channel(form.channelId), private: form.audience.visibility === 'private',
      })) })),
    ] : [{ key: 'empty', html: `<div class="community-empty live-action-empty">
      <span class="material-symbols-outlined">bolt</span>
      <h2>${t('community.emptyActions')}</h2>
      <p>${t('community.emptyActionsHint')}</p>
    </div>` }];
    // A vote changes one card's count: only that card is rebuilt, and every other one
    // keeps its focus and its open menu.
    const markup = heading + items.map((item) => item.html).join('');
    if (markup === shown) return;
    shown = markup;
    const title = modal.card.querySelector('.modal-title');
    if (title) title.innerHTML = heading;
    keepPlace(modal, () => renderKeyedList(modal.content, items));
  };
  modal.content.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const menuButton = target?.closest<HTMLButtonElement>('[data-live-action-menu]');
    if (menuButton) {
      const rect = menuButton.getBoundingClientRect();
      const close = { label: t('community.closeLiveAction'), danger: true };
      if (menuButton.dataset.liveActionMenu === 'action') {
        const id = menuButton.closest<HTMLElement>('[data-live-action-card]')?.dataset.liveActionCard;
        const action = feed.snapshot?.liveActions.find(entry => entry.id === id);
        if (action) contextMenu.open(rect.left, rect.bottom, [{
          ...close,
          onClick: () => closeLiveItem(modal, menuButton,
            () => feed.client.sendRequest(MessageType.LIVE_ACTION_CLOSE, { id: action.id })),
        }], menuButton);
      } else if (menuButton.dataset.liveActionMenu === 'poll') {
        const id = menuButton.closest<HTMLElement>('[data-live-poll-card]')?.dataset.livePollCard;
        const poll = (feed.snapshot?.polls ?? []).find(entry => entry.id === id);
        if (poll) contextMenu.open(rect.left, rect.bottom, [
          ...(canEditPoll(ctx, poll) ? [{ label: t('poll.edit'), icon: 'edit', onClick: () => editPoll(ctx, poll) }] : []),
          {
            ...close,
            onClick: () => closeLiveItem(modal, menuButton,
              () => feed.client.sendRequest(MessageType.POLL_CLOSE, { id: poll.id })),
          },
        ], menuButton);
      } else {
        const id = menuButton.closest<HTMLElement>('[data-native-live-form-card]')?.dataset.nativeLiveFormCard;
        const form = (feed.snapshot?.nativeForms ?? []).find(entry => entry.id === id);
        if (form) contextMenu.open(rect.left, rect.bottom, [{
          label: t('liveForm.viewResults', { count: form.responseCount }),
          onClick: () => openNativeFormResults(ctx, form),
        }, {
          ...close,
          onClick: () => closeLiveItem(modal, menuButton,
            () => feed.client.sendRequest(MessageType.NATIVE_FORM_CLOSE, { id: form.id })),
        }], menuButton);
      }
      return;
    }
    const id = target?.closest<HTMLElement>('[data-live-action]')?.dataset.liveAction;
    const action = feed.snapshot?.liveActions.find((entry) => entry.id === id);
    if (action) void openBotLiveAction(ctx, action);
    const pollId = target?.closest<HTMLElement>('[data-live-poll]')?.dataset.livePoll;
    const poll = (feed.snapshot?.polls ?? []).find(entry => entry.id === pollId);
    if (poll) openPollAction(ctx, poll);
    const formId = target?.closest<HTMLElement>('[data-native-live-form]')?.dataset.nativeLiveForm;
    const form = (feed.snapshot?.nativeForms ?? []).find(entry => entry.id === formId);
    if (form) openNativeFormResponse(ctx, form);
  }, { signal: modal.signal });
  followFeed(feed, modal, render);
  render();
}

/** Picks the channel and the kind of a new live action, then opens its wizard. */
function openCreateLiveAction(ctx: CommunityContext): void {
  const { feed } = ctx;
  const { server } = feed;
  const modal = ctx.modal(t('liveAction.create'));
  modal.card.classList.add('live-action-create-modal');
  const channels = liveActionChannels(server);
  const features = server.serverDetails?.protocol?.features ?? [];
  const canPoll = channels.some(channel => server.hasPermission(Permission.SEND_MESSAGES, channel.id)) &&
    features.includes('native-polls');
  const canForm = features.includes('native-live-forms');
  modal.content.innerHTML = String(html`<p class="event-wizard-hint">${t('liveAction.createHint')}</p>
    <label>${t('liveAction.channel')}<select class="input-field" data-live-action-channel>
      ${channels.map(channel => html`<option value="${channel.id}">${channel.name}</option>`)}
    </select></label>
    <div class="live-action-type-grid">
      ${canPoll ? html`<button type="button" class="live-action-type-card" data-live-action-type="poll">
        <span class="material-symbols-outlined">poll</span><strong>${t('liveAction.poll')}</strong>
        <small>${t('liveAction.pollHint')}</small></button>` : ''}
      ${canForm ? html`<button type="button" class="live-action-type-card" data-live-action-type="form">
        <span class="material-symbols-outlined">dynamic_form</span><strong>${t('liveAction.form')}</strong>
        <small>${t('liveAction.formHint')}</small></button>` : ''}
    </div>`);
  if (channels.length === 0) modal.fail(t('liveAction.noChannels'));
  modal.content.addEventListener('click', event => {
    const type = event.target instanceof Element
      ? event.target.closest<HTMLElement>('[data-live-action-type]')?.dataset.liveActionType : undefined;
    if (!type) return;
    const channelId = modal.content.querySelector<HTMLSelectElement>('[data-live-action-channel]')?.value;
    if (!channelId) { modal.fail(t('liveAction.noChannels')); return; }
    if (!server.hasPermission(Permission.EMIT_LIVE_ACTIONS, channelId) ||
        type === 'poll' && !server.hasPermission(Permission.SEND_MESSAGES, channelId)) {
      modal.fail(t('protocolError.permissionDenied'));
      return;
    }
    modal.close(true);
    queueMicrotask(() => {
      ctx.track(type === 'poll'
        ? openNativePollWizard(feed.client, server, channelId, { liveAction: true, lockLiveAction: true })
        : openNativeLiveFormWizard(feed.client, server, channelId));
    });
  }, { signal: modal.signal });
}

/** A poll shown as a live action: vote, see who voted, follow the results. */
export function openPollAction(ctx: CommunityContext, initial: NativePoll): void {
  const { feed } = ctx;
  const modal = ctx.modal(t('poll.liveAction'));
  modal.card.classList.add('event-detail-modal', 'live-action-detail-modal');
  let poll = initial;
  let pendingSelection: string[] | undefined;
  const formatTime = (value: number) => new Intl.DateTimeFormat(getLanguage(), {
    dateStyle: 'short', timeStyle: 'short',
  }).format(value);
  const profile = () => nativePollVoterProfile(feed.server.knownMembers);
  const snapshotPoll = () => (feed.snapshot?.polls ?? []).find(entry => entry.id === poll.id);
  let shown: string | null = null;
  const render = () => {
    const markup = renderNativePoll(
      poll,
      feed.server.hasPermission(Permission.SEND_MESSAGES, poll.channelId),
      formatTime,
      feed.client.getHttpBaseUrl(),
      { pendingSelection, profile: profile() },
    );
    // Snapshots for other items arrive too; only a real change replaces the buttons.
    if (markup === shown) return;
    shown = markup;
    const focused = capturePollFocus(modal.content);
    const bars = capturePollBars(modal.content);
    modal.content.innerHTML = markup;
    restorePollFocus(modal.content, focused);
    animatePollBars(modal.content, bars);
  };
  modal.content.addEventListener('click', event => {
    const carouselButton = imageCarouselNavigationButton(event.target);
    if (carouselButton && moveImageCarousel(carouselButton)) return;
    const target = event.target instanceof Element ? event.target : null;
    const voters = target?.closest<HTMLButtonElement>('[data-native-poll-voters]');
    if (voters) {
      if (!voters.disabled) {
        openNativePollVoters(feed.client, poll, {
          optionId: voters.dataset.nativePollVotersOption,
          profile: profile(),
          subscribe: listener => feed.subscribe(() => {
            const current = snapshotPoll();
            if (current) listener(current);
          }),
        });
      }
      return;
    }
    const button = target?.closest<HTMLButtonElement>('[data-native-poll][data-native-poll-option]');
    const optionId = button?.dataset.nativePollOption;
    if (!button || !optionId || button.disabled || pendingSelection) return;
    const optionIds = nextNativePollSelection(poll, optionId);
    if (optionIds.length === 0 && !feed.server.serverDetails?.protocol?.features.includes('poll-voters')) {
      showInfoToast(t('poll.withdrawRequiresUpdate'));
      return;
    }
    pendingSelection = optionIds;
    render();
    void submitNativePollVote(feed.client, poll.id, optionIds)
      .then(
        updated => { if (updated.revision >= poll.revision) poll = updated; },
        (error: unknown) => {
          if (!modal.signal.aborted) reportError(error instanceof Error ? error.message : t('poll.voteFailed'));
        },
      )
      .finally(() => {
        pendingSelection = undefined;
        if (!modal.signal.aborted) render();
      });
  }, { signal: modal.signal });
  followFeed(feed, modal, () => {
    const current = snapshotPoll();
    if (!current) { modal.close(true); return; }
    if (current.revision < poll.revision) return;
    poll = current.myVoteOptionIds === null && poll.myVoteOptionIds !== null
      ? { ...current, myVoteOptionIds: survivingNativePollSelection(current, poll.myVoteOptionIds) }
      : current;
    render();
  });
  render();
}

/** Opens the item a banner shows: a bot's live action, a poll or a form. */
export function openLiveItem(ctx: CommunityContext, item: { action?: LiveAction; poll?: NativePoll; form?: NativeLiveForm }): void {
  if (item.action) void openBotLiveAction(ctx, item.action);
  if (item.poll) openPollAction(ctx, item.poll);
  if (item.form) openNativeFormResponse(ctx, item.form);
}
