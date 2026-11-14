import type { DiscordWebCommand } from '@monky/shared';
import { t } from '../../i18n';
import { appEvents } from '../../core/EventBus';
import { settingsChanged, settingsStore } from '../../stores/settingsStore';
import { platformSupports } from '../../platform/capabilities';
import { lockedAttributes } from '../../utils/desktopOnly';
import { errorMessage, reportError } from '../../utils/feedback';
import { escapeHtml } from '../../utils/html';
import { withButtonLoading } from '../../utils/buttonLoading';
import { cancelSurfaceMotion, hideWithMotion, motionDuration, reducedMotion, showWithMotion } from '../../utils/surfaceMotion';
import { showConfirm } from '../Dialog';
import type { ContextMenuEntry } from '../ContextMenu';
import { DiscordWebSurface } from './discordWebSurface';
import '../../styles/discordWeb.css';

/** Discord's mark (Simple Icons, CC0), drawn by Monky itself: the Discord page is never touched. */
const DISCORD_ICON = `<svg class="discord-web-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>`;

const TERMS_URL = 'https://discord.com/terms';
const SHOWN_CLASS = 'discord-web-shown';
const EXPANDED_CLASS = 'discord-web-expanded';
const CLOSING_CLASS = 'discord-web--closing';
/** Room left under a rail divider before Discord's server list begins, so its top fade covers no icon. */
const DIVIDER_GAP = 8;
/** Room left between Discord's server list and the end of its section, for its bottom fade. */
const LIST_END_GAP = 8;
/**
 * Discord's first icon sits at the very top of its list; drawn this much lower
 * in the section, it clears the top fade and keeps Monky's room under a divider.
 */
const LIST_TOP_INSET = 12;
/** Share of the remaining distance the list's window covers each frame, so wheel turns glide. */
const LIST_EASING = 0.3;
/** Height of Monky's discreet footer under the page. */
const FOOTER_HEIGHT = 26;
/**
 * Discord's own measures (CSS px), which decide how its page is cut in two:
 * its server list is a column this wide, starting under its top bar, and its
 * user panel floats over the bottom of that column and the channel list, this
 * tall with the room above it when not in a call.
 */
const DISCORD_SERVER_LIST_WIDTH = 72;
const DISCORD_TOP_BAR = 32;
const DISCORD_USER_PANEL = 70;
/** The room Discord leaves between its list and its user panel. */
const DISCORD_PANEL_GAP = 4;
/**
 * After a page resized to the whole screen shows its first frame, Discord
 * still takes a few frames to fill it: the main area holds at least this long,
 * and REVEAL_WAIT_MS at most.
 */
const REVEAL_HOLD_MS = 250;
const REVEAL_WAIT_MS = 600;

function setStyle(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
}

/** Discord's section is opening or Monky's servers are changing size in the rail, which moves the section. */
function settling(slot: HTMLElement | null): boolean {
  const moving = [slot, document.querySelector<HTMLElement>('#server-rail .server-rail-list')];
  return moving.some(element => element?.getAnimations().some(animation => animation.playState === 'running') === true);
}

/**
 * How much of Discord is on screen: nothing; only its server list, in Monky's
 * rail, with Monky's own screen still in use beside it; or all of it.
 */
type DiscordWebMode = 'hidden' | 'rail' | 'full';

/**
 * The official Discord web app inside Monky, in two containers: Discord's
 * server list has its own section of Monky's server rail, and the rest of
 * Discord fills Monky's main area. A discreet Monky footer says it is the
 * official Discord and keeps Monky's settings at hand.
 * The Discord button shows only the server list, under Monky's own servers,
 * leaving Monky's screen as it is; Discord takes the main area once the list is
 * clicked, and Monky's servers stay above the list. There its section is
 * shorter than Discord's list, so turning the wheel past Discord's last server
 * moves the section down the rest of the list (see listOffset).
 * Login and other standalone pages, which have no server list, stay whole in
 * the main area. Both containers show the same single real page, which the main process
 * renders hidden and keeps alive while Monky shows something else.
 */
