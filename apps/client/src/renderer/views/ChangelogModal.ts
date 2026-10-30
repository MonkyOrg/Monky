import type { ReleaseHistoryEntry, ReleaseNotesResult } from '@monky/shared';
import { appEvents } from '../core/EventBus';
import { getLanguage, t, tCount, type TranslationKey } from '../i18n';
import { CLIENT_NOTE_GROUPS, parseClientReleaseNotes, type ClientNoteGroup, type ClientReleaseNotes } from '../utils/clientReleaseNotes';
import { escapeHtml } from '../utils/html';
import { openModal, type ModalShell } from '../utils/modalShell';
import { openExternalUrl } from '../utils/feedback';
import { animateEnter } from '../utils/surfaceMotion';
import { bindVersionCopyButton, renderVersionCopyButton } from './VersionCopyButton';
import { renderLoadingSkeleton } from '../utils/loadingSkeleton';
import { showErrorToast } from './CopyToast';

const RELEASES_URL = 'https://github.com/MonkyOrg/Monky/releases';
const GROUP_LABELS: Record<ClientNoteGroup, TranslationKey> = {
  novidades: 'changelog.group.new',
  correcoes: 'changelog.group.fixes',
  outros: 'changelog.group.other',
};
const GROUP_ICONS: Record<ClientNoteGroup, string> = {
  novidades: 'auto_awesome', correcoes: 'healing', outros: 'tune',
};

interface OpenOptions {
  /** Specific tag to fetch (e.g. "v8.2.8-beta"). Defaults to the running version. */
  tag?: string;
  /** Show the celebratory "updated to" header (used right after an update). */
  celebrate?: boolean;
  /**
   * Only open when there is real changelog content. Used by the auto-show after
   * an update, so an offline start (or a version with no release) falls back to
   * the plain banner instead of flashing an empty modal.
   */
  requireContent?: boolean;
}

interface HistoryRelease {
  version: string;
  publishedAt: string | null;
  notes: ClientReleaseNotes;
}

type HistoryState = 'idle' | 'loading' | 'error' | 'done';

const baseVersion = (version: string): string => version.split(/[-+]/)[0];
/** How close (px) the end of the list must be before older releases load. */
const HISTORY_PREFETCH_PX = 160;

/**
 * In-app changelog shown once after an update and on demand from Settings
 * (#547). Only the dedicated bilingual client payload is rendered as prose.
 * Older releases get an explicitly labelled count summary, not technical
 * commit subjects disguised as friendly notes (#616). Scrolling to the end
 * lazily loads older releases, one GitHub page at a time.
 */
export class ChangelogModal {
  private shell: ModalShell | null = null;
  private modalEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private currentEl: HTMLElement | null = null;
  private historyEl: HTMLElement | null = null;
  private historyStatusEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private unbind: Array<() => void> = [];
  private unbindVersionCopy: (() => void) | null = null;
  private pendingOpen: Promise<boolean> | null = null;
  private requestId = 0;
  private tag: string | undefined;
  private result: ReleaseNotesResult | null = null;
  private notes: ClientReleaseNotes = { kind: 'empty' };
  private celebrate = false;
  private githubUrl = RELEASES_URL;
  private history: HistoryRelease[] = [];
  private historyBases = new Set<string>();
  private historyAnchor: string | null = null;
  private historyPage = 0;
  private historyState: HistoryState = 'idle';
  private historyObserver: IntersectionObserver | null = null;

  public isOpen(): boolean {
    return !!this.modalEl;
  }

  /**
   * Opens the changelog. Resolves to whether a modal was shown: the auto-show
   * path passes `requireContent` and uses the result to decide whether to fall
   * back to the banner.
   */
  public async open(options: OpenOptions = {}): Promise<boolean> {
    if (this.modalEl) return true;
    if (this.pendingOpen) return this.pendingOpen;
    const opening = this.loadAndOpen(options, ++this.requestId);
    this.pendingOpen = opening;
    try {
      return await opening;
    } finally {
      if (this.pendingOpen === opening) this.pendingOpen = null;
    }
  }

  private async loadAndOpen(options: OpenOptions, requestId: number): Promise<boolean> {
    this.celebrate = options.celebrate ?? false;
    this.tag = options.tag;
    if (!options.requireContent) {
      this.buildShell();
      this.renderState();
    }
    const res = await this.fetchNotes(options.tag);
    if (requestId !== this.requestId) return false;
    const notes: ClientReleaseNotes = res.ok ? parseClientReleaseNotes(res.body ?? '') : { kind: 'empty' };
    if (options.requireContent && (!res.ok || (notes.kind !== 'curated' && notes.kind !== 'legacy'))) {
      return false;
    }
    if (!this.modalEl) this.buildShell();
    this.result = res;
    this.notes = notes;
    this.renderState();
    this.startHistory();
    return true;
  }

