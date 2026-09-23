import { settingsStore } from '../../../stores/settingsStore';
import { soundEffects, getSoundLabels, isSoundEffectType, SOUND_EFFECT_TYPES } from '../../../core/SoundEffects';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import { clientLog } from '../../../core/ClientLogService';
import { showAlert } from '../../Dialog';

export class NotificationsTab {
  private unbind: (() => void) | null = null;
  private generation = 0;

  public cleanup(): void {
    this.generation++;
    this.unbind?.();
    this.unbind = null;
  }

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
                ${t('settings.chatSoundEnabled')}
              </label>
              <div style="font-size: 11px; color: var(--text-muted);">
                ${t('settings.chatSoundEnabledDesc')}
              </div>
            </div>
            <label class="toggle-switch" aria-label="${escapeHtml(t('settings.chatSoundEnabled'))}">
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
                ${t('settings.chatSoundMentionsDesc')}
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
    return SOUND_EFFECT_TYPES.map((key) => {
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
    this.cleanup();
    const generation = this.generation;
    const checkboxChatSound = container.querySelector<HTMLInputElement>('#checkbox-chat-sound');
    const checkboxChatSoundMentions = container.querySelector<HTMLInputElement>('#checkbox-chat-sound-mentions');

    const onChatSound = () => {
      if (checkboxChatSound) {
        settingsStore.chatMessageSoundEnabled = checkboxChatSound.checked;
        settingsStore.save();
      }
    };

    const onMentions = () => {
      if (checkboxChatSoundMentions) {
        settingsStore.chatMessageSoundMentionsOnly = checkboxChatSoundMentions.checked;
        settingsStore.save();
      }
    };

    const onClick = (event: MouseEvent) => {
      const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(
        '.btn-sound-preview, .btn-sound-change, .btn-sound-reset, #btn-reset-all-sounds') : null;
      if (!button || !container.contains(button) || button.disabled) return;
      event.preventDefault();
      void this.handleSoundAction(button, container, generation);
    };
    checkboxChatSound?.addEventListener('change', onChatSound);
    checkboxChatSoundMentions?.addEventListener('change', onMentions);
    container.addEventListener('click', onClick);
    this.unbind = () => {
      checkboxChatSound?.removeEventListener('change', onChatSound);
      checkboxChatSoundMentions?.removeEventListener('change', onMentions);
      container.removeEventListener('click', onClick);
    };
  }

  private saveCustomSounds(next: typeof settingsStore.customSounds): void {
    const previous = settingsStore.customSounds;
    settingsStore.customSounds = next;
    try {
      settingsStore.save();
    } catch (error: unknown) {
      settingsStore.customSounds = previous;
      throw error;
    }
  }

  private async handleSoundAction(button: HTMLButtonElement, container: HTMLElement, generation: number): Promise<void> {
    button.disabled = true;
    try {
      if (button.id === 'btn-reset-all-sounds') {
        this.saveCustomSounds({});
        soundEffects.loadAll();
      } else {
        const key = button.dataset.soundKey;
        if (!isSoundEffectType(key)) throw new Error('Unknown sound effect control');
        if (button.classList.contains('btn-sound-preview')) {
          soundEffects.play(key);
          return;
        }
        if (button.classList.contains('btn-sound-change')) {
          if (!window.api?.selectSoundFile) throw new Error('Native sound selection is unavailable');
          const dataUrl = await window.api.selectSoundFile();
          if (generation !== this.generation || !button.isConnected || !dataUrl) return;
          this.saveCustomSounds({ ...settingsStore.customSounds, [key]: dataUrl });
          soundEffects.reloadSound(key, dataUrl);
        } else {
          const next = { ...settingsStore.customSounds };
          delete next[key];
          this.saveCustomSounds(next);
          soundEffects.reloadSound(key);
        }
      }
      const list = container.querySelector<HTMLElement>('#custom-sounds-list');
      if (list) list.innerHTML = this.getCustomSoundsHtml();
    } catch (error: unknown) {
      clientLog.warn('AUDIO', 'Could not update custom sound preferences', {
        error: error instanceof Error ? error.message : String(error),
      });
      if (generation === this.generation && container.isConnected) {
        await showAlert({ message: t('settings.customSoundFailed'), variant: 'danger' });
      }
    } finally {
      if (button.isConnected) button.disabled = false;
    }
  }
}