class DiscordWebView {
  private overlay: HTMLElement | null = null;
  /** The main area and the footer, which only the full mode shows. */
  private content: HTMLElement | null = null;
  private surface: DiscordWebSurface | null = null;
  private parts: Record<'servers' | 'panel' | 'main', HTMLCanvasElement | null> = { servers: null, panel: null, main: null };
  /** The page exists in the main process, even while hidden. */
  private opened = false;
  private opening: Promise<void> | null = null;
  private mode: DiscordWebMode = 'hidden';
  /** The page shows Discord's server list, so it is cut in two; null until Discord has routed its entry address. */
  private split: boolean | null = null;
  private placement: AbortController | null = null;
  private animationFrame: number | null = null;
  private lastLayout = '';
  private lastSize = { width: 1, height: 1 };
  /**
   * When the main area may fade in. Leaving the list alone, the page is still
   * as short as the list's section: once resized, Discord takes a few frames to
   * fill the new space, so the area waits for a picture as tall as the screen,
   * until REVEAL_WAIT_MS at most.
   */
  private reveal: { after: number; until: number } | null = null;
  /** How long Discord's list was in the section, kept while the main area waits. */
  private heldList = 0;
  /**
   * On the whole screen the page is as tall as the main area, and so is
   * Discord's list, but its section in the rail is shorter: the section shows
   * the list this far down, easing toward listTarget, up to listSpare().
   */
  private listOffset = 0;
  private listTarget = 0;
  /** The height of the list's section on the whole screen; 0 otherwise. */
  private listRoom = 0;
  /** Where, down the page, Discord's user panel starts covering the bottom of its list. */
  private listEnd = 0;
  private stopEvents: (() => void) | null = null;

  /** Like the rail it lives in, it follows navigation for the app's lifetime. */
  constructor() {
    // Going to Monky's home or a Monky server shows Monky again, keeping Discord's list in the rail.
    appEvents.on('navigation.home', () => this.backToMonky());
    appEvents.on('session.changed', () => this.backToMonky());
    // Turned off in the settings: the button leaves the rail and the page is ended.
    appEvents.on('settings.updated', update => {
      if (settingsChanged(update, 'discordWebEnabled') && !settingsStore.discordWebEnabled) this.close();
    });
  }

  private available(): boolean {
    return platformSupports('discordWeb') && settingsStore.discordWebEnabled;
  }

  /** The rail button with its current state, so a rebuilt rail draws it right; none while turned off. */
  railButtonMarkup(): string {
    if (!settingsStore.discordWebEnabled) return '';
    const label = this.railLabel();
    return `<button type="button" class="server-rail-discord" id="server-rail-discord" aria-pressed="${this.mode !== 'hidden'}"
      aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${lockedAttributes('discordWeb', 'discordWeb')}>
      ${DISCORD_ICON}
    </button>`;
  }

  /** Discord's section of the rail, after Monky's servers: it opens while Discord is shown. */
  railSlotMarkup(): string {
    if (!settingsStore.discordWebEnabled) return '';
    return `<div class="server-rail-discord-slot" id="server-rail-discord-slot" aria-hidden="true">
      <span class="server-rail-discord-slot__divider"></span>
    </div>`;
  }

  /** The rail button's context menu: ending the page, which otherwise keeps running in the background. */
  railContextEntries(): ContextMenuEntry[] {
    if (!this.available()) return [];
    return [{
      label: t('discordWeb.close'),
      icon: 'power_settings_new',
      disabled: !this.opened && !this.opening,
      onClick: () => this.close(),
    }];
  }

  /**
   * The rail button: shows Discord's server list beside Monky's screen; with
   * Discord on the whole screen, goes back to Monky keeping the list (or puts
   * Discord away when the page has no list, like login); with only the list,
   * puts Discord away.
   */
  toggle(): void {
    if (!this.available()) return;
    if (this.mode === 'full') this.backToMonky();
    else if (this.mode === 'rail') this.hide();
    else void this.show();
  }

  /** Gives the main area back to Monky, keeping Discord's list in the rail when the page has one. */
  backToMonky(): void {
    if (this.mode !== 'full') return;
    if (this.split === false) this.hide();
    else this.setMode('rail');
  }

  private railLabel(): string {
    if (this.mode === 'full' && this.split !== false) return t('discordWeb.railBack');
    return t(this.mode === 'hidden' ? 'discordWeb.railOpen' : 'discordWeb.railHide');
  }

