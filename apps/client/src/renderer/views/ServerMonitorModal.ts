import { LOG_LEVELS, SERVER_MONITOR_LIMITS, type LogEntry, type LogLevel, type ServerMonitorStats } from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { t, type TranslationKey } from '../i18n';
import { appEvents } from '../core/EventBus';
import { RequestTimeoutError } from '../core/NetworkClient';
import { sessionManager, type ServerSession } from '../core/SessionManager';
import { currentEventOrigin } from '../core/sessionRouting';
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

const LEVEL_COLORS: Record<LogLevel, string> = {
  INFO: 'var(--text-secondary)',
  WARN: 'var(--warning, #faa61a)',
  ERROR: 'var(--danger)',
};

/** Explicit sources prevent remote failures from exposing a different local server. */
export class ServerMonitorModal {
  private modalEl: HTMLElement | null = null;
  private entries: LogEntry[] = [];
  private levelFilter: LogLevel | 'ALL' = 'ALL';
  private searchTerm = '';
  private autoScroll = true;
  private feed: ServerMonitorFeed | null = null;
  private cleanup: Array<() => void> = [];
  private events: AbortController | null = null;
  private generation = 0;
  private previousFocus: HTMLElement | null = null;
  private dropped = 0;
  private failureMessage: string | null = null;

  public async openRemote(session: ServerSession): Promise<void> {
    const source = new RemoteServerMonitorSource(
      session.client, session.serverStore,
      () => sessionManager.getActive() === session && sessionManager.get(session.key) === session,
    );
    await this.openSource(source, session);
  }

