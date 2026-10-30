import { MessageType, type ChannelCategory } from '@monky/shared';
import { networkClient } from '../core/NetworkClient';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { openModal, type ModalShell } from '../utils/modalShell';
import { errorMessage, reportError, useAppValidation } from '../utils/feedback';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import { attachChannelPrivacyFields, readChannelPrivacyFields, renderChannelPrivacyFields } from './channelFormFields';
import { channelSettingsModal } from './ChannelSettingsModal';

export class CategoryModal {
  private shell: ModalShell | null = null;

  open(category?: ChannelCategory): void {
    this.close();
    if (category) { channelSettingsModal.open({ kind: 'category', value: category }); return; }
    const detach: Array<() => void> = [];
    const shell = openModal({
      card: `<div class="modal-card category-modal" aria-labelledby="category-modal-title">
      <div class="modal-header"><div class="modal-title" id="category-modal-title">${t('categories.create')}</div>
        <button type="button" class="modal-close-btn" data-modal-close aria-label="${t('common.cancel')}">&times;</button></div>
      <form>
        <div class="form-group"><label for="input-category-name">${t('categories.name')}</label>
          <div class="input-with-emoji-container">
            <input id="input-category-name" required minlength="2" maxlength="50" placeholder="${escapeHtml(t('categories.placeholder'))}">
            <button type="button" class="btn-input-emoji" data-category-emoji aria-label="${t('chat.emojiPickerTitle')}"><span class="material-symbols-outlined md-18">mood</span></button>
          </div></div>
        ${renderChannelPrivacyFields({ isPrivate: false, allowedRoleIds: [] }, true)}
        <div class="modal-footer"><button type="button" class="btn btn-secondary" data-modal-close>${t('common.cancel')}</button>
          <button type="submit" class="btn btn-primary">${t('categories.create')}</button></div>
      </form></div>`,
      initialFocus: '#input-category-name',
      closeWithSession: true,
      onClose: () => {
        detach.forEach(off => off());
        if (this.shell === shell) this.shell = null;
      },
    });
    this.shell = shell;
    const root = shell.card;
    const options = { signal: shell.signal };
    detach.push(attachChannelPrivacyFields(root));
    const nameInput = root.querySelector<HTMLInputElement>('#input-category-name')!;
    detach.push(attachInputEmojiPicker(nameInput, root.querySelector<HTMLElement>('[data-category-emoji]')!));
    const submit = root.querySelector<HTMLButtonElement>('[type="submit"]')!;
    const sync = () => { submit.disabled = nameInput.value.trim().length < 2; };
    nameInput.addEventListener('input', sync, options);
    sync();
    const form = root.querySelector('form')!;
    useAppValidation(form, shell.signal);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const name = nameInput.value.trim();
      if (!name) return;
      submit.disabled = true;
      void networkClient.sendRequest(MessageType.CATEGORY_CREATE, {
        name, ...readChannelPrivacyFields(root),
      }).then(() => shell.close('api')).catch((error: unknown) => {
        if (!shell.closed) reportError(errorMessage(error, t('categories.error')));
      }).finally(() => { if (!shell.closed) sync(); });
    }, options);
  }

  close(): void {
    channelSettingsModal.close();
    this.shell?.close('api');
  }
}

export const categoryModal = new CategoryModal();
