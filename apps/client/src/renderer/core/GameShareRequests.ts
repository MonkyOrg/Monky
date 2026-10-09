import {
  MessageType,
  ProtocolErrorCode,
  type GameShareAnsweredPayload,
  type GameShareRequestSentPayload,
  type GameShareRequestedPayload,
} from '@monky/shared';
import { appEvents } from './EventBus';
import { ProtocolRequestError } from './NetworkClient';
import { sessionManager } from './SessionManager';
import { currentEventOrigin } from './sessionRouting';
import { voiceStore } from '../stores/voiceStore';
import { settingsStore } from '../stores/settingsStore';
import { showInfoToast } from '../views/CopyToast';
import { GameSharePrompt } from '../views/GameSharePrompt';
import { screenSharePickerModal } from '../views/ScreenSharePickerModal';
import { t } from '../i18n';

function isRequested(value: unknown): value is GameShareRequestedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.shareRequestId === 'string' && typeof payload.nickname === 'string' &&
    typeof payload.gameName === 'string' && typeof payload.expiresInMs === 'number';
}

function shareRequestId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as Record<string, unknown>).shareRequestId;
  return typeof id === 'string' ? id : null;
}

interface OpenPrompt {
  prompt: GameSharePrompt;
  sessionKey: string;
  timer: ReturnType<typeof setTimeout>;
}

/** Both ends of "Pedir para ver a partida" (#763): asking, and being asked. */
export class GameShareRequests {
  private readonly prompts = new Map<string, OpenPrompt>();
  /** Asks this person made, to name the player when the answer comes back. */
  private readonly asked = new Map<string, string>();
  private readonly unbind: Array<() => void> = [];

  public start(): void {
    this.unbind.push(
      appEvents.on(`message.${MessageType.GAME_SHARE_REQUESTED}`, (payload: unknown) => this.onRequested(payload)),
      appEvents.on(`message.${MessageType.GAME_SHARE_CLOSED}`, (payload: unknown) => {
        const id = shareRequestId(payload);
        if (id) this.closePrompt(id);
      }),
      appEvents.on(`message.${MessageType.GAME_SHARE_ANSWERED}`, (payload: unknown) => this.onAnswered(payload)),
    );
  }

  public dispose(): void {
    for (const off of this.unbind.splice(0)) off();
    for (const id of [...this.prompts.keys()]) this.closePrompt(id);
    this.asked.clear();
  }

  /** Sent through the server hosting the call: that is where both people are. */
  public async ask(target: { id: string; nickname: string }): Promise<void> {
    const session = voiceStore.voiceSessionKey ? sessionManager.get(voiceStore.voiceSessionKey) : undefined;
    if (!session) {
      showInfoToast(t('gameShare.unavailable'), 5000);
      return;
    }
    try {
      const sent = await session.client.sendRequest<GameShareRequestSentPayload>(
        MessageType.GAME_SHARE_REQUEST, { targetUserId: target.id });
      this.asked.set(sent.shareRequestId, target.nickname);
      showInfoToast(t('gameShare.sent', { name: target.nickname }));
    } catch (error: unknown) {
      const limited = error instanceof ProtocolRequestError && error.code === ProtocolErrorCode.RATE_LIMITED;
      showInfoToast(t(limited ? 'gameShare.wait' : 'gameShare.unavailable'), 5000);
    }
  }

  private onAnswered(value: unknown): void {
    const id = shareRequestId(value);
    const name = id ? this.asked.get(id) : undefined;
    if (!id || name === undefined) return;
    this.asked.delete(id);
    const outcome = (value as GameShareAnsweredPayload).outcome;
    showInfoToast(outcome === 'accepted' ? t('gameShare.accepted', { name }) : t('gameShare.notAccepted'), 5000);
  }

  private onRequested(value: unknown): void {
    const sessionKey = currentEventOrigin();
    if (!isRequested(value) || !sessionKey || this.prompts.has(value.shareRequestId)) return;
    const id = value.shareRequestId;
    const prompt = new GameSharePrompt({
      nickname: value.nickname,
      gameName: value.gameName,
      onShare: (shareAudio) => void this.accept(id, shareAudio),
      onDecline: () => this.answer(id, false),
    });
    // The server closes it too; this only covers a connection that went quiet.
    const timer = setTimeout(() => this.closePrompt(id), value.expiresInMs);
    this.prompts.set(id, { prompt, sessionKey, timer });
    prompt.show();
  }

  private answer(id: string, accepted: boolean): void {
    const open = this.prompts.get(id);
    if (!open) return;
    this.closePrompt(id);
    const session = sessionManager.get(open.sessionKey);
    if (session?.client.getStatus() === 'CONNECTED') {
      session.client.send(MessageType.GAME_SHARE_RESPONSE, { shareRequestId: id, accepted });
    }
  }

  private async accept(id: string, shareAudio: boolean): Promise<void> {
    this.answer(id, true);
    await this.shareGame(shareAudio);
  }

  /**
   * The click on "Compartilhar" — on a request or on the sidebar suggestion —
   * is the explicit confirmation sharing already requires; nothing is captured
   * or hooked before it. Only the game's own windows are offered, and with
   * none found the person picks one by hand.
   */
  public async shareGame(shareAudio: boolean): Promise<void> {
    let sourceIds: string[] = [];
    try {
      sourceIds = await window.api?.findGameWindows?.() ?? [];
    } catch (error: unknown) {
      console.warn('[GameShare] Could not look up the game windows', error);
    }
    if (sourceIds.length === 0) {
      showInfoToast(t('gameShare.windowNotFound'), 6000);
      await screenSharePickerModal.open();
      return;
    }
    await screenSharePickerModal.openForGameRequest({
      sourceIds,
      shareAudio,
      captureKind: settingsStore.gameShareUseGameCapture ? 'game' : 'window',
    });
  }

  private closePrompt(id: string): void {
    const open = this.prompts.get(id);
    if (!open) return;
    this.prompts.delete(id);
    clearTimeout(open.timer);
    open.prompt.close();
  }
}

export const gameShareRequests = new GameShareRequests();
