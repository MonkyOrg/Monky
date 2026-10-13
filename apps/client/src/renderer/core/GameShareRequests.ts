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
import { showErrorToast, showInfoToast } from '../views/CopyToast';
import { t } from '../i18n';

function isRequested(value: unknown): value is GameShareRequestedPayload {
  if (typeof value !== 'object' || value === null) return false;
  const payload = value as Record<string, unknown>;
  return typeof payload.shareRequestId === 'string' && typeof payload.fromUserId === 'string' &&
    typeof payload.nickname === 'string' && typeof payload.gameName === 'string' &&
    typeof payload.expiresInMs === 'number';
}

function shareRequestId(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const id = (value as Record<string, unknown>).shareRequestId;
  return typeof id === 'string' ? id : null;
}

/** A request someone in the call made to watch this person's game. */
export interface PendingGameShareRequest {
  id: string;
  nickname: string;
  /** Epoch ms when the server gives up on it; drives the strip's timer. */
  expiresAt: number;
  durationMs: number;
}

interface OpenRequest extends PendingGameShareRequest {
  sessionKey: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Both ends of "Pedir para ver a partida" (#763): asking, and being asked. The
 * asked side only keeps the queue; the game strip shows the newest request and
 * answers through here. Changes go out as `game_share.request_changed`.
 */
export class GameShareRequests {
  private readonly open = new Map<string, OpenRequest>();
  /** Asks this person made, to name the player when the answer comes back. */
  private readonly asked = new Map<string, string>();
  private readonly unbind: Array<() => void> = [];

  public start(): void {
    this.unbind.push(
      appEvents.on(`message.${MessageType.GAME_SHARE_REQUESTED}`, (payload: unknown) => this.onRequested(payload)),
      appEvents.on(`message.${MessageType.GAME_SHARE_CLOSED}`, (payload: unknown) => {
        const id = shareRequestId(payload);
        if (id) this.close(id);
      }),
      appEvents.on(`message.${MessageType.GAME_SHARE_ANSWERED}`, (payload: unknown) => this.onAnswered(payload)),
    );
  }

  public dispose(): void {
    for (const off of this.unbind.splice(0)) off();
    for (const id of [...this.open.keys()]) this.close(id);
    this.asked.clear();
  }

  /** The newest request still waiting for an answer, if any. */
  public current(): PendingGameShareRequest | null {
    let newest: OpenRequest | null = null;
    for (const request of this.open.values()) newest = request;
    return newest && { id: newest.id, nickname: newest.nickname, expiresAt: newest.expiresAt, durationMs: newest.durationMs };
  }

  /** Sent through the server hosting the call: that is where both people are. */
  public async ask(target: { id: string; nickname: string }): Promise<void> {
    const session = voiceStore.voiceSessionKey ? sessionManager.get(voiceStore.voiceSessionKey) : undefined;
    if (!session) {
      showErrorToast(t('gameShare.unavailable'));
      return;
    }
    try {
      const sent = await session.client.sendRequest<GameShareRequestSentPayload>(
        MessageType.GAME_SHARE_REQUEST, { targetUserId: target.id });
      this.asked.set(sent.shareRequestId, target.nickname);
      showInfoToast(t('gameShare.sent', { name: target.nickname }));
    } catch (error: unknown) {
      const limited = error instanceof ProtocolRequestError && error.code === ProtocolErrorCode.RATE_LIMITED;
      if (limited) showInfoToast(t('gameShare.wait'), 5000);
      else showErrorToast(t('gameShare.unavailable'));
    }
  }

  /** The player's answer; the request leaves the strip either way. */
  public answer(id: string, accepted: boolean): void {
    const request = this.open.get(id);
    if (!request) return;
    this.close(id);
    const session = sessionManager.get(request.sessionKey);
    if (session?.client.getStatus() === 'CONNECTED') {
      session.client.send(MessageType.GAME_SHARE_RESPONSE, { shareRequestId: id, accepted });
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
    if (!isRequested(value) || !sessionKey || this.open.has(value.shareRequestId)) return;
    const id = value.shareRequestId;
    // The server closes it too; this only covers a connection that went quiet.
    const timer = setTimeout(() => this.close(id), value.expiresInMs);
    this.open.set(id, {
      id, sessionKey, timer, nickname: value.nickname,
      expiresAt: Date.now() + value.expiresInMs, durationMs: value.expiresInMs,
    });
    appEvents.emit('game_share.request_changed');
  }

  private close(id: string): void {
    const request = this.open.get(id);
    if (!request) return;
    this.open.delete(id);
    clearTimeout(request.timer);
    appEvents.emit('game_share.request_changed');
  }
}

export const gameShareRequests = new GameShareRequests();
