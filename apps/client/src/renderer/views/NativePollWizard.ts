import {
  LIMITS,
  MessageType,
  Permission,
  nativePollCreateSchema,
  type NativePoll,
  type NativePollCreate,
} from '@monky/shared';
import type { NetworkClient } from '../core/NetworkClient';
import type { ServerStore } from '../stores/serverStore';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { uploadCommunityImage } from '../utils/communityImages';
import { openCommunityModal } from './CommunityModal';
import { contextMenu } from './ContextMenu';
import { EmojiPicker } from './EmojiPicker';
import { cropDroppedImages, pickAndCropImages } from './ImageCropModal';
import { renderNativePoll } from './nativePoll';
import { imageCarouselNavigationButton, moveImageCarousel, renderImageCarouselEditor, renderImageDropzone } from './ImageCarousel';
import { ResourceAudiencePicker } from './ResourceAudiencePicker';
import { setButtonLoading } from '../utils/buttonLoading';

type PollOption = NativePollCreate['options'][number];
type DurationUnit = 'minutes' | 'hours' | 'days';

export function openNativePollWizard(
  client: NetworkClient,
  server: ServerStore,
  channelId: string,
  config: { liveAction?: boolean; lockLiveAction?: boolean } = {},
): ReturnType<typeof openCommunityModal> | undefined {
  if (!server.hasPermission(Permission.SEND_MESSAGES) ||
      !server.serverDetails?.protocol?.features.includes('native-polls')) return;
  const modal = openCommunityModal(t('poll.create'));
  modal.element.querySelector('.community-modal')?.classList.add('event-wizard', 'native-poll-wizard');
  const canLive = server.hasPermission(Permission.EMIT_LIVE_ACTIONS);
  let step = 0;
  let question = '';
  let options: PollOption[] = [{ label: '', emoji: null }, { label: '', emoji: null }];
  let allowMultiple = false;
  let imageAssetRefs: string[] = [];
  let imagePreviews: string[] = [];
  let imageIndex = 0;
  let duration = '24';
  let unit: DurationUnit = 'hours';
  let maxVoters = '';
  let liveAction = (config.liveAction ?? false) && server.communityEventsEnabled === true;
  let pending = false;
  let uploading = false;
  let emojiPicker: EmojiPicker | null = null;
  const messageId = crypto.randomUUID();
  const audience = new ResourceAudiencePicker(server, 'poll-audience');
  const liveActionHint = () => !canLive
    ? t('poll.liveActionPermission')
    : server.communityEventsEnabled === false
      ? t('poll.liveActionsDisabled')
      : server.communityEventsEnabled === null
        ? t('poll.liveActionsLoading')
        : t('poll.showLiveActionHint');
  const canEnableLiveAction = () => canLive && server.communityEventsEnabled === true;

  modal.content.innerHTML = `<div class="native-poll-wizard-shell">
    <nav class="community-steps native-poll-stepper" aria-label="${escapeHtml(t('poll.steps'))}">
      ${(['content', 'appearance', 'preview'] as const).map((name, index) =>
        `<span data-poll-stepper="${index}">${t(`poll.step.${name}`)}</span>`).join('')}
    </nav>
    <div class="native-poll-step-viewport" data-poll-step-viewport></div>
    <footer class="modal-footer event-wizard-footer" data-poll-footer></footer>
  </div>`;

  const viewport = modal.content.querySelector<HTMLElement>('[data-poll-step-viewport]')!;
  const footer = modal.content.querySelector<HTMLElement>('[data-poll-footer]')!;
  const closeEmojiPicker = () => { emojiPicker?.destroy(); emojiPicker = null; };
  const durationMinutes = () => Number(duration) * (unit === 'days' ? 1440 : unit === 'hours' ? 60 : 1);
  const payload = (): NativePollCreate => ({
    channelId,
    clientMessageId: messageId,
    question: question.trim(),
    options: options.map(option => ({ label: option.label.trim(), emoji: option.emoji })),
    allowMultiple,
    imageAssetRefs,
    ...(duration.trim() ? { durationMinutes: durationMinutes() } : {}),
    ...(maxVoters.trim() ? { maxVoters: Number(maxVoters) } : {}),
    liveAction,
    audience: audience.value(),
  });
  const isValid = () => audience.isValid() && nativePollCreateSchema.safeParse(payload()).success;
  const isContentValid = () => {
    const normalized = options.map(option => option.label.trim());
    return question.trim().length >= 1 && question.trim().length <= 200 &&
      normalized.length >= 2 && normalized.length <= 10 &&
      normalized.every(label => label.length >= 1 && label.length <= 80) &&
      new Set(normalized.map(label => label.toLocaleLowerCase())).size === normalized.length;
  };

  const capture = () => {
    if (step === 0) {
      question = viewport.querySelector<HTMLInputElement>('[data-poll-question]')?.value ?? question;
      options = [...viewport.querySelectorAll<HTMLInputElement>('[data-poll-option]')]
        .map((input, index) => ({ label: input.value, emoji: options[index]?.emoji ?? null }));
      allowMultiple = viewport.querySelector<HTMLInputElement>('[data-poll-multiple]')?.checked ?? allowMultiple;
    } else if (step === 1) {
      duration = viewport.querySelector<HTMLInputElement>('[data-poll-duration]')?.value ?? duration;
      unit = (viewport.querySelector<HTMLSelectElement>('[data-poll-unit]')?.value ?? unit) as DurationUnit;
      maxVoters = viewport.querySelector<HTMLInputElement>('[data-poll-limit]')?.value ?? maxVoters;
      liveAction = config.lockLiveAction ? canEnableLiveAction() :
        canEnableLiveAction() && (viewport.querySelector<HTMLInputElement>('[data-poll-live]')?.checked ?? liveAction);
    }
  };

  const emojiButtonContent = (emoji: string | null) => emoji
    ? `<span class="native-poll-option-emoji-value" aria-hidden="true">${escapeHtml(emoji)}</span>`
    : '<span class="material-symbols-outlined md-18" aria-hidden="true">mood</span>';
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
  const numberControl = (attribute: string, value: string, min: number, max: number, label: string) =>
    `<div class="native-poll-number-control">
      <input data-${attribute} class="native-poll-number-input" type="number" inputmode="numeric"
        min="${min}" max="${max}" value="${escapeHtml(value)}" aria-label="${escapeHtml(label)}"
        placeholder="${escapeHtml(t('poll.optional'))}" ${pending ? 'disabled' : ''}>
      <button type="button" data-poll-number-step="-1" aria-label="${escapeHtml(t('poll.decrement', { field: label }))}">
        <span class="material-symbols-outlined md-16">remove</span></button>
      <button type="button" data-poll-number-step="1" aria-label="${escapeHtml(t('poll.increment', { field: label }))}">
        <span class="material-symbols-outlined md-16">add</span></button>
    </div>`;

  const contentStep = () => `<section class="native-poll-step" data-poll-step="0">
    <div class="native-poll-step-heading"><span class="material-symbols-outlined">edit_note</span>
      <div><h2 tabindex="-1">${t('poll.step.content')}</h2><p>${t('poll.contentHint')}</p></div></div>
    <label>${t('poll.question')} <span class="required-indicator">*</span>
      <input class="input-field" data-poll-question maxlength="200" value="${escapeHtml(question)}"
        placeholder="${escapeHtml(t('poll.questionPlaceholder'))}" ${pending ? 'disabled' : ''}>
    </label>
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
      </div>`).join('')}
      <button type="button" class="btn btn-secondary native-poll-add-option" data-add-poll-option
        ${options.length >= 10 ? 'disabled' : ''}><span class="material-symbols-outlined md-18">add</span>${t('poll.addOption')}</button>
    </fieldset>
    <div class="bot-permission-row native-poll-multiple-row">
      <div><label for="native-poll-multiple">${t('poll.allowMultiple')}</label>
        <p class="bot-settings-description">${t('poll.allowMultipleHint')}</p></div>
      <label class="toggle-switch"><input id="native-poll-multiple" data-poll-multiple type="checkbox" role="switch"
        ${allowMultiple ? 'checked' : ''}><span class="toggle-slider"></span></label>
    </div>
  </section>`;

  const imageEditor = () => `<div class="native-poll-image-editor">
    <div class="native-poll-image-editor-heading"><div><strong>${t('poll.images')}</strong>
      <p>${t('poll.imagesHint')}</p></div><span>${imageAssetRefs.length}/${LIMITS.MAX_LIVE_ACTION_IMAGES}</span></div>
    ${imagePreviews.length ? renderImageCarouselEditor(imagePreviews, {
      label: t('poll.images'),
      addLabel: t(uploading ? 'poll.uploadingImage' : 'poll.addImage'),
      removeLabel: t('poll.removeImage'),
      moveBackLabel: t('poll.moveImageBack'),
      moveForwardLabel: t('poll.moveImageForward'),
      disabled: pending || uploading,
      addDisabled: imageAssetRefs.length >= LIMITS.MAX_LIVE_ACTION_IMAGES,
      initialIndex: imageIndex,
    }) : renderImageDropzone(uploading || imageAssetRefs.length >= LIMITS.MAX_LIVE_ACTION_IMAGES)}
  </div>`;

  const appearanceStep = () => `<section class="native-poll-step" data-poll-step="1">
    <div class="native-poll-step-heading"><span class="material-symbols-outlined">imagesmode</span>
      <div><h2 tabindex="-1">${t('poll.step.appearance')}</h2><p>${t('poll.appearanceHint')}</p></div></div>
    ${imageEditor()}
    <div class="native-poll-settings-grid">
      <label>${t('poll.duration')}${numberControl('poll-duration', duration, 1, unit === 'days' ? 30 : unit === 'hours' ? 720 : 43200, t('poll.duration'))}</label>
      <label>${t('poll.durationUnit')}<select class="input-field" data-poll-unit>
        ${(['minutes', 'hours', 'days'] as const).map(value =>
          `<option value="${value}" ${unit === value ? 'selected' : ''}>${t(`poll.${value}`)}</option>`).join('')}
      </select></label>
      <label>${t('poll.maxVoters')}${numberControl('poll-limit', maxVoters, 1, 10000, t('poll.maxVoters'))}</label>
    </div>
    <div class="bot-permission-row native-poll-live-row">
      <div><label for="native-poll-live">${t('poll.showLiveAction')}</label>
        <p class="bot-settings-description${server.communityEventsEnabled === false ? ' community-inline-warning' : ''}">${liveActionHint()}</p></div>
      <label class="toggle-switch"><input id="native-poll-live" data-poll-live type="checkbox" role="switch"
        ${liveAction ? 'checked' : ''} ${!canEnableLiveAction() || config.lockLiveAction ? 'disabled' : ''}><span class="toggle-slider"></span></label>
    </div>
    ${audience.render(pending || uploading)}
  </section>`;

  const previewPoll = (): NativePoll => ({
    id: 'preview',
    messageId,
    channelId,
    creatorUserId: 'preview',
    question: question.trim(),
    allowMultiple,
    imageUrls: imagePreviews,
    options: options.map((option, index) => ({ id: `preview-${index}`, ...option, votes: 0 })),
    totalVotes: 0,
    myVoteOptionIds: [],
    allowChange: true,
    closesAt: duration.trim() ? Date.now() + durationMinutes() * 60_000 : null,
    maxVoters: maxVoters.trim() ? Number(maxVoters) : null,
    closedAt: null,
    liveAction,
    createdAt: Date.now(),
    revision: 0,
    audience: audience.value(),
  });
  const previewStep = () => `<section class="native-poll-step native-poll-preview-step" data-poll-step="2">
    <div class="native-poll-step-heading"><span class="material-symbols-outlined">preview</span>
      <div><h2 tabindex="-1">${t('poll.step.preview')}</h2><p>${t('poll.previewHint')}</p></div></div>
    <div class="native-poll-preview-surface">${renderNativePoll(previewPoll(), false, value =>
      new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'short' }).format(value))}</div>
  </section>`;

  const addImages = (select: () => Promise<string[]>) => {
    if (uploading || imageAssetRefs.length >= LIMITS.MAX_LIVE_ACTION_IMAGES) return;
    uploading = true;
    render();
    setButtonLoading(viewport.querySelector<HTMLElement>('[data-carousel-edit="add"]'), true);
    void modal.run(async () => {
      try {
        const images = await select();
        for (const image of images) {
          if (modal.signal.aborted) return;
          const uploaded = await uploadCommunityImage(client, channelId, image);
          imageAssetRefs.push(uploaded.ref);
          imagePreviews.push(uploaded.url);
          imageIndex = imageAssetRefs.length - 1;
        }
      } finally {
        uploading = false;
        if (!modal.signal.aborted) render();
      }
    });
  };

  const render = (direction = 0, focusOption?: number) => {
    closeEmojiPicker();
    const stepper = modal.content.querySelector<HTMLElement>('.native-poll-stepper')!;
    stepper.style.setProperty('--event-step', String(step));
    for (const [index, item] of [...modal.content.querySelectorAll<HTMLElement>('[data-poll-stepper]')].entries()) {
      item.classList.toggle('is-active', index === step);
      item.classList.toggle('is-complete', index < step);
      item.setAttribute('aria-current', index === step ? 'step' : 'false');
    }
    viewport.classList.remove('native-poll-step-viewport--forward', 'native-poll-step-viewport--back');
    if (direction) viewport.classList.add(direction > 0 ? 'native-poll-step-viewport--forward' : 'native-poll-step-viewport--back');
    viewport.innerHTML = step === 0 ? contentStep() : step === 1 ? appearanceStep() : previewStep();
    audience.sync(viewport);
    footer.innerHTML = `${step > 0
      ? `<button type="button" class="btn btn-secondary" data-poll-back ${pending || uploading ? 'disabled' : ''}>${t('common.back')}</button>`
      : '<span class="event-footer-spacer"></span>'}
      <span class="event-footer-spacer"></span>
      <button type="button" class="btn btn-secondary" data-poll-cancel ${pending ? 'disabled' : ''}>${t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" ${step < 2 ? 'data-poll-next' : 'data-poll-submit'}
        ${pending || uploading || (step === 0 ? !isContentValid() : step === 1 ? !audience.isValid() : !isValid()) ? 'disabled' : ''}>
        ${t(step < 2 ? 'common.next' : 'poll.publish')}</button>`;
    const focus = focusOption === undefined
      ? viewport.querySelector<HTMLElement>('h2, [data-poll-question]')
      : viewport.querySelector<HTMLElement>(`[data-option-index="${focusOption}"]`);
    focus?.focus();
  };
  const syncValidity = () => {
    capture();
    const durationInput = viewport.querySelector<HTMLInputElement>('[data-poll-duration]');
    if (durationInput) durationInput.max = String(unit === 'days' ? 30 : unit === 'hours' ? 720 : 43200);
    const next = footer.querySelector<HTMLButtonElement>('[data-poll-next]');
    if (next) next.disabled = pending || uploading ||
      (step === 0 ? !isContentValid() : step === 1 && !audience.isValid());
  };
  audience.bind(viewport, modal.signal, syncValidity);
  const unbindCommunity = server.bus?.on?.('community.updated', () => {
    if (server.communityEventsEnabled !== true) liveAction = false;
    if (step === 1) {
      capture();
      render();
    }
  });
  modal.signal.addEventListener('abort', () => unbindCommunity?.(), { once: true });
  viewport.addEventListener('input', syncValidity, { signal: modal.signal });
  viewport.addEventListener('change', syncValidity, { signal: modal.signal });
  modal.content.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    const carouselButton = imageCarouselNavigationButton(target);
    if (carouselButton && moveImageCarousel(carouselButton)) {
      imageIndex = Number(carouselButton.closest<HTMLElement>('[data-image-carousel]')?.dataset.carouselIndex ?? 0);
      return;
    }
    if (target?.closest('[data-poll-cancel]')) { modal.close(); return; }
    if (target?.closest('[data-poll-back]') && step > 0) {
      capture();
      step--;
      render(-1);
      return;
    }
    if (target?.closest('[data-poll-next]') && step < 2) {
      capture();
      if ((step === 0 && !isContentValid()) || (step === 1 && !audience.isValid())) return;
      step++;
      render(1);
      return;
    }
    if (target?.closest('[data-add-poll-option]') && options.length < 10) {
      capture();
      options.push({ label: '', emoji: null });
      render(0, options.length - 1);
      return;
    }
    const remove = target?.closest<HTMLElement>('[data-remove-poll-option]')?.dataset.removePollOption;
    if (remove !== undefined && options.length > 2) {
      capture();
      options.splice(Number(remove), 1);
      render(0, Math.min(Number(remove), options.length - 1));
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
    const numberStep = target?.closest<HTMLButtonElement>('[data-poll-number-step]');
    if (numberStep) {
      const input = numberStep.closest('.native-poll-number-control')?.querySelector<HTMLInputElement>('input');
      if (!input) return;
      const delta = Number(numberStep.dataset.pollNumberStep);
      const current = input.valueAsNumber;
      if (!Number.isFinite(current) && delta < 0) return;
      input.value = String(Math.min(Number(input.max), Math.max(Number(input.min),
        Number.isFinite(current) ? current + delta : Number(input.min))));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.focus();
      return;
    }
    const imageAction = target?.closest<HTMLButtonElement>('[data-carousel-edit]');
    if (imageAction && imageAction.dataset.carouselEdit !== 'add') {
      const index = Number(imageAction.closest<HTMLElement>('[data-image-carousel]')?.dataset.carouselIndex ?? 0);
      const action = imageAction.dataset.carouselEdit;
      if (action === 'remove') {
        imageAssetRefs.splice(index, 1);
        imagePreviews.splice(index, 1);
        imageIndex = Math.min(index, Math.max(0, imageAssetRefs.length - 1));
      } else {
        const next = index + (action === 'back' ? -1 : action === 'forward' ? 1 : 0);
        if (next === index || next < 0 || next >= imageAssetRefs.length) return;
        [imageAssetRefs[index], imageAssetRefs[next]] = [imageAssetRefs[next], imageAssetRefs[index]];
        [imagePreviews[index], imagePreviews[next]] = [imagePreviews[next], imagePreviews[index]];
        imageIndex = next;
      }
      render();
      return;
    }
    if (imageAction?.dataset.carouselEdit === 'add') {
      addImages(() => pickAndCropImages(
        imageAction,
        LIMITS.MAX_LIVE_ACTION_IMAGES - imageAssetRefs.length,
        'banner',
      ));
      return;
    }
    if (!target?.closest('[data-poll-submit]') || pending) return;
    const parsed = nativePollCreateSchema.safeParse(payload());
    if (!parsed.success) { modal.fail(t('poll.invalid')); return; }
    pending = true;
    render();
    void modal.run(async () => {
      try {
        await client.sendRequest(MessageType.POLL_CREATE, parsed.data, messageId, 30_000);
        if (!modal.signal.aborted) modal.close();
      } catch (error) {
        pending = false;
        if (!modal.signal.aborted) render();
        throw error;
      }
    });
  }, { signal: modal.signal });
  modal.content.addEventListener('dragover', event => {
    const dropzone = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-carousel-dropzone]') : null;
    if (!dropzone || uploading) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    dropzone.classList.add('is-dragging');
  }, { signal: modal.signal });
  modal.content.addEventListener('dragleave', event => {
    const dropzone = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-carousel-dropzone]') : null;
    if (dropzone && (!event.relatedTarget || !dropzone.contains(event.relatedTarget as Node))) {
      dropzone.classList.remove('is-dragging');
    }
  }, { signal: modal.signal });
  modal.content.addEventListener('drop', event => {
    const dropzone = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-carousel-dropzone]') : null;
    if (!dropzone || uploading) return;
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
    const files = event.dataTransfer?.files;
    if (files?.length) {
      addImages(() => cropDroppedImages(files, LIMITS.MAX_LIVE_ACTION_IMAGES - imageAssetRefs.length, 'banner'));
    }
  }, { signal: modal.signal });
  modal.signal.addEventListener('abort', () => { closeEmojiPicker(); contextMenu.close(); }, { once: true });
  render();
  return modal;
}
