import type { BotScreenCloseReason } from '@monky/shared';
import { appEvents } from '../core/EventBus';
import { t } from '../i18n';
import type { VoiceBotScreensUpdated } from '../stores/botScreenStore';
import { getBotVoiceContext, type BotVoiceContext } from '../utils/botVoice';
import { moveWithoutReload, offStageArea } from './BotScreenFrame';
import { BotScreenView } from './BotScreenView';
import { showInfoToast } from './CopyToast';

/** What the stage showing the call offers the miniapp tiles placed on it. */
export interface BotScreenStage {
  /** Opens a miniapp, or only focuses it when its view is already open. */
  open(id: string): void;
  toggleFocus(id: string): void;
  /** A filmstrip frame ignores the pointer, so a question from the miniapp must come into focus. */
  revealQuestion(id: string): void;
  /** Tiles were added or removed, or one of them changed state. */
  changed(): void;
}

const sameCall = (a: BotVoiceContext, b: BotVoiceContext | null): boolean =>
  !!b && a.session === b.session && a.channelId === b.channelId && a.user.sessionId === b.user.sessionId;

/**
 * Owns the miniapp tiles of the ongoing call, for as long as this connection stays in that room.
 * The stage only borrows them: while its person browses text channels, Home or other servers, the
 * tiles wait off stage, hidden but connected, still receiving state and sending actions. Leaving
 * or switching rooms, disconnecting or losing access is what closes them.
 */
export class BotScreenDock {
  private views = new Map<string, BotScreenView>();
  private context: BotVoiceContext | null = null;
  private stage: BotScreenStage | null = null;
  private host: HTMLElement | null = null;
  /** Where the stage last saw each tile: in view, or cut off by the layout. */
  private onScreen = new Map<BotScreenView, boolean>();
  private windowAway = false;
  private clearEndedNotice: (() => void) | null = null;
  private unbind: Array<() => void>;

  constructor() {
    const sync = (): void => this.sync();
    this.unbind = [
      appEvents.on<VoiceBotScreensUpdated | undefined>('voice.bot_screens_updated', (update) => this.screensUpdated(update)),
      // The same signals the room's miniapp list follows, wherever the person is looking.
      ...['voice.channel_changed', 'session.voice_context_updated', 'participants.updated', 'server.updated', 'server.roles_updated']
        .map((event) => appEvents.on(event, sync)),
    ];
    // The window keeps a "visible" page while minimized or in the tray, so main says when it is away.
    const away = window.api?.onWindowInactive?.(() => this.setWindowAway(true));
    const back = window.api?.onWindowActive?.(() => this.setWindowAway(false));
    this.unbind.push(() => {
      away?.();
      back?.();
    });
    this.sync();
  }

  /** The call these tiles belong to, if any. */
  get call(): BotVoiceContext | null { return this.context; }

  get(id: string): BotScreenView | undefined { return this.views.get(id); }

  isWatching(id: string): boolean { return this.views.get(id)?.isWatching ?? false; }

  /** Whether any of the call's miniapps is open, on stage or waiting off stage. */
  isWatchingAny(): boolean { return [...this.views.values()].some((view) => view.isWatching); }

  isDockedTo(stage: BotScreenStage): boolean { return this.stage === stage; }

  /** The tiles placed on this stage, in creation order. */
  viewsOn(stage: BotScreenStage): BotScreenView[] {
    return this.stage === stage ? [...this.views.values()] : [];
  }

  /** Open views waiting off stage while their person browses elsewhere. */
  parked(): BotScreenView[] {
    return this.stage ? [] : [...this.views.values()].filter((view) => view.isWatching);
  }

  /** Places the call's tiles on this stage. Open documents move without reloading. */
  dock(stage: BotScreenStage, host: HTMLElement): void {
    const moved = this.stage !== stage || this.host !== host;
    this.stage = stage;
    this.host = host;
    for (const view of this.views.values()) this.place(view);
    if (moved) appEvents.emit('stage.bot_screens_changed');
  }

  /** The stage is going away or showing something else: the tiles wait off stage, still open. */
  release(stage: BotScreenStage): void {
    if (this.stage !== stage) return;
    this.stage = null;
    this.host = null;
    for (const view of this.views.values()) this.place(view);
    appEvents.emit('stage.bot_screens_changed');
  }

  /** Where the stage sees a tile; the window being away hides every tile. */
  setOnScreen(view: BotScreenView, onScreen: boolean): void {
    if (this.views.get(view.snapshot.id) !== view) return;
    this.onScreen.set(view, onScreen);
    view.setStageVisible(this.isVisible(view));
  }

