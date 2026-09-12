import { settingsStore } from '../../../stores/settingsStore';
import { soundboardService, SoundItem } from '../../../core/SoundboardService';
import { getLanguage, t, tCount } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import { matchesSearch } from '../../../utils/search';
import { sortFavoritesFirst } from '../../../utils/favoriteOrder';
import { FavoriteListMotion, type FavoriteMotionKind } from '../../../utils/favoriteMotion';
import { captureShortcut } from '../../../utils/keybind';
import { favoritesStore, soundFavoriteKey } from '../../../stores/favoritesStore';
import { clientLog } from '../../../core/ClientLogService';
import { renderFavoriteToggle, renderFavoritesFilter } from '../../FavoritesControls';
import { showAlert } from '../../Dialog';

export class SoundboardTab {
  private searchQuery: string = '';
  private favoritesOnly = false;
  private pickingFolder = false;
  private readonly favoriteMotion = new FavoriteListMotion();

  public renderHtml(): string {
    this.favoriteMotion.cancel();
    return `
      <div data-settings-section="sound-folder" data-settings-label="${escapeHtml(t('settings.soundFolder'))}" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">music_note</span>
          ${t('settings.soundboardSection')}
        </span>
      </div>

      <div class="form-group" style="margin-bottom: 12px;">
        <label>${t('settings.soundFolder')}</label>
        <div style="display: flex; gap: 8px; align-items: center;">
          <input id="input-soundboard-path" type="text" readonly value="${escapeHtml(settingsStore.soundboardFolderPath || '')}" placeholder="${t('settings.noFolderPlaceholder')}" style="flex: 1; font-size: 12px; cursor: pointer;">
          <button type="button" id="btn-select-soundboard-folder" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px; white-space: nowrap;">
            <span class="material-symbols-outlined md-14" style="margin-right: 4px;">folder_open</span>
            ${t('soundboard.chooseFolder')}
          </button>
        </div>
        <div id="soundboard-folder-info" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">
          ${settingsStore.soundboardFolderPath ? tCount('settings.soundsFound', soundboardService.getSounds().length) : t('soundboard.formatsBadge')}
        </div>
      </div>

      <div data-settings-section="soundboard-volume" data-settings-label="${escapeHtml(t('settings.soundboardVolume'))}" class="form-group" style="margin-bottom: 12px;">
        <label style="display: flex; align-items: center; justify-content: space-between;">
          <span>${t('settings.soundboardVolume')}</span>
          <span id="soundboard-vol-val" style="font-family: var(--font-mono); font-size: 12px;">${settingsStore.soundboardVolume}%</span>
        </label>
        <input id="slider-soundboard-vol" class="sb-slider" type="range" min="0" max="100" value="${settingsStore.soundboardVolume}" style="--slider-progress: ${settingsStore.soundboardVolume}%; width: 100%;">
        <div style="font-size: 11px; color: var(--text-muted); margin-top: 2px;">
          ${t('settings.soundboardVolumeDesc')}
        </div>
      </div>

      <div class="form-group" style="padding: 10px 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md);">
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div>
            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-soundboard-mute">
              <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">volume_off</span>
              ${t('settings.soundboardMute')}
            </label>
            <div style="font-size: 11px; color: var(--text-muted);">
              ${t('settings.soundboardMuteDesc')}
            </div>
          </div>
          <label class="toggle-switch" aria-label="${t('settings.soundboardMute')}">
            <input id="checkbox-soundboard-mute" type="checkbox" ${settingsStore.soundboardMuted ? 'checked' : ''}>
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <!-- Soundboard Shortcuts Table -->
      <div data-settings-section="soundboard-shortcuts" data-settings-label="${escapeHtml(t('soundboard.shortcut'))}" style="border-top: 1px solid var(--border-color); padding-top: 14px; margin-top: 14px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
          <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 0;">
            <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">keyboard</span>
            ${t('soundboard.shortcut')}
          </label>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 8px;">
          ${t('soundboard.footerHint')}
        </div>
        <div id="soundboard-shortcuts-table-container">
          ${this.renderShortcutsTable()}
        </div>
      </div>
    `;
  }

