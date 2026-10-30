import {
  MessageType, botSelectorPublicSchema, nativeLiveFormSchema, validateBotFormValues, validateNativeLiveFormValues,
  type LiveAction, type NativeLiveForm,
} from '@monky/shared';
import { audioPreviewService } from '../../core/AudioPreviewService';
import { getLanguage, t } from '../../i18n';
import { botInputError, convertBotInputValues, initialBotInputValues } from '../../utils/botInputs';
import { escapeHtml } from '../../utils/html';
import { preserveViewState } from '../../utils/preserveViewState';
import { scrollWithin } from '../../utils/scroll';
import { addBotFieldImage, applyBotFieldAction, chooseBotFieldValue, readBotFieldChange, renderBotFields } from '../botFields';
import { showInfoToast } from '../CopyToast';
import { imageCarouselNavigationButton, moveImageCarousel, renderImageCarousel } from '../ImageCarousel';
import { PublicSelectorView } from '../PublicSelectorView';
import { followFeed, type CommunityContext } from './communityContext';
import { privateBadge } from './communityMarkup';

/** Each question of a form; see `preserveViewState`. */
const QUESTION_ITEMS = ['data-field-name'];

/** Answers a native form, or changes the answers already sent. */
export function openNativeFormResponse(ctx: CommunityContext, initial: NativeLiveForm): void {
  const { feed } = ctx;
  const modal = ctx.modal(initial.form.title);
  modal.card.classList.add('event-wizard', 'live-action-wizard', 'native-live-form-action-modal');
  let form = initial;
  let values = form.myResponse?.values ?? initialBotInputValues(form.form.fields);
  let pending = false;
  // Answers changed here and not sent yet: a snapshot must never overwrite them.
  let edited = false;
  let seenResponseAt = form.myResponse?.updatedAt ?? null;
  const fieldContext = () => ({
    prefix: `native-form-${form.id}`,
    disabled: pending,
    nativeForm: true,
    persistentSelection: true,
    members: [...feed.server.knownMembers.values()],
  });
  const clearFieldError = (target: EventTarget | null) => {
    const question = target instanceof Element ? target.closest<HTMLElement>('.native-form-question') : null;
    if (!question) return;
    question.classList.remove('native-form-question--invalid');
    question.removeAttribute('aria-invalid');
    question.querySelector('[data-native-form-field-error]')?.remove();
    modal.clearError();
  };
  const updateClearButton = (target: EventTarget | null) => {
    const question = target instanceof Element ? target.closest<HTMLElement>('.native-form-question') : null;
    const name = question?.dataset.fieldName;
    const clear = question?.querySelector<HTMLButtonElement>('.bot-field-clear');
    if (!name || !clear) return;
    const value = values[name];
    clear.hidden = value === undefined || value === null
      || (typeof value === 'string' && value.trim().length === 0)
      || (Array.isArray(value) && value.length === 0);
  };
  const showFieldError = (fieldName: string, reason: Parameters<typeof botInputError>[2]) => {
    const question = modal.content.querySelector<HTMLElement>(
      `[data-field-name="${CSS.escape(fieldName)}"]`,
    );
    if (!question) { modal.fail(t('community.invalidResponse')); return; }
    const message = botInputError(form.form.fields, fieldName, reason);
    question.classList.add('native-form-question--invalid');
    question.setAttribute('aria-invalid', 'true');
    const error = document.createElement('p');
    error.dataset.nativeFormFieldError = '';
    error.className = 'native-form-field-error';
    error.setAttribute('role', 'alert');
    error.textContent = message;
    question.append(error);
    modal.fail(message);
    const scroller = modal.content.querySelector<HTMLElement>('.live-action-step');
    if (scroller) scrollWithin(scroller, question, 16);
    question.querySelector<HTMLElement>(
      '[data-bot-input], [data-bot-select-value], [data-field-action], select, input, textarea, button:not(:disabled)',
    )?.focus({ preventScroll: true });
  };
  const draw = () => {
    modal.content.innerHTML = `<header class="native-form-action-header">
      <h2 tabindex="-1">${escapeHtml(form.form.title)}
        ${form.audience.visibility === 'private' ? privateBadge() : ''}</h2>
      <button type="button" class="native-form-action-close" data-native-form-cancel
        aria-label="${escapeHtml(t('common.close'))}" title="${escapeHtml(t('common.close'))}" ${pending ? 'disabled' : ''}>
        <span class="material-symbols-outlined md-20" aria-hidden="true">close</span>
      </button>
      </header>
      <section class="live-action-step">
        ${form.form.description ? `<p class="event-wizard-hint">${escapeHtml(form.form.description)}</p>` : ''}
        ${renderBotFields(form.form.fields, values, fieldContext())}
      </section>
      <footer class="modal-footer event-wizard-footer live-action-footer">
        <span class="event-footer-spacer"></span>
        <button type="button" class="btn btn-secondary" data-native-form-cancel ${pending ? 'disabled' : ''}>${t('common.cancel')}</button>
        <button type="button" class="btn btn-primary" data-native-form-submit ${pending ? 'disabled' : ''}>${escapeHtml(form.form.submitLabel ?? t('liveForm.submit'))}</button>
      </footer>`;
  };
  // Rebuilding the questions (sending, a failure, answers from another device) keeps the reader's place.
  const render = () => preserveViewState(modal.content, draw, {
    scroller: '.live-action-step',
    itemKeys: QUESTION_ITEMS,
    fallback: () => modal.content.querySelector<HTMLElement>('.native-form-action-header h2'),
  });
  const read = (event: Event) => {
    clearFieldError(event.target);
    const next = readBotFieldChange(event.target, form.form.fields, values);
    if (next) { values = next; edited = true; }
    updateClearButton(event.target);
  };
  modal.content.addEventListener('input', read, { signal: modal.signal });
  modal.content.addEventListener('change', read, { signal: modal.signal });
  modal.content.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('[data-native-form-cancel]')) { modal.close(); return; }
    if (pending) return;
    const choice = target?.closest<HTMLElement>('[data-bot-select-value]');
    if (choice) {
      clearFieldError(choice);
      const next = chooseBotFieldValue(choice, form.form.fields, values);
      if (next) { values = next; edited = true; }
      return;
    }
    const fieldButton = target?.closest<HTMLButtonElement>('[data-field-action]');
    if (fieldButton) {
      clearFieldError(fieldButton);
      const next = applyBotFieldAction(fieldButton, form.form.fields, values, fieldContext());
      if (next) { values = next; edited = true; }
      return;
    }
    if (!target?.closest('[data-native-form-submit]')) return;
    const parsed = validateNativeLiveFormValues(form.form, convertBotInputValues(form.form.fields, values));
    if (!parsed.success) { showFieldError(parsed.field, parsed.reason); return; }
    pending = true;
    render();
    void modal.run(async () => {
      try {
        const updated = nativeLiveFormSchema.parse(await feed.client.sendRequest(
          MessageType.NATIVE_FORM_SUBMIT,
          { id: form.id, expectedRevision: form.revision, values: parsed.values },
        ));
        form = updated;
        values = updated.myResponse?.values ?? values;
        if (!modal.signal.aborted) {
          showInfoToast(t(updated.myResponse?.createdAt === updated.myResponse?.updatedAt
            ? 'liveForm.responseSent' : 'liveForm.responseUpdated'));
          modal.close();
        }
      } catch (error) {
        pending = false;
        if (!modal.signal.aborted) render();
        throw error;
      } finally { pending = false; }
    });
  }, { signal: modal.signal });
  followFeed(feed, modal, () => {
    const current = (feed.snapshot?.nativeForms ?? []).find(entry => entry.id === form.id);
    if (!current) { modal.close(true); return; }
    // Every submission, vote or "interested" on the server sends a snapshot: only
    // a changed form, or this member's answers sent from another device, repaint.
    const changed = current.revision !== form.revision || current.audience.visibility !== form.audience.visibility;
    const responseAt = current.myResponse?.updatedAt ?? null;
    const answeredElsewhere = responseAt !== seenResponseAt && !!current.myResponse && !edited && !pending;
    seenResponseAt = responseAt;
    form = current;
    if (answeredElsewhere && current.myResponse) values = current.myResponse.values;
    if (changed || answeredElsewhere) render();
  });
  render();
}

