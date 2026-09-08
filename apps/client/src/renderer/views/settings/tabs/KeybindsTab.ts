import { settingsStore } from '../../../stores/settingsStore';
import { keybindService, KEYBIND_ACTIONS, KeybindActionDefinition } from '../../../core/KeybindService';
import { t, type TranslationKey } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';
import { captureShortcut } from '../../../utils/keybind';

export class KeybindsTab {
  public renderHtml(): string {
    return `
      <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
        <span style="font-size: 13px; font-weight: 700; color: var(--text-primary); text-transform: uppercase; letter-spacing: 0.5px; display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">keyboard</span>
          ${t('keybinds.title')}
        </span>
      </div>

      <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 16px; line-height: 1.5;">
        ${t('keybinds.description')}
      </div>

      <div id="keybinds-actions-list-container">
        ${this.renderActionsList()}
      </div>
    `;
  }

  public renderActionsList(): string {
    const rows = KEYBIND_ACTIONS.map((action: KeybindActionDefinition) => {
      const binding = settingsStore.keybindShortcuts[action.id];
      const displayKey = binding ? binding.display : '—';
      const hasShortcut = Boolean(binding);

      return `
        <div class="keybind-action-row" style="display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); margin-bottom: 8px; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;">
            <div style="width: 32px; height: 32px; border-radius: var(--radius-sm); background: rgba(88, 101, 242, 0.12); display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <span class="material-symbols-outlined md-18" style="color: var(--accent-primary);">${action.icon}</span>
            </div>
            <div style="flex: 1; min-width: 0;">
              <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 2px;">
                ${t(action.nameKey as TranslationKey)}
              </div>
              <div style="font-size: 11px; color: var(--text-muted); line-height: 1.3;">
                ${t(action.descKey as TranslationKey)}
              </div>
            </div>
          </div>

          <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
            <span class="keybind-badge ${hasShortcut ? 'has-key' : ''}" style="font-family: var(--font-mono); font-size: 12px; font-weight: 600; padding: 4px 10px; background: rgba(255,255,255,0.06); border-radius: 6px; border: 1px solid var(--border-color); color: ${hasShortcut ? 'var(--accent-primary)' : 'var(--text-muted)'}; min-width: 70px; text-align: center;">
              ${escapeHtml(displayKey)}
            </span>
            <button type="button" class="btn-bind-action btn btn-secondary" data-action-id="${action.id}" style="font-size: 11px; padding: 4px 10px; height: 28px;" title="${hasShortcut ? t('keybinds.editShortcut') : t('keybinds.recordShortcut')}">
              ${hasShortcut ? t('keybinds.editShortcut') : t('keybinds.recordShortcut')}
            </button>
            ${hasShortcut ? `
              <button type="button" class="btn-clear-action-keybind btn btn-icon" data-action-id="${action.id}" style="width: 28px; height: 28px;" title="${t('keybinds.clearShortcut')}">
                <span class="material-symbols-outlined md-16" style="color: var(--danger);">close</span>
              </button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');

    return rows;
  }

  public attachEvents(container: HTMLElement): void {
    container.querySelectorAll('.btn-bind-action').forEach((btn) => {
      btn.addEventListener('click', () => {
        const actionId = btn.getAttribute('data-action-id');
        if (actionId) this.openKeybindModal(container, actionId);
      });
    });

    container.querySelectorAll('.btn-clear-action-keybind').forEach((btn) => {
      btn.addEventListener('click', () => {
        const actionId = btn.getAttribute('data-action-id');
        if (actionId) {
          delete settingsStore.keybindShortcuts[actionId];
          settingsStore.save();
          keybindService.syncShortcuts();
          const listContainer = container.querySelector<HTMLElement>('#keybinds-actions-list-container');
          if (listContainer) {
            listContainer.innerHTML = this.renderActionsList();
            this.attachEvents(container);
          }
        }
      });
    });
  }

  private openKeybindModal(container: HTMLElement, actionId: string): void {
    const actionDef = KEYBIND_ACTIONS.find((a) => a.id === actionId);
    const actionName = actionDef ? t(actionDef.nameKey as TranslationKey) : actionId;

    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.style.zIndex = '10002';

    backdrop.innerHTML = `
      <div class="modal-card" style="width: 360px; text-align: center;">
        <div class="modal-header">
          <div class="modal-title">${t('keybinds.recordShortcut')}</div>
        </div>
        <div class="modal-body" style="padding: 16px;">
          <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">
            ${escapeHtml(actionName)}
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 14px;">
            ${t('keybinds.pressKeyPrompt')}
          </div>
          <div id="keybind-capture-box" style="padding: 16px; background: var(--bg-card); border: 2px dashed var(--accent-primary); border-radius: var(--radius-md); font-family: var(--font-mono); font-size: 14px; font-weight: 600; color: var(--accent-primary); min-height: 52px; display: flex; align-items: center; justify-content: center;">
            ${t('keybinds.recording')}
          </div>
          <div style="font-size: 11px; color: var(--text-muted); margin-top: 10px;">
            ${t('soundboard.cancelEsc')}
          </div>
        </div>
        <div class="modal-footer" style="justify-content: center;">
          <button id="btn-cancel-action-keybind" class="btn btn-secondary">${t('common.cancel')}</button>
        </div>
      </div>
    `;

    document.body.appendChild(backdrop);

    const disposeCapture = captureShortcut(backdrop, backdrop.querySelector('#keybind-capture-box'), (combo) => {
      settingsStore.keybindShortcuts[actionId] = combo;
      settingsStore.save();
      keybindService.syncShortcuts();

      cleanup();

      const listContainer = container.querySelector<HTMLElement>('#keybinds-actions-list-container');
      if (listContainer) {
        listContainer.innerHTML = this.renderActionsList();
        this.attachEvents(container);
      }
    }, () => cleanup(), container);

    const cleanup = () => {
      disposeCapture();
      backdrop.remove();
    };

    backdrop.querySelector('#btn-cancel-action-keybind')?.addEventListener('click', cleanup);
  }
}
