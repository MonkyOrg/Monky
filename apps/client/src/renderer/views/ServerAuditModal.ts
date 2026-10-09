import '../styles/serverAudit.css';
import {
  SERVER_AUDIT_CATEGORIES, SERVER_AUDIT_LIMITS,
  type ServerAuditCategory, type ServerAuditEntry,
} from '@monky/shared';
import { t, type TranslationKey } from '../i18n';
import { escapeHtml } from '../utils/html';
import { renderLoadingSkeleton } from '../utils/loadingSkeleton';
import { enterModal, exitModal, handlesModalKey } from '../utils/modalSurface';
import { animateEnter } from '../utils/surfaceMotion';
import { appEvents } from '../core/EventBus';
import { RequestTimeoutError } from '../core/NetworkClient';
import { sessionManager, type ServerSession } from '../core/SessionManager';
import { currentEventOrigin } from '../core/sessionRouting';
import {
  ServerAuditError, ServerAuditSource, endsServerAudit, type ServerAuditFailure, type ServerAuditQuery,
} from '../core/ServerAuditSource';
import { showErrorToast } from './CopyToast';
import {
  AUDIT_CATEGORY_ICONS, AUDIT_CATEGORY_LABELS, formatAuditEntry, formatAuditTime, type FormattedAuditChange,
} from './serverAuditFormat';

const FAILURE_KEYS: Record<ServerAuditFailure, TranslationKey> = {
  permissionDenied: 'serverAudit.permissionDenied',
  disconnected: 'serverAudit.disconnected',
  serverChanged: 'serverAudit.serverChanged',
  updateRequired: 'serverAudit.updateRequired',
  invalidResponse: 'serverAudit.invalidResponse',
};

const SEARCH_DEBOUNCE_MS = 300;

type AuditFilter = ServerAuditCategory | 'all';

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function changeHtml(change: FormattedAuditChange): string {
  const label = `<span class="server-audit-field">${escapeHtml(change.label)}:</span>`;
  if (change.changedOnly) return `${label} ${escapeHtml(t('serverAudit.changed'))}`;
  const before = change.before === undefined ? '' : `<span class="server-audit-before">${escapeHtml(change.before)}</span>`;
  const after = `<span class="server-audit-after">${escapeHtml(change.after ?? '—')}</span>`;
  if (!before) return `${label} ${after}`;
  return `${label} ${before} <span aria-hidden="true">→</span><span class="server-audit-sr"> ${escapeHtml(t('serverAudit.changedTo'))} </span> ${after}`;
}

export function auditEntryHtml(entry: ServerAuditEntry): string {
  const formatted = formatAuditEntry(entry);
  const related = formatted.related.map((item) => `${escapeHtml(item.label)}: ${escapeHtml(item.name)}`).join(' · ');
  return `
    <li class="server-audit-entry" data-audit-id="${entry.id}">
      <span class="material-symbols-outlined server-audit-icon" aria-hidden="true">${formatted.icon}</span>
      <div class="server-audit-body">
        <div class="server-audit-summary">${formatted.summary}</div>
        ${related ? `<div class="server-audit-related">${related}</div>` : ''}
        ${formatted.changes.length ? `<ul class="server-audit-changes">${formatted.changes
          .map((change) => `<li class="server-audit-change">${changeHtml(change)}</li>`).join('')}</ul>` : ''}
        <time class="server-audit-time" datetime="${new Date(entry.createdAt).toISOString()}">${escapeHtml(formatAuditTime(entry.createdAt))}</time>
      </div>
    </li>
  `;
}

/**
 * One server at a time, bound to the connection and member that opened it.
 * Reads run one after another, so a refresh can never interleave with
 * "load more" and reorder the list; changing a filter discards stale pages.
 */
export class ServerAuditModal {
  private modalEl: HTMLElement | null = null;
  private source: ServerAuditSource | null = null;
  private entries: ServerAuditEntry[] = [];
  private filter: AuditFilter = 'all';
  private query = '';
  private hasMore = false;
  private loading = false;
  private loadingMore = false;
  private failed = false;
  private view = 0;
  private queue: Promise<void> = Promise.resolve();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private cleanup: Array<() => void> = [];
  private events: AbortController | null = null;
  private previousFocus: HTMLElement | null = null;

