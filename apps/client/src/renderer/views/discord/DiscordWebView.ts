import type { DiscordWebCommand } from '@monky/shared';
import { t } from '../../i18n';
import { appEvents } from '../../core/EventBus';
import { settingsChanged, settingsStore } from '../../stores/settingsStore';
import { platformSupports } from '../../platform/capabilities';
import { lockedAttributes } from '../../utils/desktopOnly';
import { errorMessage, reportError } from '../../utils/feedback';
import { escapeHtml } from '../../utils/html';
import { withButtonLoading } from '../../utils/buttonLoading';
import { hideWithMotion, showWithMotion } from '../../utils/surfaceMotion';
import { showConfirm } from '../Dialog';
import type { ContextMenuEntry } from '../ContextMenu';
import { DiscordWebSurface } from './discordWebSurface';
import '../../styles/discordWeb.css';

/** Discord's mark (Simple Icons, CC0), drawn by Monky itself: the Discord page is never touched. */
const DISCORD_ICON = `<svg class="discord-web-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z"/></svg>`;

const TERMS_URL = 'https://discord.com/terms';
const SHOWN_CLASS = 'discord-web-shown';
/** Room left under the rail's divider before Discord's server list begins. */
const DIVIDER_GAP = 2;
/** Height of Monky's discreet footer under the page. */
const FOOTER_HEIGHT = 26;
/**
 * Discord's own measures (CSS px), which decide how its page is cut in two:
 * its server list is a column this wide, starting under its top bar, and its
 * user panel floats over the bottom of that column and the channel list.
 */
const DISCORD_SERVER_LIST_WIDTH = 72;
const DISCORD_TOP_BAR = 32;
const DISCORD_USER_PANEL = 70;

function setStyle(element: HTMLElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) !== value) element.style.setProperty(property, value);
}

/**
 * The official Discord web app inside Monky (pilot), in two containers: Discord's
 * server list continues Monky's server rail under its home and Discord buttons,
 * and the rest of Discord fills Monky's main area. A discreet Monky footer says
 * it is the official Discord and keeps Monky's settings at hand.
 * Login and other standalone pages, which have no server list, stay whole in
 * the main area. Both containers show the same single real page, which the main process
 * renders hidden and keeps alive while Monky shows something else.
 */
class DiscordWebView {
  private overlay: HTMLElement | null = null;
  private surface: DiscordWebSurface | null = null;
  private parts: Record<'servers' | 'panel' | 'main', HTMLCanvasElement | null> = { servers: null, panel: null, main: null };
  /** The page exists in the main process, even while hidden. */
  private opened = false;
  private opening: Promise<void> | null = null;
  private shown = false;
  /** The page shows Discord's server list, so it is cut in two. */
  private split = false;
  private placement: AbortController | null = null;
  private animationFrame: number | null = null;
  private lastLayout = '';
  private lastSize = { width: 1, height: 1 };
  private stopEvents: (() => void) | null = null;