  public renderShortcutsTable(): string {
    const sounds = soundboardService.getSounds();
    if (sounds.length === 0) {
      return `
        <div class="favorite-motion-empty" style="padding: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); text-align: center; color: var(--text-muted); font-size: 12px;">
          ${t('soundboard.noAudioFilesTitle')}
        </div>
      `;
    }

    const filteredSounds = sortFavoritesFirst(
      sounds.filter(sound => (!this.favoritesOnly || favoritesStore.isSoundFavorite(sound.filePath))
        && (!this.searchQuery.trim() || matchesSearch(sound.name, this.searchQuery))),
      sound => ({
        favorite: favoritesStore.isSoundFavorite(sound.filePath),
        name: sound.name,
        identity: soundFavoriteKey(sound.filePath),
      }),
      getLanguage()
    );
    const filterHtml = `<div style="margin-bottom: 8px;">${renderFavoritesFilter('sb-settings-filter', this.favoritesOnly)}</div>`;

    const searchHtml = sounds.length > 3 || this.searchQuery ? `
      <div style="margin-bottom: 8px; position: relative; display: flex; align-items: center;">
        <span class="material-symbols-outlined md-16" style="position: absolute; left: 8px; color: var(--text-muted); pointer-events: none;">search</span>
        <input
          id="sb-shortcuts-search-input"
          type="text"
          placeholder="${t('soundboard.searchPlaceholder')}"
          value="${escapeHtml(this.searchQuery)}"
          style="width: 100%; height: 28px; padding: 0 10px 0 28px; font-size: 11px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: var(--radius-sm); color: var(--text-primary);"
        />
      </div>
    ` : '';

    if (this.favoritesOnly && !sounds.some(sound => favoritesStore.isSoundFavorite(sound.filePath))) {
      return `${filterHtml}${searchHtml}
        <div class="favorites-empty" role="status">
          <strong>${t('favorites.emptySoundsTitle')}</strong>
          <span>${t('favorites.emptySoundsDescription')}</span>
          <button type="button" id="sb-settings-show-all" class="btn btn-secondary">${t('favorites.showAll')}</button>
        </div>`;
    }

    if (filteredSounds.length === 0) {
      return `
        ${filterHtml}
        ${searchHtml}
        <div class="favorite-motion-empty" style="padding: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); text-align: center; color: var(--text-muted); font-size: 12px;">
          ${t('soundboard.noSearchResultsTitle')}
        </div>
      `;
    }

    const rows = filteredSounds.map((sound: SoundItem) => {
      const shortcut = settingsStore.soundboardShortcuts[sound.name];
      const displayKey = shortcut ? shortcut.display : '—';
      const hasShortcut = Boolean(shortcut);

      return `
        <div class="sb-shortcut-row" data-soundname="${escapeHtml(sound.name)}" style="display: flex; align-items: center; justify-content: space-between; padding: 6px 10px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-sm); margin-bottom: 4px; gap: 8px;">
          <span style="font-size: 12px; color: var(--text-primary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${escapeHtml(sound.name)}
          </span>
          <div style="display: flex; align-items: center; gap: 6px;">
            ${renderFavoriteToggle(soundFavoriteKey(sound.filePath), sound.name, favoritesStore.isSoundFavorite(sound.filePath))}
            <span class="sb-keybind-badge ${hasShortcut ? 'has-key' : ''}" style="font-family: var(--font-mono); font-size: 11px; padding: 2px 8px; background: rgba(255,255,255,0.06); border-radius: 4px; border: 1px solid var(--border-color); color: ${hasShortcut ? 'var(--accent-primary)' : 'var(--text-muted)'}; min-width: 60px; text-align: center;">
              ${escapeHtml(displayKey)}
            </span>
            <button type="button" class="btn-bind-shortcut btn btn-secondary" data-sound-name="${escapeHtml(sound.name)}" style="font-size: 11px; padding: 2px 8px; height: 24px;" title="${hasShortcut ? t('soundboard.keybindTitle') : t('soundboard.addShortcut')}">
              ${hasShortcut ? t('soundboard.keybindTitle') : t('soundboard.addShortcut')}
            </button>
            ${hasShortcut ? `
              <button type="button" class="btn-clear-shortcut btn btn-icon" data-sound-name="${escapeHtml(sound.name)}" style="width: 24px; height: 24px;" title="${t('soundboard.removeShortcut')}">
                <span class="material-symbols-outlined md-14" style="color: var(--danger);">close</span>
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    return `
      ${filterHtml}
      ${searchHtml}
      <div class="sb-shortcuts-list" style="max-height: 200px; overflow-y: auto; padding-right: 2px;">${rows}</div>
    `;
  }

  public attachEvents(container: HTMLElement): void {
    this.favoriteMotion.cancel();
    const inputPath = container.querySelector<HTMLInputElement>('#input-soundboard-path');
    const btnSelectFolder = container.querySelector<HTMLButtonElement>('#btn-select-soundboard-folder');
    const sliderVol = container.querySelector<HTMLInputElement>('#slider-soundboard-vol');
    const volVal = container.querySelector<HTMLElement>('#soundboard-vol-val');
    const checkboxMute = container.querySelector<HTMLInputElement>('#checkbox-soundboard-mute');

    const handlePickFolder = async () => {
      if (this.pickingFolder) return;
      this.pickingFolder = true;
      if (btnSelectFolder) btnSelectFolder.disabled = true;
      try {
        const folder = await soundboardService.selectFolder();
        if (!folder || !container.isConnected) return;
        if (inputPath) inputPath.value = folder;
        const info = container.querySelector<HTMLElement>('#soundboard-folder-info');
        if (info) {
          info.textContent = tCount('settings.soundsFound', soundboardService.getSounds().length);
        }
        this.refreshTable(container);
      } catch (error: unknown) {
        clientLog.warn('AUDIO', 'Could not select the soundboard settings folder', {
          error: error instanceof Error ? error.message : String(error),
        });
        if (container.isConnected) {
          await showAlert({ title: t('common.error'), message: t('soundboard.chooseFolderFailed'), variant: 'danger' });
        }
      } finally {
        this.pickingFolder = false;
        if (btnSelectFolder) btnSelectFolder.disabled = false;
      }
    };

    btnSelectFolder?.addEventListener('click', handlePickFolder);
    inputPath?.addEventListener('click', handlePickFolder);

    sliderVol?.addEventListener('input', () => {
      const val = parseInt(sliderVol.value, 10);
      sliderVol.style.setProperty('--slider-progress', `${val}%`);
      if (volVal) volVal.textContent = `${val}%`;
      settingsStore.soundboardVolume = val;
      settingsStore.save();
    });

    checkboxMute?.addEventListener('change', () => {
      settingsStore.soundboardMuted = checkboxMute.checked;
      settingsStore.save();
    });

    this.attachShortcutButtons(container);
  }

  public attachShortcutButtons(container: HTMLElement): void {
    const table = container.querySelector('#soundboard-shortcuts-table-container');
    table?.querySelectorAll<HTMLButtonElement>('[data-favorites-filter]').forEach(button => {
      button.addEventListener('click', () => {
        this.favoritesOnly = button.dataset.favoritesFilter === 'favorites';
        this.refreshTable(container, 'filter');
      });
    });
    table?.querySelector('#sb-settings-show-all')?.addEventListener('click', () => {
      this.favoritesOnly = false;
      this.refreshTable(container, 'filter');
      container.querySelector<HTMLButtonElement>('#sb-settings-filter-all')?.focus();
    });
    table?.querySelectorAll<HTMLButtonElement>('.favorite-toggle').forEach(button => {
      button.addEventListener('click', async event => {
        event.preventDefault();
        event.stopPropagation();
        const key = button.dataset.favoriteKey;
        if (!key) return;
        try {
          favoritesStore.toggleSound(key);
          this.refreshTable(container, 'reorder');
        } catch (error: unknown) {
          clientLog.warn('STORE', 'Could not save the sound favorite in settings', {
            error: error instanceof Error ? error.message : String(error),
          });
          await showAlert({ title: t('common.error'), message: t('favorites.saveFailed'), variant: 'danger' });
        }
      });
    });

    const searchInput = container.querySelector<HTMLInputElement>('#sb-shortcuts-search-input');
    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.refreshTable(container);
      const newInput = container.querySelector<HTMLInputElement>('#sb-shortcuts-search-input');
      if (newInput) {
        newInput.focus();
        newInput.setSelectionRange(newInput.value.length, newInput.value.length);
      }
    });

    container.querySelectorAll('.btn-bind-shortcut').forEach((btn) => {
      btn.addEventListener('click', () => {
        const soundName = btn.getAttribute('data-sound-name');
        if (soundName) this.openShortcutModal(container, soundName);
      });
    });

    container.querySelectorAll('.btn-clear-shortcut').forEach((btn) => {
      btn.addEventListener('click', () => {
        const soundName = btn.getAttribute('data-sound-name');
        if (soundName) {
          delete settingsStore.soundboardShortcuts[soundName];
          settingsStore.save();
          soundboardService.syncShortcuts();
          this.refreshTable(container);
        }
      });
    });
  }

