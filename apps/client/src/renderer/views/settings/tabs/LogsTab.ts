import { CLIENT_LOG_DEFAULTS } from '@monky/shared';
import { clientLog } from '../../../core/ClientLogService';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export class LogsTab {
  public renderHtml(): string {
    return `
      <!-- Logging Toggle -->
      <div data-settings-section="logging" data-settings-label="${escapeHtml(t('settings.logsSection'))}" class="form-group" style="margin-bottom: 16px;">
        <label style="display: flex; align-items: center; gap: 6px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">description</span>
          ${t('settings.logsSection')}
        </label>
        <small style="display: block; margin-bottom: 8px; color: var(--text-muted); font-size: 11px;">
          ${t('settings.logsDesc')}
        </small>

        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px;">
          <div>
            <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 2px; cursor: pointer; font-weight: 600;" for="checkbox-logs-enabled">
              <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">toggle_on</span>
              ${t('settings.logsEnabled')}
            </label>
            <div style="font-size: 11px; color: var(--text-muted);">
              ${t('settings.logsEnabledDesc')}
            </div>
          </div>
          <label class="toggle-switch" aria-label="${t('settings.logsEnabled')}">
            <input id="checkbox-logs-enabled" type="checkbox">
            <span class="toggle-slider"></span>
          </label>
        </div>
      </div>

      <!-- Size Limit -->
      <div data-settings-section="log-size" data-settings-label="${escapeHtml(t('settings.logsSizeLimit'))}" class="form-group" style="margin-bottom: 16px; border-top: 1px dashed var(--border-color); padding-top: 12px;">
        <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-weight: 600;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">storage</span>
          ${t('settings.logsSizeLimit')}
        </label>
        <div style="display: flex; align-items: center; gap: 12px;">
          <select id="select-logs-max-size" style="flex: 1; padding: 6px 10px; border-radius: 6px; border: 1px solid var(--border-color); background: var(--bg-tertiary); color: var(--text-primary); font-size: 13px;">
            <option value="10485760">10 MB</option>
            <option value="26214400">25 MB</option>
            <option value="52428800">50 MB</option>
            <option value="104857600">100 MB</option>
            <option value="209715200">200 MB</option>
          </select>
        </div>
        <div id="logs-current-size" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;"></div>
      </div>

      <!-- Actions -->
      <div data-settings-section="log-actions" data-settings-label="${escapeHtml(t('settings.logsActions'))}" class="form-group" style="border-top: 1px solid var(--border-color); padding-top: 14px;">
        <label style="display: flex; align-items: center; gap: 6px; margin-bottom: 8px;">
          <span class="material-symbols-outlined md-16" style="color: var(--accent-primary);">build</span>
          ${t('settings.logsActions')}
        </label>
        <div style="display: flex; gap: 8px; flex-wrap: wrap;">
          <button id="btn-export-logs" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">download</span>
            ${t('settings.logsExport')}
          </button>
          <button id="btn-clear-logs" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px; color: var(--text-danger); border-color: rgba(255, 80, 80, 0.4);">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">delete</span>
            ${t('settings.logsClear')}
          </button>
        </div>
        <div id="logs-action-status" style="font-size: 11px; color: var(--text-muted); margin-top: 6px;"></div>
      </div>
    `;
  }

  public async attachEvents(container: HTMLElement): Promise<void> {
    const checkboxEnabled = container.querySelector<HTMLInputElement>('#checkbox-logs-enabled');
    const selectMaxSize = container.querySelector<HTMLSelectElement>('#select-logs-max-size');
    const currentSizeEl = container.querySelector<HTMLElement>('#logs-current-size');
    const btnExport = container.querySelector<HTMLButtonElement>('#btn-export-logs');
    const btnClear = container.querySelector<HTMLButtonElement>('#btn-clear-logs');
    const statusEl = container.querySelector<HTMLElement>('#logs-action-status');

    // Load current config
    try {
      const config = await window.api.getClientLogConfig();
      if (checkboxEnabled) checkboxEnabled.checked = config.enabled;
      if (selectMaxSize) selectMaxSize.value = String(config.maxSizeBytes);
    } catch {
      // defaults
      if (checkboxEnabled) checkboxEnabled.checked = CLIENT_LOG_DEFAULTS.enabled;
      if (selectMaxSize) selectMaxSize.value = String(CLIENT_LOG_DEFAULTS.maxSizeBytes);
    }

    // Load current size
    this.updateSize(currentSizeEl);

    // Toggle enabled
    checkboxEnabled?.addEventListener('change', async () => {
      const enabled = checkboxEnabled.checked;
      await window.api.setClientLogConfig({ enabled });
      clientLog.setEnabled(enabled);
      if (statusEl) statusEl.textContent = enabled ? t('settings.logsEnabledStatus') : t('settings.logsDisabledStatus');
    });

    // Size limit
    selectMaxSize?.addEventListener('change', async () => {
      const maxSizeBytes = parseInt(selectMaxSize.value, 10);
      if (maxSizeBytes > 0) {
        await window.api.setClientLogConfig({ maxSizeBytes });
      }
    });

    // Export
    btnExport?.addEventListener('click', async () => {
      if (statusEl) statusEl.textContent = t('settings.logsExporting');
      try {
        const result = await window.api.exportClientLogs();
        if (result.success) {
          if (statusEl) statusEl.textContent = t('settings.logsExportSuccess');
        } else if (result.error === 'cancelled') {
          if (statusEl) statusEl.textContent = '';
        } else if (result.error === 'no-logs') {
          if (statusEl) statusEl.textContent = t('settings.logsEmpty');
        } else {
          if (statusEl) statusEl.textContent = t('settings.logsExportError');
        }
      } catch {
        if (statusEl) statusEl.textContent = t('settings.logsExportError');
      }
      this.updateSize(currentSizeEl);
    });

    // Clear
    btnClear?.addEventListener('click', async () => {
      await window.api.clearClientLogs();
      if (statusEl) statusEl.textContent = t('settings.logsClearSuccess');
      this.updateSize(currentSizeEl);
    });
  }

  private async updateSize(el: HTMLElement | null): Promise<void> {
    if (!el) return;
    try {
      const size = await window.api.getClientLogSize();
      el.textContent = `${t('settings.logsCurrentSize')}: ${formatBytes(size)}`;
    } catch {
      el.textContent = '';
    }
  }
}