  private async show(): Promise<void> {
    if (!settingsStore.discordWebNoticeAccepted) {
      const accepted = await showConfirm({
        title: t('discordWeb.noticeTitle'),
        message: t('discordWeb.noticeMessage'),
        note: t('discordWeb.noticeNote'),
        link: { label: t('discordWeb.terms'), url: TERMS_URL },
        confirmLabel: t('discordWeb.noticeConfirm'),
        variant: 'info',
      });
      if (!accepted) return;
      settingsStore.acceptDiscordWebNotice();
    }
    if (this.mode !== 'hidden' || !this.available()) return;
    const overlay = this.mount();
    // A page known to have no server list (login) needs the main area right away.
    this.setMode(this.split === false ? 'full' : 'rail', false);
    overlay.classList.remove(CLOSING_CLASS);
    showWithMotion(overlay, 'view');
    this.startPlacement();
    if (this.opened || this.opening) return;
    this.listen();
    const opening = window.api.openDiscordWeb();
    this.opening = opening;
    try {
      await opening;
      if (this.opening !== opening) return;
      this.opened = true;
    } catch (error) {
      if (this.opening !== opening) return;
      this.forget();
      reportError(errorMessage(error, t('discordWeb.openFailed')));
    } finally {
      if (this.opening === opening) this.opening = null;
    }
  }

  /** Puts the page away; it keeps running, signed in, until closed. */
  hide(): void {
    if (this.mode === 'hidden') return;
    const returnFocus = this.overlay?.contains(document.activeElement) === true;
    this.setMode('hidden');
    this.stopPlacement();
    this.sendLayout(false);
    const overlay = this.overlay;
    if (overlay) {
      overlay.classList.add(CLOSING_CLASS);
      hideWithMotion(overlay, 'view', () => overlay.classList.remove(CLOSING_CLASS));
    }
    if (returnFocus) document.getElementById('server-rail-discord')?.focus({ preventScroll: true });
  }

  /** Ends the Discord page; the login stays saved in its own storage. */
  private close(): void {
    const existed = this.opened || this.opening !== null;
    this.forget();
    if (existed) this.command({ action: 'close' });
  }

  /** Drops the page, closed here or by the main process. */
  private forget(): void {
    this.opened = false;
    this.opening = null;
    this.hide();
    this.surface?.reset();
    this.setSplit(null);
    this.overlay?.classList.remove('discord-web--painted');
  }

  /** Shows nothing, only Discord's server list or all of Discord. */
  private setMode(mode: DiscordWebMode, animate = true): void {
    if (mode === this.mode) return;
    const returnFocus = mode === 'rail' && this.content?.contains(document.activeElement) === true;
    const fromList = this.mode === 'rail';
    this.mode = mode;
    this.reveal = null;
    document.body.classList.toggle(SHOWN_CLASS, mode !== 'hidden');
    document.body.classList.toggle(EXPANDED_CLASS, mode === 'full');
    this.overlay?.classList.toggle('discord-web--rail-only', mode === 'rail');
    if (mode !== 'rail') this.overlay?.classList.remove('discord-web--rail-away');
    const content = this.content;
    if (content && mode !== 'hidden') {
      const full = mode === 'full';
      if (!animate) {
        cancelSurfaceMotion(content);
        content.hidden = !full;
      } else if (full && fromList && this.split === true && content.hidden) {
        const now = performance.now();
        this.reveal = { after: now + Math.max(motionDuration('panel'), REVEAL_HOLD_MS), until: now + REVEAL_WAIT_MS };
      }
      else if (full && (content.hidden || content.hasAttribute('data-ui-closing'))) showWithMotion(content, 'view');
      else if (!full && !content.hidden) hideWithMotion(content, 'view');
    }
    this.syncRailButton();
    if (returnFocus) document.getElementById('server-rail-discord')?.focus({ preventScroll: true });
  }

  /** The page's pictures, cursor and end reach this view for the rest of the app's life. */
  private listen(): void {
    if (this.stopEvents) return;
    const stops = [
      window.api.onDiscordWebClosed(() => this.forget()),
      window.api.onDiscordWebFrame(frame => {
        if (!this.opened && !this.opening) return;
        this.surface?.frame(frame);
        // Discord's windows (an invite, a profile) need its whole screen, not just the list.
        if (frame.modal && this.mode === 'rail') this.setMode('full');
      }),
      window.api.onDiscordWebCursor(cursor => this.surface?.cursor(cursor)),
      window.api.onDiscordWebSplit(split => { if (this.opened || this.opening) this.setSplit(split); }),
    ];
    this.stopEvents = () => { for (const stop of stops) stop(); };
  }

