import '../styles/desktopOnly.css';
import { getLanguage, t, type SupportedLanguage, type TranslationKey } from '../i18n';
import { featureAvailability } from '../platform/capabilities';
import type { PlatformCapabilities } from '../platform/api';
import { openExternalUrl } from './feedback';
import { escapeHtml } from './html';
import { openModal, type ModalShell } from './modalShell';

/**
 * Desktop features where the platform lacks them (the web version, #858): the
 * interface stays identical, but their controls are locked. They look disabled
 * yet stay focusable and hoverable, so a tooltip explains them, and activating
 * one offers the desktop app. The rule of what is locked is `featureAvailability`.
 */
const DOWNLOAD_PAGES: Readonly<Record<SupportedLanguage, string>> = {
  'pt-BR': 'https://monkyorg.github.io/Monky/download.html',
  en: 'https://monkyorg.github.io/Monky/en/download.html',
};

const FEATURE_NAMES = {
  hostServer: 'desktopOnly.feature.hostServer',
  overlay: 'desktopOnly.feature.overlay',
  pushToTalk: 'desktopOnly.feature.pushToTalk',
  globalShortcuts: 'desktopOnly.feature.globalShortcuts',
  soundboardShortcuts: 'desktopOnly.feature.soundboardShortcuts',
  lanServers: 'desktopOnly.feature.lanServers',
  localTools: 'desktopOnly.feature.localTools',
  gamePresence: 'desktopOnly.feature.gamePresence',
  screenAudio: 'desktopOnly.feature.screenAudio',
  screenEncoder: 'desktopOnly.feature.screenEncoder',
  screenReceiver: 'desktopOnly.feature.screenReceiver',
  botSounds: 'desktopOnly.feature.botSounds',
  tray: 'desktopOnly.feature.tray',
  autoStart: 'desktopOnly.feature.autoStart',
  appUpdates: 'desktopOnly.feature.appUpdates',
  screenShare: 'desktopOnly.feature.screenShare',
  screenAutoPip: 'desktopOnly.feature.screenAutoPip',
  mediaLibrary: 'desktopOnly.feature.mediaLibrary',
  directMessages: 'desktopOnly.feature.directMessages',
  miniappBrowser: 'desktopOnly.feature.miniappBrowser',
  discordWeb: 'desktopOnly.feature.discordWeb',
} as const satisfies Readonly<Record<string, TranslationKey>>;

export type DesktopFeature = keyof typeof FEATURE_NAMES;

function isDesktopFeature(value: string | null): value is DesktopFeature {
  return value !== null && Object.hasOwn(FEATURE_NAMES, value);
}

export function desktopFeatureName(feature: DesktopFeature): string {
  return t(FEATURE_NAMES[feature]);
}

/** Features a browser lacks for a reason worth naming: this browser, not the web version, cannot do them. */
const FEATURE_REASONS: Partial<Readonly<Record<DesktopFeature, TranslationKey>>> = {
  screenShare: 'desktopOnly.reason.screenShare',
};

/** The tooltip of a locked `feature`: why it is locked, or just where it works. */
function lockedTooltip(feature: DesktopFeature): string {
  return t(FEATURE_REASONS[feature] ?? 'desktopOnly.tooltip');
}

/** Whether `capability` is shown locked here, rather than working or hidden. */
export function isDesktopOnly(capability: keyof PlatformCapabilities): boolean {
  return featureAvailability(capability) === 'desktop-only';
}

/** Whether controls of `capability` are rendered at all: working or locked. */
export function isShown(capability: keyof PlatformCapabilities): boolean {
  return featureAvailability(capability) !== 'hidden';
}

/** Attributes of one locked control. Never `disabled`: it would block hover, focus and click. */
export function desktopOnlyAttributes(feature: DesktopFeature): string {
  return `aria-disabled="true" data-desktop-only="${feature}" data-tooltip="${escapeHtml(lockedTooltip(feature))}"`;
}

/** `desktopOnlyAttributes` when `capability` is locked here, nothing otherwise. */
export function lockedAttributes(capability: keyof PlatformCapabilities, feature: DesktopFeature): string {
  return isDesktopOnly(capability) ? ` ${desktopOnlyAttributes(feature)}` : '';
}

export function desktopOnlyBadge(): string {
  return `<span class="desktop-only-badge">${escapeHtml(t('desktopOnly.badge'))}</span>`;
}

/** `desktopOnlyBadge` when `capability` is locked here, nothing otherwise. */
export function lockedBadge(capability: keyof PlatformCapabilities): string {
  return isDesktopOnly(capability) ? desktopOnlyBadge() : '';
}

/**
 * A group of controls kept as rendered (a settings section, a card), locked as
 * one: the badge sits at its corner and any activation inside offers the app.
 */
