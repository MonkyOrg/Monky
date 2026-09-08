import { ChannelSummary, MessageType } from '@monky/shared';
import { networkClient } from '../core/NetworkClient';
import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { enableBackdropClose } from '../utils/modal';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import {
  attachChannelPrivacyFields,
  readChannelBotCommandsField,
  renderChannelBotCommandsField,
  readChannelPrivacyFields,
  renderChannelPrivacyFields,
} from './channelFormFields';

/**
 * Editing an existing channel (#384): rename it and control who gets in.
 *
 * Separate from CreateChannelModal because the channel type cannot be changed
 * after creation — turning a text channel into a voice one would strand its
 * message history — so this dialog shows the type as read-only.
 */
export class EditChannelModal {
  private modalEl: HTMLElement | null = null;
  private detachPrivacyFields: (() => void) | null = null;
  private detachEmojiPicker: (() => void) | null = null;

  public open(channelId: string): void {
    const channel = serverStore.serverDetails?.channels.find((c) => c.id === channelId);
    if (!channel) return;

    this.close();
    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = this.buildMarkup(channel);

    document.body.appendChild(this.modalEl);
    this.attachEvents(channel);
  }

  private buildMarkup(channel: ChannelSummary): string {
    const isVoice = channel.type === 'VOICE';
    const typeIcon = isVoice ? 'volume_up' : 'tag';
    const typeColor = isVoice ? 'var(--success)' : 'var(--text-muted)';
    const typeLabel = isVoice ? t('channelModal.typeVoice') : t('channelModal.typeText');

    return `
      <div class="modal-card">
        <div class="modal-header">
          <div class="modal-title">${t('channelModal.editTitle')}</div>
          <button id="modal-close" class="modal-close-btn">&times;</button>
        </div>

        <div id="channel-error-banner" class="error-banner"></div>

        <form id="form-edit-channel">
          <div class="form-group">
            <label>${t('channelModal.typeLabel')}</label>
            <div class="channel-type-readonly">
              <span class="material-symbols-outlined md-16" style="color: ${typeColor};">${typeIcon}</span>
              <span>${typeLabel}</span>
            </div>
          </div>

          <div class="form-group">
            <label>${t('channelModal.nameLabel')}</label>
            <div class="input-with-emoji-container">
              <input id="input-channel-name" type="text" value="${escapeHtml(channel.name)}" required minlength="2" maxlength="50" style="padding-right: 36px;">
              <button type="button" id="btn-emoji-channel-name" class="btn-input-emoji" title="${t('chat.emojiPickerTitle')}">
                <span class="material-symbols-outlined md-18">mood</span>
              </button>
            </div>
          </div>

          ${renderChannelPrivacyFields({
            isPrivate: channel.isPrivate,
            allowedRoleIds: channel.allowedRoleIds,
          })}
          ${renderChannelBotCommandsField(channel.botCommandsEnabled, channel.type)}

          <div class="modal-footer">
            <button type="button" id="btn-cancel" class="btn btn-secondary">${t('common.cancel')}</button>
            <button type="submit" id="btn-save" class="btn btn-primary">${t('channelModal.saveSubmit')}</button>
          </div>
        </form>
      </div>
    `;
  }

  private attachEvents(channel: ChannelSummary): void {
    if (!this.modalEl) return;

    const btnClose = this.modalEl.querySelector('#modal-close');
    const btnCancel = this.modalEl.querySelector('#btn-cancel');
    const form = this.modalEl.querySelector('#form-edit-channel') as HTMLFormElement;
    const inputName = this.modalEl.querySelector('#input-channel-name') as HTMLInputElement;
    const btnEmoji = this.modalEl.querySelector('#btn-emoji-channel-name') as HTMLElement | null;
    const modalCard = this.modalEl.querySelector('.modal-card') as HTMLElement | null;

    btnClose?.addEventListener('click', () => this.close());
    btnCancel?.addEventListener('click', () => this.close());
    enableBackdropClose(this.modalEl, () => this.close());
    this.detachPrivacyFields = attachChannelPrivacyFields(this.modalEl);

    if (btnEmoji && inputName) {
      this.detachEmojiPicker = attachInputEmojiPicker(inputName, btnEmoji);
    }

    form?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = inputName?.value.trim();
      if (!name || !this.modalEl) return;

      const privacy = readChannelPrivacyFields(this.modalEl);

      try {
        await networkClient.sendRequest(MessageType.CHANNEL_UPDATE, {
          channelId: channel.id,
          name,
          isPrivate: privacy.isPrivate,
          allowedRoleIds: privacy.allowedRoleIds,
          ...(channel.type === 'TEXT' ? { botCommandsEnabled: readChannelBotCommandsField(this.modalEl) } : {}),
        });
        this.close();
      } catch (err: any) {
        const banner = this.modalEl?.querySelector('#channel-error-banner') as HTMLElement | null;
        if (banner) {
          banner.innerText = err.message || t('channelModal.editError');
          banner.classList.add('show');
        }
      }
    });
  }

  public close(): void {
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

export const editChannelModal = new EditChannelModal();
