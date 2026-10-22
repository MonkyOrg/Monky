import { customStatusSchema, LIMITS, type CustomStatus } from '@monky/shared';
import { t } from '../i18n';
import { sessionManager } from '../core/SessionManager';
import { settingsStore } from '../stores/settingsStore';
import { serverStore } from '../stores/serverStore';
import { connectionStore } from '../stores/connectionStore';
import { escapeHtml } from '../utils/html';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';
import { enableBackdropClose } from '../utils/modal';
import { customStatusDotStyle, renderPresenceTag } from '../utils/presenceTag';
import { COLOR_PRESETS } from '../utils/colors';
import { ColorPicker } from './ColorPicker';
import { EmojiPicker } from './EmojiPicker';
import { showErrorToast } from './CopyToast';

const DEFAULT_COLOR = '#5865f2';

/**
 * Writes the person's own status (custom-status): emoji, text, tag, dot colour
 * and whether the emoji and tag show next to their name. Saving makes it the
 * current status; removing deletes it and falls back to online.
 */
export class CustomStatusModal {
  private root: HTMLElement | null = null;
  private draft: CustomStatus = { color: DEFAULT_COLOR, showEmoji: true, showTag: true };
  private readonly colorPicker = new ColorPicker({ id: 'custom-status-color', label: 'customStatus.colorLabel', presets: COLOR_PRESETS });
  private emojiPicker: EmojiPicker | null = null;
  private controller: AbortController | null = null;

  public open(): void {
    this.close();
    const saved = settingsStore.customStatus;
    this.draft = saved ? { ...saved } : { color: DEFAULT_COLOR, showEmoji: true, showTag: true };
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    root.innerHTML = `<div class="modal-card custom-status-modal" role="dialog" aria-modal="true" aria-labelledby="custom-status-title">
      <div class="modal-header">
        <div class="modal-title" id="custom-status-title">${t('customStatus.title')}</div>
        <button type="button" class="modal-close-btn" data-custom-status-cancel aria-label="${escapeHtml(t('common.close'))}">&times;</button>
      </div>
      <form class="custom-status-form" novalidate>
        <div class="custom-status-preview" aria-live="polite" data-custom-status-preview></div>
        <div class="form-group">
          <label for="custom-status-text">${t('customStatus.textLabel')}</label>
          <div class="custom-status-text-row">
            <button type="button" class="custom-status-emoji-btn" data-custom-status-emoji aria-haspopup="dialog" aria-expanded="false"></button>
            <input id="custom-status-text" type="text" autocomplete="off" maxlength="${LIMITS.MAX_CUSTOM_STATUS_TEXT_LENGTH}"
              placeholder="${escapeHtml(t('customStatus.textPlaceholder'))}" value="${escapeHtml(this.draft.text ?? '')}">
            <button type="button" class="btn btn-icon custom-status-clear-emoji" data-custom-status-clear-emoji
              aria-label="${escapeHtml(t('customStatus.removeEmoji'))}" title="${escapeHtml(t('customStatus.removeEmoji'))}">
              <span class="material-symbols-outlined md-16" aria-hidden="true">close</span>
            </button>
          </div>
        </div>
        <div class="custom-status-grid">
          <div class="form-group">
            <label for="custom-status-tag">${t('customStatus.tagLabel')}</label>
            <input id="custom-status-tag" type="text" autocomplete="off" maxlength="${LIMITS.MAX_CUSTOM_STATUS_TAG_LENGTH}"
              placeholder="${escapeHtml(t('customStatus.tagPlaceholder'))}" value="${escapeHtml(this.draft.tag ?? '')}">
          </div>
          <div class="form-group">
            <span class="custom-status-field-label">${t('customStatus.colorLabel')}</span>
            ${this.colorPicker.renderHtml(this.draft.color)}
          </div>
        </div>
        ${this.switchRow('custom-status-show-emoji', 'customStatus.showEmoji', this.draft.showEmoji)}
        ${this.switchRow('custom-status-show-tag', 'customStatus.showTag', this.draft.showTag)}
        <div class="modal-footer custom-status-footer">
          ${saved ? `<button type="button" class="btn btn-secondary custom-status-remove" data-custom-status-remove>${t('customStatus.remove')}</button>` : ''}
          <button type="button" class="btn btn-secondary" data-custom-status-cancel>${t('common.cancel')}</button>
          <button type="submit" class="btn btn-primary" data-custom-status-save>${t('common.save')}</button>
        </div>
      </form>
    </div>`;
    document.body.appendChild(root);
    this.root = root;
    enterModal(root);
    this.bind(root);
    this.render();
    root.querySelector<HTMLInputElement>('#custom-status-text')?.focus();
  }

  public close(): void {
    this.controller?.abort();
    this.controller = null;
    this.emojiPicker?.destroy();
    this.emojiPicker = null;
    this.colorPicker.cleanup();
    if (this.root) exitModal(this.root);
    this.root = null;
  }