  private refreshTable(container: HTMLElement, animate: FavoriteMotionKind | false = false): void {
    const table = container.querySelector<HTMLElement>('#soundboard-shortcuts-table-container');
    if (!table || !container.isConnected) return;
    this.favoriteMotion.update(table, '.sb-shortcut-row', () => {
      const scrollTop = table.scrollTop;
      const listScrollTop = table.querySelector('.sb-shortcuts-list')?.scrollTop ?? 0;
      const focused = document.activeElement;
      const buttons = Array.from(table.querySelectorAll<HTMLButtonElement>('.favorite-toggle'));
      const favorite = focused instanceof HTMLButtonElement && buttons.includes(focused) ? focused : null;
      const favoriteIndex = favorite ? buttons.indexOf(favorite) : -1;
      const filterId = focused instanceof HTMLButtonElement && focused.hasAttribute('data-favorites-filter') ? focused.id : null;
      table.innerHTML = this.renderShortcutsTable();
      this.attachShortcutButtons(container);
      table.scrollTop = scrollTop;
      const list = table.querySelector('.sb-shortcuts-list');
      if (list) list.scrollTop = listScrollTop;
      if (favorite) {
        const nextButtons = Array.from(table.querySelectorAll<HTMLButtonElement>('.favorite-toggle'));
        const next = nextButtons.find(button => button.dataset.favoriteKey === favorite.dataset.favoriteKey)
          ?? nextButtons[Math.min(favoriteIndex, nextButtons.length - 1)]
          ?? table.querySelector<HTMLButtonElement>('#sb-settings-filter-favorites');
        next?.focus({ preventScroll: true });
        next?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      } else if (filterId) {
        const next = table.querySelector<HTMLButtonElement>(`#${filterId}`);
        next?.focus({ preventScroll: true });
        next?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
    }, animate);
  }

  private openShortcutModal(container: HTMLElement, soundName: string): void {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.zIndex = '10002';

    backdrop.innerHTML = `
      <div class="modal-card" style="width: 340px; text-align: center;">
        <div class="modal-header">
          <div class="modal-title">${t('soundboard.keybindTitle')}</div>
        </div>
        <div class="modal-body" style="padding: 16px;">
          <div style="font-size: 13px; color: var(--text-secondary); margin-bottom: 12px;">
            ${t('soundboard.keybindPrompt', { sound: escapeHtml(soundName) })}
          </div>
          <div id="sb-keybind-capture-box" style="padding: 14px; background: var(--bg-card); border: 2px dashed var(--accent-primary); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: 14px; color: var(--accent-primary); min-height: 48px; display: flex; align-items: center; justify-content: center;">
            ${t('soundboard.keybindWaiting')}
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 8px;">
            ${t('soundboard.cancelEsc')}
          </div>
        </div>
        <div class="modal-footer" style="justify-content: center;">
          <button id="btn-cancel-keybind" class="btn btn-secondary">${t('common.cancel')}</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    const disposeCapture = captureShortcut(backdrop, backdrop.querySelector('#sb-keybind-capture-box'), (combo) => {
      settingsStore.soundboardShortcuts[soundName] = combo;
      settingsStore.save();
      soundboardService.syncShortcuts();

      cleanup();

      this.refreshTable(container);
    }, () => cleanup(), container);

    const cleanup = () => {
      disposeCapture();
      backdrop.remove();
    };

    backdrop.querySelector('#btn-cancel-keybind')?.addEventListener('click', cleanup);
  }
}