  public async openLocal(): Promise<void> {
    await this.openSource(new LocalServerMonitorSource(window.api));
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
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.events = new AbortController();

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="monitor-title"
        aria-describedby="monitor-source" tabindex="-1" style="max-width: 860px; width: 92vw;">
        <div class="modal-header">
          <div id="monitor-title" class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" aria-hidden="true" style="color: var(--accent-primary);">monitoring</span>
            <span>${t('serverMonitor.title')}</span>
          </div>
          <button type="button" id="modal-close" class="modal-close-btn" aria-label="${t('common.close')}">&times;</button>
        </div>

        <div id="monitor-source" style="font-size: 12px; color: var(--text-secondary);">
          ${escapeHtml(session
            ? t('serverMonitor.remoteSource', { server: session.serverStore.serverDetails?.name ?? '' })
            : t('serverMonitor.localSource'))}
        </div>
        <div style="font-size: 11px; color: var(--text-muted);">${t(session ? 'serverMonitor.remotePrivacy' : 'serverMonitor.clearHint')}</div>
        <p id="monitor-error" role="alert" hidden style="color: var(--danger); margin: 0;"></p>

        <div id="monitor-stats" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px;">
          ${this.renderStatsSkeleton()}
        </div>

        <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
          <div style="display: flex; gap: 4px;">
            ${(['ALL', ...LOG_LEVELS] as const)
              .map(
                (level) => `
                  <button type="button" class="btn btn-secondary btn-log-level" data-level="${level}"
                    style="padding: 4px 10px; font-size: 11px; height: 26px;">
                    ${level === 'ALL' ? t('serverMonitor.levelAll') : level}
                  </button>
                `
              )
              .join('')}
          </div>
          <input id="monitor-search" type="text" aria-label="${t('serverMonitor.searchPlaceholder')}" placeholder="${t('serverMonitor.searchPlaceholder')}"
            style="flex: 1; min-width: 140px; font-size: 12px; padding: 5px 10px; height: 26px;">
          <div style="display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-muted); white-space: nowrap;">
            <label for="monitor-autoscroll" style="cursor: pointer;">${t('serverMonitor.autoScroll')}</label>
            <label class="toggle-switch toggle-switch-sm" aria-label="${t('serverMonitor.autoScroll')}">
              <input id="monitor-autoscroll" type="checkbox" role="switch" checked>
              <span class="toggle-slider"></span>
            </label>
          </div>
        </div>

        <div id="monitor-logs" style="background: var(--bg-tertiary, #1e1f22); border: 1px solid var(--border-color); border-radius: var(--radius-md); height: 320px; overflow-y: auto; padding: 8px 10px; font-family: var(--font-mono); font-size: 11px; line-height: 1.6;">
          <div style="color: var(--text-muted); text-align: center; padding: 16px;">${t('serverMonitor.loading')}</div>
        </div>

        <div id="monitor-dropped" role="status" hidden style="font-size: 11px; color: var(--warning);"></div>
        <div id="monitor-action-status" role="status" style="font-size: 11px; color: var(--text-secondary);"></div>
        <div class="modal-footer" style="display: flex; gap: 8px;">
          <span id="monitor-count" style="flex: 1; font-size: 11px; color: var(--text-muted); align-self: center;"></span>
          <button type="button" id="btn-copy-logs" class="btn btn-secondary" disabled style="font-size: 12px; padding: 6px 12px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">content_copy</span>
            ${t('serverMonitor.copy')}
          </button>
          <button type="button" id="btn-clear-logs" class="btn btn-secondary" disabled title="${t('serverMonitor.clearHint')}" style="font-size: 12px; padding: 6px 12px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">delete_sweep</span>
            ${t('serverMonitor.clearView')}
          </button>
        </div>
      </div>
    `;

    document.body.appendChild(this.modalEl);
    this.attachEvents();
    this.updateLevelButtons();
    this.modalEl.querySelector<HTMLButtonElement>('#modal-close')?.focus();
    const modal = this.modalEl;
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
      const errorEl = modal.querySelector<HTMLElement>('#monitor-error');
      if (errorEl) { errorEl.textContent = this.failureMessage; errorEl.hidden = false; }
      const statsEl = modal.querySelector<HTMLElement>('#monitor-stats');
      if (statsEl) statsEl.innerHTML = this.renderStatsSkeleton();
      this.renderLogs();
    });
    this.feed = feed;
    if (session) {
      const revalidate = () => {
        const origin = currentEventOrigin();
        if (origin === null || origin === session.key) feed.revalidate();
      };
      this.cleanup.push(
        appEvents.on('server.updated', revalidate),
        appEvents.on('server.roles_updated', revalidate),
        appEvents.on('network.status', revalidate),
        appEvents.on('session.changed', () => {
          if (sessionManager.getActive() !== session || sessionManager.get(session.key) !== session) this.close();
        }),
      );
    }
    await feed.start();
  }

  private applyUpdate(update: MonitorUpdate): void {
    this.renderStats(update.stats);
    if (update.replaceLogs) this.entries = [];
    this.entries.push(...update.entries);
    if (this.entries.length > SERVER_MONITOR_LIMITS.HISTORY_ENTRIES) {
      this.entries.splice(0, this.entries.length - SERVER_MONITOR_LIMITS.HISTORY_ENTRIES);
    }
    this.dropped += update.dropped;
    if (update.replaceLogs || update.entries.length || update.dropped) this.renderLogs();
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
          <div style="background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 8px 10px;">
            <div style="display: flex; align-items: center; gap: 4px; font-size: 10px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.4px;">
              <span class="material-symbols-outlined md-14">${card.icon}</span>
              ${card.label}
            </div>
            <div id="stat-${card.id}" style="font-size: 16px; font-weight: 700; color: var(--text-primary); margin-top: 2px;">—</div>
          </div>
        `
      )
      .join('');
  }

  private renderStats(stats: ServerMonitorStats): void {
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

  private getVisibleEntries(): LogEntry[] {
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
      container.innerHTML = `<div style="color: var(--text-muted); text-align: center; padding: 16px;">${
        this.failureMessage ? t('serverMonitor.stopped')
          : this.entries.length === 0 ? t('serverMonitor.empty') : t('serverMonitor.noMatches')
      }</div>`;
      return;
    }

    const scrollTop = container.scrollTop;
    container.innerHTML = visible
      .map((entry) => {
        const time = this.formatTime(entry.timestamp);
        return `
          <div style="display: flex; gap: 8px; white-space: pre-wrap; word-break: break-word;">
            <span style="color: var(--text-muted); flex-shrink: 0;">${escapeHtml(time)}</span>
            <span style="color: ${LEVEL_COLORS[entry.level]}; flex-shrink: 0; font-weight: 600;">[${escapeHtml(entry.category)}]</span>
            <span style="color: var(--text-primary);">${escapeHtml(entry.message)}</span>
          </div>
        `;
      })
      .join('');

    if (this.autoScroll) {
      container.scrollTop = container.scrollHeight;
    } else container.scrollTop = scrollTop;
  }

  private formatTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleTimeString();
  }

  private updateLevelButtons(): void {
    if (!this.modalEl) return;
    this.modalEl.querySelectorAll<HTMLElement>('.btn-log-level').forEach((btn) => {
      const isActive = btn.getAttribute('data-level') === this.levelFilter;
      btn.setAttribute('aria-pressed', String(isActive));
      btn.style.background = isActive ? 'var(--accent-primary)' : '';
      btn.style.color = isActive ? '#fff' : '';
      btn.style.borderColor = isActive ? 'var(--accent-primary)' : '';
    });
  }

  private attachEvents(): void {
    if (!this.modalEl || !this.events) return;
    const modal = this.modalEl;
    const generation = this.generation;
    const options = { signal: this.events.signal };
    modal.querySelector('#modal-close')?.addEventListener('click', () => this.close(), options);
    modal.addEventListener('mousedown', (event) => {
      if (event.target === modal) this.close();
    }, options);
    document.addEventListener('keydown', (event) => {
      if (Array.from(document.querySelectorAll('.modal-backdrop')).at(-1) !== modal) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        this.close();
      } else if (event.key === 'Tab') {
        const focusable = Array.from(modal.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex="0"]',
        )).filter((element) => element.getClientRects().length > 0);
        const target = event.shiftKey ? focusable.at(-1) : focusable[0];
        const boundary = event.shiftKey ? focusable[0] : focusable.at(-1);
        if (document.activeElement === boundary || !modal.contains(document.activeElement)) {
          event.preventDefault();
          target?.focus();
        }
      }
    }, { ...options, capture: true });

    this.modalEl.querySelectorAll<HTMLElement>('.btn-log-level').forEach((btn) => {
      btn.addEventListener('click', () => {
        const value = btn.getAttribute('data-level');
        const level = value === 'ALL' ? 'ALL' : LOG_LEVELS.find((entry) => entry === value);
        if (!level) return;
        this.levelFilter = level;
        this.updateLevelButtons();
        this.renderLogs();
      }, options);
    });

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

    this.modalEl.querySelector('#btn-copy-logs')?.addEventListener('click', async () => {
      const text = this.getVisibleEntries()
        .map((entry) => `${entry.timestamp} [${entry.category}] ${entry.message}`)
        .join('\n');
      try {
        await navigator.clipboard.writeText(text);
        if (generation !== this.generation) return;
        const status = modal.querySelector<HTMLElement>('#monitor-action-status');
        if (status) status.textContent = t('serverMonitor.copied');
      } catch (error) {
        if (generation !== this.generation) return;
        console.warn('[ServerMonitorModal] Could not copy logs', error);
        const status = modal.querySelector<HTMLElement>('#monitor-action-status');
        if (status) status.textContent = t('serverMonitor.copyFailed');
      }
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

  public close(): void {
    this.generation++;
    this.stopMonitoring();
    this.events?.abort();
    this.events = null;
    if (this.modalEl) {
      this.modalEl.remove();
      this.modalEl = null;
    }
    this.entries = [];
    const previousFocus = this.previousFocus;
    this.previousFocus = null;
    if (previousFocus?.isConnected) previousFocus.focus();
  }
}

export const serverMonitorModal = new ServerMonitorModal();