  public async open(session: ServerSession): Promise<void> {
    this.close();
    const source = new ServerAuditSource(
      session.client, session.serverStore,
      () => sessionManager.getActive() === session && sessionManager.get(session.key) === session,
    );
    try {
      source.assertCurrent();
    } catch (error) {
      source.dispose();
      this.report(error);
      return;
    }
    this.source = source;
    this.entries = [];
    this.filter = 'all';
    this.query = '';
    this.hasMore = false;
    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.events = new AbortController();

    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.innerHTML = `
      <div class="modal-card server-audit-card" role="dialog" aria-modal="true" aria-labelledby="audit-title"
        aria-describedby="audit-subtitle" tabindex="-1">
        <div class="modal-header">
          <div id="audit-title" class="modal-title server-audit-title">
            <span class="material-symbols-outlined" aria-hidden="true">policy</span>
            <span>${escapeHtml(t('serverAudit.title'))}</span>
          </div>
          <button type="button" id="modal-close" class="modal-close-btn" aria-label="${escapeHtml(t('common.close'))}">&times;</button>
        </div>
        <p id="audit-subtitle" class="server-audit-subtitle">${escapeHtml(t('serverAudit.subtitle', {
          server: session.serverStore.serverDetails?.name ?? '', days: SERVER_AUDIT_LIMITS.RETENTION_DAYS,
        }))}</p>
        <div class="server-audit-toolbar">
          <div class="server-audit-filters" role="group" aria-label="${escapeHtml(t('serverAudit.filterLabel'))}">
            ${this.filterButton('all', 'list', t('serverAudit.category.all'))}
            ${SERVER_AUDIT_CATEGORIES.map((category) =>
              this.filterButton(category, AUDIT_CATEGORY_ICONS[category], t(AUDIT_CATEGORY_LABELS[category]))).join('')}
          </div>
          <input id="audit-search" class="server-audit-search" type="text" autocomplete="off" spellcheck="false"
            maxlength="${SERVER_AUDIT_LIMITS.MAX_QUERY_LENGTH}"
            aria-label="${escapeHtml(t('serverAudit.searchLabel'))}" placeholder="${escapeHtml(t('serverAudit.searchPlaceholder'))}">
        </div>
        <div id="audit-results" class="server-audit-list" role="region" tabindex="0"
          aria-label="${escapeHtml(t('serverAudit.listLabel'))}" aria-busy="true"></div>
        <div class="server-audit-footer">
          <span id="audit-status" role="status" aria-live="polite"></span>
          <button type="button" id="audit-load-more" class="btn btn-secondary server-audit-load-more" hidden>
            ${escapeHtml(t('serverAudit.loadMore'))}
          </button>
        </div>
      </div>
    `;
    this.modalEl = modal;
    document.body.appendChild(modal);
    enterModal(modal);
    this.attachEvents(modal);
    modal.querySelector<HTMLButtonElement>('#modal-close')?.focus();

    const revalidate = () => {
      const origin = currentEventOrigin();
      if (origin !== null && origin !== session.key) return;
      try {
        source.assertCurrent();
      } catch (error) {
        this.report(error);
      }
    };
    this.cleanup.push(
      appEvents.on('server.updated', revalidate),
      appEvents.on('server.roles_updated', revalidate),
      appEvents.on('network.status', revalidate),
      appEvents.on('session.changed', () => {
        if (sessionManager.getActive() !== session || sessionManager.get(session.key) !== session) this.close(true);
      }),
    );
    await this.reload();
  }

  private filterButton(filter: AuditFilter, icon: string, label: string): string {
    return `
      <button type="button" class="server-audit-filter" data-audit-filter="${filter}" aria-pressed="${filter === this.filter}">
        <span class="material-symbols-outlined" aria-hidden="true">${icon}</span>
        <span>${escapeHtml(label)}</span>
      </button>
    `;
  }

  private filters(): ServerAuditQuery {
    return {
      ...(this.filter !== 'all' ? { category: this.filter } : {}),
      ...(this.query ? { query: this.query } : {}),
    };
  }

