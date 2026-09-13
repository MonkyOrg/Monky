import { MessageType, Permission, botScreenSchema, type BotScreen, type BotScreenAction } from '@monky/shared';
import { appEvents } from '../core/EventBus';
import { getLanguage, t, type TranslationKey } from '../i18n';
import { botRequestError } from '../utils/botInputs';
import { getBotVoiceContext, type BotVoiceContext } from '../utils/botVoice';
import { BotScreenFrame } from './BotScreenFrame';

/** A persistent stage tile; viewing and layout never change the game's seats. */
export class BotScreenView {
  readonly element = document.createElement('section');
  private frame: BotScreenFrame | null = null;
  private title = document.createElement('strong');
  private openButton = document.createElement('button');
  private close = document.createElement('button');
  private focus = document.createElement('button');
  private fullscreen = document.createElement('button');
  private notice = document.createElement('p');
  private body = document.createElement('div');
  private placeholder = document.createElement('div');
  private placeholderHint = document.createElement('p');
  private error = document.createElement('p');
  private destroyed = false;
  private focused = false;
  private requestId: string | null = null;
  private unbindLanguage: () => void;

  constructor(
    private screen: BotScreen,
    private context: BotVoiceContext,
    onOpen: () => void,
    onClose: () => void,
    onFocus: () => void,
  ) {
    if (!this.canRead()) throw new Error(t('protocolError.botVoiceRequired'));
    this.element.className = 'stage-card stage-bot-screen-card';
    this.element.dataset.botScreenId = screen.id;
    this.element.setAttribute('aria-label', screen.title);
    const header = document.createElement('div');
    header.className = 'bot-screen-header';
    this.title.textContent = screen.title;
    const controls = document.createElement('div');
    controls.className = 'bot-screen-controls';
    for (const button of [this.openButton, this.focus, this.fullscreen, this.close]) {
      button.type = 'button';
      button.className = 'btn btn-secondary';
    }
    this.openButton.className = 'btn btn-primary';
    this.openButton.dataset.botScreenAction = 'open';
    this.focus.dataset.botScreenAction = 'focus';
    this.fullscreen.dataset.botScreenAction = 'fullscreen';
    this.close.dataset.botScreenAction = 'close';
    this.openButton.addEventListener('click', (event) => { event.stopPropagation(); onOpen(); });
    this.focus.addEventListener('click', (event) => { event.stopPropagation(); onFocus(); });
    this.close.addEventListener('click', (event) => { event.stopPropagation(); onClose(); });
    this.fullscreen.addEventListener('click', (event) => { event.stopPropagation(); void this.toggleFullscreen(); });
    this.element.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('button, iframe')) return;
      onFocus();
    });
    this.notice.className = 'bot-screen-notice';
    this.error.className = 'bot-error';
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    controls.append(this.focus, this.fullscreen, this.close);
    header.append(this.title, controls);
    this.body.className = 'bot-screen-body';
    this.placeholder.className = 'bot-screen-placeholder';
    this.placeholder.append(this.openButton, this.placeholderHint);
    this.body.append(this.placeholder);
    this.element.append(header, this.notice, this.body, this.error);
    this.localize();
    this.unbindLanguage = appEvents.on('i18n.language_changed', () => this.localize());
  }

  get snapshot(): BotScreen { return this.screen; }
  get isWatching(): boolean { return this.frame !== null; }

  open(): void {
    if (this.frame || !this.canRead()) return;
    const frame = new BotScreenFrame(this.screen, {
      id: this.context.user.id, nickname: this.context.user.nickname, locale: getLanguage(),
    }, (action) => { void this.act(action); });
    this.frame = frame;
    this.body.append(frame.element);
    this.placeholder.hidden = true;
    this.localize();
  }

  leave(): void {
    if (this.requestId) this.context.session.client.cancelRequest(this.requestId);
    this.requestId = null;
    this.frame?.destroy();
    this.frame = null;
    this.placeholder.hidden = false;
    this.error.hidden = true;
    this.localize();
  }

  update(screen: BotScreen): void {
    if (this.destroyed || screen.id !== this.screen.id) return;
    this.screen = screen;
    this.title.textContent = screen.title;
    this.element.setAttribute('aria-label', screen.title);
    if (this.frame) {
      this.frame.element.title = screen.title;
      this.frame.update(screen);
    }
  }

  setLayout(focused: boolean, miniature: boolean): void {
    const focusChanged = this.focused !== focused;
    this.focused = focused;
    this.element.className = `${focused ? 'stage-focused-main' : miniature ? 'stage-mini-card stage-mini-card--video' : 'stage-card stage-card--video'} stage-bot-screen-card`;
    this.focus.setAttribute('aria-pressed', String(focused));
    if (focusChanged) this.localize();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.leave();
    this.unbindLanguage();
    this.element.remove();
  }

  private canRead(): boolean {
    const current = getBotVoiceContext();
    return !this.destroyed && current?.session === this.context.session &&
      current.channelId === this.screen.channelId && current.user.sessionId === this.context.user.sessionId;
  }

  private localize(): void {
    this.frame?.setLocale(getLanguage());
    const label = (button: HTMLButtonElement, key: TranslationKey, icon: string, showText = true): void => {
      button.title = t(key);
      button.setAttribute('aria-label', t(key));
      const glyph = document.createElement('span');
      glyph.className = 'material-symbols-outlined md-18';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = icon;
      button.replaceChildren(glyph);
      if (showText) {
        const text = document.createElement('span');
        text.className = 'bot-screen-control-label';
        text.textContent = t(key);
        button.append(text);
      }
    };
    label(this.openButton, 'botScreen.openView', 'smart_display');
    label(this.close, 'botScreen.close', 'visibility_off');
    label(this.focus, this.focused ? 'botScreen.unfocus' : 'botScreen.focus', this.focused ? 'grid_view' : 'center_focus_strong');
    label(this.fullscreen, 'stage.fullscreen', 'fullscreen', false);
    this.close.hidden = !this.isWatching;
    this.notice.textContent = t('botScreen.publicNotice');
    this.placeholderHint.textContent = t('botScreen.viewHint');
  }

  private async toggleFullscreen(): Promise<void> {
    if (!this.canRead()) return;
    try {
      if (document.fullscreenElement === this.element) await document.exitFullscreen();
      else await this.element.requestFullscreen();
    } catch (error: unknown) {
      console.warn('[Bot screens] Could not change stage fullscreen.', error);
    }
  }

  private async act(action: BotScreenAction): Promise<void> {
    const { session } = this.context;
    if (!this.frame || this.requestId || action.id !== this.screen.id || !this.canRead()) return;
    if (!session.serverStore.hasPermission(Permission.USE_BOT_COMMANDS)) {
      this.error.textContent = t('botChat.commandsPermissionDenied');
      this.error.hidden = false;
      return;
    }
    const requestId = crypto.randomUUID();
    this.requestId = requestId;
    try {
      const screen = botScreenSchema.parse(await session.client.sendRequest<unknown>(
        MessageType.BOT_SCREEN_ACTION, action, requestId,
      ));
      if (!this.canRead() || this.requestId !== requestId || screen.id !== this.screen.id ||
          screen.channelId !== this.context.channelId || screen.botId !== this.screen.botId) return;
      session.botScreenStore.upsert(screen);
      this.error.hidden = true;
    } catch (error: unknown) {
      if (!this.canRead() || this.requestId !== requestId) return;
      this.error.textContent = botRequestError(error);
      this.error.hidden = false;
      appEvents.emit('voice.bot_screens_reload');
    } finally {
      if (this.requestId === requestId) this.requestId = null;
    }
  }
}
