import { LIMITS, MessageType, Permission, eventSaveSchema, eventTimeInZone, type EventSave, type ServerEventPublic } from '@monky/shared';
import type { CommunityFeed } from '../core/CommunityFeed';
import { getLanguage, t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { dateFieldValue, formatCalendarValue, todayCalendarValue } from '../utils/calendarDate';
import { motionDuration, reducedMotion } from '../utils/surfaceMotion';
import { cancelVisibilityMotion, setSurfaceVisible } from '../utils/surfaceVisibility';
import { smoothScrollIntoView } from '../utils/scroll';
import { openCommunityModal } from './CommunityModal';
import { cropDroppedImageEntries, openImageCropper, pickAndCropImageEntries, type CroppedImage } from './ImageCropModal';
import { imageCarouselNavigationButton, moveImageCarousel, renderImageCarouselEditor, renderImageDropzone } from './ImageCarousel';
import { renderServerEventCard } from './ServerEventCard';
import { ResourceAudiencePicker } from './ResourceAudiencePicker';
import { showErrorToast } from './CopyToast';

function inputTime(timestamp: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp);
  const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

export function openServerEventWizard(feed: CommunityFeed, existing?: ServerEventPublic): ReturnType<typeof openCommunityModal> | undefined {
  const canManageExisting = () => !!existing && (
    existing.creatorUserId === feed.server.currentUser?.id ||
    feed.server.hasPermission(Permission.MANAGE_SERVER) ||
    feed.server.hasPermission(Permission.MANAGE_EVENTS, existing.location.kind === 'external' ? undefined : existing.location.channelId)
  );
  const canCreate = () => feed.server.hasPermission(Permission.MANAGE_EVENTS) ||
    !!feed.server.serverDetails?.channels.some(channel => !channel.forumId &&
      (channel.type === 'TEXT' || channel.type === 'VOICE') && feed.server.hasPermission(Permission.MANAGE_EVENTS, channel.id));
  if (existing ? !canManageExisting() : !canCreate()) return;
  const modal = openCommunityModal(t(existing ? 'community.edit' : 'community.newEvent'));
  modal.element.querySelector('.community-modal')?.classList.add('event-wizard', 'server-event-wizard');
  const channels = () => feed.server.serverDetails?.channels.filter((channel) =>
    !channel.forumId && (channel.type === 'VOICE' || channel.type === 'TEXT') &&
    (existing && existing.location.kind !== 'external' && existing.location.channelId === channel.id && canManageExisting() ||
      feed.server.hasPermission(Permission.MANAGE_EVENTS, channel.id))) ?? [];
  let step = 0;
  let locationChosen = !!existing;
  const existingImageSources = existing
    ? existing.imageUrls?.length ? [...existing.imageUrls] : existing.imageUrl ? [existing.imageUrl] : []
    : [];
  const existingImages: CroppedImage[] = existingImageSources.map(source => ({ original: source, cropped: source }));
  let images: CroppedImage[] | undefined;
  let imageIndex = Math.max(0, existingImageSources.length - 1);
  let saving = false;
  let transitioning = false;
  let renderedStep = -1;
  let transitionRevision = 0;
  let animations: Animation[] = [];
  const audience = new ResourceAudiencePicker(feed.server, 'event-audience', existing?.audience?.visibility === 'private' &&
    existing.audience.userIds && existing.audience.roleIds
    ? { visibility: 'private', userIds: existing.audience.userIds, roleIds: existing.audience.roleIds }
    : { visibility: 'public' }, 'below');
  const draft: EventSave = existing ? {
    id: existing.id, expectedRevision: existing.revision, title: existing.title, description: existing.description,
    location: existing.location, startsAt: existing.startsAt, endsAt: existing.endsAt,
    repeat: existing.repeat, timeZone: existing.timeZone,
  } : {
    title: '', description: '', location: { kind: 'voice', channelId: '' },
    startsAt: Date.now() + 3_600_000, endsAt: Date.now() + 7_200_000, repeat: 'none',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
  let starts = inputTime(draft.startsAt, draft.timeZone);
  let ends = inputTime(draft.endsAt ?? draft.startsAt + 3_600_000, draft.timeZone);
  let endDate = ends.split('T')[0] || todayCalendarValue();
  let endTime = ends.split('T')[1] ?? '';
  let scheduleExpanded = false;
  const currentImages = () => images ?? existingImages;
  const currentImageSources = () => currentImages().map(image => image.cropped);
  const imagePreviews = () => currentImageSources().map(source =>
    source.startsWith('/avatars/') ? feed.client.getHttpBaseUrl() + source : source);
  const imageOriginalPreview = (image: CroppedImage) => image.original.startsWith('/avatars/')
    ? feed.client.getHttpBaseUrl() + image.original
    : image.original;
  const mutableImages = () => images ??= existingImages.map(image => ({ ...image }));
  const imageSources = () => images?.map(image => image.cropped);
  const selectedChannel = () => channels().find(channel => draft.location.kind !== 'external'
    && channel.id === draft.location.channelId && channel.type === (draft.location.kind === 'voice' ? 'VOICE' : 'TEXT'));
  modal.content.innerHTML = `<nav class="community-steps" aria-label="${escapeHtml(t('community.newEvent'))}">
    ${(['location', 'details', 'review'] as const).map(name => `<span>${escapeHtml(t(`community.${name}`))}</span>`).join('')}
    </nav><div class="event-step-viewport"></div>
    <footer class="modal-footer event-wizard-footer">
      <button type="button" class="btn btn-secondary" data-action="back">${t('community.previous')}</button>
      <span class="event-footer-spacer"></span><button type="button" class="btn btn-secondary" data-action="cancel">${t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" data-action="next"></button>
    </footer>`;
  const viewport = modal.content.querySelector<HTMLElement>('.event-step-viewport')!;
  const steps = modal.content.querySelector<HTMLElement>('.community-steps')!;
  const expandSchedule = (details: HTMLDetailsElement, expanded: boolean) => {
    animations.forEach(animation => animation.finish());
    scheduleExpanded = expanded;
    const content = details.querySelector<HTMLElement>('.event-schedule-body')!;
    details.querySelector('summary')!.setAttribute('aria-expanded', String(expanded));
    if (expanded) details.open = true;
    setSurfaceVisible(content, expanded, 'panel', undefined, () => { details.open = false; });
  };
  const clearInvalid = () => {
    viewport.querySelectorAll<HTMLElement>('[data-event-invalid]').forEach(element => {
      delete element.dataset.eventInvalid;
      element.removeAttribute('aria-invalid');
    });
  };
  const showInvalid = (message: string, selectors: string[]) => {
    clearInvalid();
    showErrorToast(message);
    const targets = selectors
      .map(selector => viewport.querySelector<HTMLElement>(selector))
      .filter((target): target is HTMLElement => !!target);
    const disclosure = targets[0]?.closest<HTMLDetailsElement>('.event-schedule-options');
    if (disclosure && !disclosure.open) expandSchedule(disclosure, true);
    for (const target of targets) {
      target.dataset.eventInvalid = '';
      target.setAttribute('aria-invalid', 'true');
    }
    const focusTarget = targets.find(target => !target.hasAttribute('disabled'));
    focusTarget?.focus({ preventScroll: true });
    if (focusTarget) smoothScrollIntoView(focusTarget, { block: 'center' });
  };
  const validateLocation = (): boolean => {
    if (!locationChosen) {
      showInvalid(t('community.locationRequired'), ['.community-location-cards']);
      return false;
    }
    if (draft.location.kind === 'external' && !draft.location.label.trim()) {
      showInvalid(t('community.locationRequired'), ['[data-input=location]']);
      return false;
    }
    if (draft.location.kind !== 'external' && !selectedChannel()) {
      showInvalid(t('community.selectChannel'), ['[data-input=channel]']);
      return false;
    }
    return true;
  };
  const validateDetails = (): boolean => {
    if (!draft.title.trim()) {
      showInvalid(t('community.titleRequired'), ['[data-input=title]']);
      return false;
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: draft.timeZone }).format();
    } catch {
      showInvalid(t('community.timeZoneInvalid'), ['[data-input=zone]']);
      return false;
    }
    let startsAt: number;
    try {
      startsAt = eventTimeInZone(starts, draft.timeZone);
    } catch {
      showInvalid(t('community.futureRequired'), ['[data-input=start-date]', '[data-input=start-time]']);
      return false;
    }
    if (!existing && startsAt <= Date.now()) {
      showInvalid(t('community.futureRequired'), ['[data-input=start-date]', '[data-input=start-time]']);
      return false;
    }
    if (!endDate || !endTime) {
      showInvalid(t('community.endRequired'), ['[data-input=end-date]', '[data-input=end-time]']);
      return false;
    }
    let endsAt: number;
    try {
      endsAt = eventTimeInZone(`${endDate}T${endTime}`, draft.timeZone);
    } catch {
      showInvalid(t('community.endRequired'), ['[data-input=end-date]', '[data-input=end-time]']);
      return false;
    }
    if (endsAt <= startsAt) {
      showInvalid(t('community.endAfterStart'), ['[data-input=end-date]', '[data-input=end-time]']);
      return false;
    }
    if (!audience.isValid()) {
      showInvalid(t('audience.empty'), ['[data-audience-toggle]']);
      return false;
    }
    draft.startsAt = startsAt;
    draft.endsAt = endsAt;
    draft.audience = audience.value();
    if (!eventSaveSchema.safeParse({ ...draft, imageSources: imageSources() }).success) {
      showInvalid(t('community.scheduleInvalid'), ['[data-input=title]']);
      return false;
    }
    return true;
  };
  const channelOptions = () => `<option value="" disabled hidden>${escapeHtml(t('community.selectChannel'))}</option>${channels()
    .filter(channel => draft.location.kind !== 'external' && channel.type === (draft.location.kind === 'voice' ? 'VOICE' : 'TEXT'))
    .map(channel => `<option value="${escapeHtml(channel.id)}" data-icon="${channel.type === 'VOICE' ? 'volume_up' : 'tag'}"
      ${selectedChannel()?.id === channel.id ? 'selected' : ''}>${escapeHtml(channel.name)}</option>`).join('')}`;
  const render = () => {
    const location = draft.location.kind === 'external' ? draft.location.label : selectedChannel()?.name ?? '';
    const scheduleOpen = scheduleExpanded;
    const body = document.createElement('section');
    body.className = 'event-step-body';
    body.dataset.eventStep = String(step);
    body.innerHTML = `${step === 0 ? `<h2 tabindex="-1">${t('community.locationTitle')}</h2><p class="event-wizard-hint">${t('community.locationHint')}</p>
        <div class="community-location-cards">${(['channel', 'external'] as const).map(kind => `
          <button class="event-location-option" type="button" data-location="${kind}" aria-pressed="${locationChosen && (kind === 'channel' ? draft.location.kind !== 'external' : draft.location.kind === 'external')}">
            <span class="material-symbols-outlined md-22">${kind === 'channel' ? 'forum' : 'location_on'}</span>
            <span><strong>${t(`community.${kind}`)}</strong><small>${t(kind === 'channel' ? 'community.channelHint' : 'community.externalHint')}</small></span>
            <span class="material-symbols-outlined md-18 event-location-selected">check_circle</span>
          </button>`).join('')}</div>
        ${!locationChosen ? '' : draft.location.kind !== 'external' ? `<div class="event-channel-types" role="group" aria-label="${escapeHtml(t('community.channelType'))}">
          ${(['voice', 'text'] as const).map(kind => `<button type="button" class="event-channel-type" data-channel-type="${kind}" aria-pressed="${draft.location.kind === kind}">
            <span class="material-symbols-outlined md-18" aria-hidden="true">${kind === 'voice' ? 'volume_up' : 'tag'}</span>${t(`community.${kind}`)}</button>`).join('')}
          </div><label for="event-select-channel">${t('community.selectChannel')} <span class="required-indicator">*</span>
          <select id="event-select-channel" class="input-field" data-input="channel" required
            data-search-placeholder="${escapeHtml(t('community.searchChannels'))}" data-empty-label="${escapeHtml(t('community.noChannels'))}">
            ${channelOptions()}</select></label>
          <p class="event-wizard-hint event-private-hint">${t('community.privateHint')}</p>` :
          `<label>${t('community.externalLabel')}<input class="input-field" data-input="location" maxlength="500" placeholder="${escapeHtml(t('community.externalPlaceholder'))}" value="${escapeHtml(draft.location.label)}"></label>`}` : ''}
      ${step === 1 ? `<h2 tabindex="-1">${t('community.detailsTitle')}</h2><p class="event-wizard-hint">${t('community.detailsHint')}</p>
        <label>${t('community.title')} <span class="required-indicator">*</span><input class="input-field" data-input="title" maxlength="100" required placeholder="${escapeHtml(t('community.detailsTitle'))}" value="${escapeHtml(draft.title)}"></label>
        <div class="event-date-time">
          <label>${t('community.startDate')} <span class="required-indicator">*</span><input class="input-field" data-input="start-date" data-picker-only data-date-picker data-date-value="${escapeHtml(starts.split('T')[0])}" type="text" readonly required value="${escapeHtml(formatCalendarValue(starts.split('T')[0], getLanguage()))}" ${existing?.status === 'active' ? 'disabled' : ''}></label>
          <label>${t('community.startTime')} <span class="required-indicator">*</span><input class="input-field" data-input="start-time" data-picker-only type="time" readonly required value="${escapeHtml(starts.split('T')[1])}" ${existing?.status === 'active' ? 'disabled' : ''}></label>
        </div>
        <div class="event-date-time event-end-date-time">
          <label>${t('community.endDate')} <span class="required-indicator">*</span><input class="input-field" data-input="end-date" data-picker-only data-date-picker data-date-value="${escapeHtml(endDate)}" type="text" readonly required value="${escapeHtml(formatCalendarValue(endDate, getLanguage()))}"></label>
          <label>${t('community.endTime')} <span class="required-indicator">*</span><input class="input-field" data-input="end-time" data-picker-only type="time" readonly required value="${escapeHtml(endTime)}"></label>
        </div>
        <label>${t('community.repeat')}<select class="input-field" data-input="repeat">
          ${(['none', 'daily', 'weekly', 'monthly'] as const).map((value) =>
            `<option value="${value}" ${value === draft.repeat ? 'selected' : ''}>${t(`community.${value}`)}</option>`).join('')}</select></label>
        <label>${t('community.description')}<textarea class="input-field" data-input="description" maxlength="4000">${escapeHtml(draft.description)}</textarea></label>
        <section class="event-cover-field native-poll-image-editor"><div class="native-poll-image-editor-heading">
          <div><strong>${t('community.coverLabel')}</strong><p class="event-wizard-hint">${t('community.coverHint')}</p></div>
          <span>${currentImageSources().length}/${LIMITS.MAX_LIVE_ACTION_IMAGES}</span></div>
          ${currentImageSources().length
            ? renderImageCarouselEditor(imagePreviews(), {
                label: t('community.coverLabel'),
                addLabel: t('community.chooseImage'),
                removeLabel: t('community.removeImage'),
                adjustLabel: t('crop.title'),
                moveBackLabel: t('poll.moveImageBack'),
                moveForwardLabel: t('poll.moveImageForward'),
                addDisabled: currentImageSources().length >= LIMITS.MAX_LIVE_ACTION_IMAGES,
                initialIndex: imageIndex,
              })
            : renderImageDropzone()}
        </section>
        <details class="event-schedule-options" ${scheduleOpen ? 'open' : ''}><summary aria-expanded="${scheduleOpen}">${t('community.timeZone')}</summary>
          <div class="event-schedule-body" ${scheduleOpen ? '' : 'hidden'}>
          <label>${t('community.timeZone')}<input class="input-field" data-input="zone" maxlength="100" value="${escapeHtml(draft.timeZone)}"></label>
          </div>
        </details>
        ${audience.render(saving)}` : ''}
      ${step === 2 ? `${renderServerEventCard({ ...draft, audience: audience.value(), id: draft.id ?? 'preview', status: existing?.status ?? 'scheduled', interestedCount: existing?.interestedCount ?? 0 }, location, imagePreviews())}
        <div class="event-review-explanation"><h2 tabindex="-1">${t('community.previewTitle')}</h2><p class="event-wizard-hint">${t('community.automatic')}</p></div>` : ''}`;
    const select = body.querySelector<HTMLSelectElement>('[data-input=channel]');
    if (select) select.value = selectedChannel()?.id ?? '';
    const old = viewport.firstElementChild;
    const changed = renderedStep >= 0 && renderedStep !== step;
    const direction = step > renderedStep ? 1 : -1;
    const revision = ++transitionRevision;
    animations.forEach(animation => animation.cancel());
    animations = [];
    viewport.querySelectorAll<HTMLElement>('.event-schedule-body').forEach(cancelVisibilityMotion);
    transitioning = changed && !reducedMotion();
    viewport.replaceChildren(body);
    if (transitioning && old instanceof HTMLElement) {
      old.inert = true;
      old.setAttribute('aria-hidden', 'true');
      old.classList.add('event-step-outgoing');
      viewport.append(old);
      const options: KeyframeAnimationOptions = { duration: motionDuration('step'), easing: 'cubic-bezier(0.2, 0, 0, 1)', fill: 'both' };
      animations = [
        body.animate([{ transform: `translateX(${direction * 100}%)`, opacity: 0 }, { transform: 'translateX(0)', opacity: 1 }], options),
        old.animate([{ transform: 'translateX(0)', opacity: 1 }, { transform: `translateX(${-direction * 100}%)`, opacity: 0 }], options),
      ];
      const complete = () => {
        if (revision !== transitionRevision) return;
        old.remove();
        animations.forEach(animation => animation.cancel());
        animations = [];
        transitioning = false;
        if (!modal.signal.aborted) sync();
      };
      void Promise.all(animations.map(animation => animation.finished)).then(complete, complete);
    }
    renderedStep = step;
    audience.sync(viewport);
    steps.style.setProperty('--event-step', String(step));
    [...steps.children].forEach((item, index) => {
      if (index === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    const back = modal.content.querySelector<HTMLButtonElement>('[data-action=back]')!;
    back.hidden = step === 0;
    modal.content.querySelector<HTMLElement>('[data-action=next]')!.textContent = t(step === 2 ? existing ? 'common.save' : 'community.newEvent' : 'community.next');
    sync();
  };
  const sync = () => {
    const next = modal.content.querySelector<HTMLButtonElement>('[data-action=next]');
    if (next) next.disabled = saving || transitioning;
    modal.content.querySelector<HTMLButtonElement>('[data-action=back]')!.disabled = saving || transitioning;
  };
  audience.bind(viewport, modal.signal, () => { clearInvalid(); sync(); });
  modal.content.addEventListener('input', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement)) return;
    clearInvalid();
    switch (target.dataset.input) {
      case 'title': draft.title = target.value; break;
      case 'description': draft.description = target.value; break;
      case 'location': draft.location = { kind: 'external', label: target.value }; break;
      case 'channel': {
        const channel = channels().find(channel => channel.id === target.value);
        if (channel && draft.location.kind !== 'external' && channel.type === (draft.location.kind === 'voice' ? 'VOICE' : 'TEXT')) {
          draft.location = { kind: draft.location.kind, channelId: channel.id };
        }
        break;
      }
      case 'start-date': starts = `${dateFieldValue(target as HTMLInputElement)}T${starts.split('T')[1] ?? ''}`; break;
      case 'start-time': starts = `${starts.split('T')[0]}T${target.value}`; break;
      case 'end-date':
        endDate = dateFieldValue(target as HTMLInputElement); ends = endDate && endTime ? `${endDate}T${endTime}` : ''; break;
      case 'end-time':
        endTime = target.value; ends = endDate && endTime ? `${endDate}T${endTime}` : ''; break;
      case 'zone': draft.timeZone = target.value; break;
      case 'repeat':
        if (target.value === 'none' || target.value === 'daily' || target.value === 'weekly' || target.value === 'monthly') draft.repeat = target.value;
        break;
    }
    sync();
  }, { signal: modal.signal });
  modal.content.addEventListener('click', (event) => {
    if (event.target instanceof Element && event.target.closest('[data-resource-audience]')) return;
    const summary = event.target instanceof Element ? event.target.closest('.event-schedule-options > summary') : null;
    if (summary?.parentElement instanceof HTMLDetailsElement) {
      event.preventDefault();
      expandSchedule(summary.parentElement, summary.getAttribute('aria-expanded') !== 'true');
      return;
    }
    const carouselButton = imageCarouselNavigationButton(event.target);
    if (carouselButton && moveImageCarousel(carouselButton)) {
      imageIndex = Number(carouselButton.closest<HTMLElement>('[data-image-carousel]')?.dataset.carouselIndex ?? 0);
      return;
    }
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || saving || button.disabled || (transitioning && button.dataset.action !== 'cancel')) return;
    clearInvalid();
    void modal.run(async () => {
      modal.clearError();
      const imageAction = button.dataset.carouselEdit;
      if (imageAction === 'add') {
        const selected = await pickAndCropImageEntries(
          button,
          LIMITS.MAX_LIVE_ACTION_IMAGES - currentImageSources().length,
          'banner',
        );
        if (modal.signal.aborted || selected.length === 0) return;
        const draftImages = mutableImages();
        draftImages.push(...selected);
        imageIndex = draftImages.length - 1;
      } else if (imageAction === 'adjust') {
        const draftImages = mutableImages();
        const selected = draftImages[imageIndex];
        if (!selected) return;
        const adjusted = await openImageCropper(imageOriginalPreview(selected), 'banner');
        if (modal.signal.aborted || adjusted === null) return;
        selected.cropped = adjusted;
      } else if (imageAction === 'remove') {
        const draftImages = mutableImages();
        draftImages.splice(imageIndex, 1);
        imageIndex = Math.min(imageIndex, Math.max(0, draftImages.length - 1));
      } else if (imageAction === 'back' || imageAction === 'forward') {
        const draftImages = mutableImages();
        const next = imageIndex + (imageAction === 'back' ? -1 : 1);
        if (next < 0 || next >= draftImages.length) return;
        [draftImages[imageIndex], draftImages[next]] = [draftImages[next], draftImages[imageIndex]];
        imageIndex = next;
      } else if (button.dataset.location === 'channel') { locationChosen = true; if (draft.location.kind === 'external') draft.location = { kind: 'voice', channelId: '' }; }
      else if (button.dataset.location === 'external') { locationChosen = true; if (draft.location.kind !== 'external') draft.location = { kind: 'external', label: '' }; }
      else if (button.dataset.channelType === 'voice' || button.dataset.channelType === 'text') {
        if (draft.location.kind !== button.dataset.channelType) draft.location = { kind: button.dataset.channelType, channelId: '' };
      }
      else if (button.dataset.action === 'cancel') { modal.close(); return; }
      else if (button.dataset.action === 'back') step--;
      else if (button.dataset.action === 'next') {
        if (step === 0) {
          if (!validateLocation()) return;
          step++;
        } else if (step === 1 && !validateDetails()) {
          return;
        } else if (step === 1) step++;
        else {
          saving = true;
          render();
          try {
            await feed.client.sendRequest(MessageType.EVENT_SAVE, {
              ...draft,
              audience: audience.value(),
              imageSources: imageSources(),
            });
            modal.close();
          } finally { saving = false; if (!modal.signal.aborted) render(); }
          return;
        }
      }
      if (!modal.signal.aborted) {
        render();
        viewport.querySelector<HTMLElement>('h2, input, select, button')?.focus({ preventScroll: true });
      }
    });
  }, { signal: modal.signal });
  modal.content.addEventListener('dragover', event => {
    const dropzone = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-carousel-dropzone]') : null;
    if (!dropzone) return;
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
    if (!dropzone || !event.dataTransfer?.files.length) return;
    event.preventDefault();
    dropzone.classList.remove('is-dragging');
    const files = event.dataTransfer.files;
    void modal.run(async () => {
      const selected = await cropDroppedImageEntries(
        files,
        LIMITS.MAX_LIVE_ACTION_IMAGES - currentImageSources().length,
        'banner',
      );
      if (modal.signal.aborted || selected.length === 0) return;
      const draftImages = mutableImages();
      draftImages.push(...selected);
      imageIndex = draftImages.length - 1;
      render();
    });
  }, { signal: modal.signal });
  const unsubscribe = feed.subscribe(() => {
    if (!feed.snapshot || (existing ? !canManageExisting() : !canCreate())) modal.close(true);
    else {
      const select = viewport.querySelector<HTMLSelectElement>('[data-input=channel]');
      if (select) {
        if (draft.location.kind !== 'external' && !selectedChannel()) draft.location = { kind: draft.location.kind, channelId: '' };
        select.innerHTML = channelOptions();
        select.value = selectedChannel()?.id ?? '';
      }
      sync();
    }
  });
  modal.signal.addEventListener('abort', unsubscribe, { once: true });
  modal.signal.addEventListener('abort', () => {
    transitionRevision++;
    animations.forEach(animation => animation.cancel());
    animations = [];
    viewport.querySelectorAll<HTMLElement>('.event-schedule-body').forEach(cancelVisibilityMotion);
  }, { once: true });
  window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
    if (event.matches) animations.forEach(animation => animation.finish());
  }, { signal: modal.signal });
  render();
  modal.content.querySelector<HTMLElement>('[data-location]')?.focus();
  return modal;
}