  /** Reads queue behind each other; a failed read never blocks the next. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  private reload(): Promise<void> {
    const view = ++this.view;
    this.stopPolling();
    this.entries = [];
    this.hasMore = false;
    this.loading = true;
    this.loadingMore = false;
    this.failed = false;
    this.renderList();
    return this.enqueue(async () => {
      const source = this.source;
      if (view !== this.view || !source) return;
      try {
        const page = await source.read(this.filters());
        if (view !== this.view) return;
        this.entries = page.entries;
        this.hasMore = page.hasMore;
        this.loading = false;
        this.renderList();
        this.schedulePoll(view);
      } catch (error) {
        if (view !== this.view) return;
        this.loading = false;
        this.failed = true;
        this.renderList();
        this.report(error);
      }
    });
  }

  private loadMore(): Promise<void> {
    if (this.loadingMore || this.loading || !this.hasMore || this.entries.length === 0) return Promise.resolve();
    const view = this.view;
    this.loadingMore = true;
    this.renderFooter();
    return this.enqueue(async () => {
      const source = this.source;
      const oldest = this.entries.at(-1);
      try {
        if (view !== this.view || !source || !oldest) return;
        const page = await source.read({ ...this.filters(), before: oldest.id });
        if (view !== this.view) return;
        this.entries.push(...page.entries);
        this.hasMore = page.hasMore;
        this.modalEl?.querySelector('.server-audit-entries')?.insertAdjacentHTML('beforeend', page.entries.map(auditEntryHtml).join(''));
      } catch (error) {
        if (view === this.view) this.report(error);
      } finally {
        if (view === this.view) {
          this.loadingMore = false;
          this.renderFooter();
        }
      }
    });
  }

  private schedulePoll(view: number): void {
    this.stopPolling();
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.poll(view);
    }, SERVER_AUDIT_LIMITS.POLL_INTERVAL_MS);
  }

  /** New entries appear on top while the log is open; a failed refresh simply waits for the next one. */
  private poll(view: number): Promise<void> {
    return this.enqueue(async () => {
      const source = this.source;
      if (view !== this.view || !source) return;
      const newest = this.entries[0];
      try {
        const page = await source.read(newest ? { ...this.filters(), after: newest.id } : this.filters());
        if (view !== this.view) return;
        if (!newest) {
          if (page.entries.length) {
            this.entries = page.entries;
            this.hasMore = page.hasMore;
            this.renderList();
          }
        } else if (page.hasMore) {
          // More arrived than one page holds: start over rather than leave a gap.
          void this.reload();
          return;
        } else if (page.entries.length) {
          this.prepend(page.entries);
        }
        this.schedulePoll(view);
      } catch (error) {
        if (view !== this.view) return;
        if (endsServerAudit(error)) this.report(error);
        else this.schedulePoll(view);
      }
    });
  }

  private prepend(entries: ServerAuditEntry[]): void {
    const list = this.modalEl?.querySelector<HTMLElement>('.server-audit-entries');
    const results = this.modalEl?.querySelector<HTMLElement>('#audit-results');
    if (!list || !results) return;
    this.entries.unshift(...entries);
    const before = list.scrollHeight;
    list.insertAdjacentHTML('afterbegin', entries.map(auditEntryHtml).join(''));
    // Someone reading further down keeps their place instead of being pushed by new rows.
    if (results.scrollTop > 0) results.scrollTop += list.scrollHeight - before;
    for (const entry of entries) {
      const item = list.querySelector<HTMLElement>(`[data-audit-id="${entry.id}"]`);
      if (item) animateEnter(item, 'notice');
    }
    const status = this.modalEl?.querySelector<HTMLElement>('#audit-status');
    if (status) status.textContent = t('serverAudit.newEntries');
  }