export function lockedBlock(capability: keyof PlatformCapabilities, feature: DesktopFeature, content: string): string {
  if (!isDesktopOnly(capability)) return content;
  return `<div class="desktop-only-block" ${desktopOnlyAttributes(feature)}>${desktopOnlyBadge()}${content}</div>`;
}

function noticeHtml(text: string, summary: boolean): string {
  return `<div class="desktop-only-notice" role="note"${summary ? ' data-desktop-only-summary' : ''}>
      <span class="material-symbols-outlined" aria-hidden="true">desktop_windows</span>
      <span class="desktop-only-notice__text">${escapeHtml(text)}</span>
      <button type="button" class="btn btn-primary desktop-only-notice__download" data-desktop-download>
        <span class="material-symbols-outlined md-16" aria-hidden="true">download</span>${escapeHtml(t('desktopOnly.download'))}
      </button>
    </div>`;
}

/** A whole panel only the desktop has (a settings tab): read-only content under a notice with the download. */
export function lockedPanel(capability: keyof PlatformCapabilities, feature: DesktopFeature, content: string): string {
  if (!isDesktopOnly(capability)) return content;
  return `${noticeHtml(t('desktopOnly.panelNotice', { feature: desktopFeatureName(feature) }), false)}
    <div class="desktop-only-panel" aria-disabled="true" data-desktop-only="${feature}"
      data-desktop-only-panel-tooltip="${escapeHtml(t('desktopOnly.tooltip'))}">${content}</div>`;
}

/** Marks an area of a dialog (a settings tab) that explains its own locked options with its own notice. */
const NOTICE_AREA_ATTRIBUTE = 'data-desktop-only-notice-area';

/** Surfaces that already explain themselves: a locked item there never stacks the offer on top (#858). */
const QUIET_AREAS = '.modal-backdrop, [aria-modal="true"], .desktop-only-panel';
/** The cards of open dialogs. Popovers and menus (no aria-modal) are not dialogs here. */
const DIALOG_CARDS = '.modal-backdrop > .modal-card, [aria-modal="true"]';

/**
 * Keeps the short "some options only work in the desktop app" notice at the top
 * of `area` (a dialog card, or a notice area inside one) exactly while it holds
 * locked options and has no notice of its own (a fully locked panel).
 */
export function syncDesktopOnlyNotice(area: HTMLElement): void {
  const summary = area.querySelector<HTMLElement>('.desktop-only-notice[data-desktop-only-summary]');
  const explained = area.querySelector('.desktop-only-notice:not([data-desktop-only-summary])') !== null;
  // A badge marks desktop-only content too (a section whose controls lock one by one).
  const locked = area.querySelector('[data-desktop-only], .desktop-only-badge') !== null;
  if (!locked || explained) {
    summary?.remove();
    return;
  }
  if (summary) return;
  const holder = document.createElement('div');
  holder.innerHTML = noticeHtml(t(area.hasAttribute(NOTICE_AREA_ATTRIBUTE) ? 'desktopOnly.someOptions' : 'desktopOnly.someOptionsDialog'), true);
  const notice = holder.firstElementChild;
  if (!notice) return;
  const header = area.querySelector(':scope > .modal-header');
  if (header) header.after(notice);
  else area.prepend(notice);
}

/** Every open dialog, or each of its notice areas, gets its notice in step with its locked options. */
function syncOpenDialogs(doc: Document): void {
  for (const card of doc.querySelectorAll<HTMLElement>(DIALOG_CARDS)) {
    if (card.closest('.desktop-only-dialog')) continue;
    const areas = card.querySelectorAll<HTMLElement>(`[${NOTICE_AREA_ATTRIBUTE}]`);
    if (areas.length) {
      for (const area of areas) syncDesktopOnlyNotice(area);
      continue;
    }
    // While a step slides, the incoming content (the card's last panel) is what stays.
    const incoming = card.querySelector(':scope > [data-ui-closing]') ? card.lastElementChild : card;
    if (incoming instanceof HTMLElement) syncDesktopOnlyNotice(incoming);
  }
}

/**
 * Locks or unlocks a control already on screen, for what is learned after it
 * rendered (what the browser can capture). `badgeHost` receives the badge.
 */
export function setDesktopOnly(control: HTMLElement, feature: DesktopFeature | null, badgeHost: HTMLElement = control): void {
  const badge = badgeHost.querySelector(':scope > .desktop-only-badge');
  if (!feature) {
    control.removeAttribute('aria-disabled');
    control.removeAttribute('data-desktop-only');
    control.removeAttribute('data-tooltip');
    badge?.remove();
    return;
  }
  control.setAttribute('aria-disabled', 'true');
  control.dataset.desktopOnly = feature;
  control.dataset.tooltip = lockedTooltip(feature);
  if (!badge) badgeHost.insertAdjacentHTML('beforeend', desktopOnlyBadge());
}

