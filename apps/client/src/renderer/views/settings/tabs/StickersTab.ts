import { settingsStore } from '../../../stores/settingsStore';
import { stickerService } from '../../../core/StickerService';
import { t, tCount } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';

/**
 * Sticker folder settings (#356). Mirrors SoundboardTab: the folder is picked
 * from inside the emoji picker too, but having it here is what makes it
 * discoverable alongside every other app-level setting.
 */
export class StickersTab {
  public renderHtml(): string {
    return `
      <div data-settings-section="sticker-folder" data-settings-label="${escapeHtml(t('settings.stickerFolder'))}" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">mood</span>
          ${t('settings.stickersSection')}
        </span>
      </div>

      <div class="form-group" style="margin-bottom: 12px;">
        <label>${t('settings.stickerFolder')}</label>
        <div style="display: flex; gap: 8px; align-items: center;">
          <input id="input-stickers-path" type="text" readonly value="${settingsStore.stickersFolderPath || ''}" placeholder="${t('settings.noFolderPlaceholder')}" style="flex: 1; font-size: 12px; cursor: pointer;">
          <button type="button" id="btn-refresh-stickers" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px; white-space: nowrap;" title="${t('emojiPicker.refresh')}">
            <span class="material-symbols-outlined md-14">refresh</span>
          </button>
          <button type="button" id="btn-select-stickers-folder" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px; white-space: nowrap;">
            <span class="material-symbols-outlined md-14" style="margin-right: 4px;">folder_open</span>
            ${t('emojiPicker.chooseFolder')}
          </button>
        </div>
        <div id="stickers-folder-info" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
          ${this.folderInfo()}
        </div>
      </div>

      <div class="form-group" style="padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
        <div style="font-size: 11px; color: var(--text-muted);">
          ${t('settings.stickersHint')}
        </div>
      </div>
    `;
  }

  private folderInfo(): string {
    if (!settingsStore.stickersFolderPath) return t('settings.stickersFormats');
    return tCount('emojiPicker.stickersFound', stickerService.getStickers().length);
  }

  public attachEvents(container: HTMLElement): void {
    const inputPath = container.querySelector<HTMLInputElement>('#input-stickers-path');
    const btnSelectFolder = container.querySelector<HTMLButtonElement>('#btn-select-stickers-folder');
    const btnRefresh = container.querySelector<HTMLButtonElement>('#btn-refresh-stickers');

    const updateInfo = () => {
      const info = container.querySelector<HTMLElement>('#stickers-folder-info');
      if (info) info.textContent = this.folderInfo();
    };

    const handlePickFolder = async () => {
      if (!window.api?.selectStickersFolder) return;
      const folder = await window.api.selectStickersFolder();
      if (!folder) return;
      settingsStore.stickersFolderPath = folder;
      settingsStore.save();
      if (inputPath) inputPath.value = folder;
      await stickerService.loadStickers(true);
      updateInfo();
    };

    btnSelectFolder?.addEventListener('click', handlePickFolder);
    inputPath?.addEventListener('click', handlePickFolder);

    btnRefresh?.addEventListener('click', () => {
      void stickerService.loadStickers(true).then(updateInfo);
    });

    // The folder can change on disk while the app runs, so the count shown here
    // is refreshed as soon as the tab is rendered rather than trusting a cache.
    void stickerService.loadStickers(true).then(updateInfo);
  }
}
