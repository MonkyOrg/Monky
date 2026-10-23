import { t } from '../i18n';
import { connectionStore, DEFAULT_FOLDER_COLOR } from '../stores/connectionStore';
import { escapeHtml } from '../utils/html';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';
import { enableBackdropClose } from '../utils/modal';
import { normalizeHexColor } from '../utils/colors';
import { ColorPicker } from './ColorPicker';

/** Discord's folder palette: a bright row and a darker one. */
export const FOLDER_SWATCHES = [
  '#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b',
  '#11806a', '#1f8b4c', '#206694', '#71368a', '#ad1457', '#c27c0e', '#a84300', '#992d22', '#979c9f', '#546e7a',
] as const;

/**
 * Name and colour of a server folder on the rail. Edits apply on "Done";
 * closing any other way discards them.
 */
export class FolderSettingsModal {
  private root: HTMLElement | null = null;
  private controller: AbortController | null = null;
  private readonly colorPicker = new ColorPicker({ id: 'folder-settings-custom-color', label: 'folderSettings.customColor', presets: FOLDER_SWATCHES });
  private folderId: string | null = null;
  private color = DEFAULT_FOLDER_COLOR;
  private returnFocus: HTMLElement | null = null;

  public open(folderId: string, returnFocus?: HTMLElement | null): void {
    const folder = connectionStore.findFolder(folderId);
    if (!folder) return;
    this.close();
    this.folderId = folderId;
    this.color = folder.color ?? DEFAULT_FOLDER_COLOR;
    this.returnFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const root = document.createElement('div');
    root.className = 'modal-backdrop';
    root.innerHTML = `<div class="modal-card folder-settings-modal" role="dialog" aria-modal="true" aria-labelledby="folder-settings-title">
      <div class="modal-header">
        <div class="modal-title" id="folder-settings-title">${t('folderSettings.title')}</div>
        <button type="button" class="modal-close-btn" data-folder-settings-cancel aria-label="${escapeHtml(t('common.close'))}">&times;</button>
      </div>
      <form class="folder-settings-form" novalidate>
        <div class="form-group">
          <label for="folder-settings-name">${t('folderSettings.nameLabel')}</label>
          <input id="folder-settings-name" type="text" autocomplete="off" maxlength="100"
            placeholder="${escapeHtml(t('folderSettings.namePlaceholder'))}" value="${escapeHtml(folder.name)}">
        </div>
        <div class="form-group">
          <span class="folder-settings-label" id="folder-settings-color-label">${t('folderSettings.colorLabel')}</span>
          <div class="folder-settings-colors">
            <div class="folder-settings-swatches" role="radiogroup" aria-labelledby="folder-settings-color-label">
              ${this.swatch(DEFAULT_FOLDER_COLOR, 'folder-settings-swatch--large', t('folderSettings.defaultColor'))}
              <div class="folder-settings-grid">
                ${FOLDER_SWATCHES.map((color) => this.swatch(color, '', t('folderSettings.swatch', { color: color.toUpperCase() }))).join('')}
              </div>
            </div>
            <div class="folder-settings-custom">${this.colorPicker.renderHtml(this.color)}</div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="submit" class="btn btn-primary folder-settings-done" data-folder-settings-done>${t('folderSettings.done')}</button>
        </div>
      </form>
    </div>`;
    document.body.appendChild(root);
    this.root = root;
    enterModal(root);
    this.bind(root);
    this.renderSelection();
    root.querySelector<HTMLInputElement>('#folder-settings-name')?.focus();
  }

  public close(): void {
    this.controller?.abort();
    this.controller = null;
    this.colorPicker.cleanup();
    if (this.root) exitModal(this.root);
    this.root = null;
    this.folderId = null;
    if (this.returnFocus?.isConnected) this.returnFocus.focus({ preventScroll: true });
    this.returnFocus = null;
  }

  private swatch(color: string, extraClass: string, label: string): string {
    return `<button type="button" role="radio" class="folder-settings-swatch ${extraClass}" data-folder-color="${color}"
      style="--swatch-color: ${color}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">
      <span class="material-symbols-outlined md-18" aria-hidden="true">check</span>
    </button>`;
  }

  private bind(root: HTMLElement): void {
    const controller = new AbortController();
    this.controller = controller;
    const options = { signal: controller.signal };
    const swatches = () => [...root.querySelectorAll<HTMLButtonElement>('[data-folder-color]')];
    root.querySelector('.folder-settings-swatches')?.addEventListener('click', (event) => {
      const swatch = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-folder-color]');
      if (!swatch?.dataset.folderColor) return;
      this.setColor(swatch.dataset.folderColor);
    }, options);
    // Arrow keys move between the colours like any radio group.
    root.querySelector('.folder-settings-swatches')?.addEventListener('keydown', (event) => {
      const key = (event as KeyboardEvent).key;
      if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp'].includes(key)) return;
      const list = swatches();
      const current = list.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = list[(current + (key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1) + list.length) % list.length];
      next.focus();
      if (next.dataset.folderColor) this.setColor(next.dataset.folderColor);
    }, options);
    this.colorPicker.attachEvents(root, (color) => this.setColor(color, false));
    root.querySelectorAll('[data-folder-settings-cancel]').forEach((button) => button.addEventListener('click', () => this.close(), options));
    root.querySelector('form')?.addEventListener('submit', (event) => {
      event.preventDefault();
      this.save();
    }, options);
    root.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && handlesModalKey(root, event)) {
        event.preventDefault();
        this.close();
      }
    }, options);
    enableBackdropClose(root, () => this.close());
  }

  private setColor(value: string, syncPicker = true): void {
    const color = normalizeHexColor(value);
    if (!color) return;
    this.color = color;
    if (syncPicker) this.colorPicker.setValue(color);
    this.renderSelection();
  }

  private renderSelection(): void {
    const root = this.root;
    if (!root) return;
    let matched = false;
    for (const swatch of root.querySelectorAll<HTMLButtonElement>('[data-folder-color]')) {
      const selected = swatch.dataset.folderColor === this.color;
      matched ||= selected;
      swatch.setAttribute('aria-checked', String(selected));
      swatch.tabIndex = selected ? 0 : -1;
    }
    // A custom colour leaves no swatch selected; keep the group reachable.
    if (!matched) {
      const first = root.querySelector<HTMLButtonElement>('[data-folder-color]');
      if (first) first.tabIndex = 0;
    }
    root.querySelector<HTMLElement>('.folder-settings-custom')?.classList.toggle('selected', !matched);
  }

  private save(): void {
    const folderId = this.folderId;
    const name = this.root?.querySelector<HTMLInputElement>('#folder-settings-name')?.value ?? '';
    if (folderId) connectionStore.updateFolder(folderId, { name, color: this.color });
    this.close();
  }
}

export const folderSettingsModal = new FolderSettingsModal();