  private setSplit(split: boolean | null): void {
    this.split = split;
    this.overlay?.classList.toggle('discord-web--split', split === true);
    // Login and other pages without a server list need the main area.
    if (split === false && this.mode === 'rail') this.setMode('full');
    else this.syncRailButton();
  }

  private command(command: DiscordWebCommand): void {
    void window.api.discordWebCommand(command).catch(error => console.error('[Discord web] Command failed.', error));
  }

  private mount(): HTMLElement {
    if (this.overlay?.isConnected) return this.overlay;
    this.overlay?.remove();
    const overlay = document.createElement('section');
    overlay.className = this.split === true ? 'discord-web discord-web--split' : 'discord-web';
    overlay.hidden = true;
    overlay.setAttribute('aria-label', t('discordWeb.regionLabel'));
    const pageLabel = escapeHtml(t('discordWeb.regionLabel'));
    const loading = escapeHtml(t('discordWeb.loading'));
    overlay.innerHTML = `
      <div class="discord-web__rail">
        <span class="discord-web__rail-loading reconnect-spinner" role="status" aria-label="${loading}" title="${loading}"></span>
        <canvas class="discord-web__canvas" data-part="servers" tabindex="-1" aria-hidden="true"></canvas>
        <canvas class="discord-web__canvas" data-part="panel" tabindex="-1" aria-hidden="true"></canvas>
      </div>
      <div class="discord-web__content" hidden>
        <div class="discord-web__main">
          <span class="discord-web__loading">${loading}</span>
          <canvas class="discord-web__canvas" data-part="main" tabindex="0" role="application" aria-label="${pageLabel}"></canvas>
        </div>
        <footer class="discord-web__footer">
          <span class="discord-web__identity" role="note">
            ${DISCORD_ICON}
            <strong>${escapeHtml(t('discordWeb.badge'))}</strong>
            <span class="discord-web__origin">${escapeHtml(t('discordWeb.origin'))}</span>
          </span>
          <button type="button" class="discord-web__settings" data-action="settings" aria-label="${escapeHtml(t('discordWeb.settings'))}"
            title="${escapeHtml(t('discordWeb.settings'))}">
            <span class="material-symbols-outlined md-16" aria-hidden="true">settings</span>
          </button>
        </footer>
      </div>
      <canvas class="discord-web__popups" aria-hidden="true" hidden></canvas>
      <canvas class="discord-web__popup-hits" tabindex="-1" aria-hidden="true" hidden></canvas>`;
    // Clicking Discord's server list (a server, the direct messages, any of its
    // buttons) opens Discord over Monky's screen. The list then moves up, so this
    // waits until the release has reached Discord where it was pressed. Its
    // context menus open beside the list instead.
    overlay.querySelector('.discord-web__rail')?.addEventListener('pointerup', event => {
      if (event instanceof PointerEvent && event.button === 0 && this.mode === 'rail') this.setMode('full');
    });
    this.content = overlay.querySelector<HTMLElement>('.discord-web__content');
    const settings = overlay.querySelector<HTMLElement>('[data-action="settings"]');
    settings?.addEventListener('click', () => {
      void withButtonLoading(settings, async () => (await import('../SettingsModal')).settingsModal.open());
    });
    const canvases = [...overlay.querySelectorAll<HTMLCanvasElement>('canvas.discord-web__canvas')];
    const layer = overlay.querySelector<HTMLCanvasElement>('.discord-web__popups');
    const hits = overlay.querySelector<HTMLCanvasElement>('.discord-web__popup-hits');
    this.parts = {
      servers: canvases.find(canvas => canvas.dataset.part === 'servers') ?? null,
      panel: canvases.find(canvas => canvas.dataset.part === 'panel') ?? null,
      main: canvases.find(canvas => canvas.dataset.part === 'main') ?? null,
    };
    if (!this.parts.main || !layer || !hits) throw new Error('Discord web markup is incomplete.');
    // The overlay lives as long as the app, like the rail button that opens it.
    this.surface = new DiscordWebSurface(canvases, this.parts.main, layer, hits, command => this.command(command),
      () => overlay.classList.add('discord-web--painted'));
    this.surface.bind(new AbortController().signal);
    this.surface.interceptWheel((canvas, deltaY) => this.scrollList(canvas, deltaY));
    document.body.append(overlay);
    this.overlay = overlay;
    return overlay;
  }

