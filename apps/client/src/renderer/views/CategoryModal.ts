import { MessageType, type ChannelCategory } from '@monky/shared';
import { networkClient } from '../core/NetworkClient';
import { appEvents } from '../core/EventBus';
import { t } from '../i18n';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';
import { escapeHtml } from '../utils/html';
import { enableBackdropClose } from '../utils/modal';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import { attachChannelPrivacyFields, readChannelPrivacyFields, renderChannelPrivacyFields } from './channelFormFields';
import { channelSettingsModal } from './ChannelSettingsModal';

export class CategoryModal {
  private root: HTMLElement | null = null;
  private detachPrivacy: (() => void) | null = null;
  private detachEmoji: (() => void) | null = null;
  private unbind: Array<() => void> = [];
  private onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && handlesModalKey(this.root, event)) {
      event.preventDefault();
      this.close();
    }
  };

  open(category?: ChannelCategory): void {
    this.close();
    if (category) { channelSettingsModal.open({ kind: 'category', value: category }); return; }
    const root = document.createElement('div');
    this.root = root;
    root.className = 'modal-backdrop';
    root.innerHTML = `<div class="modal-card category-modal" role="dialog" aria-modal="true" aria-labelledby="category-modal-title">
      <div class="modal-header"><div class="modal-title" id="category-modal-title">${t('categories.create')}</div>
        <button type="button" class="modal-close-btn" aria-label="${t('common.cancel')}">&times;</button></div>
      <div class="error-banner" role="alert"></div>
      <form>
        <div class="form-group"><label for="input-category-name">${t('categories.name')}</label>
          <div class="input-with-emoji-container">
            <input id="input-category-name" required minlength="2" maxlength="50" placeholder="${escapeHtml(t('categories.placeholder'))}">
            <button type="button" class="btn-input-emoji" data-category-emoji aria-label="${t('chat.emojiPickerTitle')}"><span class="material-symbols-outlined md-18">mood</span></button>
          </div></div>
        ${renderChannelPrivacyFields({ isPrivate: false, allowedRoleIds: [] }, true)}
        <div class="modal-footer"><button type="button" class="btn btn-secondary">${t('common.cancel')}</button>
          <button type="submit" class="btn btn-primary">${t('categories.create')}</button></div>
      </form></div>`;
    document.body.appendChild(root);
    enterModal(root);
    this.detachPrivacy = attachChannelPrivacyFields(root);
    const nameInput = root.querySelector<HTMLInputElement>('#input-category-name')!;
    this.detachEmoji = attachInputEmojiPicker(nameInput, root.querySelector<HTMLElement>('[data-category-emoji]')!);
    const sync = () => { root.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = nameInput.value.trim().length < 2; };
    nameInput.addEventListener('input', sync);
    sync();
    this.unbind = [
      appEvents.on('session.changed', () => this.close()),
      appEvents.on('network.disconnected', () => this.close()),
    ];
    enableBackdropClose(root, () => this.close());
    root.querySelector('.modal-close-btn')?.addEventListener('click', () => this.close());
    root.querySelector('.btn-secondary')?.addEventListener('click', () => this.close());
    root.addEventListener('keydown', this.onKeydown);
    root.querySelector<HTMLInputElement>('#input-category-name')?.focus();
    root.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = root.querySelector<HTMLInputElement>('#input-category-name')?.value.trim();
      if (!name) return;
      const submit = root.querySelector<HTMLButtonElement>('[type="submit"]');
      if (submit) submit.disabled = true;
      void networkClient.sendRequest(MessageType.CATEGORY_CREATE, {
        name, ...readChannelPrivacyFields(root),
      }).then(() => { if (this.root === root) this.close(); }).catch((error: unknown) => {
        const banner = root.querySelector<HTMLElement>('.error-banner');
        if (banner) {
          banner.textContent = error instanceof Error ? error.message : t('categories.error');
          banner.classList.add('show');
        }
      }).finally(() => { if (submit) submit.disabled = false; });
    });
  }

  close(): void {
    channelSettingsModal.close();
    this.unbind.forEach((off) => off());
    this.unbind = [];
    this.detachPrivacy?.();
    this.detachPrivacy = null;
    this.detachEmoji?.();
    this.detachEmoji = null;
    this.root?.removeEventListener('keydown', this.onKeydown);
    if (this.root) exitModal(this.root);
    this.root = null;
  }
}

export const categoryModal = new CategoryModal();
