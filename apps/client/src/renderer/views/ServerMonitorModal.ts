import '../styles/serverMonitor.css';
import { LOG_LEVELS, SERVER_MONITOR_LIMITS, type LogLevel, type ServerMonitorLogLine, type ServerMonitorStats } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { renderLoadingSkeleton } from '../utils/loadingSkeleton';
import { t, type TranslationKey } from '../i18n';
import { openModal, type ModalShell } from '../utils/modalShell';
import { copyText, reportError } from '../utils/feedback';
import { RequestTimeoutError } from '../core/NetworkClient';
import type { ServerSession } from '../core/SessionManager';
import { isVisibleSession, watchVisibleSession } from '../core/visibleSession';
import { smoothScrollTo } from '../utils/scroll';
import {
  LocalServerMonitorSource, RemoteServerMonitorSource, ServerMonitorError, ServerMonitorFeed,
  type MonitorUpdate, type ServerMonitorFailure, type ServerMonitorSource,
} from '../core/ServerMonitorFeed';

const FAILURE_KEYS: Record<ServerMonitorFailure, TranslationKey> = {
  permissionDenied: 'serverMonitor.permissionDenied',
  disconnected: 'serverMonitor.disconnected',
  serverChanged: 'serverMonitor.serverChanged',
  localStopped: 'serverMonitor.localStopped',
  localUnavailable: 'serverMonitor.localUnavailable',
  invalidResponse: 'serverMonitor.invalidResponse',
};

/** Explicit sources prevent remote failures from exposing a different local server. */
export class ServerMonitorModal {
  private shell: ModalShell | null = null;
  private modalEl: HTMLElement | null = null;
  private entries: ServerMonitorLogLine[] = [];
  private levelFilter: LogLevel | 'ALL' = 'ALL';
  private searchTerm = '';
  private autoScroll = true;
  private feed: ServerMonitorFeed | null = null;
  private cleanup: Array<() => void> = [];
  private generation = 0;
  private dropped = 0;
  private failureMessage: string | null = null;
  private loading = true;

  public async openRemote(session: ServerSession): Promise<void> {
    const source = new RemoteServerMonitorSource(session.client, session.serverStore, () => isVisibleSession(session));
    await this.openSource(source, session);
  }

  public async openLocal(port: number): Promise<void> {
    await this.openSource(new LocalServerMonitorSource(window.api, port));
  }

  private async openSource(source: ServerMonitorSource, session?: ServerSession): Promise<void> {
    this.close();
    const generation = this.generation;

    this.entries = [];
    this.levelFilter = 'ALL';
    this.searchTerm = '';
    this.autoScroll = true;
    this.dropped = 0;
    this.failureMessage = null;
    this.loading = true;
    const shell = openModal({
      card: `
      <div class="modal-card server-monitor-card" aria-labelledby="monitor-title"
        aria-describedby="monitor-source" tabindex="-1">
        <div class="modal-header">
          <div id="monitor-title" class="modal-title server-monitor-title">
            <span class="material-symbols-outlined" aria-hidden="true">monitoring</span>
            <span>${t('serverMonitor.title')}</span>
          </div>
          <button type="button" id="modal-close" class="modal-close-btn" data-modal-close aria-label="${t('common.close')}">&times;</button>
        </div>

        <div id="monitor-source" class="server-monitor-source">
          ${escapeHtml(session
            ? t('serverMonitor.remoteSource', { server: session.serverStore.serverDetails?.name ?? '' })
            : t('serverMonitor.localSource'))}
        </div>
        <div class="server-monitor-hint">${t(session ? 'serverMonitor.remotePrivacy' : 'serverMonitor.clearHint')}</div>

        <div id="monitor-stats" class="server-monitor-stats" aria-busy="true">
          ${this.renderStatsSkeleton()}
        </div>

        <div class="server-monitor-toolbar">
          <div class="server-monitor-levels">
            ${(['ALL', ...LOG_LEVELS] as const)
              .map(
                (level) => `
                  <button type="button" class="btn btn-secondary server-monitor-level" data-level="${level}"
                    aria-pressed="${level === this.levelFilter}">
                    ${level === 'ALL' ? t('serverMonitor.levelAll') : level}
                  </button>
                `
              )
              .join('')}
          </div>
          <input id="monitor-search" class="server-monitor-search" type="text" aria-label="${t('serverMonitor.searchPlaceholder')}" placeholder="${t('serverMonitor.searchPlaceholder')}">
          <div class="server-monitor-autoscroll">
            <label for="monitor-autoscroll">${t('serverMonitor.autoScroll')}</label>
            <label class="toggle-switch toggle-switch-sm" aria-label="${t('serverMonitor.autoScroll')}">
              <input id="monitor-autoscroll" type="checkbox" role="switch" checked>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>

        <div id="monitor-logs" class="server-monitor-logs">
          ${renderLoadingSkeleton('lines', 6)}
        </div>

        <div id="monitor-dropped" class="server-monitor-dropped" role="status" hidden></div>
        <div class="modal-footer server-monitor-footer">
          <span id="monitor-count" class="server-monitor-count"></span>
          <button type="button" id="btn-copy-logs" class="btn btn-secondary" disabled>
            <span class="material-symbols-outlined md-16">content_copy</span>
            ${t('serverMonitor.copy')}
          </button>
          <button type="button" id="btn-clear-logs" class="btn btn-secondary" disabled title="${t('serverMonitor.clearHint')}">
            <span class="material-symbols-outlined md-16">delete_sweep</span>
            ${t('serverMonitor.clearView')}
          </button>
        </div>
      </div>
    `,
      initialFocus: '#modal-close',
      onClose: () => { if (this.shell === shell) this.teardown(); },
    });
    this.shell = shell;
    this.modalEl = shell.element;
    this.attachEvents(shell.signal);
    const modal = shell.element;
    const isCurrent = () => generation === this.generation && this.modalEl === modal;
    const feed = new ServerMonitorFeed(source, (update) => {
      if (isCurrent()) this.applyUpdate(update);
    }, (error) => {
      if (!isCurrent()) return;
      this.stopMonitoring();
      this.failureMessage = error instanceof ServerMonitorError ? t(FAILURE_KEYS[error.reason])
        : error instanceof RequestTimeoutError ? t('serverMonitor.timeout')
        : t('serverMonitor.loadFailed', {
            error: error instanceof Error ? error.message : t('protocolError.internalError'),
          });
      this.entries = [];
      this.dropped = 0;
      this.loading = false;
      // Why it stopped goes to the alert toast; the view keeps saying that it stopped.
      reportError(this.failureMessage);
      const statsEl = modal.querySelector<HTMLElement>('#monitor-stats');
      if (statsEl) {
        statsEl.setAttribute('aria-busy', 'false');
        statsEl.innerHTML = this.renderStatsSkeleton();
      }
      this.renderLogs();
    });
    this.feed = feed;
    if (session) this.cleanup.push(watchVisibleSession(session, () => feed.revalidate(), () => this.close(true)));
    await feed.start();
  }