  private startPlacement(): void {
    this.stopPlacement();
    const placement = new AbortController();
    this.placement = placement;
    const sync = (): void => this.syncPlacement();
    window.addEventListener('resize', sync, { signal: placement.signal });
    document.addEventListener('visibilitychange', sync, { signal: placement.signal });
    this.lastLayout = '';
    this.syncPlacement();
  }

  private stopPlacement(): void {
    this.placement?.abort();
    this.placement = null;
    if (this.animationFrame !== null) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
    this.surface?.cancelFrames();
  }

  /**
   * Follows Monky's frame on every animation frame. A split page's top-left
   * corner sits at the top-left of Monky's rail, so the main area shows Discord
   * as is, right of its server list; a whole page fits the main area alone. In
   * the rail, the server list fills Discord's section, shifted down to start
   * under its divider. On the whole screen, the strip behind Discord's user
   * panel stays in place so the panel reads as one piece across both
   * containers, and the section shows a window of Discord's taller list (see
   * listOffset). With only the list shown, the page is exactly as tall as the
   * section needs: Discord scrolls its list in its own height, so a taller page
   * would leave its last servers out of the section, unreachable.
   */
  private syncPlacement(): void {
    const overlay = this.overlay, surface = this.surface, { servers, panel, main } = this.parts;
    if (this.mode === 'hidden' || !overlay || !surface || !servers || !panel || !main) return;
    const full = this.mode === 'full';
    const layout = document.querySelector('.main-layout')?.getBoundingClientRect();
    const railElement = document.getElementById('server-rail');
    const rail = railElement?.getBoundingClientRect();
    // The compact layout hides Monky's rail behind other panels; the list alone goes with it.
    overlay.classList.toggle('discord-web--rail-away', !full && !!railElement && getComputedStyle(railElement).visibility === 'hidden');
    const slot = document.getElementById('server-rail-discord-slot');
    const section = slot?.getBoundingClientRect();
    const divider = slot?.querySelector('.server-rail-discord-slot__divider')?.getBoundingClientRect();
    const top = Math.max(0, Math.round(layout?.top ?? 0));
    const bottom = Math.round(layout?.bottom ?? window.innerHeight);
    const left = Math.max(0, Math.round(rail?.left ?? 0));
    const pageBottom = bottom - FOOTER_HEIGHT;
    const railTop = Math.round(divider ? divider.bottom + DIVIDER_GAP : top + DISCORD_TOP_BAR);
    const railBottom = full || !section ? pageBottom : Math.max(railTop, Math.round(section.bottom) - LIST_END_GAP);
    // Where Discord's list ends: over its user panel on the whole screen, at the section's end otherwise.
    const userPanel = this.userPanel();
    const listBottom = full ? Math.max(railTop, pageBottom - userPanel) : railBottom;
    // Until Discord fills a page grown to the whole screen, its picture keeps the list as long as it was in the section.
    if (!full) this.heldList = listBottom - railTop;
    const holding = this.reveal !== null;
    overlay.classList.toggle('discord-web--revealing', holding);
    setStyle(overlay, '--discord-web-top', `${top}px`);
    setStyle(overlay, '--discord-web-left', `${left}px`);
    setStyle(overlay, '--discord-web-servers', `${DISCORD_SERVER_LIST_WIDTH}px`);
    setStyle(overlay, '--discord-web-rail-width', `${Math.round(railElement?.clientWidth ?? DISCORD_SERVER_LIST_WIDTH)}px`);
    setStyle(overlay, '--discord-web-rail-top', `${railTop}px`);
    setStyle(overlay, '--discord-web-rail-bottom', `${Math.max(0, window.innerHeight - railBottom)}px`);
    setStyle(overlay, '--discord-web-panel-top', `${holding ? Math.min(listBottom, railTop + this.heldList) : listBottom}px`);
    setStyle(overlay, '--discord-web-page-bottom', `${Math.max(0, window.innerHeight - pageBottom)}px`);
    setStyle(overlay, '--discord-web-footer', `${FOOTER_HEIGHT}px`);
    const pageLeft = this.split === true ? left : left + DISCORD_SERVER_LIST_WIDTH;
    surface.setOrigin(main, pageLeft, top);
    surface.setOrigin(panel, left, top);
    this.listRoom = full ? listBottom - railTop : 0;
    this.listEnd = listBottom - top;
    this.easeList();
    const listTop = surface.serverList()?.top ?? DISCORD_TOP_BAR;
    surface.setOrigin(servers, left, railTop + LIST_TOP_INSET - listTop - Math.round(this.listOffset));
    // While Discord's section opens or Monky's servers change size, the page keeps the whole height and is fitted once the rail settles.
    const fitted = !full && this.split === true && !settling(slot);
    const height = fitted
      ? listBottom - railTop - LIST_TOP_INSET + DISCORD_TOP_BAR + userPanel
      : pageBottom - top;
    this.lastSize = { width: Math.max(1, Math.round(window.innerWidth - pageLeft)), height: Math.max(1, height) };
    this.sendLayout(document.visibilityState === 'visible');
    const now = performance.now();
    if (this.reveal !== null && this.content && (now >= this.reveal.until
      || (now >= this.reveal.after && surface.pictureHeight() >= this.lastSize.height - 1))) {
      this.reveal = null;
      showWithMotion(this.content, 'view');
    }
    if (document.visibilityState === 'visible' && this.animationFrame === null) {
      this.animationFrame = requestAnimationFrame(() => { this.animationFrame = null; this.syncPlacement(); });
    }
  }

