import { MessageType } from '@monky/shared';
import { networkClient } from '../core/NetworkClient';
import { t } from '../i18n';
import { enableBackdropClose } from '../utils/modal';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import {
  attachChannelPrivacyFields,
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

  public open(defaultType: 'TEXT' | 'VOICE' = 'TEXT'): void {
    this.close();

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <div class="modal-title">${t('channelModal.title')}</div>
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

          ${renderChannelPrivacyFields({ isPrivate: false, allowedRoleIds: [] })}
          ${renderChannelBotCommandsField(true, defaultType)}

          <div class="modal-footer">
            <button type="button" id="btn-cancel" class="btn btn-secondary">${t('common.cancel')}</button>
            <button type="submit" id="btn-create" class="btn btn-primary">${t('channelModal.submit')}</button>
          </div>
        </form>
      </div>
    `;

    document.body.appendChild(this.modalEl);
    this.attachEvents();
  }

  private attachEvents(): void {
    if (!this.modalEl) return;

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
    this.detachBotCommandsField = attachChannelBotCommandsField(this.modalEl);

    if (btnEmoji && inputName) {
      this.detachEmojiPicker = attachInputEmojiPicker(inputName, btnEmoji);
    }

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = inputName?.value.trim();
      const type = (this.modalEl?.querySelector('input[name="channel-type"]:checked') as HTMLInputElement)?.value as 'TEXT' | 'VOICE';

      if (!name || !this.modalEl) return;

      const privacy = readChannelPrivacyFields(this.modalEl);

      try {
        await networkClient.sendRequest(MessageType.CHANNEL_CREATE, {
          name,
          type,
          isPrivate: privacy.isPrivate,
          allowedRoleIds: privacy.allowedRoleIds,
          ...(type === 'TEXT' ? { botCommandsEnabled: readChannelBotCommandsField(this.modalEl) } : {}),
        });
        this.close();
      } catch (err: any) {
        const banner = document.getElementById('channel-error-banner');
        if (banner) {
          banner.innerText = err.message || t('channelModal.error');
          banner.classList.add('show');
        }
      }
    });
  }

  public close(): void {
    this.detachBotCommandsField?.();
    this.detachBotCommandsField = null;
    this.detachEmojiPicker?.();
    this.detachEmojiPicker = null;
    this.detachPrivacyFields?.();
    this.detachPrivacyFields = null;
    if (this.modalEl) {
      this.modalEl.remove();
      this.modalEl = null;
    }
  }
}

export const createChannelModal = new CreateChannelModal();