  private switchRow(id: string, label: 'customStatus.showEmoji' | 'customStatus.showTag', checked: boolean): string {
    return `<div class="custom-status-switch-row">
      <span id="${id}-label">${t(label)}</span>
      <label class="toggle-switch"><input type="checkbox" role="switch" id="${id}" aria-labelledby="${id}-label" ${checked ? 'checked' : ''}>
        <span class="toggle-slider"></span></label>
    </div>`;
  }

  private bind(root: HTMLElement): void {
    const controller = new AbortController();
    this.controller = controller;
    const options = { signal: controller.signal };
    const field = (id: string) => root.querySelector<HTMLInputElement>(`#${id}`)!;
    const text = field('custom-status-text');
    const tag = field('custom-status-tag');
    text.addEventListener('input', () => { this.draft.text = text.value; this.render(); }, options);
    tag.addEventListener('input', () => { this.draft.tag = tag.value; this.render(); }, options);
    field('custom-status-show-emoji').addEventListener('change', (event) => {
      this.draft.showEmoji = (event.currentTarget as HTMLInputElement).checked;
      this.render();
    }, options);
    field('custom-status-show-tag').addEventListener('change', (event) => {
      this.draft.showTag = (event.currentTarget as HTMLInputElement).checked;
      this.render();
    }, options);
    this.colorPicker.attachEvents(root, (color) => { this.draft.color = color; this.render(); });

    const emojiButton = root.querySelector<HTMLElement>('[data-custom-status-emoji]')!;
    emojiButton.addEventListener('click', () => {
      if (this.emojiPicker?.isOpen()) { this.emojiPicker.close(); return; }
      this.emojiPicker?.destroy();
      this.emojiPicker = new EmojiPicker({
        container: document.body, anchor: emojiButton, emojiOnly: true, floating: true,
        onSelectEmoji: (emoji) => {
          this.draft.emoji = emoji;
          this.emojiPicker?.close();
          this.render();
          text.focus();
        },
      });
      void this.emojiPicker.open();
    }, options);
    root.querySelector('[data-custom-status-clear-emoji]')?.addEventListener('click', () => {
      this.draft.emoji = undefined;
      this.render();
      emojiButton.focus();
    }, options);

    root.querySelectorAll('[data-custom-status-cancel]').forEach((button) => button.addEventListener('click', () => this.close(), options));
    root.querySelector('[data-custom-status-remove]')?.addEventListener('click', () => {
      sessionManager.saveCustomStatus(null);
      this.close();
    }, options);
    root.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.save();
    }, options);
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && handlesModalKey(root, event)) {
        event.preventDefault();
        this.close();
      }
    }, options);
    enableBackdropClose(root, () => this.close());
  }

  /** The draft as it would be published, or null while it has nothing to show. */
  private parsed(): CustomStatus | null {
    const result = customStatusSchema.safeParse(this.draft);
    if (!result.success) return null;
    return result.data.text || result.data.emoji || result.data.tag ? result.data : null;
  }

  private save(): void {
    const status = this.parsed();
    if (!status) {
      showErrorToast(t('customStatus.empty'));
      return;
    }
    sessionManager.saveCustomStatus(status);
    this.close();
  }

  private render(): void {
    const root = this.root;
    if (!root) return;
    const emojiButton = root.querySelector<HTMLElement>('[data-custom-status-emoji]');
    if (emojiButton) {
      emojiButton.innerHTML = this.draft.emoji
        ? `<span class="custom-status-emoji-glyph">${escapeHtml(this.draft.emoji)}</span>`
        : '<span class="material-symbols-outlined md-20" aria-hidden="true">add_reaction</span>';
      emojiButton.setAttribute('aria-label', t(this.draft.emoji ? 'customStatus.changeEmoji' : 'customStatus.chooseEmoji'));
      emojiButton.title = emojiButton.getAttribute('aria-label') ?? '';
    }
    const clear = root.querySelector<HTMLElement>('[data-custom-status-clear-emoji]');
    if (clear) clear.hidden = !this.draft.emoji;

    const status = this.parsed();
    const preview = root.querySelector<HTMLElement>('[data-custom-status-preview]');
    if (preview) {
      const user = serverStore.currentUser;
      const shown: CustomStatus = status ?? { color: this.draft.color, showEmoji: false, showTag: false };
      preview.innerHTML = `
        <span class="custom-status-preview-dot status-indicator custom" style="${customStatusDotStyle(shown)}" aria-hidden="true"></span>
        <span class="custom-status-preview-info">
          <span class="custom-status-preview-name">${escapeHtml(user?.nickname ?? connectionStore.savedNickname ?? '')}${renderPresenceTag({ customStatus: shown })}</span>
          <span class="custom-status-preview-text">${escapeHtml(status?.text ?? t('main.statusOnline'))}</span>
        </span>`;
    }
    const saveButton = root.querySelector<HTMLButtonElement>('[data-custom-status-save]');
    if (saveButton) saveButton.disabled = !status;
  }
}

export const customStatusModal = new CustomStatusModal();