function openDownloadPage(): Promise<boolean> {
  return openExternalUrl(DOWNLOAD_PAGES[getLanguage()], t('desktopOnly.openFailed'));
}

let offer: ModalShell | null = null;

/**
 * The single "available in the desktop app" dialog, naming the feature and offering the download page.
 * Closing it hands focus back to `returnFocus`, by default whoever had it. The header X and Esc close it.
 */
export function showDesktopOnly(feature: DesktopFeature, returnFocus?: Element): void {
  if (offer && !offer.closed) return;
  const shell = openModal({
    card: `<div class="modal-card dialog-card desktop-only-dialog">
      <div class="modal-header">
        <div class="modal-title desktop-only-dialog__title">
          <span class="material-symbols-outlined" aria-hidden="true">desktop_windows</span>
          <span>${escapeHtml(t('desktopOnly.title'))}</span>
        </div>
        <button type="button" class="modal-close-btn" data-modal-close aria-label="${escapeHtml(t('common.close'))}">&times;</button>
      </div>
      <p class="desktop-only-dialog__message">${escapeHtml(FEATURE_REASONS[feature] ? lockedTooltip(feature)
        : t('desktopOnly.message', { feature: desktopFeatureName(feature) }))}</p>
      <div class="desktop-only-dialog__actions">
        <button type="button" class="btn btn-primary" data-action="download">
          <span class="material-symbols-outlined md-16" aria-hidden="true">download</span>${escapeHtml(t('desktopOnly.download'))}
        </button>
      </div>
    </div>`,
    initialFocus: '[data-action="download"]',
    ...(returnFocus ? { returnFocus } : {}),
    onClose: () => { if (offer === shell) offer = null; },
  });
  offer = shell;
  shell.card.querySelector('[data-action="download"]')?.addEventListener('click', () => {
    void openDownloadPage().then(opened => { if (opened) shell.close('button'); });
  }, { signal: shell.signal });
}

const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]';

const NAVIGATION_KEYS = new Set(['Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);

/**
 * One set of listeners for every locked control, mounted now or later. They run
 * in the capture phase, so the control's own handlers, a switch's toggle or a
 * field's typing never see the activation. Keyboard users can still move
 * through a locked panel and read it. Outside any dialog, a click, Enter or
 * Space offers the app; inside a dialog or a locked panel, which explain
 * themselves with a notice, nothing happens beyond the tooltip.
 */
export function installDesktopOnlyGate(doc: Document = document): () => void {
  const locked = (event: Event): Element | null =>
    event.target instanceof Element ? event.target.closest('[data-desktop-only]') : null;
  // A press never focuses the control (its mousedown is held back), so the offer hands focus back to it explicitly.
  const offerFor = (control: Element, target: EventTarget | null): void => {
    const feature = control.getAttribute('data-desktop-only');
    const activated = target instanceof Element ? target.closest(FOCUSABLE) : null;
    if (isDesktopFeature(feature)) showDesktopOnly(feature, activated && control.contains(activated) ? activated : control);
  };
  const quiet = (event: Event): boolean =>
    event.target instanceof Element && event.target.closest(QUIET_AREAS) !== null;
  const block = (event: Event): void => {
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onClick = (event: MouseEvent): void => {
    const download = event.target instanceof Element ? event.target.closest('[data-desktop-download]') : null;
    if (download) {
      block(event);
      void openDownloadPage();
      return;
    }
    const control = locked(event);
    if (!control) return;
    block(event);
    if (!quiet(event)) offerFor(control, event.target);
  };
  // No focus, selection or native popup from a press inside a locked area; the click still offers the app.
  const onPointerDown = (event: Event): void => { if (locked(event)) event.preventDefault(); };
  const onKeyDown = (event: KeyboardEvent): void => {
    const control = locked(event);
    if (!control || NAVIGATION_KEYS.has(event.key)) return;
    block(event);
    if ((event.key === 'Enter' || event.key === ' ') && !quiet(event)) offerFor(control, event.target);
  };
  const onEdit = (event: Event): void => { if (locked(event)) block(event); };
  // Dialogs and their contents change on their own (steps, tabs, data): their notices follow.
  const notices = new MutationObserver(() => {
    if (doc.querySelector(DIALOG_CARDS)) syncOpenDialogs(doc);
  });
  notices.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-desktop-only'] });
  syncOpenDialogs(doc);
  doc.addEventListener('click', onClick, true);
  doc.addEventListener('mousedown', onPointerDown, true);
  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('beforeinput', onEdit, true);
  doc.addEventListener('paste', onEdit, true);
  return () => {
    notices.disconnect();
    doc.removeEventListener('click', onClick, true);
    doc.removeEventListener('mousedown', onPointerDown, true);
    doc.removeEventListener('keydown', onKeyDown, true);
    doc.removeEventListener('beforeinput', onEdit, true);
    doc.removeEventListener('paste', onEdit, true);
  };
}
