import { LIMITS } from '@monky/shared';
import logoUrl from '../assets/Logo.png';
import { t } from '../i18n';
import { connectionStore } from '../stores/connectionStore';
import { stampProfileChange } from '../core/profileSync';
import { getAvatarUrl } from '../utils/avatar';
import { escapeHtml } from '../utils/html';
import { attachInputEmojiPicker } from '../utils/inputEmojiPicker';
import { pickAndCropImage } from './ImageCropModal';
import { showAlert } from './Dialog';

export function hasValidLocalProfile(): boolean {
  const nickname = connectionStore.savedNickname.trim();
  return nickname.length >= LIMITS.MIN_NICKNAME_LENGTH && nickname.length <= LIMITS.MAX_NICKNAME_LENGTH;
}

export function showIdentityProfileStep(container: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let avatar = connectionStore.savedAvatarBase64 || '';
    let avatarPicked = false;
    let detachEmoji: (() => void) | null = null;
    const render = (): void => {
      detachEmoji?.();
      container.innerHTML = `
        <div class="identity-onboarding identity-profile-step">
          <img src="${logoUrl}" alt="Monky" class="identity-profile-logo">
          <h1>${t('identity.profileTitle')}</h1>
          <p>${t('identity.profileDesc')}</p>
          <form id="identity-profile-form" class="identity-profile-form">
            <button type="button" id="identity-profile-avatar" class="identity-profile-avatar" title="${t('settings.avatarTitle')}">
              <img id="identity-profile-avatar-preview" src="${escapeHtml(getAvatarUrl(avatar))}" alt="Avatar" data-fallback="avatar">
              <span class="identity-profile-avatar-overlay">
                <span class="material-symbols-outlined md-22" aria-hidden="true">photo_camera</span>
              </span>
            </button>
            <div class="form-group">
              <label for="identity-profile-nickname">${t('connection.nicknameLabel')}</label>
              <div class="input-with-emoji-container">
                <input id="identity-profile-nickname" type="text" required
                  minlength="${LIMITS.MIN_NICKNAME_LENGTH}" maxlength="${LIMITS.MAX_NICKNAME_LENGTH}"
                  value="${escapeHtml(connectionStore.savedNickname)}"
                  placeholder="${t('connection.nicknamePlaceholder')}" autocomplete="nickname">
                <button type="button" id="identity-profile-emoji" class="btn-input-emoji" title="${t('chat.emojiPickerTitle')}">
                  <span class="material-symbols-outlined md-18">mood</span>
                </button>
              </div>
              <small>${t('identity.profileNicknameHint', { min: LIMITS.MIN_NICKNAME_LENGTH, max: LIMITS.MAX_NICKNAME_LENGTH })}</small>
            </div>
            <button type="submit" class="btn btn-primary" id="identity-profile-submit">
              <span class="material-symbols-outlined md-18" aria-hidden="true">check</span>
              ${t('identity.profileContinue')}
            </button>
          </form>
        </div>
      `;
      const input = container.querySelector<HTMLInputElement>('#identity-profile-nickname');
      const emoji = container.querySelector<HTMLElement>('#identity-profile-emoji');
      if (input && emoji) detachEmoji = attachInputEmojiPicker(input, emoji);
      input?.focus({ preventScroll: true });
      input?.select();
      container.querySelector<HTMLButtonElement>('#identity-profile-avatar')?.addEventListener('click', async (event) => {
        const cropped = await pickAndCropImage(event.currentTarget as HTMLElement);
        if (!cropped) return;
        avatar = cropped;
        avatarPicked = true;
        const preview = container.querySelector<HTMLImageElement>('#identity-profile-avatar-preview');
        if (preview) preview.src = cropped;
      });
      container.querySelector<HTMLFormElement>('#identity-profile-form')?.addEventListener('submit', async (event) => {
        event.preventDefault();
        const nickname = input?.value.trim() ?? '';
        if (nickname.length < LIMITS.MIN_NICKNAME_LENGTH || nickname.length > LIMITS.MAX_NICKNAME_LENGTH) {
          await showAlert({ title: t('common.error'), message: t('protocolError.nicknameInvalid'), variant: 'danger' });
          input?.focus();
          return;
        }
        connectionStore.saveUserProfile(nickname, avatar);
        // Chosen now, so it wins over what this identity used on other devices.
        stampProfileChange({ nickname: true, avatar: avatarPicked });
        detachEmoji?.();
        detachEmoji = null;
        resolve();
      });
    };
    render();
  });
}
