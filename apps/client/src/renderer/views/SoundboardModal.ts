import { escapeHtml } from '../utils/html';
import { Permission } from '@monky/shared';
import { soundboardService, SoundItem } from '../core/SoundboardService';
import { settingsStore } from '../stores/settingsStore';
import { serverStore } from '../stores/serverStore';
import { voiceStore } from '../stores/voiceStore';
import { appEvents } from '../core/EventBus';
import { t, tCount } from '../i18n';
import { captureShortcut, shortcutIdentity } from '../utils/keybind';
import { showAlert, showConfirm } from './Dialog';
import { enableBackdropClose } from '../utils/modal';
import { matchesSearch as matchesSoundSearch } from '../utils/search';

export class SoundboardModal {
  private modalEl: HTMLElement | null = null;
  private unbindEvents: Array<() => void> = [];
  private searchQuery: string = '';
  private closeShortcutCapture: (() => void) | null = null;

  public async open(): Promise<void> {
    this.close();
    this.searchQuery = '';

    // Ensure sounds are loaded
    await soundboardService.loadSounds();
    const sounds = soundboardService.getSounds();
    const serverAllows = serverStore.serverDetails?.allowSoundboard !== false;
    const hasSoundboardPermission = serverStore.hasPermission(Permission.USE_SOUNDBOARD);

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = `
      <div class="modal-card" style="max-width: 600px; max-height: 85vh; display: flex; flex-direction: column; padding: 0; overflow: hidden;">
        
        <!-- Header -->
        <div class="modal-header" style="padding: 16px 20px 12px; border-bottom: 1px solid var(--border-color);">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);">music_note</span>
            <span>Soundboard</span>
            <span id="sb-sound-count" style="font-size: 11px; background: var(--bg-tertiary); padding: 2px 8px; border-radius: 12px; color: var(--text-muted); font-weight: 500;">
              ${tCount('soundboard.soundCount', sounds.length)}
            </span>
            <div class="sb-help-badge" title="${t('soundboard.formatsBadge')}" style="margin-left: 2px;">
              <span class="material-symbols-outlined md-16">help</span>
            </div>
          </div>
          <button id="modal-close" class="modal-close-btn">&times;</button>
        </div>

        <!-- Quick Volume & Mute Toolbar -->
        <div style="padding: 10px 20px; background: var(--bg-secondary); border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; gap: 16px;">
          <!-- Folder select & Change -->
          <div style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
            <button id="sb-btn-change-folder" class="btn btn-secondary" style="font-size: 11px; padding: 4px 10px; height: 28px; white-space: nowrap;">
              <span class="material-symbols-outlined md-14" style="margin-right: 4px;">folder_open</span>
              ${settingsStore.soundboardFolderPath ? t('soundboard.changeFolder') : t('soundboard.chooseFolder')}
            </button>
            <span id="sb-folder-path-label" style="font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${settingsStore.soundboardFolderPath || ''}">
              ${settingsStore.soundboardFolderPath ? escapeHtml(settingsStore.soundboardFolderPath) : t('soundboard.noFolderSelected')}
            </span>
          </div>

          <!-- Volume & Mute Controls -->
          <div style="display: flex; align-items: center; gap: 12px;">
            <button id="sb-btn-mute" class="btn btn-icon ${settingsStore.soundboardMuted ? 'danger-active' : ''}" style="width: 28px; height: 28px; padding: 0;" title="${settingsStore.soundboardMuted ? t('soundboard.unmuteTitle') : t('soundboard.muteTitle')}">
              <span class="material-symbols-outlined md-16">${settingsStore.soundboardMuted ? 'volume_off' : 'volume_up'}</span>
            </button>
            
            <div style="display: flex; align-items: center; gap: 8px;">
              <input id="sb-slider-volume" class="sb-slider" type="range" min="0" max="100" value="${settingsStore.soundboardVolume}" style="--slider-progress: ${settingsStore.soundboardVolume}%; width: 80px;">
              <span id="sb-volume-label" style="font-family: var(--font-mono); font-size: 11px; color: var(--text-secondary); min-width: 32px; text-align: right;">${settingsStore.soundboardVolume}%</span>
            </div>
          </div>
        </div>

        <!-- Search Bar & View Mode Switcher (#288, #326) -->
        <div style="padding: 10px 20px 6px; background: var(--bg-card); display: flex; flex-direction: column; gap: 6px;">
          <div style="position: relative; width: 100%; display: flex; align-items: center;">
            <span class="material-symbols-outlined md-18" style="position: absolute; left: 10px; color: var(--text-muted); pointer-events: none;">search</span>
            <input
              id="sb-search-input"
              type="text"
              placeholder="${t('soundboard.searchPlaceholder')}"
              value="${escapeHtml(this.searchQuery)}"
              style="width: 100%; height: 32px; padding: 0 32px 0 34px; font-size: 12px; background: var(--bg-input); border: 1px solid var(--border-color); border-radius: var(--radius-md); color: var(--text-primary);"
            />
            <button id="sb-search-clear" type="button" class="btn btn-icon" style="position: absolute; right: 6px; width: 20px; height: 20px; padding: 0; color: var(--text-muted); display: ${this.searchQuery ? 'inline-flex' : 'none'};" title="${t('common.clear')}">
              <span class="material-symbols-outlined md-16">close</span>
            </button>
          </div>

          <!-- View Mode Toggle Toolbar (Grid vs List) -->
          <div style="display: flex; align-items: center; justify-content: flex-end; gap: 4px;">
            <button
              id="sb-btn-view-grid"
              type="button"
              class="btn btn-icon ${settingsStore.soundboardViewMode === 'grid' ? 'active' : ''}"
              style="width: 26px; height: 26px; border-radius: var(--radius-sm); border: 1px solid ${settingsStore.soundboardViewMode === 'grid' ? 'var(--accent-primary)' : 'transparent'}; background: ${settingsStore.soundboardViewMode === 'grid' ? 'rgba(88, 101, 242, 0.15)' : 'transparent'}; color: ${settingsStore.soundboardViewMode === 'grid' ? 'var(--accent-primary)' : 'var(--text-muted)'}; padding: 0;"
              title="${t('soundboard.viewGrid')}"
              aria-label="${t('soundboard.viewGrid')}"
            >
              <span class="material-symbols-outlined md-18">grid_view</span>
            </button>
            <button
              id="sb-btn-view-list"
              type="button"
              class="btn btn-icon ${settingsStore.soundboardViewMode === 'list' ? 'active' : ''}"
              style="width: 26px; height: 26px; border-radius: var(--radius-sm); border: 1px solid ${settingsStore.soundboardViewMode === 'list' ? 'var(--accent-primary)' : 'transparent'}; background: ${settingsStore.soundboardViewMode === 'list' ? 'rgba(88, 101, 242, 0.15)' : 'transparent'}; color: ${settingsStore.soundboardViewMode === 'list' ? 'var(--accent-primary)' : 'var(--text-muted)'}; padding: 0;"
              title="${t('soundboard.viewList')}"
              aria-label="${t('soundboard.viewList')}"
            >
              <span class="material-symbols-outlined md-18">view_list</span>
            </button>
          </div>
        </div>

        <!-- Server disabled alert banner -->
        ${!serverAllows ? `
          <div style="margin: 12px 20px 0; padding: 8px 12px; background: rgba(237, 66, 69, 0.15); border: 1px solid rgba(237, 66, 69, 0.3); border-radius: var(--radius-md); color: var(--danger); font-size: 12px; display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined md-16">block</span>
            <span>${t('soundboard.disabledByAdmin')}</span>
          </div>
        ` : ''}
        ${serverAllows && !hasSoundboardPermission ? `
          <div style="margin: 12px 20px 0; padding: 8px 12px; background: rgba(237, 66, 69, 0.15); border: 1px solid rgba(237, 66, 69, 0.3); border-radius: var(--radius-md); color: var(--danger); font-size: 12px; display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined md-16">block</span>
            <span>${t('soundboard.noPermission')}</span>
          </div>
        ` : ''}

        <!-- Voice channel warning if not in call -->
        ${!voiceStore.currentVoiceChannelId ? `
          <div style="margin: 12px 20px 0; padding: 8px 12px; background: rgba(240, 178, 50, 0.15); border: 1px solid rgba(240, 178, 50, 0.3); border-radius: var(--radius-md); color: #f0b232; font-size: 12px; display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined md-16">info</span>
            <span>${t('soundboard.localPreviewOnly')}</span>
          </div>
        ` : ''}

        <!-- Sounds Grid Area -->
        <div id="sb-sounds-container" style="flex: 1; overflow-y: auto; padding: 10px 20px 16px; min-height: 220px;">
          ${this.renderSoundsGrid(sounds)}
        </div>

        <!-- Footer -->
        <div class="modal-footer" style="padding: 12px 20px; border-top: 1px solid var(--border-color); background: var(--bg-card);">
          <div style="font-size: 11px; color: var(--text-muted); flex: 1;">
            ${t('soundboard.footerHint')}
          </div>
          <button type="button" id="sb-btn-close" class="btn btn-secondary" style="padding: 6px 16px; font-size: 12px;">${t('common.close')}</button>
        </div>
      </div>
    `;

    document.body.appendChild(this.modalEl);
    this.attachEvents();
    this.setupPlaybackListeners();
  }

