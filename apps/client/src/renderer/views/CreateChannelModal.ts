import { MessageType, type ChannelType } from '@monky/shared';
import { networkClient } from '../core/NetworkClient';
import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';
import { enterModal, exitModal } from '../utils/modalSurface';
import { escapeHtml } from '../utils/html';
import { enableBackdropClose } from '../utils/modal';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import {
  attachChannelPrivacyFields,
  renderChannelCategoryFields,
  attachChannelCategoryFields,
  readChannelCategoryFields,
  attachChannelBotCommandsField,
  readChannelBotCommandsField,
  renderChannelBotCommandsField,
  readChannelPrivacyFields,
  renderChannelPrivacyFields,
  renderChannelTypeFields,
} from './channelFormFields';

export class CreateChannelModal {
  private modalEl: HTMLElement | null = null;
  private detachPrivacyFields: (() => void) | null = null;
  private detachBotCommandsField: (() => void) | null = null;
  private detachEmojiPicker: (() => void) | null = null;
  private detachCategoryFields: (() => void) | null = null;

  public open(defaultType: ChannelType = 'TEXT', categoryId: string | null = null): void {
    this.close();

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = `
      <div class="modal-card create-channel-modal">
        <div class="modal-header">
          <div><div class="modal-title">${t('channelModal.title')}</div>
            ${categoryId ? `<p class="channel-category-subtitle">${escapeHtml(serverStore.serverDetails?.categories?.find(category => category.id === categoryId)?.name ?? '')}</p>` : ''}</div>
          <button id="modal-close" class="modal-close-btn">&times;</button>
        </div>

        <div id="channel-error-banner" class="error-banner"></div>

        <form id="form-create-channel">
          ${renderChannelTypeFields(defaultType)}

          <div class="form-group">
            <label>${t('channelModal.nameLabel')}</label>
            <div class="input-with-emoji-container">
              <input id="input-channel-name" type="text" placeholder="${t('channelModal.namePlaceholder')}" required minlength="2" maxlength="50" style="padding-right: 36px;">
              <button type="button" id="btn-emoji-channel-name" class="btn-input-emoji" title="${t('chat.emojiPickerTitle')}">
                <span class="material-symbols-outlined md-18">mood</span>
              </button>
            </div>
          </div>

          ${renderChannelCategoryFields(categoryId, true)}
          <div id="channel-permission-overrides">${renderChannelPrivacyFields({ isPrivate: false, allowedRoleIds: [] })}</div>
          ${renderChannelBotCommandsField(true)}

          <div class="modal-footer">
            <button type="button" id="btn-cancel" class="btn btn-secondary">${t('common.cancel')}</button>
            <button type="submit" id="btn-create" class="btn btn-primary">${t('channelModal.submit')}</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(this.modalEl);
    enterModal(this.modalEl);
    this.attachEvents();
  }

  private attachEvents(): void {
    if (!this.modalEl) return;
    const root = this.modalEl;

    const btnClose = this.modalEl.querySelector('#modal-close');
    const btnCancel = this.modalEl.querySelector('#btn-cancel');
    const form = this.modalEl.querySelector('#form-create-channel') as HTMLFormElement;
    const inputName = this.modalEl.querySelector('#input-channel-name') as HTMLInputElement;
    const btnEmoji = this.modalEl.querySelector('#btn-emoji-channel-name') as HTMLElement | null;
    const modalCard = this.modalEl.querySelector('.modal-card') as HTMLElement | null;

    btnClose?.addEventListener('click', () => this.close());
    btnCancel?.addEventListener('click', () => this.close());
    enableBackdropClose(this.modalEl, () => this.close());
    this.detachPrivacyFields = attachChannelPrivacyFields(this.modalEl);
    this.detachCategoryFields = attachChannelCategoryFields(this.modalEl);
    this.detachBotCommandsField = attachChannelBotCommandsField(this.modalEl);

    if (btnEmoji && inputName) {
      this.detachEmojiPicker = attachInputEmojiPicker(inputName, btnEmoji);
    }

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (this.modalEl !== root) return;
      const name = inputName?.value.trim();
      const type = (this.modalEl?.querySelector('input[name="channel-type"]:checked') as HTMLInputElement)?.value as ChannelType;

      if (!name || !this.modalEl) return;

      const privacy = readChannelPrivacyFields(this.modalEl);

      try {
        await networkClient.sendRequest(MessageType.CHANNEL_CREATE, {
          name,
          ...readChannelCategoryFields(this.modalEl),
          type,
          isPrivate: privacy.isPrivate,
          allowedRoleIds: privacy.allowedRoleIds,
          botCommandsEnabled: readChannelBotCommandsField(this.modalEl),
        });
        if (this.modalEl === root) this.close();
      } catch (err: unknown) {
        if (this.modalEl !== root) return;
        const banner = this.modalEl?.querySelector<HTMLElement>('#channel-error-banner');
        if (banner) {
          banner.innerText = err instanceof Error ? err.message : t('channelModal.error');
          banner.classList.add('show');
        }
      }
    });
  }

  public close(): void {
    this.detachCategoryFields?.();
    this.detachCategoryFields = null;
    this.detachBotCommandsField?.();
    this.detachBotCommandsField = null;
    this.detachEmojiPicker?.();
    this.detachEmojiPicker = null;
    this.detachPrivacyFields?.();
    this.detachPrivacyFields = null;
    if (this.modalEl) {
      exitModal(this.modalEl);
      this.modalEl = null;
    }
  }
}

export const createChannelModal = new CreateChannelModal();