  dispose(): void {
    for (const off of this.unbind.splice(0)) off();
    this.stage = null;
    this.host = null;
    this.closeAll();
  }

  private isVisible(view: BotScreenView): boolean {
    return this.stage !== null && !this.windowAway && (this.onScreen.get(view) ?? false);
  }

  private setWindowAway(away: boolean): void {
    if (this.windowAway === away) return;
    this.windowAway = away;
    for (const view of this.views.values()) view.setStageVisible(this.isVisible(view));
  }

  private place(view: BotScreenView): void {
    // A stage replaced without releasing its tiles took their documents along; never write into it.
    if (this.host && !this.host.isConnected) {
      this.stage = null;
      this.host = null;
    }
    const parent = this.host ?? offStageArea('bot-screen-parking');
    const card = view.element;
    if (!this.host) {
      this.onScreen.delete(view);
      if (document.fullscreenElement && card.contains(document.fullscreenElement)) {
        void document.exitFullscreen().catch((error: unknown) => { console.warn('[Bot screens] Could not exit miniapp fullscreen.', error); });
      }
      view.park();
    }
    if (card.parentElement === parent) return;
    // A new tile has no document yet. An open one that lost its own, or cannot move without
    // reloading, closes: a reloaded page would run without its bridge and hooks.
    if (!card.isConnected || !moveWithoutReload(card, parent)) {
      if (view.isWatching) view.leave('revoked');
      parent.append(card);
    }
  }

  private sync(changed = false): void {
    const context = getBotVoiceContext();
    if (this.context && (!context || !sameCall(context, this.context))) this.closeAll();
    this.context = context;
    if (!context) {
      if (changed) this.notify();
      return;
    }
    const screens = context.session.botScreenStore.list(context.channelId);
    for (const [id, view] of this.views) {
      if (!screens.some((screen) => screen.id === id && screen.instanceId === view.snapshot.instanceId)) {
        // Gone from the room's current list (or replaced by a new instance) while access remained.
        this.remove(view, 'ended');
        changed = true;
      }
    }
    for (const screen of screens) {
      const view = this.views.get(screen.id);
      if (view) {
        if (view.snapshot !== screen) view.update(screen);
        continue;
      }
      const created = new BotScreenView(screen, context,
        () => this.stage?.open(screen.id),
        () => this.leave(screen.id),
        () => this.stage?.toggleFocus(screen.id),
        () => this.stage?.revealQuestion(screen.id));
      this.views.set(screen.id, created);
      this.place(created);
      changed = true;
    }
    if (changed) this.notify();
  }

  /** The server's reason reaches the miniapp's onClose; a later sync would only know it vanished. */
  private screensUpdated(update: VoiceBotScreensUpdated | undefined): void {
    const removed = update?.removed;
    const context = getBotVoiceContext();
    const view = removed ? this.views.get(removed.id) : undefined;
    let changed = false;
    if (removed && view && context && sameCall(context, this.context) && update?.key === context.session.key &&
        removed.channelId === context.channelId && view.snapshot.instanceId === removed.instanceId) {
      // Someone else ended a view this person had open, here or in the background.
      if (removed.reason === 'ended' && view.isWatching && !view.isEnding) {
        this.clearEndedNotice?.();
        this.clearEndedNotice = showInfoToast(t('botScreen.endedNotice', { title: view.snapshot.title }));
      }
      this.remove(view, view.closeReasonFor(removed));
      changed = true;
    }
    this.sync(changed);
  }

  /** **Leave miniapp**, once its onBeforeClose agreed: only this person's view closes. */
  private leave(id: string): void {
    const view = this.views.get(id);
    if (!view?.isWatching) return;
    this.context?.session.botScreenStore.setInvitationDismissed(id, true);
    view.leave('leave');
    this.notify();
  }

  private remove(view: BotScreenView, reason: BotScreenCloseReason): void {
    view.destroy(reason);
    this.views.delete(view.snapshot.id);
    this.onScreen.delete(view);
  }

  private closeAll(): void {
    this.clearEndedNotice?.();
    this.clearEndedNotice = null;
    this.context = null;
    if (!this.views.size) return;
    for (const view of [...this.views.values()]) this.remove(view, 'revoked');
    this.notify();
  }

  private notify(): void {
    this.stage?.changed();
    appEvents.emit('stage.bot_screens_changed');
  }
}
