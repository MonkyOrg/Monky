import type { BotDeviceStorageEntry } from '@monky/shared';
import { t } from '../../i18n';
import { formatBytes } from '../../utils/attachment';
import { escapeHtml } from '../../utils/html';
import { renderLoadingIndicator } from '../../utils/loadingIndicator';
import { storageUsageHtml } from '../../utils/storageUsage';
import { showErrorToast, showSuccessToast } from '../CopyToast';
import { showConfirm } from '../Dialog';

const DECISION_KEYS = {
  ask: 'botStorage.localDecision.ask',
  always: 'botStorage.localDecision.always',
  never: 'botStorage.localDecision.never',
} as const;

/** Everything bots kept on this computer, including servers and bots the person no longer uses. */
export class BotDeviceStorageList {
  private root: HTMLElement | null = null;
  private entries: BotDeviceStorageEntry[] = [];
  private loading = false;
  private failed = false;
  private busy = false;
  /** Changes only when the list is attached or cleaned up; a newer load never cancels a removal. */
  private mount = 0;
  private request = 0;
  private unsubscribe: (() => void) | null = null;

  static html(): string {
    return `<p style="color: var(--text-muted);">${escapeHtml(t('botStorage.localDescription'))}</p>
      <div data-bot-storage-list aria-live="polite"></div>`;
  }

  attach(root: HTMLElement): void {
    this.cleanup();
    this.root = root;
    root.addEventListener('click', this.onClick);
    if (!window.api?.botStorage) {
      this.failed = true;
      this.render();
      return;
    }
    this.unsubscribe = window.api.botStorage.onChanged(() => { if (!this.busy) void this.load(); });
    void this.load();
  }

  cleanup(): void {
    this.mount++;
    this.root?.removeEventListener('click', this.onClick);
    this.root = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.entries = [];
    this.loading = this.failed = this.busy = false;
  }

  private async load(): Promise<void> {
    const mount = this.mount;
    const request = ++this.request;
    const current = (): boolean => mount === this.mount && request === this.request;
    this.loading = true;
    this.render();
    try {
      const entries = await window.api.botStorage.list();
      if (!current()) return;
      // A preference without data still shows, so the person can find and remove it.
      this.entries = entries.filter((entry) => entry.usage.objectCount > 0 || entry.decision !== 'ask');
      this.failed = false;
    } catch (error: unknown) {
      if (!current()) return;
      console.warn('[Bot storage] Could not list the bot data on this computer.', error);
      this.failed = true;
    } finally {
      if (current()) {
        this.loading = false;
        this.render();
      }
    }
  }

  private render(): void {
    const root = this.root;
    if (!root?.isConnected) return;
    const focusedId = document.activeElement instanceof HTMLElement && root.contains(document.activeElement)
      ? document.activeElement.dataset.botStorageForget : undefined;
    if (this.loading && !this.entries.length) {
      root.innerHTML = `<p role="status">${renderLoadingIndicator(t('botStorage.loading'))}</p>`;
      return;
    }
    if (this.failed) {
      root.innerHTML = `<p style="color: var(--text-muted);">${escapeHtml(t('botStorage.localLoadFailed'))}</p>`;
      return;
    }
    if (!this.entries.length) {
      root.innerHTML = `<p style="color: var(--text-muted);">${escapeHtml(t('botStorage.localEmpty'))}</p>`;
      return;
    }
    root.innerHTML = this.entries.map((entry) => `<div class="bot-device-storage-entry">
      <div class="bot-device-storage-entry-header">
        <div>
          <strong>${escapeHtml(t('botStorage.localEntry', { bot: entry.scope.botName, server: entry.scope.serverName }))}</strong>
          <div class="bot-device-storage-entry-meta">${escapeHtml(t(DECISION_KEYS[entry.decision]))} · ${escapeHtml(new URL(entry.scope.serverUrl).host)}</div>
        </div>
        <button type="button" class="btn btn-danger" data-bot-storage-forget="${escapeHtml(entry.id)}" ${this.busy ? 'disabled' : ''}
          aria-label="${escapeHtml(`${t('botStorage.localRemove')}: ${t('botStorage.localEntry', { bot: entry.scope.botName, server: entry.scope.serverName })}`)}">
          ${escapeHtml(t('botStorage.localRemove'))}</button>
      </div>
      ${storageUsageHtml(entry.usage)}
    </div>`).join('');
    if (focusedId) root.querySelector<HTMLElement>(`[data-bot-storage-forget="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
  }

  private onClick = (event: MouseEvent): void => {
    if (!(event.target instanceof Element) || this.busy) return;
    const id = event.target.closest<HTMLElement>('[data-bot-storage-forget]')?.dataset.botStorageForget;
    const entry = this.entries.find((candidate) => candidate.id === id);
    if (entry) void this.forget(entry);
  };

  private async forget(entry: BotDeviceStorageEntry): Promise<void> {
    const mount = this.mount;
    const confirmed = await showConfirm({
      title: t('botStorage.localRemoveTitle'),
      message: t('botStorage.localRemoveConfirm', {
        bot: entry.scope.botName, server: entry.scope.serverName, size: formatBytes(entry.usage.usedBytes),
      }),
      confirmLabel: t('botStorage.localRemove'),
      variant: 'danger',
      focusCancel: true,
    });
    // Bots may keep saving while the person decides: that refreshes the list, but only closing the tab cancels.
    if (!confirmed || mount !== this.mount) return;
    this.busy = true;
    this.render();
    try {
      await window.api.botStorage.forget(entry.id);
      if (mount === this.mount) showSuccessToast(t('botStorage.localRemoved'));
    } catch (error: unknown) {
      console.warn('[Bot storage] Could not delete the bot data on this computer.', error);
      if (mount === this.mount) showErrorToast(t('botStorage.localRemoveFailed'));
    } finally {
      if (mount === this.mount) {
        this.busy = false;
        await this.load();
      }
    }
  }
}
