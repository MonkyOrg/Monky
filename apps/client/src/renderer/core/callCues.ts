import { appEvents } from './EventBus';
import { soundEffects } from './SoundEffects';

/**
 * The join and leave cues of the local call, in one place so that every way
 * of entering, changing or losing a call is heard — a click, an admin move,
 * the AFK room, a voice kick, a server restart or a dropped connection.
 *
 * Each path used to play its own cue, and the ones that forgot stayed silent:
 * a server restarting for an update drops the socket, the client re-admits
 * the call on its own and nothing was heard at all. Here the cue follows what
 * the user was last told: a join is announced once per room, and a leave only
 * after a join, so a refused admission or a second teardown makes no sound.
 * Like every app cue they play while deafened, which only silences voices and
 * the soundboard.
 */
let announcedCall: string | null = null;

/** Admission into a room the user was not already announced in. */
export function announceCallJoined(sessionKey: string, channelId: string): void {
  const call = `${sessionKey}\n${channelId}`;
  if (announcedCall === call) return;
  announcedCall = call;
  soundEffects.play('join_voice');
}

/**
 * The announced call is gone, or suspended until the server admits it again
 * (signalling lost). The join cue then marks the way back.
 */
export function announceCallLeft(): void {
  if (announcedCall === null) return;
  announcedCall = null;
  soundEffects.play('leave_voice');
}

appEvents.on('voice.call_ended', () => announceCallLeft());