  private applyUpdate(update: MonitorUpdate): void {
    const firstUpdate = this.loading;
    this.loading = false;
    this.renderStats(update.stats);
    if (update.replaceLogs) this.entries = [];
    this.entries.push(...update.entries);
    if (this.entries.length > SERVER_MONITOR_LIMITS.HISTORY_ENTRIES) {
      this.entries.splice(0, this.entries.length - SERVER_MONITOR_LIMITS.HISTORY_ENTRIES);
    }
    this.dropped += update.dropped;
    if (firstUpdate || update.replaceLogs || update.entries.length || update.dropped) this.renderLogs();
  }

  private renderStatsSkeleton(): string {
    const cards: Array<{ id: string; icon: string; label: string }> = [
      { id: 'uptime', icon: 'schedule', label: t('serverMonitor.uptime') },
      { id: 'online', icon: 'group', label: t('serverMonitor.online') },
      { id: 'members', icon: 'badge', label: t('serverMonitor.members') },
      { id: 'channels', icon: 'tag', label: t('serverMonitor.channels') },
      { id: 'messages', icon: 'chat', label: t('serverMonitor.messages') },
      { id: 'port', icon: 'lan', label: t('serverMonitor.port') },
    ];

    return cards
      .map(
        (card) => `
          <div class="server-monitor-stat">
            <div class="server-monitor-stat-label">
              <span class="material-symbols-outlined md-14">${card.icon}</span>
              ${card.label}
            </div>
            <div id="stat-${card.id}" class="server-monitor-stat-value">${this.loading ? '<span class="skeleton loading-skeleton-value" aria-hidden="true"></span>' : '—'}</div>
          </div>
        `
      )
      .join('');
  }

  private renderStats(stats: ServerMonitorStats): void {
    this.modalEl?.querySelector('#monitor-stats')?.setAttribute('aria-busy', 'false');
    const set = (id: string, value: string) => {
      const el = this.modalEl?.querySelector<HTMLElement>(`#stat-${id}`);
      if (el) el.textContent = value;
    };

    set('uptime', this.formatUptime(stats.uptimeMs));
    // Online and the membership cap are different things (#403): the cap counts
    // registered members, so pairing it with the online count would be wrong.
    set('online', String(stats.onlineUsers));
    set('members', stats.maxUsers > 0 ? `${stats.members}/${stats.maxUsers}` : String(stats.members));
    set('channels', String(stats.channels));
    set('messages', String(stats.messages));
    set('port', String(stats.port));
  }

