import { serverStore } from '../../../stores/serverStore';
import { formatBytes } from '../../../utils/attachment';
import { t } from '../../../i18n';
import { escapeHtml } from '../../../utils/html';

export class ServerStorageTab {
  public renderHtml(): string {
    const s = serverStore.serverDetails;
    if (!s) return '';

    const usedBytes = s.attachmentStorage?.usedBytes ?? 0;
    const maxTotalBytes = s.attachmentStorage?.maxTotalBytes ?? 1024 * 1024 * 1024;
    const maxFileBytes = s.attachmentStorage?.maxFileBytes ?? 25 * 1024 * 1024;
    const usedPct = maxTotalBytes > 0 ? Math.min(100, Math.round((usedBytes / maxTotalBytes) * 100)) : 0;
    const barColor = usedPct >= 90 ? 'var(--danger)' : usedPct >= 75 ? '#f0b232' : 'var(--accent-primary)';
    const fileMb = Math.round(maxFileBytes / (1024 * 1024));
    const totalMb = Math.round(maxTotalBytes / (1024 * 1024));

    return `
      <div data-settings-section="attachment-storage" data-settings-label="${escapeHtml(t('serverSettings.tabStorage'))}" style="background: var(--bg-card); padding: 14px; border-radius: var(--radius-md); border: 1px solid var(--border-color);">
        <div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-secondary); margin-bottom: 6px;">
          <span id="server-storage-usage">${t('serverSettings.storageUsed', { used: formatBytes(usedBytes), total: formatBytes(maxTotalBytes) })}</span>
          <span id="server-storage-percent" style="font-weight: 600; color: ${barColor};">${usedPct}%</span>
        </div>
        <div style="height: 8px; background: var(--bg-input); border-radius: 999px; overflow: hidden; margin-bottom: 4px;">
          <div id="server-storage-fill" style="height: 100%; width: ${usedPct}%; background: ${barColor}; border-radius: 999px; transition: width 0.3s;"></div>
        </div>
        <div style="font-size: 11px; color: var(--text-muted); margin-bottom: 14px;">
          ${t('serverSettings.storageHint')}
        </div>

        <div style="display: flex; gap: 12px;">
          <div class="form-group" style="margin-bottom: 0; flex: 1;">
            <label style="margin-bottom: 4px; font-size: 12px;">${t('serverSettings.limitPerFile')}</label>
            <input id="input-attach-file-mb" type="number" min="1" step="1" value="${fileMb}">
          </div>
          <div class="form-group" style="margin-bottom: 0; flex: 1;">
            <label style="margin-bottom: 4px; font-size: 12px;">${t('serverSettings.limitTotal')}</label>
            <input id="input-attach-total-mb" type="number" min="1" step="1" value="${totalMb}">
          </div>
        </div>
      </div>
    `;
  }

  public refreshState(root: HTMLElement): void {
    const storage = serverStore.serverDetails?.attachmentStorage;
    if (!storage) return;
    const percent = storage.maxTotalBytes > 0 ? Math.max(0, Math.min(100, Math.round(storage.usedBytes / storage.maxTotalBytes * 100))) : 0;
    const color = percent >= 90 ? 'var(--danger)' : percent >= 75 ? '#f0b232' : 'var(--accent-primary)';
    const usage = root.querySelector('#server-storage-usage');
    if (usage) usage.textContent = t('serverSettings.storageUsed', { used: formatBytes(storage.usedBytes), total: formatBytes(storage.maxTotalBytes) });
    const label = root.querySelector<HTMLElement>('#server-storage-percent');
    if (label) { label.textContent = `${percent}%`; label.style.color = color; }
    const fill = root.querySelector<HTMLElement>('#server-storage-fill');
    if (fill) { fill.style.width = `${percent}%`; fill.style.background = color; }
  }
}