  public close(): void {
    if (this.shell) this.shell.close('api');
    else this.finishClose();
  }

  /** Drops what an open (or one still loading) left behind. */
  private finishClose(): void {
    this.requestId++;
    this.pendingOpen = null;
    this.stopHistory();
    this.unbindVersionCopy?.();
    this.unbindVersionCopy = null;
    this.unbind.forEach((fn) => fn());
    this.unbind = [];
    this.shell = null;
    this.modalEl = null;
    this.bodyEl = null;
    this.currentEl = null;
    this.historyEl = null;
    this.historyStatusEl = null;
    this.titleEl = null;
    this.result = null;
    this.notes = { kind: 'empty' };
    this.githubUrl = RELEASES_URL;
  }

  private async fetchNotes(tag?: string): Promise<ReleaseNotesResult> {
    try {
      if (!window.api?.getReleaseNotes) throw new Error('Release notes bridge unavailable');
      const result = await window.api.getReleaseNotes(tag);
      if (!result.ok) console.warn('[ChangelogModal] Could not load release notes', result.error);
      return result;
    } catch (e) {
      console.warn('[ChangelogModal] Could not load release notes', e);
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private buildShell(): void {
    const shell = openModal({
      card: `
      <div class="modal-card changelog-card" aria-labelledby="changelog-title" style="max-width: 560px; width: 92%; display: flex; flex-direction: column;">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" aria-hidden="true" style="color: var(--accent-primary);">${this.celebrate ? 'celebration' : 'auto_awesome'}</span>
            <span data-el="title" id="changelog-title">${escapeHtml(t('changelog.title'))}</span>
          </div>
          <button type="button" id="modal-close" class="modal-close-btn" data-modal-close aria-label="${escapeHtml(t('common.close'))}">&times;</button>
        </div>
        <div data-el="body" class="changelog-body" style="max-height: 55vh; overflow-y: auto; padding: 4px 4px 2px; line-height: 1.6; font-size: 13px;">
          <div data-el="current" aria-live="polite"></div>
          <div data-el="history" class="changelog-history" hidden></div>
          <div data-el="history-status" class="changelog-history-status"></div>
        </div>
        <div class="modal-footer">
          <button type="button" id="changelog-retry" class="btn btn-secondary" hidden></button>
          <button type="button" id="changelog-github" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px;">
            <span class="material-symbols-outlined md-16" aria-hidden="true" style="margin-right: 4px;">open_in_new</span>
            <span data-el="github-label">${escapeHtml(t('changelog.viewOnGithub'))}</span>
          </button>
          <button type="button" id="changelog-close" class="btn btn-primary" data-modal-close style="font-size: 12px; padding: 6px 12px;">${escapeHtml(t('common.close'))}</button>
        </div>
      </div>
    `,
      initialFocus: '#modal-close',
      onClose: () => { if (this.shell === shell) this.finishClose(); },
    });
    const backdrop = shell.element;
    this.shell = shell;
    this.modalEl = backdrop;
    this.bodyEl = backdrop.querySelector('[data-el="body"]');
    this.currentEl = backdrop.querySelector('[data-el="current"]');
    this.historyEl = backdrop.querySelector('[data-el="history"]');
    this.historyStatusEl = backdrop.querySelector('[data-el="history-status"]');
    this.titleEl = backdrop.querySelector('[data-el="title"]');

    backdrop.querySelector('#changelog-github')?.addEventListener('click', () => { void this.openGithub(); });
    backdrop.querySelector('#changelog-retry')?.addEventListener('click', () => { void this.retry(); });
    this.historyStatusEl?.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('[data-history-retry]')) void this.loadMoreHistory();
    });
    this.unbind.push(appEvents.on('i18n.language_changed', () => this.renderState()));
  }

  private renderState(): void {
    if (!this.modalEl || !this.bodyEl) return;
    this.renderTitle();
    this.modalEl.querySelector('#modal-close')?.setAttribute('aria-label', t('common.close'));
    const close = this.modalEl.querySelector('#changelog-close');
    if (close) close.textContent = t('common.close');
    const github = this.modalEl.querySelector('[data-el="github-label"]');
    if (github) github.textContent = t('changelog.viewOnGithub');
    const retry = this.modalEl.querySelector<HTMLButtonElement>('#changelog-retry');
    if (retry) {
      retry.textContent = t('changelog.retry');
      retry.hidden = this.result?.ok !== false && this.notes.kind !== 'invalid';
    }
    this.bodyEl.setAttribute('aria-busy', String(!this.result));
    const current = this.currentEl;
    if (!current) return;
    if (!this.result) {
      current.innerHTML = renderLoadingSkeleton('lines', 5);
      return;
    }
    if (!this.result.ok || this.notes.kind === 'invalid' || this.notes.kind === 'empty') {
      const failed = this.result?.ok === false || this.notes.kind === 'invalid';
      const key = !this.result.ok ? 'changelog.loadFailed'
          : this.notes.kind === 'invalid' ? 'changelog.invalid' : 'changelog.noHighlights';
      current.innerHTML = `<p class="${failed ? 'changelog-error' : 'changelog-empty'}" role="${failed ? 'alert' : 'status'}">${escapeHtml(t(key))}</p>`;
    } else {
      const intro = t(this.notes.kind === 'legacy' ? 'changelog.legacyIntro' : 'changelog.intro');
      current.innerHTML = `<p class="changelog-intro">${escapeHtml(intro)}</p>${this.renderGroups(this.notes, 'h3')}`;
    }
    this.renderHistory();
  }

  private renderGroups(notes: ClientReleaseNotes, heading: 'h3' | 'h4'): string {
    if (notes.kind !== 'curated' && notes.kind !== 'legacy') return '';
    return CLIENT_NOTE_GROUPS.map((group) => {
      const items = notes.kind === 'curated'
        ? notes.groups[group].map((note) => note[getLanguage()])
        : notes.counts[group] ? [tCount(`changelog.legacy.${group}`, notes.counts[group])] : [];
      if (!items.length) return '';
      return `<section class="changelog-group">
        <${heading} class="changelog-group-title"><span class="material-symbols-outlined md-18" aria-hidden="true">${GROUP_ICONS[group]}</span>${escapeHtml(t(GROUP_LABELS[group]))}</${heading}>
        <ul class="changelog-group-list">${items.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>
      </section>`;
    }).join('');
  }

  private renderRelease(release: HistoryRelease): string {
    const date = release.publishedAt
      ? new Intl.DateTimeFormat(getLanguage(), { dateStyle: 'medium' }).format(new Date(release.publishedAt))
      : '';
    const body = release.notes.kind === 'curated' || release.notes.kind === 'legacy'
      ? this.renderGroups(release.notes, 'h4')
      : `<p class="changelog-empty">${escapeHtml(t('changelog.historyNoHighlights'))}</p>`;
    return `<section class="changelog-release" data-version="${escapeHtml(release.version)}">
      <h3 class="changelog-release-title">
        <span>${escapeHtml(t('changelog.versionHeading', { version: release.version }))}</span>
        ${date ? `<time datetime="${escapeHtml(release.publishedAt ?? '')}">${escapeHtml(date)}</time>` : ''}
      </h3>
      ${body}
    </section>`;
  }

  /** Repaints every loaded release, e.g. after a language change. */
  private renderHistory(): void {
    if (!this.historyEl) return;
    this.historyEl.hidden = this.history.length === 0;
    this.historyEl.innerHTML = this.history.length
      ? `<h3 class="changelog-history-heading">${escapeHtml(t('changelog.olderVersions'))}</h3>${this.history.map((release) => this.renderRelease(release)).join('')}`
      : '';
    this.renderHistoryStatus();
  }

  private renderHistoryStatus(): void {
    const status = this.historyStatusEl;
    if (!status) return;
    status.setAttribute('aria-busy', String(this.historyState === 'loading'));
    switch (this.historyState) {
      case 'loading':
        status.innerHTML = `<p class="changelog-history-note" role="status">${escapeHtml(t('changelog.historyLoading'))}</p>`;
        break;
      case 'error':
        status.innerHTML = `<button type="button" class="btn btn-secondary changelog-history-retry" data-history-retry>${escapeHtml(t('changelog.retry'))}</button>`;
        break;
      case 'done':
        status.innerHTML = this.history.length
          ? `<p class="changelog-history-note">${escapeHtml(t('changelog.historyEnd'))}</p>` : '';
        break;
      default:
        status.innerHTML = '';
    }
  }

  /**
   * Starts watching the end of the list once the release on screen has
   * loaded; older releases are fetched only as the user scrolls towards them.
   */
  private startHistory(): void {
    if (this.historyObserver || !this.bodyEl || !this.historyStatusEl || !this.result?.ok || !this.result.version) return;
    if (!window.api?.getReleaseHistory) return;
    this.historyAnchor = this.result.version;
    this.historyBases.add(baseVersion(this.result.version));
    this.historyObserver = new IntersectionObserver((records) => {
      if (records.some((record) => record.isIntersecting)) void this.loadMoreHistory();
    }, { root: this.bodyEl, rootMargin: `0px 0px ${HISTORY_PREFETCH_PX}px 0px` });
    this.historyObserver.observe(this.historyStatusEl);
  }

  private stopHistory(): void {
    this.historyObserver?.disconnect();
    this.historyObserver = null;
    this.history = [];
    this.historyBases = new Set();
    this.historyAnchor = null;
    this.historyPage = 0;
    this.historyState = 'idle';
  }

  private historyNearEnd(): boolean {
    if (!this.bodyEl || !this.historyStatusEl) return false;
    return this.historyStatusEl.getBoundingClientRect().top
      <= this.bodyEl.getBoundingClientRect().bottom + HISTORY_PREFETCH_PX;
  }

  private async loadMoreHistory(): Promise<void> {
    if (this.historyState === 'loading' || this.historyState === 'done' || !this.historyAnchor || !window.api?.getReleaseHistory) return;
    const requestId = this.requestId;
    const observer = this.historyObserver;
    this.historyState = 'loading';
    this.renderHistoryStatus();
    let failed = false;
    try {
      const result = await window.api.getReleaseHistory(this.historyPage + 1, this.historyAnchor);
      if (requestId !== this.requestId || observer !== this.historyObserver) return;
      if (!result.ok) throw new Error(result.error ?? 'Release history unavailable');
      this.historyPage++;
      const fresh = (result.entries ?? []).filter((entry: ReleaseHistoryEntry) => {
        const base = baseVersion(entry.version);
        if (this.historyBases.has(base)) return false;
        this.historyBases.add(base);
        return true;
      }).map((entry) => ({ version: entry.version, publishedAt: entry.publishedAt, notes: parseClientReleaseNotes(entry.body) }));
      this.historyState = result.hasMore ? 'idle' : 'done';
      this.appendHistory(fresh);
    } catch (error) {
      if (requestId !== this.requestId || observer !== this.historyObserver) return;
      console.warn('[ChangelogModal] Could not load release history', error);
      failed = true;
      this.historyState = 'error';
      showErrorToast(t('changelog.historyFailed'));
    }
    this.renderHistoryStatus();
    // The observer only reports changes: when a page added little (or only
    // duplicates) the end is still in view, so keep going without a scroll.
    if (!failed && this.historyState === 'idle' && this.historyNearEnd()) void this.loadMoreHistory();
  }

  private appendHistory(releases: HistoryRelease[]): void {
    if (!releases.length || !this.historyEl) return;
    const first = this.history.length === 0;
    this.history.push(...releases);
    if (first) {
      this.historyEl.hidden = false;
      this.historyEl.innerHTML = `<h3 class="changelog-history-heading">${escapeHtml(t('changelog.olderVersions'))}</h3>`;
    }
    const template = document.createElement('template');
    template.innerHTML = releases.map((release) => this.renderRelease(release)).join('');
    for (const section of Array.from(template.content.children)) {
      this.historyEl.appendChild(section);
      if (section instanceof HTMLElement) animateEnter(section, 'view');
    }
  }

  private renderTitle(): void {
    if (!this.titleEl) return;
    const restoreFocus = this.titleEl.contains(document.activeElement);
    this.unbindVersionCopy?.();
    this.unbindVersionCopy = null;
    const version = this.result?.version;
    if (!version || !/^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$/i.test(version)) {
      this.titleEl.textContent = t('changelog.title');
      return;
    }
    this.githubUrl = `${RELEASES_URL}/tag/${encodeURIComponent(`v${version}`)}`;
    const label = t(this.celebrate ? 'changelog.updatedTo' : 'changelog.titleVersion', { version: '\0' });
    const [before, after] = label.split('\0');
    this.titleEl.innerHTML = renderVersionCopyButton('changelog-version', `v${version}`);
    this.titleEl.prepend(document.createTextNode(before));
    this.titleEl.append(document.createTextNode(after ?? ''));
    const button = this.titleEl.querySelector<HTMLButtonElement>('#changelog-version');
    if (button) {
      this.unbindVersionCopy = bindVersionCopyButton(button);
      if (restoreFocus) button.focus();
    }
  }

  private async retry(): Promise<void> {
    if (!this.modalEl) return;
    const requestId = ++this.requestId;
    this.result = null;
    this.notes = { kind: 'empty' };
    this.renderState();
    const res = await this.fetchNotes(this.tag);
    if (!this.modalEl || requestId !== this.requestId) return;
    this.result = res;
    this.notes = res.ok ? parseClientReleaseNotes(res.body ?? '') : { kind: 'empty' };
    this.renderState();
    this.startHistory();
  }

  private async openGithub(): Promise<void> {
    await openExternalUrl(this.githubUrl, t('changelog.openFailed'));
  }
}

export const changelogModal = new ChangelogModal();