  private renderList(): void {
    const results = this.modalEl?.querySelector<HTMLElement>('#audit-results');
    if (!results) return;
    results.setAttribute('aria-busy', String(this.loading));
    if (this.loading) {
      results.innerHTML = renderLoadingSkeleton('lines', 6);
    } else if (this.entries.length === 0) {
      results.innerHTML = this.failed
        ? `<div class="server-audit-state">
            <span class="material-symbols-outlined" aria-hidden="true">history</span>
            <button type="button" id="audit-retry" class="btn btn-secondary">${escapeHtml(t('common.retry'))}</button>
          </div>`
        : `<div class="server-audit-state">
            <span class="material-symbols-outlined" aria-hidden="true">${this.query || this.filter !== 'all' ? 'search_off' : 'history'}</span>
            <span>${escapeHtml(t(this.query || this.filter !== 'all' ? 'serverAudit.noMatches' : 'serverAudit.empty'))}</span>
          </div>`;
    } else {
      results.innerHTML = `<ol class="server-audit-entries">${this.entries.map(auditEntryHtml).join('')}</ol>`;
    }
    this.renderFooter();
  }

  private renderFooter(): void {
    const button = this.modalEl?.querySelector<HTMLButtonElement>('#audit-load-more');
    const status = this.modalEl?.querySelector<HTMLElement>('#audit-status');
    if (!button || !status) return;
    button.hidden = this.loading || !this.hasMore;
    button.disabled = this.loadingMore;
    button.setAttribute('aria-busy', String(this.loadingMore));
    status.textContent = this.loadingMore ? t('serverAudit.loadingMore')
      : !this.loading && !this.hasMore && this.entries.length > 0 ? t('serverAudit.reachedEnd') : '';
  }

  private setFilter(filter: AuditFilter): void {
    if (filter === this.filter) return;
    this.filter = filter;
    this.modalEl?.querySelectorAll<HTMLElement>('[data-audit-filter]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.auditFilter === filter));
    });
    void this.reload();
  }

  private attachEvents(modal: HTMLElement): void {
    if (!this.events) return;
    const options = { signal: this.events.signal };
    modal.querySelector('#modal-close')?.addEventListener('click', () => this.close(), options);
    modal.addEventListener('mousedown', (event) => {
      if (event.target === modal) this.close();
    }, options);
    document.addEventListener('keydown', (event) => {
      if (!handlesModalKey(modal, event)) return;
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

    modal.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) return;
      const filter = event.target.closest<HTMLElement>('[data-audit-filter]')?.dataset.auditFilter;
      if (filter === 'all') this.setFilter('all');
      else {
        const category = SERVER_AUDIT_CATEGORIES.find((entry) => entry === filter);
        if (category) this.setFilter(category);
      }
      if (event.target.closest('#audit-load-more')) void this.loadMore();
      if (event.target.closest('#audit-retry')) void this.reload();
    }, options);

    const search = modal.querySelector<HTMLInputElement>('#audit-search');
    search?.addEventListener('input', () => {
      if (this.searchTimer !== null) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.searchTimer = null;
        const query = search.value.trim();
        if (query === this.query) return;
        this.query = query;
        void this.reload();
      }, SEARCH_DEBOUNCE_MS);
    }, options);
  }

  /** Errors surface as a toast; losing access, the connection or the server also closes the log. */
  private report(error: unknown): void {
    if (isAbort(error)) return;
    const message = error instanceof ServerAuditError ? t(FAILURE_KEYS[error.reason])
      : error instanceof RequestTimeoutError ? t('serverAudit.timeout')
      : t('serverAudit.loadFailed', { error: error instanceof Error ? error.message : t('protocolError.internalError') });
    showErrorToast(message);
    if (endsServerAudit(error)) this.close(true);
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  /** Revoked content leaves at once; an ordinary close animates out. */
  public close(immediate = false): void {
    this.view++;
    // Reads of the closed view drop their results; a new opening never waits behind them.
    this.queue = Promise.resolve();
    this.stopPolling();
    if (this.searchTimer !== null) clearTimeout(this.searchTimer);
    this.searchTimer = null;
    for (const cleanup of this.cleanup.splice(0)) cleanup();
    this.source?.dispose();
    this.source = null;
    this.events?.abort();
    this.events = null;
    if (this.modalEl) {
      exitModal(this.modalEl, immediate);
      this.modalEl = null;
    }
    this.entries = [];
    const previousFocus = this.previousFocus;
    this.previousFocus = null;
    if (previousFocus?.isConnected) previousFocus.focus();
  }
}

export const serverAuditModal = new ServerAuditModal();
