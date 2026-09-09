import type { ReleaseNotesResult } from '@monky/shared';
import { appEvents } from '../core/EventBus';
import { getLanguage, t, tCount, type SupportedLanguage, type TranslationKey } from '../i18n';
import { CLIENT_NOTE_GROUPS, parseClientReleaseNotes, type ClientNoteGroup, type ClientReleaseNotes } from '../utils/clientReleaseNotes';
import { escapeHtml } from '../utils/html';
import { enableBackdropClose } from '../utils/modal';
import { bindVersionCopyButton, renderVersionCopyButton } from './VersionCopyButton';

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

/**
 * In-app changelog shown once after an update and on demand from Settings
 * (#547). Only the dedicated bilingual client payload is rendered as prose.
 * Older releases get an explicitly labelled count summary, not technical
 * commit subjects disguised as friendly notes (#616).
 */
export class ChangelogModal {
  private modalEl: HTMLElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private unbind: Array<() => void> = [];
  private unbindVersionCopy: (() => void) | null = null;
  private previousFocus: HTMLElement | null = null;
  private pendingOpen: Promise<boolean> | null = null;
  private requestId = 0;
  private tag: string | undefined;
  private result: ReleaseNotesResult | null = null;
  private notes: ClientReleaseNotes = { kind: 'empty' };
  private celebrate = false;
  private githubUrl = RELEASES_URL;
  private linkFailed = false;

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
    return true;
  }

  public close(): void {
    this.requestId++;
    this.pendingOpen = null;
    this.unbindVersionCopy?.();
    this.unbindVersionCopy = null;
    this.unbind.forEach((fn) => fn());
    this.unbind = [];
    if (this.modalEl) {
      this.modalEl.remove();
      this.modalEl = null;
    }
    this.bodyEl = null;
    this.titleEl = null;
    this.result = null;
    this.notes = { kind: 'empty' };
    this.githubUrl = RELEASES_URL;
    this.linkFailed = false;
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
    this.previousFocus = null;
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
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card changelog-card" role="dialog" aria-modal="true" aria-labelledby="changelog-title" style="max-width: 560px; width: 92%; display: flex; flex-direction: column;">
        <div class="modal-header">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" aria-hidden="true" style="color: var(--accent-primary);">${this.celebrate ? 'celebration' : 'auto_awesome'}</span>
            <span data-el="title" id="changelog-title">${escapeHtml(t('changelog.title'))}</span>
          </div>
          <button type="button" id="modal-close" class="modal-close-btn" aria-label="${escapeHtml(t('common.close'))}">&times;</button>
        </div>
        <div data-el="body" class="changelog-body" aria-live="polite" style="max-height: 55vh; overflow-y: auto; padding: 4px 4px 2px; line-height: 1.6; font-size: 13px;"></div>
        <p data-el="link-error" role="alert" class="changelog-error" hidden></p>
        <div class="modal-footer">
          <button type="button" id="changelog-retry" class="btn btn-secondary" hidden></button>
          <button type="button" id="changelog-github" class="btn btn-secondary" style="font-size: 12px; padding: 6px 12px;">
            <span class="material-symbols-outlined md-16" aria-hidden="true" style="margin-right: 4px;">open_in_new</span>
            <span data-el="github-label">${escapeHtml(t('changelog.viewOnGithub'))}</span>
          </button>
          <button type="button" id="changelog-close" class="btn btn-primary" style="font-size: 12px; padding: 6px 12px;">${escapeHtml(t('common.close'))}</button>
        </div>
      </div>
    `;

    this.previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.appendChild(backdrop);
    this.modalEl = backdrop;
    this.bodyEl = backdrop.querySelector('[data-el="body"]');
    this.titleEl = backdrop.querySelector('[data-el="title"]');

    backdrop.querySelector('#modal-close')?.addEventListener('click', () => this.close());
    backdrop.querySelector('#changelog-close')?.addEventListener('click', () => this.close());
    backdrop.querySelector('#changelog-github')?.addEventListener('click', () => { void this.openGithub(); });
    backdrop.querySelector('#changelog-retry')?.addEventListener('click', () => { void this.retry(); });
    enableBackdropClose(backdrop, () => this.close());

    const onKeyDown = (e: KeyboardEvent): void => {
      const modals = document.querySelectorAll('.modal-backdrop');
      if (modals[modals.length - 1] !== backdrop) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        this.close();
      } else if (e.key === 'Tab') {
        const buttons = Array.from(backdrop.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
          .filter((button) => button.checkVisibility());
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (first && last && (e.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    this.unbind.push(() => window.removeEventListener('keydown', onKeyDown, true));
    this.unbind.push(appEvents.on<SupportedLanguage>('i18n.language_changed', () => this.renderState()));
    backdrop.querySelector<HTMLButtonElement>('#modal-close')?.focus();
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
    const linkError = this.modalEl.querySelector<HTMLElement>('[data-el="link-error"]');
    if (linkError) {
      linkError.hidden = !this.linkFailed;
      linkError.textContent = this.linkFailed ? t('changelog.openFailed') : '';
    }
    this.bodyEl.setAttribute('aria-busy', String(!this.result));
    if (!this.result || !this.result.ok || this.notes.kind === 'invalid' || this.notes.kind === 'empty') {
      const failed = this.result?.ok === false || this.notes.kind === 'invalid';
      const key = !this.result ? 'changelog.loading'
        : !this.result.ok ? 'changelog.loadFailed'
          : this.notes.kind === 'invalid' ? 'changelog.invalid' : 'changelog.noHighlights';
      this.bodyEl.innerHTML = `<p class="${failed ? 'changelog-error' : 'changelog-empty'}" role="${failed ? 'alert' : 'status'}">${escapeHtml(t(key))}</p>`;
      return;
    }
    const notes = this.notes;
    const intro = t(notes.kind === 'legacy' ? 'changelog.legacyIntro' : 'changelog.intro');
    const sections = CLIENT_NOTE_GROUPS.map((group) => {
      const items = notes.kind === 'curated'
        ? notes.groups[group].map((note) => note[getLanguage()])
        : notes.counts[group] ? [tCount(`changelog.legacy.${group}`, notes.counts[group])] : [];
      if (!items.length) return '';
      return `<section class="changelog-group">
        <h3 class="changelog-group-title"><span class="material-symbols-outlined md-18" aria-hidden="true">${GROUP_ICONS[group]}</span>${escapeHtml(t(GROUP_LABELS[group]))}</h3>
        <ul class="changelog-group-list">${items.map((text) => `<li>${escapeHtml(text)}</li>`).join('')}</ul>
      </section>`;
    }).join('');
    this.bodyEl.innerHTML = `<p class="changelog-intro">${escapeHtml(intro)}</p>${sections}`;
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
  }

  private async openGithub(): Promise<void> {
    const modal = this.modalEl;
    if (this.linkFailed) {
      this.linkFailed = false;
      this.renderState();
    }
    try {
      if (!window.api?.openExternal) {
        window.open(this.githubUrl, '_blank', 'noopener');
        return;
      }
      const result = await window.api.openExternal(this.githubUrl);
      if (!result.success) throw new Error('Could not open release page');
    } catch (error) {
      console.warn('[ChangelogModal] Could not open GitHub', error);
      if (this.modalEl !== modal) return;
      this.linkFailed = true;
      this.renderState();
    }
  }
}

export const changelogModal = new ChangelogModal();