  /**
   * How tall the strip under Discord's list is, from the room Discord leaves
   * above its user panel down to the page's bottom. The panel grows in a call,
   * for its voice controls; until the page tells, it has its usual height.
   */
  private userPanel(): number {
    const panel = this.surface?.serverList()?.panel;
    return panel == null ? DISCORD_USER_PANEL : Math.round(panel) + DISCORD_PANEL_GAP;
  }

  /**
   * How much of Discord's list falls below its section. The list's viewport
   * runs on under Discord's user panel, which Discord ends its list above; the
   * window stops there, or it would show the top of that panel a second time.
   */
  private listSpare(): number {
    const list = this.surface?.serverList();
    if (this.mode !== 'full' || !list || this.listRoom <= 0) return 0;
    const shown = Math.min(list.height, this.listEnd - list.top);
    return Math.max(0, Math.round(shown + LIST_TOP_INSET - this.listRoom));
  }

  /** Moves the section's window toward its target, at once when motion is reduced. */
  private easeList(): void {
    this.listTarget = Math.min(Math.max(0, this.listTarget), this.listSpare());
    const gap = this.listTarget - this.listOffset;
    this.listOffset = Math.abs(gap) < 0.5 || reducedMotion() ? this.listTarget : this.listOffset + gap * LIST_EASING;
  }

  /**
   * On the whole screen, the wheel over Discord's list scrolls it like a list
   * inside a taller one: going down, Discord's own list first and then the
   * section's window; going up, the window first and then Discord's list.
   * Returns whether the turn moved the window, and so must not reach Discord.
   */
  private scrollList(canvas: HTMLCanvasElement, deltaY: number): boolean {
    if (canvas !== this.parts.servers || this.mode !== 'full' || deltaY === 0) return false;
    if (deltaY < 0) {
      if (this.listTarget <= 0) return false;
      this.listTarget = Math.max(0, this.listTarget + deltaY);
      return true;
    }
    const list = this.surface?.serverList();
    const atEnd = !list || list.scrollTop >= list.scrollHeight - list.height - 1;
    const spare = this.listSpare();
    if (!atEnd || this.listTarget >= spare) return false;
    this.listTarget = Math.min(spare, this.listTarget + deltaY);
    return true;
  }

  /** Tells the main process the page's size, and whether to paint it. */
  private sendLayout(visible: boolean): void {
    const { width, height } = this.lastSize;
    const signature = `${width}x${height}@${window.devicePixelRatio}:${visible}`;
    if (signature === this.lastLayout) return;
    this.lastLayout = signature;
    this.surface?.scheduleDraw();
    this.command({ action: 'layout', width, height, visible });
  }

  private syncRailButton(): void {
    const button = document.getElementById('server-rail-discord');
    if (!button || !platformSupports('discordWeb')) return;
    const label = this.railLabel();
    button.setAttribute('aria-pressed', String(this.mode !== 'hidden'));
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

export const discordWeb = new DiscordWebView();
