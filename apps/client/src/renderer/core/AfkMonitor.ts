import { LIMITS, MessageType, type VoiceAfkPayload } from '@monky/shared';
import { appEvents } from './EventBus';
import { sessionManager } from './SessionManager';
import { clientLog } from './ClientLogService';
import { voiceStore } from '../stores/voiceStore';
import { afkChannelIdOf, isIdleInCall } from '../utils/voiceRooms';

const CHECK_INTERVAL_MS = 15_000;

/**
 * Reports an idle call to its server, which moves it to the AFK room
 * (`afk-channel`) and announces the move with ADMIN_MOVE_USER, which the call
 * follows like any other move. Idle means no keyboard or mouse input anywhere
 * in the system and no speech for the server's timeout, while neither
 * broadcasting nor watching a stream.
 */
export class AfkMonitor {
  private timer: number | null = null;
  private lastSpeechAt = Date.now();
  /** The call already reported, so an ignored report is not repeated until the member is active again. */
  private reported: string | null = null;
  private checking = false;
  private readonly unbind: Array<() => void> = [];

  start(): void {
    if (this.timer !== null) return;
    this.unbind.push(
      appEvents.on('voice.speaking_changed', (speaking: boolean) => {
        if (speaking) this.lastSpeechAt = Date.now();
      }),
      appEvents.on('voice.channel_changed', () => {
        this.lastSpeechAt = Date.now();
        this.reported = null;
      }),
    );
    this.timer = window.setInterval(() => void this.check(), CHECK_INTERVAL_MS);
  }

  dispose(): void {
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.unbind.splice(0).forEach((off) => off());
  }

  private async check(): Promise<void> {
    const key = voiceStore.voiceSessionKey;
    const channelId = voiceStore.currentVoiceChannelId;
    const session = key ? sessionManager.get(key) : undefined;
    const details = session?.serverStore.serverDetails;
    const afkChannelId = afkChannelIdOf(details);
    const readIdleSeconds = window.api?.getSystemIdleSeconds;
    if (this.checking || !session || !channelId || !afkChannelId || channelId === afkChannelId
      || session.client.getStatus() !== 'CONNECTED' || !readIdleSeconds) return;
    if (voiceStore.isSpeaking) this.lastSpeechAt = Date.now();
    this.checking = true;
    try {
      const idleSeconds = await readIdleSeconds();
      // The call may have moved or ended while the system was asked.
      if (voiceStore.voiceSessionKey !== key || voiceStore.currentVoiceChannelId !== channelId) return;
      const idle = isIdleInCall({
        idleSeconds,
        msSinceSpeech: Date.now() - this.lastSpeechAt,
        timeoutSeconds: details?.afkTimeoutSeconds ?? LIMITS.AFK_TIMEOUT_DEFAULT_SECONDS,
        broadcasting: voiceStore.isScreenSharing || voiceStore.isCameraOn,
        watching: voiceStore.isWatchingAnyScreenShare(),
      });
      const call = `${key}\n${channelId}`;
      if (!idle) {
        this.reported = null;
        return;
      }
      if (this.reported === call) return;
      this.reported = call;
      clientLog.info('CONNECTION', 'Idle in the call; asking the server for the AFK channel', { channelId, idleSeconds });
      session.client.send(MessageType.VOICE_AFK, { channelId } satisfies VoiceAfkPayload);
    } catch (error) {
      clientLog.warn('CONNECTION', 'Could not read the system idle time for the AFK channel', {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.checking = false;
    }
  }
}

export const afkMonitor = new AfkMonitor();