  /** Like the rail it lives in, it follows navigation for the app's lifetime. */
  constructor() {
    // Going back to Monky (home or any server) puts Discord away, still signed in and running.
    appEvents.on('navigation.home', () => this.hide());
    appEvents.on('session.changed', () => this.hide());
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
    return `<button type="button" class="server-rail-discord" id="server-rail-discord" aria-pressed="${this.shown}"
      aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${lockedAttributes('discordWeb', 'discordWeb')}>
      ${DISCORD_ICON}
    </button>`;
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

  /** The rail button: shows Discord, or puts it away again. */
  toggle(): void {
    if (!this.available()) return;
    if (this.shown) this.hide();
    else void this.show();
  }

  private railLabel(): string {
    return t(this.shown ? 'discordWeb.railHide' : 'discordWeb.railOpen');
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
    if (this.shown || !this.available()) return;
    const overlay = this.mount();
    this.shown = true;
    document.body.classList.add(SHOWN_CLASS);
    this.syncRailButton();
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
    if (!this.shown) return;
    const returnFocus = this.overlay?.contains(document.activeElement) === true;
    this.shown = false;
    document.body.classList.remove(SHOWN_CLASS);
    this.syncRailButton();
    this.stopPlacement();
    this.sendLayout(false);
    if (this.overlay) hideWithMotion(this.overlay, 'view');
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
    this.setSplit(false);
    this.overlay?.classList.remove('discord-web--painted');
  }

  /** The page's pictures, cursor and end reach this view for the rest of the app's life. */
  private listen(): void {
    if (this.stopEvents) return;
    const stops = [
      window.api.onDiscordWebClosed(() => this.forget()),
      window.api.onDiscordWebFrame(frame => { if (this.opened || this.opening) this.surface?.frame(frame); }),
      window.api.onDiscordWebCursor(cursor => this.surface?.cursor(cursor)),
      window.api.onDiscordWebSplit(split => { if (this.opened || this.opening) this.setSplit(split); }),
    ];
    this.stopEvents = () => { for (const stop of stops) stop(); };
  }

  private setSplit(split: boolean): void {
    this.split = split;
    this.overlay?.classList.toggle('discord-web--split', split);
  }

  private command(command: DiscordWebCommand): void {
    void window.api.discordWebCommand(command).catch(error => console.error('[Discord web] Command failed.', error));
  }

  private mount(): HTMLElement {
    if (this.overlay?.isConnected) return this.overlay;
    this.overlay?.remove();
    const overlay = document.createElement('section');
    overlay.className = this.split ? 'discord-web discord-web--split' : 'discord-web';
    overlay.hidden = true;
    overlay.setAttribute('aria-label', t('discordWeb.regionLabel'));
    const pageLabel = escapeHtml(t('discordWeb.regionLabel'));
    overlay.innerHTML = `
      <div class="discord-web__rail">
        <canvas class="discord-web__canvas" data-part="servers" tabindex="-1" aria-hidden="true"></canvas>
        <canvas class="discord-web__canvas" data-part="panel" tabindex="-1" aria-hidden="true"></canvas>
      </div>
      <div class="discord-web__main">
        <span class="discord-web__loading">${escapeHtml(t('discordWeb.loading'))}</span>
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
      </footer>`;
    const settings = overlay.querySelector<HTMLElement>('[data-action="settings"]');
    settings?.addEventListener('click', () => {
      void withButtonLoading(settings, async () => (await import('../SettingsModal')).settingsModal.open());
    });
    const canvases = [...overlay.querySelectorAll<HTMLCanvasElement>('canvas')];
    this.parts = {
      servers: canvases.find(canvas => canvas.dataset.part === 'servers') ?? null,
      panel: canvases.find(canvas => canvas.dataset.part === 'panel') ?? null,
      main: canvases.find(canvas => canvas.dataset.part === 'main') ?? null,
    };
    // The overlay lives as long as the app, like the rail button that opens it.
    this.surface = new DiscordWebSurface(canvases, command => this.command(command), () => overlay.classList.add('discord-web--painted'));
    this.surface.bind(new AbortController().signal);
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
   * as is, right of its server list; a whole page fits the main area alone. In the rail, the server list is shifted down to
   * start under the divider, while the strip behind Discord's user panel stays
   * in place so the panel reads as one piece across both containers.
   */
  private syncPlacement(): void {
    const overlay = this.overlay, surface = this.surface, { servers, panel, main } = this.parts;
    if (!this.shown || !overlay || !surface || !servers || !panel || !main) return;
    const layout = document.querySelector('.main-layout')?.getBoundingClientRect();
    const rail = document.getElementById('server-rail')?.getBoundingClientRect();
    const divider = document.querySelector('#server-rail .server-rail-divider')?.getBoundingClientRect();
    const top = Math.max(0, Math.round(layout?.top ?? 0));
    const bottom = Math.round(layout?.bottom ?? window.innerHeight);
    const left = Math.max(0, Math.round(rail?.left ?? 0));
    const pageBottom = bottom - FOOTER_HEIGHT;
    const railTop = Math.round(divider ? divider.bottom + DIVIDER_GAP : top + DISCORD_TOP_BAR);
    const panelTop = Math.max(railTop, pageBottom - DISCORD_USER_PANEL);
    setStyle(overlay, '--discord-web-top', `${top}px`);
    setStyle(overlay, '--discord-web-left', `${left}px`);
    setStyle(overlay, '--discord-web-servers', `${DISCORD_SERVER_LIST_WIDTH}px`);
    setStyle(overlay, '--discord-web-rail-top', `${railTop}px`);
    setStyle(overlay, '--discord-web-panel-top', `${panelTop}px`);
    setStyle(overlay, '--discord-web-page-bottom', `${Math.max(0, window.innerHeight - pageBottom)}px`);
    setStyle(overlay, '--discord-web-footer', `${FOOTER_HEIGHT}px`);
    const pageLeft = this.split ? left : left + DISCORD_SERVER_LIST_WIDTH;
    surface.setOrigin(main, pageLeft, top);
    surface.setOrigin(panel, left, top);
    surface.setOrigin(servers, left, railTop - DISCORD_TOP_BAR);
    this.lastSize = { width: Math.max(1, Math.round(window.innerWidth - pageLeft)), height: Math.max(1, pageBottom - top) };
    this.sendLayout(document.visibilityState === 'visible');
    if (document.visibilityState === 'visible' && this.animationFrame === null) {
      this.animationFrame = requestAnimationFrame(() => { this.animationFrame = null; this.syncPlacement(); });
    }
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
    button.setAttribute('aria-pressed', String(this.shown));
    button.setAttribute('aria-label', label);
    button.title = label;
  }
}

export const discordWeb = new DiscordWebView();
