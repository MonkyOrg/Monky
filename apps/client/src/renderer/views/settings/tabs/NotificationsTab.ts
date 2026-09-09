import { settingsStore } from '../../../stores/settingsStore';
import { soundEffects, getSoundLabels, SoundEffectType } from '../../../core/SoundEffects';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';

export class NotificationsTab {
  public renderHtml(): string {
    return `
      <!-- Chat Notifications -->
      <div data-settings-section="chat-notifications" data-settings-label="${escapeHtml(t('settings.chatNotifications'))}" class="form-group" style="margin-bottom: 16px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">chat</span>
          ${t('settings.chatNotifications')}
        </label>
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
          ${t('settings.chatNotificationsDesc')}
        </div>
        <div class="form-group" style="padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); margin-top: 8px; margin-bottom: 10px;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div>
              <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-chat-sound">
                <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">notifications_active</span>
                Tocar som ao receber mensagens
              </label>
              <div style="font-size: 11px; color: var(--text-muted);">
                Reproduz um breve som quando uma nova mensagem de outra pessoa chega em qualquer canal de texto.
              </div>
            </div>
            <label class="toggle-switch" aria-label="Tocar som ao receber mensagens">
              <input id="checkbox-chat-sound" type="checkbox" ${settingsStore.chatMessageSoundEnabled ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
        <div class="form-group" style="padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); margin-bottom: 0;">
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
            <div>
              <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-chat-sound-mentions">
                <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">alternate_email</span>
                ${t('settings.chatSoundMentionsOnly')}
              </label>
              <div style="font-size: 11px; color: var(--text-muted);">
                Toca o som somente quando seu apelido for citado na mensagem (ex.: @seu_apelido).
              </div>
            </div>
            <label class="toggle-switch" aria-label="${t('settings.chatSoundMentionsOnly')}">
              <input id="checkbox-chat-sound-mentions" type="checkbox" ${settingsStore.chatMessageSoundMentionsOnly ? 'checked' : ''}>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>
      </div>

      <!-- Custom Sounds -->
      <div data-settings-section="custom-sounds" data-settings-label="${escapeHtml(t('settings.customSounds'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">music_note</span>
          ${t('settings.customSounds')}
        </label>
        <div id="custom-sounds-list" style="display: flex; flex-direction: column; gap: 6px; margin-top: 6px;">
          ${this.getCustomSoundsHtml()}
        </div>
        <button id="btn-reset-all-sounds" class="btn btn-secondary" style="margin-top: 8px; font-size: 11px; padding: 4px 10px;">
          <span class="material-symbols-outlined md-14" style="margin-right: 4px;">restart_alt</span>
          ${t('settings.resetAllSounds')}
        </button>
      </div>
    `;
  }

  public getCustomSoundsHtml(): string {
    const labels = getSoundLabels();
    const keys = Object.keys(labels) as SoundEffectType[];
    return keys.map((key) => {
      const label = labels[key];
      const isCustom = Boolean(settingsStore.customSounds[key]);
      return `
        <div style="display: flex; align-items: center; gap: 8px; padding: 4px 0;">
          <span style="flex: 1; font-size: 12px; color: var(--text-secondary);">${label}</span>
          ${isCustom ? `<span style="font-size: 10px; color: var(--accent-primary);">${t('settings.customBadge')}</span>` : ''}
          <button class="btn-sound-preview btn btn-secondary" data-sound-key="${key}" style="font-size: 10px; padding: 2px 8px;" title="${t('settings.playSound')}">
            <span class="material-symbols-outlined md-14">play_arrow</span>
          </button>
          <button class="btn-sound-change btn btn-secondary" data-sound-key="${key}" style="font-size: 10px; padding: 2px 8px;" title="${t('settings.changeSound')}">
            <span class="material-symbols-outlined md-14">folder_open</span>
          </button>
          ${isCustom ? `<button class="btn-sound-reset btn btn-secondary" data-sound-key="${key}" style="font-size: 10px; padding: 2px 8px;" title="${t('settings.resetSound')}">
            <span class="material-symbols-outlined md-14">restart_alt</span>
          </button>` : ''}
        </div>`;
    }).join('');
  }

  public attachEvents(container: HTMLElement): void {
    const checkboxChatSound = container.querySelector<HTMLInputElement>('#checkbox-chat-sound');
    const checkboxChatSoundMentions = container.querySelector<HTMLInputElement>('#checkbox-chat-sound-mentions');
    const btnResetAll = container.querySelector<HTMLButtonElement>('#btn-reset-all-sounds');

    checkboxChatSound?.addEventListener('change', () => {
      settingsStore.chatMessageSoundEnabled = checkboxChatSound.checked;
      settingsStore.save();
    });

    checkboxChatSoundMentions?.addEventListener('change', () => {
      settingsStore.chatMessageSoundMentionsOnly = checkboxChatSoundMentions.checked;
      settingsStore.save();
    });

    btnResetAll?.addEventListener('click', () => {
      settingsStore.customSounds = {};
      settingsStore.save();
      soundEffects.loadAll();
      const list = container.querySelector<HTMLElement>('#custom-sounds-list');
      if (list) {
        list.innerHTML = this.getCustomSoundsHtml();
        this.attachCustomSoundsListeners(container);
      }
    });

    this.attachCustomSoundsListeners(container);
  }

  public attachCustomSoundsListeners(container: HTMLElement): void {
    container.querySelectorAll('.btn-sound-preview').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-sound-key') as SoundEffectType;
        if (key) soundEffects.play(key);
      });
    });

    container.querySelectorAll('.btn-sound-change').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.getAttribute('data-sound-key') as SoundEffectType;
        if (!key || !window.api?.selectSoundFile) return;
        const dataUrl = await window.api.selectSoundFile();
        if (dataUrl) {
          settingsStore.customSounds[key] = dataUrl;
          settingsStore.save();
          soundEffects.loadAll();
          const list = container.querySelector<HTMLElement>('#custom-sounds-list');
          if (list) {
            list.innerHTML = this.getCustomSoundsHtml();
            this.attachCustomSoundsListeners(container);
          }
        }
      });
    });

    container.querySelectorAll('.btn-sound-reset').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = btn.getAttribute('data-sound-key') as SoundEffectType;
        if (key) {
          delete settingsStore.customSounds[key];
          settingsStore.save();
          soundEffects.loadAll();
          const list = container.querySelector<HTMLElement>('#custom-sounds-list');
          if (list) {
            list.innerHTML = this.getCustomSoundsHtml();
            this.attachCustomSoundsListeners(container);
          }
        }
      });
    });
  }
}