/** A bot's live action: its public selector, or the form it asks to be answered. */
export async function openBotLiveAction(ctx: CommunityContext, action: LiveAction): Promise<void> {
  const { feed } = ctx;
  const modal = ctx.modal(action.title);
  modal.card.classList.add(action.content.kind === 'form' ? 'event-wizard' : 'event-detail-modal',
    action.content.kind === 'form' ? 'live-action-wizard' : 'live-action-detail-modal');
  followFeed(feed, modal, () => {
    const current = feed.snapshot?.liveActions.find((entry) => entry.id === action.id);
    if (!current || current.revision !== action.revision) modal.close(true);
  });
  if (action.content.kind === 'selector') {
    const selectorId = action.content.selectorId;
    await modal.run(async () => {
      const response = await feed.client.sendRequest<{ selectors: unknown[] }>(MessageType.SELECTOR_LIST, { channelId: action.channelId });
      if (modal.signal.aborted) return;
      const selector = response.selectors.map((entry) => botSelectorPublicSchema.parse(entry)).find((entry) => entry.id === selectorId);
      if (!selector) throw new Error(t('community.changed'));
      modal.content.innerHTML = `${renderImageCarousel(
        action.imageUrls, feed.client.getHttpBaseUrl(), action.title, action.imagePresentation,
      )}
        <div data-message-id="${escapeHtml(selector.messageId)}"><div class="chat-message-body">
        <p class="chat-message-text">${escapeHtml(selector.title)}</p></div></div>`;
      const view = new PublicSelectorView(modal.content, feed.client, feed.server, action.channelId);
      modal.signal.addEventListener('abort', () => view.destroy(), { once: true });
      modal.content.addEventListener('click', event => {
        const button = imageCarouselNavigationButton(event.target);
        if (button) { moveImageCarousel(button); return; }
      }, { signal: modal.signal });
    });
    return;
  }
  const form = action.content.form;
  let values = initialBotInputValues(form.fields);
  let pending = false;
  const fieldContext = () => ({
    prefix: `live-${action.id}`, disabled: pending, persistentSelection: true,
    members: [...feed.server.knownMembers.values()],
    imageUpload: { client: feed.client, channelId: action.channelId },
  });
  modal.signal.addEventListener('abort', audioPreviewService.bind(modal.content), { once: true });
  const draw = () => {
    modal.content.innerHTML = `${renderImageCarousel(
      action.imageUrls, feed.client.getHttpBaseUrl(), action.title, action.imagePresentation,
    )}
      <section class="live-action-step">
        <h2 tabindex="-1">${escapeHtml(action.title)}
          ${action.audience.visibility === 'private' ? privateBadge() : ''}</h2>
        <p class="event-wizard-hint">${escapeHtml(form.description ?? action.description)}</p>
        ${renderBotFields(form.fields, values, fieldContext())}
      </section>
      <footer class="modal-footer event-wizard-footer live-action-footer">
        <span class="event-footer-spacer"></span>
        <button type="button" class="btn btn-secondary" data-live-cancel ${pending ? 'disabled' : ''}>${t('common.cancel')}</button>
        <button type="button" class="btn btn-primary" data-live-submit ${pending ? 'disabled' : ''}>${escapeHtml(form.submitLabel ?? t('common.confirm'))}</button>
      </footer>`;
  };
  // Sending and a failed send rebuild the form; the scroll position stays where it was.
  const render = () => preserveViewState(modal.content, draw, {
    scroller: '.live-action-step',
    itemKeys: QUESTION_ITEMS,
    fallback: () => modal.content.querySelector<HTMLElement>('.live-action-step > h2'),
  });
  const read = (event: Event) => { values = readBotFieldChange(event.target, form.fields, values) ?? values; };
  modal.content.addEventListener('input', read, { signal: modal.signal });
  modal.content.addEventListener('change', read, { signal: modal.signal });
  modal.content.addEventListener('click', (event) => {
    const carouselButton = imageCarouselNavigationButton(event.target);
    if (carouselButton && moveImageCarousel(carouselButton)) return;
    const cancel = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-live-cancel]') : null;
    if (cancel && !pending) { modal.close(); return; }
    if (pending || audioPreviewService.ownsEventTarget(event.target)) return;
    const choice = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-bot-select-value]') : null;
    if (choice) {
      values = chooseBotFieldValue(choice, form.fields, values) ?? values;
      return;
    }
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || pending) return;
    if (button.dataset.fieldAction) {
      if (button.dataset.fieldAction === 'image-add') {
        button.disabled = true;
        void modal.run(async () => {
          const next = await addBotFieldImage(button, form.fields, values, fieldContext());
          if (next) values = next;
        }).finally(() => { if (button.isConnected) button.disabled = false; });
        return;
      }
      values = applyBotFieldAction(button, form.fields, values, fieldContext()) ?? values;
      return;
    }
    if (!button.hasAttribute('data-live-submit')) return;
    void modal.run(async () => {
      const parsed = validateBotFormValues(form, convertBotInputValues(form.fields, values));
      if (!parsed.success) { modal.fail(t('community.invalidResponse')); return; }
      pending = true;
      render();
      try {
        await feed.client.sendRequest(MessageType.LIVE_ACTION_SUBMIT, {
          id: action.id, expectedRevision: action.revision, values: parsed.values, locale: getLanguage(),
        });
        if (!modal.signal.aborted) {
          showInfoToast(t('community.submitted'));
          modal.close();
        }
      } catch (error) {
        pending = false;
        if (!modal.signal.aborted) render();
        throw error;
      } finally { pending = false; }
    });
  }, { signal: modal.signal });
  modal.content.addEventListener('keydown', event => {
    if (pending || audioPreviewService.ownsEventTarget(event.target)) return;
    const option = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-bot-select-value]') : null;
    if (!option || option instanceof HTMLButtonElement) return;
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); option.click(); return; }
    const options = [...option.closest('[data-bot-choice-list]')?.querySelectorAll<HTMLElement>('[data-bot-select-value]') ?? []];
    const index = options.indexOf(option);
    const next = event.key === 'ArrowDown' ? Math.min(index + 1, options.length - 1) :
      event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); options[next]?.focus(); }
  }, { signal: modal.signal });
  render();
}
