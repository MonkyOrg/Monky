import { MessageType, type ChannelType } from '@monky/shared';
import { networkClient } from '../core/NetworkClient';
import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { openModal, type ModalShell } from '../utils/modalShell';
import { errorMessage, reportError, useAppValidation } from '../utils/feedback';
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
  private shell: ModalShell | null = null;

  public open(defaultType: ChannelType = 'TEXT', categoryId: string | null = null): void {
    this.close();
    const detach: Array<() => void> = [];
    const shell = openModal({
      card: `
      <div class="modal-card create-channel-modal" aria-labelledby="create-channel-title">
        <div class="modal-header">
          <div><div class="modal-title" id="create-channel-title">${t('channelModal.title')}</div>
            ${categoryId ? `<p class="channel-category-subtitle">${escapeHtml(serverStore.serverDetails?.categories?.find(category => category.id === categoryId)?.name ?? '')}</p>` : ''}</div>
          <button type="button" id="modal-close" class="modal-close-btn" data-modal-close aria-label="${t('common.close')}">&times;</button>
        </div>

        <form id="form-create-channel">
          ${renderChannelTypeFields(defaultType)}

          <div class="form-group">
            <label for="input-channel-name">${t('channelModal.nameLabel')}</label>
            <div class="input-with-emoji-container">
              <input id="input-channel-name" type="text" placeholder="${t('channelModal.namePlaceholder')}" required minlength="2" maxlength="50" style="padding-right: 36px;">
              <button type="button" id="btn-emoji-channel-name" class="btn-input-emoji" title="${t('chat.emojiPickerTitle')}" aria-label="${t('chat.emojiPickerTitle')}">
                <span class="material-symbols-outlined md-18" aria-hidden="true">mood</span>
              </button>
            </div>
          </div>

          ${renderChannelCategoryFields(categoryId, true)}
          <div id="channel-permission-overrides">${renderChannelPrivacyFields({ isPrivate: false, allowedRoleIds: [] })}</div>
          ${renderChannelBotCommandsField(true)}

          <div class="modal-footer">
            <button type="button" id="btn-cancel" class="btn btn-secondary" data-modal-close>${t('common.cancel')}</button>
            <button type="submit" id="btn-create" class="btn btn-primary">${t('channelModal.submit')}</button>
          </div>
        </form>
      </div>
    `,
      initialFocus: '#input-channel-name',
      // The request goes to the visible server: when it changes, the form no longer belongs to it.
      closeWithSession: true,
      onClose: () => {
        detach.forEach(off => off());
        if (this.shell === shell) this.shell = null;
      },
    });
    this.shell = shell;
    const root = shell.card;
    const form = root.querySelector<HTMLFormElement>('#form-create-channel')!;
    const inputName = root.querySelector<HTMLInputElement>('#input-channel-name')!;
    detach.push(attachChannelPrivacyFields(root), attachChannelCategoryFields(root), attachChannelBotCommandsField(root),
      attachInputEmojiPicker(inputName, root.querySelector<HTMLElement>('#btn-emoji-channel-name')!));
    useAppValidation(form, shell.signal);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = inputName.value.trim();
      const type = root.querySelector<HTMLInputElement>('input[name="channel-type"]:checked')?.value as ChannelType;
      if (!name || shell.closed) return;
      const privacy = readChannelPrivacyFields(root);
      try {
        await networkClient.sendRequest(MessageType.CHANNEL_CREATE, {
          name,
          ...readChannelCategoryFields(root),
          type,
          isPrivate: privacy.isPrivate,
          allowedRoleIds: privacy.allowedRoleIds,
          botCommandsEnabled: readChannelBotCommandsField(root),
        });
        shell.close('api');
      } catch (err: unknown) {
        if (!shell.closed) reportError(errorMessage(err, t('channelModal.error')));
      }
    }, { signal: shell.signal });
  }

  public close(): void {
    this.shell?.close('api');
  }
}

export const createChannelModal = new CreateChannelModal();
