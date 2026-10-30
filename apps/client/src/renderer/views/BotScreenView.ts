import {
  BOT_SCREEN_PERMISSION_POLICY_VERSION, MessageType, Permission, botDeviceStorageScopeSchema, botScreenSchema, botScreenRemovedSchema,
  botStorageInfoSchema, botStorageLevelEventSchema,
  type BotDeviceStorageDecision, type BotDeviceStorageGrant, type BotDeviceStorageScope, type BotScreen, type BotScreenAction,
  type BotScreenBeforeCloseReason, type BotScreenCloseReason, type BotScreenRemoved, type BotStorageUsage,
} from '@monky/shared';
import { appEvents } from '../core/EventBus';
import { currentEventOrigin } from '../core/sessionRouting';
import { getLanguage, t, type TranslationKey } from '../i18n';
import { settingsStore, type SaveTiming } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { formatBytes } from '../utils/attachment';
import { botRequestError } from '../utils/botInputs';
import { getBotVoiceContext, type BotVoiceContext } from '../utils/botVoice';
import { setSurfaceVisible } from '../utils/surfaceVisibility';
import { BotScreenFrame } from './BotScreenFrame';
import { botSettingsModal } from './BotSettingsModal';
import { BotScreenVolumeControl } from './BotScreenVolumeControl';
import { showConfirm, showConfirmWithChoice } from './Dialog';

/** What the person may decide about storing data on this computer when opening the view. */
interface StorageOffer {
  scope: BotDeviceStorageScope;
  decision: BotDeviceStorageDecision;
  maxBytes: number;
}

/** A persistent stage tile; viewing and layout never change the game's seats. */
export class BotScreenView {
  readonly element = document.createElement('section');
  private frame: BotScreenFrame | null = null;
  private title = document.createElement('strong');
  private openButton = document.createElement('button');
  private close = document.createElement('button');
  private endButton = document.createElement('button');
  private focus = document.createElement('button');
  private fullscreen = document.createElement('button');
  private volumeControl = new BotScreenVolumeControl((percent, timing) => this.setVolume(percent, timing), () => {
    voiceStore.setMiniappMuted(this.screen.botId, !voiceStore.isMiniappMuted(this.screen.botId));
  });
  private notice = document.createElement('p');
  private body = document.createElement('div');
  private placeholder = document.createElement('div');
  private placeholderHint = document.createElement('p');
  private error = document.createElement('p');
  /** Rendered by Monky, so every miniapp shows it and none can hide or imitate it. */
  private storageBadge = document.createElement('button');
  private deviceStorage: BotStorageUsage | null = null;
  private serverStorage: BotStorageUsage | null = null;
  private destroyed = false;
  private focused = false;
  private requestId: string | null = null;
  private endRequestId: string | null = null;
  /** A close this person asked for, waiting for the miniapp's onBeforeClose. */
  private confirming: BotScreenBeforeCloseReason | null = null;
  private pendingConsent: AbortController | null = null;
  /** Whether its person can see the tile; frames learn it through onVisibilityChange. */
  private stageVisible = false;
  private unbind: Array<() => void>;

