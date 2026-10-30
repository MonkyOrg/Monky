import {
  LIMITS,
  MessageType,
  PUBLIC_AUDIENCE,
  Permission,
  ProtocolErrorCode,
  nativePollCreateSchema,
  nativePollEditSchema,
  nativePollSchema,
  planNativePollEdit,
  type NativePoll,
  type NativePollCreate,
  type NativePollEdit,
  type ResourceAudience,
} from '@monky/shared';
import type { NetworkClient } from '../core/NetworkClient';
import type { ServerStore } from '../stores/serverStore';
import { getLanguage, t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { uploadCommunityImage } from '../utils/communityImages';
import { resolveAvatarUrl } from '../utils/avatar';
import { openCommunityModal, type CommunityModal } from './CommunityModal';
import { contextMenu } from './ContextMenu';
import { showConfirm } from './Dialog';
import { EmojiPicker } from './EmojiPicker';
import { cropDroppedImages, pickAndCropImages } from './ImageCropModal';
import { fetchNativePoll, renderNativePoll } from './nativePoll';
import {
  bindImageDropzone, editCarouselList, imageCarouselNavigationButton, moveImageCarousel, renderImageCarouselEditor,
  renderImageDropzone,
} from './ImageCarousel';
import { ResourceAudiencePicker } from './ResourceAudiencePicker';
import { setButtonLoading } from '../utils/buttonLoading';
import { mountWizard } from './community/wizardShell';
import {
  durationMinutes, isDurationUnit, longestDuration, renderDurationUnit, renderNumberControl, stepNumberControl,
  type DurationUnit,
} from './community/durationField';

type PollOption = NativePollCreate['options'][number] & { id?: string };
/** A kept image is its URL, a new upload its staged reference; the preview is what the editor shows. */
interface PollImage { source: string; preview: string }

/** Remaining time in the largest unit that keeps it readable; untouched, the deadline itself is kept. */
function remainingDuration(closesAt: number | null, now = Date.now()): { duration: string; unit: DurationUnit } {
  if (closesAt === null) return { duration: '', unit: 'hours' };
  const minutes = Math.max(1, Math.ceil((closesAt - now) / 60_000));
  if (minutes >= 2 * 1440) return { duration: String(Math.ceil(minutes / 1440)), unit: 'days' };
  if (minutes >= 120) return { duration: String(Math.ceil(minutes / 60)), unit: 'hours' };
  return { duration: String(minutes), unit: 'minutes' };
}

function editableAudience(audience: NativePoll['audience']): ResourceAudience {
  return audience.visibility === 'private'
    ? { visibility: 'private', userIds: audience.userIds ?? [], roleIds: audience.roleIds ?? [] }
    : PUBLIC_AUDIENCE;
}

export function openNativePollWizard(
  client: NetworkClient,
  server: ServerStore,
  channelId: string,
  config: {
    liveAction?: boolean;
    lockLiveAction?: boolean;
    /** Opens the same steps prefilled to change this open poll. */
    edit?: NativePoll;
    onSaved?: (poll: NativePoll) => void;
  } = {},
): CommunityModal | undefined {
  /** The poll as last reviewed; a conflict on save replaces it with the current state. */
  let edit = config.edit;
  const features = server.serverDetails?.protocol?.features ?? [];
  if (edit ? !features.includes('poll-edit')
    : !server.hasPermission(Permission.SEND_MESSAGES, channelId) || !features.includes('native-polls')) return;
  const modal = openCommunityModal(t(edit ? 'poll.editTitle' : 'poll.create'), { closeWithSession: true });
  modal.card.classList.add('event-wizard', 'native-poll-wizard');
  const canLive = server.hasPermission(Permission.EMIT_LIVE_ACTIONS, channelId);
  const initialDuration = edit ? remainingDuration(edit.closesAt) : { duration: '24', unit: 'hours' as DurationUnit };
  let question = edit?.question ?? '';
  let options: PollOption[] = edit
    ? edit.options.map(({ id, label, emoji }) => ({ id, label, emoji }))
    : [{ label: '', emoji: null }, { label: '', emoji: null }];
  let allowMultiple = edit?.allowMultiple ?? false;
  // Older servers reject the field and never reveal voters, so the choice only exists with poll-voters.
  const supportsVoters = features.includes('poll-voters');
  let anonymousVotes = edit?.anonymousVotes ?? false;
  const images: PollImage[] = edit
    ? edit.imageUrls.map(url => ({ source: url, preview: resolveAvatarUrl(url, client.getHttpBaseUrl()) }))
    : [];
  let imageIndex = 0;
  let duration = initialDuration.duration;
  let unit: DurationUnit = initialDuration.unit;
  let durationTouched = false;
  let maxVoters = edit?.maxVoters ? String(edit.maxVoters) : '';
  let liveAction = edit ? edit.liveAction : (config.liveAction ?? false) && server.communityEventsEnabled === true;
  let pending = false;
  let uploading = false;
  let emojiPicker: EmojiPicker | null = null;
  const messageId = crypto.randomUUID();
  const audience = new ResourceAudiencePicker(server, 'poll-audience', edit ? editableAudience(edit.audience) : undefined);
  const liveActionHint = () => !canLive
    ? t('poll.liveActionPermission')
    : server.communityEventsEnabled === false
      ? t('poll.liveActionsDisabled')
      : server.communityEventsEnabled === null
        ? t('poll.liveActionsLoading')
        : t('poll.showLiveActionHint');
  // An edit may always switch off a live action it already has; switching one on needs the permission.
  const canEnableLiveAction = () => (canLive && server.communityEventsEnabled === true) || edit?.liveAction === true;

  const closeEmojiPicker = () => { emojiPicker?.destroy(); emojiPicker = null; };
  const minutes = () => durationMinutes(duration, unit);
  const payload = (): NativePollCreate => ({
    channelId,
    clientMessageId: messageId,
    question: question.trim(),
    options: options.map(option => ({ label: option.label.trim(), emoji: option.emoji })),
    allowMultiple,
    ...(supportsVoters ? { anonymousVotes } : {}),
    imageAssetRefs: images.map(image => image.source),
    ...(duration.trim() ? { durationMinutes: minutes() } : {}),
    ...(maxVoters.trim() ? { maxVoters: Number(maxVoters) } : {}),
    liveAction,
    audience: audience.value(),
  });
  const editPayload = (poll: NativePoll): NativePollEdit => ({
    id: poll.id,
    expectedRevision: poll.revision,
    question: question.trim(),
    options: options.map(option => ({ ...(option.id ? { id: option.id } : {}), label: option.label.trim(), emoji: option.emoji })),
    allowMultiple,
    anonymousVotes,
    images: images.map(image => image.source),
    // Untouched, the original deadline stays exactly as it was.
    ...(durationTouched ? { durationMinutes: duration.trim() ? minutes() : null } : {}),
    maxVoters: maxVoters.trim() ? Number(maxVoters) : null,
    liveAction,
    audience: audience.value(),
  });
  const hasDeadlineOrLimit = () => maxVoters.trim() !== '' ||
    (edit && !durationTouched ? edit.closesAt !== null : duration.trim() !== '');
  const isValid = () => audience.isValid() && (edit
    ? hasDeadlineOrLimit() && nativePollEditSchema.safeParse(editPayload(edit)).success
    : nativePollCreateSchema.safeParse(payload()).success);
  const isContentValid = () => {
    const normalized = options.map(option => option.label.trim());
    return question.trim().length >= 1 && question.trim().length <= 200 &&
      normalized.length >= 2 && normalized.length <= 10 &&
      normalized.every(label => label.length >= 1 && label.length <= 80) &&
      new Set(normalized.map(label => label.toLocaleLowerCase())).size === normalized.length;
  };
  const editPlan = () => edit ? planNativePollEdit(edit, { question, allowMultiple, anonymousVotes, options }) : null;
  /** What saving discards, as the editor must be told before it happens. */
  const warningText = (key: string): string | null => {
    const plan = editPlan();
    if (!edit || !plan) return null;
    const hasVotes = edit.totalVotes > 0;
    if (key === 'question') return plan.resetAll === 'question' && hasVotes ? t('poll.editWarnQuestion') : null;
    if (key === 'anonymity') return plan.resetAll === 'anonymity' && hasVotes ? t('poll.editWarnAnonymity') : null;
    if (key === 'single') return plan.resetAll === null && plan.singleAnswer && hasVotes ? t('poll.editWarnSingle') : null;
    if (key === 'limit') {
      const voters = plan.resetAll ? 0 : edit.totalVotes;
      return maxVoters.trim() && Number(maxVoters) <= voters ? t('poll.editWarnLimit', { count: voters }) : null;
    }
    const option = key.startsWith('option-') ? options[Number(key.slice('option-'.length))] : undefined;
    const original = option?.id ? edit.options.find(entry => entry.id === option.id) : undefined;
    return original && original.votes > 0 && plan.resetAll === null && plan.relabeledOptionIds.includes(original.id)
      ? t(original.votes === 1 ? 'poll.editWarnOptionOne' : 'poll.editWarnOption', { count: original.votes }) : null;
  };
  const editLosses = (): string[] => {
    const plan = editPlan();
    if (!edit || !plan) return [];
    const losses = [warningText('question'), warningText('anonymity')];
    if (plan.resetAll === null) {
      for (const option of edit.options) {
        if (option.votes === 0) continue;
        if (plan.relabeledOptionIds.includes(option.id)) {
          losses.push(t('poll.editLossChanged', { option: option.label, count: option.votes }));
        } else if (plan.removedOptionIds.includes(option.id)) {
          losses.push(t('poll.editLossRemoved', { option: option.label, count: option.votes }));
        }
      }
      losses.push(warningText('single'));
    }
    losses.push(warningText('limit'));
    return losses.filter((loss): loss is string => loss !== null);
  };
  const warning = (key: string) => {
    const text = warningText(key);
    return `<p class="native-poll-edit-warning" data-poll-warning="${escapeHtml(key)}" role="status" ${text ? '' : 'hidden'}>
      <span class="material-symbols-outlined md-16" aria-hidden="true">warning</span>
      <span data-poll-warning-text>${escapeHtml(text ?? '')}</span></p>`;
  };

  const emojiButtonContent = (emoji: string | null) => emoji
    ? `<span class="native-poll-option-emoji-value" aria-hidden="true">${escapeHtml(emoji)}</span>`
    : '<span class="material-symbols-outlined md-18" aria-hidden="true">mood</span>';

  const contentStep = () => `<section class="native-poll-step" data-poll-step="0">
    <div class="native-poll-step-heading"><span class="material-symbols-outlined">edit_note</span>
      <div><h2 tabindex="-1">${t('poll.step.content')}</h2><p>${t('poll.contentHint')}</p></div></div>
    ${edit ? `<p class="native-poll-edit-notice" role="note"><span class="material-symbols-outlined md-18" aria-hidden="true">info</span>
      <span>${t('poll.editRules')}</span></p>` : ''}
    <label>${t('poll.question')} <span class="required-indicator">*</span>
      <input class="input-field" data-poll-question maxlength="200" value="${escapeHtml(question)}"
        placeholder="${escapeHtml(t('poll.questionPlaceholder'))}" ${pending ? 'disabled' : ''}>
    </label>
    ${edit ? warning('question') : ''}
    <fieldset class="native-poll-option-editor">
      <legend>${t('poll.options')}</legend>
      ${options.map((option, index) => `<div class="native-poll-option-row">
        <button type="button" class="native-poll-option-emoji-button${option.emoji ? ' native-poll-option-emoji-button--selected' : ''}"
          data-poll-emoji="${index}" aria-haspopup="${option.emoji ? 'menu' : 'dialog'}"
          aria-label="${escapeHtml(t(option.emoji ? 'poll.replaceEmoji' : 'poll.addEmoji'))}">
          ${emojiButtonContent(option.emoji)}</button>
        <input data-poll-option data-option-index="${index}" maxlength="80"
          aria-label="${escapeHtml(t('poll.optionNumber', { number: index + 1 }))}"
          value="${escapeHtml(option.label)}" placeholder="${escapeHtml(t('poll.optionPlaceholder'))}">
        <button type="button" class="native-poll-option-remove" data-remove-poll-option="${index}"
          aria-label="${escapeHtml(t('poll.removeOption'))}" ${options.length <= 2 ? 'disabled' : ''}>
          <span class="material-symbols-outlined md-18">delete</span></button>
      </div>${edit ? warning(`option-${index}`) : ''}`).join('')}
      <button type="button" class="btn btn-secondary native-poll-add-option" data-add-poll-option
        ${options.length >= 10 ? 'disabled' : ''}><span class="material-symbols-outlined md-18">add</span>${t('poll.addOption')}</button>
    </fieldset>
    <div class="native-poll-switch-list">
      <div class="bot-permission-row native-poll-multiple-row">
        <div><label for="native-poll-multiple">${t('poll.allowMultiple')}</label>
          <p class="bot-settings-description">${t('poll.allowMultipleHint')}</p></div>
        <label class="toggle-switch"><input id="native-poll-multiple" data-poll-multiple type="checkbox" role="switch"
          ${allowMultiple ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>
      ${edit ? warning('single') : ''}
      ${supportsVoters ? `<div class="bot-permission-row native-poll-anonymous-row">
        <div><label for="native-poll-anonymous">${t('poll.anonymousVotes')}</label>
          <p class="bot-settings-description">${t('poll.anonymousVotesHint')}</p></div>
        <label class="toggle-switch"><input id="native-poll-anonymous" data-poll-anonymous type="checkbox" role="switch"
          ${anonymousVotes ? 'checked' : ''}><span class="toggle-slider"></span></label>
      </div>` : ''}
      ${edit ? warning('anonymity') : ''}
    </div>
  </section>`;

  const imageEditor = () => `<div class="native-poll-image-editor">
    <div class="native-poll-image-editor-heading"><div><strong>${t('poll.images')}</strong>
      <p>${t('poll.imagesHint')}</p></div><span>${images.length}/${LIMITS.MAX_LIVE_ACTION_IMAGES}</span></div>
    ${images.length ? renderImageCarouselEditor(images.map(image => image.preview), {
      label: t('poll.images'),
      addLabel: t(uploading ? 'poll.uploadingImage' : 'poll.addImage'),
      removeLabel: t('poll.removeImage'),
      moveBackLabel: t('poll.moveImageBack'),
      moveForwardLabel: t('poll.moveImageForward'),
      disabled: pending || uploading,
      addDisabled: images.length >= LIMITS.MAX_LIVE_ACTION_IMAGES,
      initialIndex: imageIndex,
    }) : renderImageDropzone(uploading || images.length >= LIMITS.MAX_LIVE_ACTION_IMAGES)}
  </div>`;

  const formatDeadline = (value: number) =>
    new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'short', timeStyle: 'short' }).format(value);
  const appearanceStep = () => `<section class="native-poll-step" data-poll-step="1">
    <div class="native-poll-step-heading"><span class="material-symbols-outlined">imagesmode</span>
      <div><h2 tabindex="-1">${t('poll.step.appearance')}</h2><p>${t('poll.appearanceHint')}</p></div></div>
    ${imageEditor()}
    <div class="native-poll-settings-grid">
      <label>${t('poll.duration')}${renderNumberControl({
        hook: 'poll-duration', value: duration, min: 1, max: longestDuration(unit),
        label: t('poll.duration'), placeholder: t('poll.optional'), disabled: pending,
      })}</label>
      ${renderDurationUnit('poll-unit', unit)}
      <label>${t('poll.maxVoters')}${renderNumberControl({
        hook: 'poll-limit', value: maxVoters, min: 1, max: 10000,
        label: t('poll.maxVoters'), placeholder: t('poll.optional'), disabled: pending,
      })}</label>
    </div>
    ${edit ? `<p class="bot-settings-description native-poll-edit-duration">${edit.closesAt === null
      ? t('poll.editDurationHintOpen') : t('poll.editDurationHint', { time: formatDeadline(edit.closesAt) })}</p>
      ${warning('limit')}` : ''}
    <div class="bot-permission-row native-poll-live-row">
      <div><label for="native-poll-live">${t('poll.showLiveAction')}</label>
        <p class="bot-settings-description${server.communityEventsEnabled === false ? ' community-inline-warning' : ''}">${liveActionHint()}</p></div>
      <label class="toggle-switch"><input id="native-poll-live" data-poll-live type="checkbox" role="switch"
        ${liveAction ? 'checked' : ''} ${!canEnableLiveAction() || config.lockLiveAction ? 'disabled' : ''}><span class="toggle-slider"></span></label>
    </div>
    ${audience.render(pending || uploading)}
  </section>`;

  const previewPoll = (): NativePoll => {
    const plan = editPlan();
    // Answers whose votes survive the edit keep their counts in the preview.
    const surviving = (id: string | undefined) => edit && plan && id && plan.resetAll === null &&
      !plan.relabeledOptionIds.includes(id) ? edit.options.find(option => option.id === id) : undefined;
    return {
      id: edit?.id ?? 'preview',
      messageId: edit?.messageId ?? messageId,
      channelId,
      creatorUserId: edit?.creatorUserId ?? 'preview',
      question: question.trim(),
      allowMultiple,
      imageUrls: images.map(image => image.preview),
      options: options.map((option, index) => {
        const previous = surviving(option.id);
        return {
          id: option.id ?? `preview-${index}`, label: option.label, emoji: option.emoji, votes: previous?.votes ?? 0,
          ...(supportsVoters && !anonymousVotes ? { voters: previous?.voters ?? [] } : {}),
        };
      }),
      totalVotes: edit && plan?.resetAll === null ? edit.totalVotes : 0,
      myVoteOptionIds: [],
      ...(supportsVoters ? { anonymousVotes } : {}),
      allowChange: true,
      closesAt: edit && !durationTouched ? edit.closesAt
        : duration.trim() ? Date.now() + minutes() * 60_000 : null,
      maxVoters: maxVoters.trim() ? Number(maxVoters) : null,
      closedAt: null,
      liveAction,
      createdAt: edit?.createdAt ?? Date.now(),
      revision: edit?.revision ?? 0,
      audience: audience.value(),
    };
  };
  const previewStep = () => {
    const losses = editLosses();
    return `<section class="native-poll-step native-poll-preview-step" data-poll-step="2">
    <div class="native-poll-step-heading"><span class="material-symbols-outlined">preview</span>
      <div><h2 tabindex="-1">${t('poll.step.preview')}</h2><p>${t('poll.previewHint')}</p></div></div>
    ${edit ? `<div class="native-poll-edit-summary${losses.length ? ' native-poll-edit-summary--loss' : ''}" role="status">
      <span class="material-symbols-outlined md-18" aria-hidden="true">${losses.length ? 'warning' : 'check_circle'}</span>
      ${losses.length ? `<div><strong>${t('poll.editSummaryTitle')}</strong>
        <ul>${losses.map(loss => `<li>${escapeHtml(loss)}</li>`).join('')}</ul></div>`
        : `<p>${t('poll.editKeepsVotes')}</p>`}
    </div>` : ''}
    <div class="native-poll-preview-surface">${renderNativePoll(previewPoll(), false, value =>
      new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(value),
      '', { preview: true })}</div>
  </section>`;
  };

  const wizard = mountWizard(modal, {
    name: 'poll',
    label: t('poll.steps'),
    stepperClass: 'native-poll-stepper',
    viewportClass: 'native-poll-step-viewport',
    steps: [
      { label: t('poll.step.content'), render: contentStep },
      { label: t('poll.step.appearance'), render: appearanceStep },
      { label: t('poll.step.preview'), render: previewStep },
    ],
    submitLabel: () => t(edit ? 'poll.saveChanges' : 'poll.publish'),
    capture: () => capture(),
    ready: step => step === 0 ? isContentValid() : step === 1 ? audience.isValid() : isValid(),
    pending: () => pending,
    busy: () => uploading,
    submit: () => submit(),
    drawn: () => {
      closeEmojiPicker();
      audience.sync(viewport);
    },
  });
  const { viewport } = wizard;

  const capture = () => {
    if (wizard.step === 0) {
      question = viewport.querySelector<HTMLInputElement>('[data-poll-question]')?.value ?? question;
      options = [...viewport.querySelectorAll<HTMLInputElement>('[data-poll-option]')]
        .map((input, index) => ({
          ...(options[index]?.id ? { id: options[index].id } : {}),
          label: input.value,
          emoji: options[index]?.emoji ?? null,
        }));
      allowMultiple = viewport.querySelector<HTMLInputElement>('[data-poll-multiple]')?.checked ?? allowMultiple;
      anonymousVotes = viewport.querySelector<HTMLInputElement>('[data-poll-anonymous]')?.checked ?? anonymousVotes;
    } else if (wizard.step === 1) {
      duration = viewport.querySelector<HTMLInputElement>('[data-poll-duration]')?.value ?? duration;
      const chosen = viewport.querySelector<HTMLSelectElement>('[data-poll-unit]')?.value;
      if (isDurationUnit(chosen)) unit = chosen;
      maxVoters = viewport.querySelector<HTMLInputElement>('[data-poll-limit]')?.value ?? maxVoters;
      liveAction = config.lockLiveAction ? canEnableLiveAction() :
        canEnableLiveAction() && (viewport.querySelector<HTMLInputElement>('[data-poll-live]')?.checked ?? liveAction);
    }
  };
  const syncWarnings = () => {
    for (const element of viewport.querySelectorAll<HTMLElement>('[data-poll-warning]')) {
      const text = warningText(element.dataset.pollWarning ?? '');
      const label = element.querySelector<HTMLElement>('[data-poll-warning-text]');
      if (text && label && label.textContent !== text) label.textContent = text;
      setSurfaceVisible(element, text !== null);
    }
  };
  const syncValidity = () => {
    capture();
    syncWarnings();
    const durationInput = viewport.querySelector<HTMLInputElement>('[data-poll-duration]');
    if (durationInput) durationInput.max = String(longestDuration(unit));
    wizard.sync();
  };

  const updateEmojiButton = (index: number) => {
    const button = viewport.querySelector<HTMLButtonElement>(`[data-poll-emoji="${index}"]`);
    if (!button) return;
    const emoji = options[index]?.emoji ?? null;
    button.innerHTML = emojiButtonContent(emoji);
    button.classList.toggle('native-poll-option-emoji-button--selected', emoji !== null);
    button.setAttribute('aria-haspopup', emoji ? 'menu' : 'dialog');
    button.setAttribute('aria-label', t(emoji ? 'poll.replaceEmoji' : 'poll.addEmoji'));
  };
  const openEmojiPicker = (button: HTMLElement, index: number) => {
    closeEmojiPicker();
    emojiPicker = new EmojiPicker({
      container: document.body,
      anchor: button,
      emojiOnly: true,
      floating: true,
      onSelectEmoji: emoji => {
        capture();
        options[index].emoji = emoji;
        updateEmojiButton(index);
        closeEmojiPicker();
      },
    });
    void emojiPicker.open();
  };

  const addImages = (select: () => Promise<string[]>) => {
    if (uploading || images.length >= LIMITS.MAX_LIVE_ACTION_IMAGES) return;
    uploading = true;
    wizard.redraw();
    setButtonLoading(viewport.querySelector<HTMLElement>('[data-carousel-edit="add"]'), true);
    void modal.run(async () => {
      try {
        for (const image of await select()) {
          if (modal.signal.aborted) return;
          const uploaded = await uploadCommunityImage(client, channelId, image);
          images.push({ source: uploaded.ref, preview: uploaded.url });
          imageIndex = images.length - 1;
        }
      } finally {
        uploading = false;
        if (!modal.signal.aborted) wizard.redraw();
      }
    });
  };

  const submit = () => {
    if (pending) return;
    if (edit) {
      const base = edit;
      const parsed = nativePollEditSchema.safeParse(editPayload(base));
      if (!parsed.success || !hasDeadlineOrLimit()) { modal.fail(t('poll.invalid')); return; }
      const losses = editLosses();
      void modal.run(async () => {
        if (losses.length && !await showConfirm({
          title: t('poll.editConfirmTitle'),
          message: losses.join('\n'),
          confirmLabel: t('poll.saveChanges'),
          variant: 'warning',
          signal: modal.signal,
        })) return;
        if (modal.signal.aborted || pending) return;
        pending = true;
        wizard.sync();
        try {
          const saved = nativePollSchema.parse(await client.sendRequest(MessageType.POLL_EDIT, parsed.data, undefined, 30_000));
          config.onSaved?.(saved);
          if (!modal.signal.aborted) modal.close();
        } catch (error) {
          // Votes arrived or the poll changed since it was reviewed: show the current effects before saving again.
          const conflict = error instanceof Error && 'code' in error && error.code === ProtocolErrorCode.COMMUNITY_CONFLICT;
          const fresh = conflict ? await fetchNativePoll(client, base.id).catch(() => undefined) : undefined;
          if (fresh) {
            edit = fresh;
            options = options.map(option => option.id && !fresh.options.some(entry => entry.id === option.id)
              ? { label: option.label, emoji: option.emoji } : option);
          }
          pending = false;
          if (!modal.signal.aborted) wizard.redraw();
          throw fresh ? new Error(t('poll.editChanged')) : error;
        }
      });
      return;
    }
    const parsed = nativePollCreateSchema.safeParse(payload());
    if (!parsed.success) { modal.fail(t('poll.invalid')); return; }
    pending = true;
    wizard.sync();
    void modal.run(async () => {
      try {
        await client.sendRequest(MessageType.POLL_CREATE, parsed.data, messageId, 30_000);
        if (!modal.signal.aborted) modal.close();
      } catch (error) {
        pending = false;
        if (!modal.signal.aborted) wizard.sync();
        throw error;
      }
    });
  };

  audience.bind(viewport, modal.signal, syncValidity);
  let eventsEnabled = server.communityEventsEnabled;
  const unbindCommunity = server.bus?.on?.('community.updated', () => {
    // Only whether live actions exist matters here; anything else must not interrupt typing.
    if (server.communityEventsEnabled === eventsEnabled) return;
    eventsEnabled = server.communityEventsEnabled;
    if (server.communityEventsEnabled !== true) liveAction = false;
    if (wizard.step === 1) {
      capture();
      wizard.redraw();
    }
  });
  modal.signal.addEventListener('abort', () => unbindCommunity?.(), { once: true });
  const markDuration = (event: Event) => {
    if (event.target instanceof Element && event.target.matches('[data-poll-duration], [data-poll-unit]')) durationTouched = true;
  };
  viewport.addEventListener('input', markDuration, { signal: modal.signal });
  viewport.addEventListener('change', markDuration, { signal: modal.signal });
  viewport.addEventListener('input', syncValidity, { signal: modal.signal });
  viewport.addEventListener('change', syncValidity, { signal: modal.signal });
  viewport.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const carouselButton = imageCarouselNavigationButton(target);
    if (carouselButton && moveImageCarousel(carouselButton)) {
      imageIndex = Number(carouselButton.closest<HTMLElement>('[data-image-carousel]')?.dataset.carouselIndex ?? 0);
      return;
    }
    if (target?.closest('[data-add-poll-option]') && options.length < 10) {
      capture();
      options.push({ label: '', emoji: null });
      wizard.redraw(`[data-option-index="${options.length - 1}"]`);
      return;
    }
    const remove = target?.closest<HTMLElement>('[data-remove-poll-option]')?.dataset.removePollOption;
    if (remove !== undefined && options.length > 2) {
      capture();
      options.splice(Number(remove), 1);
      wizard.redraw(`[data-option-index="${Math.min(Number(remove), options.length - 1)}"]`);
      return;
    }
    const emojiButton = target?.closest<HTMLButtonElement>('[data-poll-emoji]');
    if (emojiButton) {
      const index = Number(emojiButton.dataset.pollEmoji);
      capture();
      if (!options[index]?.emoji) openEmojiPicker(emojiButton, index);
      else {
        const rect = emojiButton.getBoundingClientRect();
        contextMenu.open(rect.left, rect.bottom + 4, [
          { label: t('poll.replaceEmoji'), icon: 'mood', onClick: () => openEmojiPicker(emojiButton, index) },
          {
            label: t('poll.removeEmoji'), icon: 'delete', danger: true,
            onClick: () => { options[index].emoji = null; updateEmojiButton(index); },
          },
        ], emojiButton);
      }
      return;
    }
    if (stepNumberControl(target)) return;
    const imageAction = target?.closest<HTMLButtonElement>('[data-carousel-edit]');
    if (imageAction?.dataset.carouselEdit === 'add') {
      addImages(() => pickAndCropImages(imageAction, LIMITS.MAX_LIVE_ACTION_IMAGES - images.length, 'banner'));
      return;
    }
    if (imageAction) {
      const index = Number(imageAction.closest<HTMLElement>('[data-image-carousel]')?.dataset.carouselIndex ?? 0);
      const shown = editCarouselList(images, index, imageAction.dataset.carouselEdit);
      if (shown === null) return;
      imageIndex = shown;
      wizard.redraw();
    }
  }, { signal: modal.signal });
  bindImageDropzone(viewport, modal.signal, {
    disabled: () => uploading,
    drop: files => addImages(() => cropDroppedImages(files, LIMITS.MAX_LIVE_ACTION_IMAGES - images.length, 'banner')),
  });
  modal.signal.addEventListener('abort', () => { closeEmojiPicker(); contextMenu.close(); }, { once: true });
  wizard.start();
  return modal;
}