  private formatUptime(ms: number): string {
    if (ms <= 0) return '—';
    const totalSeconds = Math.floor(ms / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${minutes}m`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  private getVisibleEntries(): ServerMonitorLogLine[] {
    const term = this.searchTerm.toLowerCase();
    return this.entries.filter((entry) => {
      if (this.levelFilter !== 'ALL' && entry.level !== this.levelFilter) return false;
      if (!term) return true;
      return (
        entry.message.toLowerCase().includes(term) || entry.category.toLowerCase().includes(term)
      );
    });
  }

  private renderLogs(): void {
    if (!this.modalEl) return;
    const container = this.modalEl.querySelector<HTMLElement>('#monitor-logs');
    const countEl = this.modalEl.querySelector<HTMLElement>('#monitor-count');
    if (!container) return;
    container.setAttribute('aria-busy', String(this.loading));
    if (this.loading) {
      container.innerHTML = renderLoadingSkeleton('lines', 6);
      if (countEl) countEl.textContent = t('common.loading');
      return;
    }

    const visible = this.getVisibleEntries();
    const copyButton = this.modalEl.querySelector<HTMLButtonElement>('#btn-copy-logs');
    const clearButton = this.modalEl.querySelector<HTMLButtonElement>('#btn-clear-logs');
    if (copyButton) copyButton.disabled = visible.length === 0;
    if (clearButton) clearButton.disabled = this.entries.length === 0;
    const droppedEl = this.modalEl.querySelector<HTMLElement>('#monitor-dropped');
    if (droppedEl) {
      droppedEl.hidden = this.dropped === 0;
      droppedEl.textContent = this.dropped ? t('serverMonitor.dropped', { count: this.dropped }) : '';
    }

    if (countEl) {
      countEl.textContent = t('serverMonitor.entryCount', {
        shown: visible.length,
        total: this.entries.length,
      });
    }

    if (visible.length === 0) {
      container.innerHTML = `<div class="server-monitor-empty">${
        this.failureMessage ? t('serverMonitor.stopped')
          : this.entries.length === 0 ? t('serverMonitor.empty') : t('serverMonitor.noMatches')
      }</div>`;
      return;
    }

    const scrollTop = container.scrollTop;
    container.innerHTML = visible
      .map((entry) => `
          <div class="server-monitor-line">
            <span class="server-monitor-time">${escapeHtml(this.formatTime(entry.timestamp))}</span>
            <span class="server-monitor-category" data-level="${entry.level}">[${escapeHtml(entry.category)}]</span>
            <span class="server-monitor-message">${escapeHtml(entry.message)}</span>
          </div>
        `)
      .join('');

    if (this.autoScroll) {
      smoothScrollTo(container, { top: container.scrollHeight });
    } else container.scrollTop = scrollTop;
  }

  private formatTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleTimeString();
  }

  private attachEvents(signal: AbortSignal): void {
    if (!this.modalEl) return;
    const options = { signal };

    const levels = this.modalEl.querySelectorAll<HTMLButtonElement>('.server-monitor-level');
    for (const btn of levels) {
      btn.addEventListener('click', () => {
        const value = btn.dataset.level;
        const level = value === 'ALL' ? 'ALL' : LOG_LEVELS.find((entry) => entry === value);
        if (!level) return;
        this.levelFilter = level;
        for (const other of levels) other.setAttribute('aria-pressed', String(other === btn));
        this.renderLogs();
      }, options);
    }

    const search = this.modalEl.querySelector<HTMLInputElement>('#monitor-search');
    search?.addEventListener('input', () => {
      this.searchTerm = search.value.trim();
      this.renderLogs();
    }, options);

    const autoScroll = this.modalEl.querySelector<HTMLInputElement>('#monitor-autoscroll');
    autoScroll?.addEventListener('change', () => {
      this.autoScroll = autoScroll.checked;
      if (this.autoScroll) this.renderLogs();
    }, options);

    this.modalEl.querySelector('#btn-copy-logs')?.addEventListener('click', () => {
      const text = this.getVisibleEntries()
        .map((entry) => `${entry.timestamp} [${entry.category}] ${entry.message}`)
        .join('\n');
      void copyText(text, { copied: t('serverMonitor.copied'), failed: t('serverMonitor.copyFailed') });
    }, options);

    this.modalEl.querySelector('#btn-clear-logs')?.addEventListener('click', () => {
      this.entries = [];
      this.dropped = 0;
      this.renderLogs();
    }, options);
  }

  private stopMonitoring(): void {
    this.feed?.stop();
    this.feed = null;
    for (const cleanup of this.cleanup.splice(0)) cleanup();
  }

  /** Another server's logs leave at once when it stops being the visible one; an ordinary close animates out. */
  public close(immediate = false): void {
    if (this.shell) this.shell.close('api', immediate);
    else this.teardown();
  }

  private teardown(): void {
    this.generation++;
    this.stopMonitoring();
    this.shell = null;
    this.modalEl = null;
    this.entries = [];
  }
}

export const serverMonitorModal = new ServerMonitorModal();