  constructor(
    private screen: BotScreen,
    private context: BotVoiceContext,
    onOpen: () => void,
    onClose: () => void,
    onFocus: () => void,
    private onConfirmClose: () => void,
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
    for (const button of [this.openButton, this.focus, this.fullscreen, this.close, this.endButton]) {
      button.type = 'button';
      button.className = 'btn btn-secondary';
    }
    this.openButton.className = 'btn btn-primary';
    this.openButton.dataset.botScreenAction = 'open';
    this.focus.dataset.botScreenAction = 'focus';
    this.fullscreen.dataset.botScreenAction = 'fullscreen';
    this.close.dataset.botScreenAction = 'close';
    this.endButton.dataset.botScreenAction = 'end';
    this.endButton.className = 'btn btn-danger';
    this.openButton.addEventListener('click', (event) => { event.stopPropagation(); onOpen(); });
    this.focus.addEventListener('click', (event) => { event.stopPropagation(); onFocus(); });
    this.close.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.confirming === 'leave') this.frame?.forceClose();
      else if (this.confirming) return;
      else if (!this.frame?.asksBeforeClose) onClose();
      else void this.confirmClose('leave').then((confirmed) => { if (confirmed) onClose(); });
    });
    this.endButton.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.confirming === 'end') this.frame?.forceClose();
      else void this.end();
    });
    this.fullscreen.addEventListener('click', (event) => { event.stopPropagation(); void this.toggleFullscreen(); });
    this.element.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('button, iframe')) return;
      onFocus();
    });
    this.notice.className = 'bot-screen-notice';
    this.notice.setAttribute('aria-live', 'polite');
    this.error.className = 'bot-error';
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    this.storageBadge.type = 'button';
    this.storageBadge.className = 'bot-screen-storage-badge';
    this.storageBadge.dataset.botScreenAction = 'storage';
    this.storageBadge.hidden = true;
    this.storageBadge.addEventListener('click', (event) => {
      event.stopPropagation();
      botSettingsModal.createOpenAction(this.screen.botId, this.context.session.client, this.context.session.serverStore, 'storage')();
    });
    controls.append(this.focus, this.fullscreen, this.close, this.endButton);
    header.append(this.title, controls);
    this.body.className = 'bot-screen-body';
    this.placeholder.className = 'bot-screen-placeholder';
    this.placeholder.append(this.openButton, this.placeholderHint);
    this.body.append(this.placeholder);
    // The volume overlays the tile's bottom-right corner; right after the toolbar in focus order.
    this.element.append(header, this.volumeControl.element, this.storageBadge, this.notice, this.body, this.error);
    this.localize();
    this.syncVolume();
    this.unbind = [
      appEvents.on('i18n.language_changed', () => this.localize()),
      appEvents.on('server.roles_updated', () => this.localize()),
      appEvents.on('server.updated', () => this.localize()),
      appEvents.on('session.voice_context_updated', () => this.localize()),
      // Another tile of the same bot, or another window, may have changed the saved volume.
      appEvents.on('settings.updated', () => this.syncVolume()),
      // Another tile of the same bot is moving the volume right now.
      appEvents.on<{ botId: string }>('miniapp_volume.changed', ({ botId }) => {
        if (botId === this.screen.botId) this.syncVolume();
      }),
      appEvents.on('voice.miniapp_mute_changed', () => this.syncVolume()),
      appEvents.on(`message.${MessageType.BOT_STORAGE_LEVEL}`, (payload: unknown) => {
        const parsed = botStorageLevelEventSchema.safeParse(payload);
        if (!parsed.success || parsed.data.botId !== this.screen.botId || !this.frame || !this.serverStorage ||
            currentEventOrigin() !== this.context.session.client.sessionKey) return;
        this.serverStorage = parsed.data.usage;
        this.renderStorageBadge();
      }),
    ];
  }

  get snapshot(): BotScreen { return this.screen; }
  get isWatching(): boolean { return this.frame !== null; }
  get isEnding(): boolean { return this.endRequestId !== null; }

  async open(): Promise<void> {
    if (this.frame || this.pendingConsent || !this.canRead()) return;
    const controller = new AbortController();
    this.pendingConsent = controller;
    const screen = this.screen;
    this.error.hidden = true;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      if (controller.signal.aborted || this.pendingConsent !== controller || !this.canRead()) return;
      const offer = await this.prepareStorage(controller.signal);
      if (controller.signal.aborted || this.pendingConsent !== controller || !this.canRead()) return;
      const dialog = {
        title: t('botScreen.permissionTitle', { title: screen.title }),
        message: t('botScreen.permissionMessage'),
        confirmLabel: t('botScreen.permissionAllow'),
        cancelLabel: t('botScreen.permissionDeny'),
        variant: 'info' as const,
        requireUserGesture: true, focusCancel: true, signal: controller.signal,
      };
      const storageText = offer ? { bot: offer.scope.botName, limit: formatBytes(offer.maxBytes) } : undefined;
      let approved: boolean;
      let grant: BotDeviceStorageGrant = 'none';
      if (offer?.decision === 'ask') {
        const answer = await showConfirmWithChoice<BotDeviceStorageGrant>({ ...dialog, choices: {
          legend: t('botScreen.storageTitle'), description: t('botScreen.storageDescription', storageText), selected: 'none',
          options: [
            { value: 'none', label: t('botScreen.storageNone'), description: t('botScreen.storageNoneHint'), icon: 'block' },
            { value: 'session', label: t('botScreen.storageSession'), description: t('botScreen.storageSessionHint'), icon: 'schedule' },
            { value: 'always', label: t('botScreen.storageAlways'), description: t('botScreen.storageAlwaysHint'), icon: 'save' },
          ],
        } });
        approved = answer.confirmed;
        grant = answer.choice;
      } else {
        approved = await showConfirm({ ...dialog, note: offer
          ? t(offer.decision === 'always' ? 'botScreen.storageAlwaysNotice' : 'botScreen.storageNeverNotice', storageText) : undefined });
      }
      if (controller.signal.aborted || this.pendingConsent !== controller || !this.canRead()) return;
      if (!approved) {
        this.error.textContent = t('botScreen.permissionDenied');
        this.error.hidden = false;
        return;
      }
      if (this.screen.id !== screen.id || this.screen.instanceId !== screen.instanceId ||
          this.screen.botId !== screen.botId || this.screen.html !== screen.html) {
        throw new Error('Miniapp changed during permission review.');
      }
      const frame = new BotScreenFrame(this.screen, {
        id: this.context.user.id, nickname: this.context.user.nickname, locale: getLanguage(),
      }, {
        policyVersion: BOT_SCREEN_PERMISSION_POLICY_VERSION, serverKey: this.context.session.key,
        botId: screen.botId, screenId: screen.id, instanceId: screen.instanceId,
        ...(offer ? { storage: { scope: offer.scope, grant } } : {}),
      }, (action) => { void this.act(action); }, error => {
        console.error('[Bot screens] Could not open miniapp document.', error);
        this.leave();
        this.error.textContent = t('botScreen.openError');
        this.error.hidden = false;
        appEvents.emit('stage.bot_screens_changed');
      }, this.outputVolume(), (state) => {
        if (this.frame !== frame) return;
        this.deviceStorage = state.status === 'granted' ? state.usage : null;
        this.renderStorageBadge();
      }, this.stageVisible);
      this.frame = frame;
      this.body.append(frame.element);
      this.placeholder.hidden = true;
      this.localize();
      this.renderStorageBadge();
    } finally {
      if (this.pendingConsent === controller) this.pendingConsent = null;
    }
  }

  /** Only bots the administrator allowed may ask; anything unexpected opens the miniapp without storage. */
  private async prepareStorage(signal: AbortSignal): Promise<StorageOffer | null> {
    const { session, user } = this.context;
    this.serverStorage = null;
    if (!session.serverStore.serverDetails?.protocol?.features.includes('bot-storage')) return null;
    try {
      const info = botStorageInfoSchema.parse(await session.client.sendRequest<unknown>(
        MessageType.BOT_STORAGE_INFO_GET, { botId: this.screen.botId }, crypto.randomUUID(),
      ));
      if (signal.aborted || info.botId !== this.screen.botId) return null;
      // The server part, and with it its warning on this card, reaches only people who manage bots.
      this.serverStorage = info.server?.granted ? info.server.usage : null;
      if (!info.device.granted) return null;
      const details = session.serverStore.serverDetails;
      const scope = botDeviceStorageScopeSchema.safeParse({
        serverUrl: session.client.getCurrentServerUrl(), serverId: details?.id, serverName: details?.name,
        userId: user.id, botId: this.screen.botId,
        botName: session.serverStore.knownMembers.get(this.screen.botId)?.nickname || this.screen.title,
      });
      if (!scope.success) return null;
      const entry = await window.api.botStorage.get(scope.data);
      return signal.aborted ? null : { scope: scope.data, decision: entry.decision, maxBytes: entry.usage.maxBytes };
    } catch (error: unknown) {
      console.warn('[Bot screens] Opening the miniapp without storage on this computer.', error);
      return null;
    }
  }

  private renderStorageBadge(): void {
    const usages = this.frame ? [this.deviceStorage, this.serverStorage].filter((usage) => usage !== null) : [];
    const level = usages.some((usage) => usage.level === 'full') ? 'full'
      : usages.some((usage) => usage.level === 'near_full') ? 'near_full' : 'ok';
    if (level !== 'ok') {
      const details = [
        ...(this.deviceStorage ? [t('botScreen.storageDeviceDetail', {
          used: formatBytes(this.deviceStorage.usedBytes), total: formatBytes(this.deviceStorage.maxBytes),
        })] : []),
        ...(this.serverStorage ? [t('botScreen.storageServerDetail', {
          used: formatBytes(this.serverStorage.usedBytes), total: formatBytes(this.serverStorage.maxBytes),
        })] : []),
        t('botScreen.storageBadgeHint'),
      ];
      const label = t(level === 'full' ? 'botScreen.storageFull' : 'botScreen.storageNearFull');
      const glyph = document.createElement('span');
      glyph.className = 'material-symbols-outlined md-16';
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = level === 'full' ? 'error' : 'warning';
      const text = document.createElement('span');
      text.textContent = label;
      this.storageBadge.replaceChildren(glyph, text);
      this.storageBadge.dataset.level = level;
      this.storageBadge.title = details.join('\n');
      this.storageBadge.setAttribute('aria-label', `${label}. ${details.join(' ')}`);
    }
    setSurfaceVisible(this.storageBadge, level !== 'ok', 'notice');
  }

  /** Closes the local view; the frame's onClose hooks learn why. */
  leave(reason: BotScreenCloseReason = 'revoked'): void {
    this.pendingConsent?.abort();
    this.pendingConsent = null;
    if (this.requestId) this.context.session.client.cancelRequest(this.requestId);
    this.requestId = null;
    this.confirming = null;
    this.frame?.retire(reason);
    this.frame = null;
    this.deviceStorage = null;
    this.serverStorage = null;
    this.renderStorageBadge();
    this.volumeControl.close();
    this.placeholder.hidden = false;
    this.error.hidden = true;
    this.localize();
  }

  update(screen: BotScreen): void {
    if (this.destroyed || screen.id !== this.screen.id || screen.instanceId !== this.screen.instanceId) return;
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

  setStageVisible(visible: boolean): void {
    this.stageVisible = visible;
    this.frame?.setVisible(visible);
  }

  /**
   * Off stage while its person browses elsewhere. The view keeps running, but nothing on the
   * tile can be answered: a pending permission review is cancelled rather than left behind.
   */
  park(): void {
    this.pendingConsent?.abort();
    this.pendingConsent = null;
    this.volumeControl.close();
    this.setStageVisible(false);
  }

  destroy(reason: BotScreenCloseReason = 'revoked'): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.endRequestId) this.context.session.client.cancelRequest(this.endRequestId);
    this.endRequestId = null;
    this.leave(reason);
    for (const unbind of this.unbind) unbind();
    this.element.remove();
  }

  /** What this viewer's onClose is told about a removal by the server. */
  closeReasonFor(removed: BotScreenRemoved): BotScreenCloseReason {
    if (removed.reason === 'view_revoked') return 'revoked';
    return removed.reason === 'ended' && this.endRequestId !== null && removed.endedByUserId === this.context.user.id
      ? 'end' : 'ended';
  }

  /** Lets an onBeforeClose hook answer first. Revocations never come through here. */
  private async confirmClose(reason: BotScreenBeforeCloseReason): Promise<boolean> {
    const frame = this.frame;
    if (!frame || this.confirming) return false;
    this.confirming = reason;
    this.localize();
    this.onConfirmClose();
    try {
      return await frame.requestBeforeClose(reason) && this.frame === frame && !this.destroyed;
    } finally {
      if (this.confirming === reason) {
        this.confirming = null;
        if (!this.destroyed) this.localize();
      }
    }
  }

  private canRead(): boolean {
    const current = getBotVoiceContext();
    return !this.destroyed && current?.session === this.context.session &&
      current.channelId === this.screen.channelId && current.user.sessionId === this.context.user.sessionId;
  }

  private canEnd(): boolean {
    return this.canRead() && (this.context.user.id === this.screen.creatorUserId ||
      this.context.session.serverStore.isAdminMember(this.context.user.id));
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
    const confirmingLeave = this.confirming === 'leave';
    const confirmingEnd = this.confirming === 'end';
    label(this.close, confirmingLeave ? 'botScreen.closeNow' : 'botScreen.close', confirmingLeave ? 'close' : 'visibility_off');
    this.close.title = t(confirmingLeave ? 'botScreen.closeNowHint' : 'botScreen.permissionRevokeHint');
    this.close.disabled = confirmingEnd;
    label(this.endButton, confirmingEnd ? 'botScreen.endNow' : this.endRequestId ? 'botScreen.ending' : 'botScreen.end', 'stop_circle');
    this.endButton.title = t(confirmingEnd ? 'botScreen.endNowHint' : 'botScreen.endHint');
    this.endButton.hidden = !this.canEnd();
    this.endButton.disabled = this.endRequestId !== null || confirmingLeave;
    label(this.focus, this.focused ? 'botScreen.unfocus' : 'botScreen.focus', this.focused ? 'grid_view' : 'center_focus_strong');
    label(this.fullscreen, 'stage.fullscreen', 'fullscreen', false);
    this.close.hidden = !this.isWatching;
    // Only an open view plays audio.
    this.volumeControl.element.hidden = !this.isWatching;
    this.volumeControl.localize();
    if (this.confirming) this.element.setAttribute('aria-busy', 'true');
    else this.element.removeAttribute('aria-busy');
    // A live region: only an actual change may be announced.
    const notice = this.confirming ? t('botScreen.confirmingClose', { title: this.screen.title }) : t('botScreen.publicNotice');
    if (this.notice.textContent !== notice) this.notice.textContent = notice;
    this.placeholderHint.textContent = t('botScreen.viewHint');
  }

  private outputVolume(): number {
    return voiceStore.isMiniappMuted(this.screen.botId) ? 0 : settingsStore.getMiniappVolume(this.screen.botId) / 100;
  }

  private syncVolume(): void {
    this.volumeControl.update(settingsStore.getMiniappVolume(this.screen.botId), voiceStore.isMiniappMuted(this.screen.botId));
    this.frame?.setVolume(this.outputVolume());
  }

  private setVolume(percent: number, timing: SaveTiming): void {
    try {
      settingsStore.setMiniappVolume(this.screen.botId, percent, timing);
    } catch (error: unknown) {
      // The new level still applies to this session; it just won't be remembered.
      console.warn('[Bot screens] Could not save the miniapp volume.', error);
    }
    this.syncVolume();
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

  private async end(): Promise<void> {
    if (this.endRequestId || this.confirming || !this.canRead()) return;
    if (!this.canEnd()) {
      this.error.textContent = t('botChat.commandsPermissionDenied');
      this.error.hidden = false;
      return;
    }
    // This person's open miniapp may ask its own question (e.g. to save) before ending for everyone.
    if (this.frame?.asksBeforeClose && (!await this.confirmClose('end') || this.endRequestId !== null || !this.canEnd())) return;
    const { session } = this.context;
    const ref = { id: this.screen.id, instanceId: this.screen.instanceId };
    if (session.botScreenStore.get(ref.id)?.instanceId !== ref.instanceId) return;
    const requestId = crypto.randomUUID();
    this.endRequestId = requestId;
    this.localize();
    try {
      const removed = botScreenRemovedSchema.parse(await session.client.sendRequest<unknown>(
        MessageType.BOT_SCREEN_END, ref, requestId,
      ));
      if (!this.canRead() || this.endRequestId !== requestId) return;
      if (removed.id !== ref.id || removed.instanceId !== ref.instanceId ||
          removed.channelId !== this.context.channelId || removed.reason !== 'ended') {
        throw new Error('The miniapp end response does not match the request.');
      }
      session.botScreenStore.remove(removed);
    } catch (error: unknown) {
      if (!this.canRead() || this.endRequestId !== requestId) return;
      this.error.textContent = botRequestError(error);
      this.error.hidden = false;
      appEvents.emit('voice.bot_screens_reload');
    } finally {
      if (this.endRequestId === requestId) {
        this.endRequestId = null;
        if (!this.destroyed) this.localize();
      }
    }
  }

  private async act(action: BotScreenAction): Promise<void> {
    const { session } = this.context;
    if (!this.frame || this.requestId || this.endRequestId || action.id !== this.screen.id ||
        action.instanceId !== this.screen.instanceId || !this.canRead()) return;
    if (!session.serverStore.hasPermission(Permission.USE_BOT_COMMANDS, this.context.channelId)) {
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
          screen.instanceId !== this.screen.instanceId || session.botScreenStore.get(screen.id)?.instanceId !== screen.instanceId ||
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