  private renderSoundsGrid(sounds: SoundItem[], activeSoundName: string | null = null): string {
    if (!settingsStore.soundboardFolderPath) {
      return `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; min-height: 180px; text-align: center; color: var(--text-muted); gap: 12px;">
          <span class="material-symbols-outlined" style="font-size: 48px; color: var(--text-dim);">folder_special</span>
          <div>
            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">${t('soundboard.emptyFolderTitle')}</div>
            <div style="font-size: 12px; max-width: 340px;">${t('soundboard.emptyFolderDesc')}</div>
          </div>
          <button type="button" id="sb-btn-select-folder-empty" class="btn btn-primary" style="font-size: 12px; padding: 8px 18px; margin-top: 6px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 6px;">folder_open</span>
            ${t('soundboard.chooseFolderButton')}
          </button>
        </div>
      `;
    }

    if (sounds.length === 0) {
      return `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; min-height: 180px; text-align: center; color: var(--text-muted); gap: 12px;">
          <span class="material-symbols-outlined" style="font-size: 48px; color: var(--text-dim);">audio_file</span>
          <div>
            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">${t('soundboard.noAudioFilesTitle')}</div>
            <div style="font-size: 12px; max-width: 340px;">${t('soundboard.noAudioFilesDesc')}</div>
          </div>
          <button type="button" id="sb-btn-select-folder-empty" class="btn btn-secondary" style="font-size: 12px; padding: 6px 14px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 6px;">folder_open</span>
            ${t('soundboard.changeFolderButton')}
          </button>
        </div>
      `;
    }

    const filteredSounds = this.searchQuery.trim()
      ? sounds.filter((s) => matchesSoundSearch(s.name, this.searchQuery))
      : sounds;

    if (filteredSounds.length === 0) {
      return `
        <div style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; min-height: 180px; text-align: center; color: var(--text-muted); gap: 10px;">
          <span class="material-symbols-outlined" style="font-size: 40px; color: var(--text-dim);">search_off</span>
          <div>
            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">${t('soundboard.noSearchResultsTitle')}</div>
            <div style="font-size: 12px; max-width: 320px;">${t('soundboard.noSearchResultsDesc', { query: escapeHtml(this.searchQuery) })}</div>
          </div>
          <button type="button" id="sb-btn-clear-search" class="btn btn-secondary" style="font-size: 11px; padding: 4px 12px; margin-top: 4px;">
            ${t('common.clear')}
          </button>
        </div>
      `;
    }

    const shortcuts = settingsStore.soundboardShortcuts || {};

    if (settingsStore.soundboardViewMode === 'list') {
      return this.renderSoundsList(filteredSounds, activeSoundName, shortcuts);
    }

    return `
      <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 10px;">
        ${filteredSounds
          .map((s) => {
            const isPlaying = activeSoundName === s.name;
            const shortcut = shortcuts[s.name];

            return `
              <div class="sb-sound-card ${isPlaying ? 'is-playing' : ''}" style="display: flex; flex-direction: column; background: var(--bg-card); border: 1px solid ${isPlaying ? 'var(--accent-primary)' : 'var(--border-color)'}; border-radius: var(--radius-md); overflow: hidden; transition: all 0.15s ease; position: relative;">
                <!-- Play Sound Button -->
                <button type="button" class="sb-sound-btn" data-filepath="${escapeHtml(s.filePath)}" data-soundname="${escapeHtml(s.name)}" title="Tocar ${escapeHtml(s.name)} (${(s.sizeBytes / 1024).toFixed(0)} KB)" style="flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; padding: 12px 8px 6px; background: transparent; border: none; color: var(--text-primary); cursor: pointer; text-align: center; outline: none; width: 100%;">
                  <span class="material-symbols-outlined sb-sound-icon" style="color: var(--accent-primary); font-size: 26px;">${isPlaying ? 'volume_up' : 'play_circle'}</span>
                  <span style="font-size: 12px; font-weight: 600; line-height: 1.2; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; width: 100%; word-break: break-word;">
                    ${escapeHtml(s.name)}
                  </span>
                </button>
                
                <!-- Shortcut Badge or Add Shortcut Button -->
                <div style="padding: 4px 6px 8px; display: flex; align-items: center; justify-content: center;">
                  ${shortcut && shortcut.display ? `
                    <div class="sb-shortcut-badge" data-soundname="${escapeHtml(s.name)}" title="${t('soundboard.shortcutBadgeTitle', { combo: escapeHtml(shortcut.display) })}" style="display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; background: rgba(88, 101, 242, 0.15); border: 1px solid rgba(88, 101, 242, 0.4); border-radius: 4px; font-family: var(--font-mono); font-size: 10px; color: #ffffff; cursor: pointer; max-width: 100%;">
                      <span class="material-symbols-outlined" style="font-size: 11px; color: var(--accent-primary);">keyboard</span>
                      <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 70px;">${escapeHtml(shortcut.display)}</span>
                      <button type="button" class="sb-btn-remove-shortcut" data-soundname="${escapeHtml(s.name)}" title="${t('soundboard.removeShortcut')}" style="background: none; border: none; color: var(--text-muted); cursor: pointer; display: inline-flex; align-items: center; padding: 0; margin-left: 2px;">
                        <span class="material-symbols-outlined" style="font-size: 12px;">close</span>
                      </button>
                    </div>
                  ` : `
                    <button type="button" class="sb-btn-add-shortcut" data-soundname="${escapeHtml(s.name)}" title="${t('soundboard.addShortcut')}" style="display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; background: transparent; border: 1px dashed var(--border-color); border-radius: 4px; font-size: 10px; color: var(--text-muted); cursor: pointer; transition: all 0.15s ease;">
                      <span class="material-symbols-outlined" style="font-size: 11px;">keyboard</span>
                      <span>${t('soundboard.shortcut')}</span>
                    </button>
                  `}
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  private renderSoundsList(
    sounds: SoundItem[],
    activeSoundName: string | null = null,
    shortcuts: Record<string, { accelerator: string; display: string }> = {}
  ): string {
    return `
      <div style="display: flex; flex-direction: column; gap: 4px;">
        ${sounds
          .map((s) => {
            const isPlaying = activeSoundName === s.name;
            const shortcut = shortcuts[s.name];

            return `
              <div
                class="sb-sound-row sb-sound-btn sb-sound-list-btn ${isPlaying ? 'is-playing' : ''}"
                role="button"
                tabindex="0"
                data-filepath="${escapeHtml(s.filePath)}"
                data-soundname="${escapeHtml(s.name)}"
                title="Tocar ${escapeHtml(s.name)} (${(s.sizeBytes / 1024).toFixed(0)} KB)"
                style="display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; background: var(--bg-card); border: 1px solid ${isPlaying ? 'var(--accent-primary)' : 'var(--border-color)'}; border-radius: var(--radius-sm); gap: 10px; cursor: pointer; color: var(--text-primary); text-align: left; outline: none;"
              >
                <!-- The row itself plays the sound (#499); the shortcut controls
                     below stop the click from reaching it. -->
                <div style="flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0; padding: 2px 0;">
                  <div style="width: 28px; height: 28px; border-radius: 50%; background: ${isPlaying ? 'var(--accent-primary)' : 'rgba(255,255,255,0.06)'}; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
                    <span class="material-symbols-outlined sb-sound-icon" style="color: ${isPlaying ? '#ffffff' : 'var(--accent-primary)'}; font-size: 18px;">${isPlaying ? 'volume_up' : 'play_arrow'}</span>
                  </div>
                  <span style="font-size: 13px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1;">
                    ${escapeHtml(s.name)}
                  </span>
                  <span style="font-size: 11px; color: var(--text-muted); margin-right: 8px;">
                    ${(s.sizeBytes / 1024).toFixed(0)} KB
                  </span>
                </div>

                <!-- Shortcut Badge or Add Shortcut Button -->
                <div style="display: flex; align-items: center; flex-shrink: 0;">
                  ${shortcut && shortcut.display ? `
                    <div class="sb-shortcut-badge" data-soundname="${escapeHtml(s.name)}" title="${t('soundboard.shortcutBadgeTitle', { combo: escapeHtml(shortcut.display) })}" style="display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; background: rgba(88, 101, 242, 0.15); border: 1px solid rgba(88, 101, 242, 0.4); border-radius: 4px; font-family: var(--font-mono); font-size: 10px; color: #ffffff; cursor: pointer;">
                      <span class="material-symbols-outlined" style="font-size: 11px; color: var(--accent-primary);">keyboard</span>
                      <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 80px;">${escapeHtml(shortcut.display)}</span>
                      <button type="button" class="sb-btn-remove-shortcut" data-soundname="${escapeHtml(s.name)}" title="${t('soundboard.removeShortcut')}" style="background: none; border: none; color: var(--text-muted); cursor: pointer; display: inline-flex; align-items: center; padding: 0; margin-left: 2px;">
                        <span class="material-symbols-outlined" style="font-size: 12px;">close</span>
                      </button>
                    </div>
                  ` : `
                    <button type="button" class="sb-btn-add-shortcut" data-soundname="${escapeHtml(s.name)}" title="${t('soundboard.addShortcut')}" style="display: inline-flex; align-items: center; gap: 3px; padding: 2px 6px; background: transparent; border: 1px dashed var(--border-color); border-radius: 4px; font-size: 10px; color: var(--text-muted); cursor: pointer; transition: all 0.15s ease;">
                      <span class="material-symbols-outlined" style="font-size: 11px;">keyboard</span>
                      <span>${t('soundboard.shortcut')}</span>
                    </button>
                  `}
                </div>
              </div>
            `;
          })
          .join('')}
      </div>
    `;
  }

  private refreshGrid(): void {
    if (!this.modalEl) return;
    const container = this.modalEl.querySelector('#sb-sounds-container');
    const countBadge = this.modalEl.querySelector('#sb-sound-count');
    if (container) {
      const sounds = soundboardService.getSounds();
      const currentPlayback = soundboardService.getCurrentPlayback();
      const filteredSounds = this.searchQuery.trim()
        ? sounds.filter((s) => matchesSoundSearch(s.name, this.searchQuery))
        : sounds;

      if (countBadge) {
        if (this.searchQuery.trim() && filteredSounds.length !== sounds.length) {
          countBadge.textContent = `${filteredSounds.length} / ${sounds.length}`;
        } else {
          countBadge.textContent = tCount('soundboard.soundCount', sounds.length);
        }
      }

      container.innerHTML = this.renderSoundsGrid(sounds, currentPlayback.soundName);
      this.attachSoundClickEvents();

      const btnClearSearch = container.querySelector('#sb-btn-clear-search');
      btnClearSearch?.addEventListener('click', () => {
        this.clearSearch();
      });
    }
  }

  private clearSearch(): void {
    this.searchQuery = '';
    const input = this.modalEl?.querySelector('#sb-search-input') as HTMLInputElement | null;
    if (input) {
      input.value = '';
      input.focus();
    }
    const clearBtn = this.modalEl?.querySelector('#sb-search-clear') as HTMLElement | null;
    if (clearBtn) clearBtn.style.display = 'none';
    this.refreshGrid();
  }

  private async openKeyCaptureModal(soundName: string): Promise<void> {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.zIndex = '10000';
    backdrop.innerHTML = `
      <div class="modal-card" style="width: 380px; max-width: 90vw; text-align: center; animation: modalIn 0.15s ease;" role="dialog" aria-modal="true">
        <div class="modal-header" style="justify-content: center; position: relative;">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px; font-size: 15px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);">keyboard</span>
            <span>${t('soundboard.keybindTitle')}</span>
          </div>
          <button id="sb-keybind-modal-close" class="modal-close-btn" style="position: absolute; right: 16px; top: 16px;">&times;</button>
        </div>
        <div style="padding: 16px 20px 20px;">
          <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 16px; word-break: break-word;">
            ${t('soundboard.keybindPrompt', { sound: `<strong style="color: var(--text-primary);">${escapeHtml(soundName)}</strong>` })}
          </div>
          <div id="sb-keybind-box" style="padding: 24px 16px; background: var(--bg-input); border: 2px dashed var(--accent-primary); border-radius: var(--radius-md); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; box-shadow: 0 0 16px rgba(88, 101, 242, 0.25);">
            <span class="material-symbols-outlined" style="font-size: 32px; color: var(--accent-primary); animation: pulse 1.5s infinite;">keyboard</span>
            <div style="font-size: 14px; font-weight: 600; color: var(--text-primary);">${t('soundboard.keybindWaiting')}</div>
            <div style="font-size: 11px; color: var(--text-muted);">${t('soundboard.keybindExamples')}</div>
          </div>
        </div>
        <div class="modal-footer" style="justify-content: space-between; padding: 12px 20px;">
          <button type="button" id="sb-keybind-btn-clear" class="btn btn-secondary" style="font-size: 12px; color: var(--danger);">${t('soundboard.removeShortcutButton')}</button>
          <button type="button" id="sb-keybind-btn-cancel" class="btn btn-secondary" style="font-size: 12px;">${t('soundboard.cancelEsc')}</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    let isClosed = false;
    const cleanup = async () => {
      if (isClosed) return;
      isClosed = true;
      this.closeShortcutCapture = null;
      disposeCapture();
      backdrop.remove();
    };

    const disposeCapture = captureShortcut(backdrop, backdrop.querySelector('#sb-keybind-box'), async (combo) => {
      await cleanup();

      // Check if this shortcut is already in use by another sound
      const existingConflict = Object.entries(settingsStore.soundboardShortcuts || {}).find(
        ([name, data]) => data && shortcutIdentity(data.accelerator) === combo.accelerator && name !== soundName
      );

      if (existingConflict) {
        const [conflictSoundName] = existingConflict;
        const confirm = await showConfirm({
          title: t('soundboard.shortcutInUseTitle'),
          message: t('soundboard.shortcutInUseMessage', { combo: combo.display, sound: conflictSoundName }),
          confirmLabel: t('soundboard.replace'),
          cancelLabel: t('common.cancel'),
          variant: 'warning',
        });

        if (!confirm) {
          await soundboardService.syncShortcuts();
          return; // Cancelled by user
        }

        // Remove from old sound
        delete settingsStore.soundboardShortcuts[conflictSoundName];
      }

      // Assign to current sound
      if (!settingsStore.soundboardShortcuts) {
        settingsStore.soundboardShortcuts = {};
      }
      settingsStore.soundboardShortcuts[soundName] = combo;
      settingsStore.save();
      await soundboardService.syncShortcuts();

      this.refreshGrid();
    }, () => { void cleanup(); }, this.modalEl ?? backdrop);

    backdrop.querySelector('#sb-keybind-modal-close')?.addEventListener('click', () => cleanup());
    backdrop.querySelector('#sb-keybind-btn-cancel')?.addEventListener('click', () => cleanup());
    backdrop.querySelector('#sb-keybind-btn-clear')?.addEventListener('click', async () => {
      await cleanup();
      if (settingsStore.soundboardShortcuts) {
        delete settingsStore.soundboardShortcuts[soundName];
        settingsStore.save();
        await soundboardService.syncShortcuts();
        this.refreshGrid();
      }
    });

    backdrop.addEventListener('mousedown', (e) => {
      if (e.target === backdrop) cleanup();
    });

    this.closeShortcutCapture = () => { void cleanup(); };
  }

  private attachEvents(): void {
    if (!this.modalEl) return;

    const btnClose = this.modalEl.querySelector('#modal-close');
    const btnFooterClose = this.modalEl.querySelector('#sb-btn-close');
    const btnChangeFolder = this.modalEl.querySelector('#sb-btn-change-folder');
    const btnSelectEmpty = this.modalEl.querySelector('#sb-btn-select-folder-empty');
    const btnMute = this.modalEl.querySelector('#sb-btn-mute');
    const sliderVol = this.modalEl.querySelector('#sb-slider-volume') as HTMLInputElement | null;
    const volLabel = this.modalEl.querySelector('#sb-volume-label');
    const searchInput = this.modalEl.querySelector('#sb-search-input') as HTMLInputElement | null;
    const searchClear = this.modalEl.querySelector('#sb-search-clear') as HTMLElement | null;

    const handleClose = () => this.close();
    btnClose?.addEventListener('click', handleClose);
    btnFooterClose?.addEventListener('click', handleClose);
    enableBackdropClose(this.modalEl, handleClose);

    searchInput?.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      if (searchClear) {
        searchClear.style.display = this.searchQuery ? 'inline-flex' : 'none';
      }
      this.refreshGrid();
    });

    searchClear?.addEventListener('click', () => {
      this.clearSearch();
    });

    const handleChangeFolder = async () => {
      let folder: string | null;
      try { folder = await soundboardService.selectFolder(); } catch {
        if (this.modalEl) await showAlert({ message: t('botChat.downloadWriteFailed'), variant: 'danger' });
        return;
      }
      if (folder) {
        const sounds = soundboardService.getSounds();
        this.refreshGrid();
        const folderLabel = this.modalEl?.querySelector('#sb-folder-path-label');
        if (folderLabel) folderLabel.textContent = folder;
        const countBadge = this.modalEl?.querySelector('#sb-sound-count');
        if (countBadge) countBadge.textContent = tCount('soundboard.soundCount', sounds.length);
      }
    };

    btnChangeFolder?.addEventListener('click', handleChangeFolder);
    btnSelectEmpty?.addEventListener('click', handleChangeFolder);

    btnMute?.addEventListener('click', () => {
      settingsStore.soundboardMuted = !settingsStore.soundboardMuted;
      settingsStore.save();
      if (btnMute) {
        btnMute.className = `btn btn-icon ${settingsStore.soundboardMuted ? 'danger-active' : ''}`;
        btnMute.innerHTML = `<span class="material-symbols-outlined md-16">${settingsStore.soundboardMuted ? 'volume_off' : 'volume_up'}</span>`;
        btnMute.setAttribute('title', settingsStore.soundboardMuted ? t('soundboard.unmuteTitle') : t('soundboard.muteTitle'));
      }
    });

    // View mode switchers (#326)
    const btnViewGrid = this.modalEl.querySelector<HTMLButtonElement>('#sb-btn-view-grid');
    const btnViewList = this.modalEl.querySelector<HTMLButtonElement>('#sb-btn-view-list');

    btnViewGrid?.addEventListener('click', () => {
      if (settingsStore.soundboardViewMode !== 'grid') {
        settingsStore.soundboardViewMode = 'grid';
        settingsStore.save();
        this.updateViewModeButtons();
        this.refreshGrid();
      }
    });

    btnViewList?.addEventListener('click', () => {
      if (settingsStore.soundboardViewMode !== 'list') {
        settingsStore.soundboardViewMode = 'list';
        settingsStore.save();
        this.updateViewModeButtons();
        this.refreshGrid();
      }
    });

    sliderVol?.addEventListener('input', () => {
      const val = parseInt(sliderVol.value, 10);
      if (volLabel) volLabel.textContent = `${val}%`;
      sliderVol.style.setProperty('--slider-progress', `${val}%`);
      settingsStore.soundboardVolume = val;
      settingsStore.save();
    });

    this.attachSoundClickEvents();
  }

  private attachSoundClickEvents(): void {
    if (!this.modalEl) return;
    
    // Play sound click. In list mode the target is the whole row, which is a
    // <div role="button"> rather than a real button (it wraps the shortcut
    // controls, and nesting buttons is invalid), so Enter/Space are wired by
    // hand to keep it reachable from the keyboard (#499).
    const buttons = this.modalEl.querySelectorAll('.sb-sound-btn');
    buttons.forEach((btn) => {
      const play = async () => {
        const filePath = btn.getAttribute('data-filepath');
        if (!filePath) return;
        await soundboardService.playSound(filePath);
      };
      btn.addEventListener('click', play);
      if (btn.tagName !== 'BUTTON') {
        btn.addEventListener('keydown', (e) => {
          const key = (e as KeyboardEvent).key;
          if (key !== 'Enter' && key !== ' ') return;
          e.preventDefault();
          void play();
        });
      }
    });

    // Add / edit shortcut click
    const shortcutTriggers = this.modalEl.querySelectorAll('.sb-btn-add-shortcut, .sb-shortcut-badge');
    shortcutTriggers.forEach((trigger) => {
      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const soundName = trigger.getAttribute('data-soundname');
        if (soundName) this.openKeyCaptureModal(soundName);
      });
    });

    // Remove shortcut click
    const removeButtons = this.modalEl.querySelectorAll('.sb-btn-remove-shortcut');
    removeButtons.forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const soundName = btn.getAttribute('data-soundname');
        if (soundName && settingsStore.soundboardShortcuts) {
          delete settingsStore.soundboardShortcuts[soundName];
          settingsStore.save();
          await soundboardService.syncShortcuts();
          this.refreshGrid();
        }
      });
    });
  }

  private setupPlaybackListeners(): void {
    this.unbindEvents.push(appEvents.on('soundboard.sounds_loaded', () => {
      if (!this.modalEl) return;
      this.refreshGrid();
      const count = this.modalEl.querySelector('#sb-sound-count');
      if (count) count.textContent = tCount('soundboard.soundCount', soundboardService.getSounds().length);
    }));
    // The progress bars themselves now live in the sidebar (#517); what is left
    // here is keeping the grid in sync with what is playing.
    const onPlaybackStarted = () => this.updateActiveButtons();

    const onPlaybackEnded = () => {
      if (soundboardService.getActivePlaybacks().length === 0) {
        this.clearActiveButtons();
      } else {
        this.updateActiveButtons();
      }
    };

    const onSoundPlayed = (payload: any) => {
      this.highlightPlayedSound(payload.soundName);
    };

    appEvents.on('soundboard.playback_started', onPlaybackStarted);
    appEvents.on('soundboard.playback_ended', onPlaybackEnded);
    appEvents.on('soundboard.played', onSoundPlayed);

    this.unbindEvents.push(() => {
      appEvents.off('soundboard.playback_started', onPlaybackStarted);
      appEvents.off('soundboard.playback_ended', onPlaybackEnded);
      appEvents.off('soundboard.played', onSoundPlayed);
    });
  }

  private updateViewModeButtons(): void {
    if (!this.modalEl) return;
    const btnGrid = this.modalEl.querySelector<HTMLButtonElement>('#sb-btn-view-grid');
    const btnList = this.modalEl.querySelector<HTMLButtonElement>('#sb-btn-view-list');
    const isGrid = settingsStore.soundboardViewMode === 'grid';

    if (btnGrid) {
      btnGrid.classList.toggle('active', isGrid);
      btnGrid.style.borderColor = isGrid ? 'var(--accent-primary)' : 'transparent';
      btnGrid.style.background = isGrid ? 'rgba(88, 101, 242, 0.15)' : 'transparent';
      btnGrid.style.color = isGrid ? 'var(--accent-primary)' : 'var(--text-muted)';
    }

    if (btnList) {
      btnList.classList.toggle('active', !isGrid);
      btnList.style.borderColor = !isGrid ? 'var(--accent-primary)' : 'transparent';
      btnList.style.background = !isGrid ? 'rgba(88, 101, 242, 0.15)' : 'transparent';
      btnList.style.color = !isGrid ? 'var(--accent-primary)' : 'var(--text-muted)';
    }
  }

  private updateActiveButtons(): void {
    if (!this.modalEl) return;
    const playingNames = soundboardService.getPlayingSoundNames();
    const buttons = this.modalEl.querySelectorAll('.sb-sound-btn');
    buttons.forEach((btn) => {
      const soundName = btn.getAttribute('data-soundname');
      const icon = btn.querySelector('.sb-sound-icon');
      const isPlaying = soundName ? playingNames.has(soundName) : false;
      const isList = btn.classList.contains('sb-sound-list-btn');

      btn.classList.toggle('is-playing', isPlaying);
      const parentContainer = btn.closest('.sb-sound-card, .sb-sound-row');
      if (parentContainer) parentContainer.classList.toggle('is-playing', isPlaying);

      if (icon) {
        icon.textContent = isPlaying ? 'volume_up' : (isList ? 'play_arrow' : 'play_circle');
      }
    });
  }

  private clearActiveButtons(): void {
    if (!this.modalEl) return;
    const buttons = this.modalEl.querySelectorAll('.sb-sound-btn');
    buttons.forEach((btn) => {
      btn.classList.remove('is-playing');
      const parentContainer = btn.closest('.sb-sound-card, .sb-sound-row');
      if (parentContainer) parentContainer.classList.remove('is-playing');
      const isList = btn.classList.contains('sb-sound-list-btn');
      const icon = btn.querySelector('.sb-sound-icon');
      if (icon) icon.textContent = isList ? 'play_arrow' : 'play_circle';
    });
  }

  private highlightPlayedSound(soundName: string): void {
    if (!this.modalEl) return;
    const buttons = this.modalEl.querySelectorAll('.sb-sound-btn');
    buttons.forEach((btn) => {
      if (btn.getAttribute('data-soundname') === soundName) {
        const parentContainer = btn.closest('.sb-sound-card, .sb-sound-row') || btn;
        parentContainer.classList.add('playing-pulse');
        setTimeout(() => {
          parentContainer.classList.remove('playing-pulse');
        }, 800);
      }
    });
  }

  public close(): void {
    this.closeShortcutCapture?.();
    this.unbindEvents.forEach((u) => u());
    this.unbindEvents = [];
    if (this.modalEl) {
      this.modalEl.remove();
      this.modalEl = null;
    }
  }
}

export const soundboardModal = new SoundboardModal();
