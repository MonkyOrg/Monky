import {
  MessageType,
  type AdminKickVoicePayload,
  type AdminMoveUserPayload,
  type AuthSuccessPayload,
  type VoiceRestrictions,
  type VoiceRestrictionsUpdatedPayload,
  type VoiceStateChangedPayload,
  type VoiceUserJoinedPayload,
  type VoiceUserLeftPayload,
} from '@monky/shared';
import { appEvents } from './EventBus';
import { callClient, eventOwnsCall } from './callScope';
import { clientLog } from './ClientLogService';
import { networkClient, type ConnectionStatus } from './NetworkClient';
import { participantManager } from './ParticipantManager';
import { applyLocalAudioState } from './localAudioState';
import { leaveCurrentCall, rejoinCallOnSession, suspendCallForNetworkLoss } from './serverConnection';
import { stopLocalScreenShares } from './screenShareControls';
import { currentEventOrigin, emitOutsideRouting, isForegroundEvent } from './sessionRouting';
import { soundEffects } from './SoundEffects';
import { videoService } from './VideoService';
import { updateLocalSpeaking } from './voiceControls';
import type { VoiceModeReconnect } from './VoiceModeReconnect';
import { webRtcManager } from './WebRtcManager';
import { serverStore } from '../stores/serverStore';
import { voiceStore } from '../stores/voiceStore';
import { afkChannelIdOf } from '../utils/voiceRooms';
import { showInfoToast } from '../views/CopyToast';
import { t } from '../i18n';

export interface VoiceEventsHost {
  /** The voice mode reconnection owns a departure it caused itself (#515). */
  readonly reconnect: Pick<VoiceModeReconnect, 'departed'>;
  /** Redraws the server on screen, whose call just ended. */
  render(): void;
  /** Follows a move of the call on screen, showing the destination's stage. */
  rejoinOnScreen(channelId: string, moveId?: string): void;
}

/** Brings the microphone, the output and the published tracks in line with the call's moderation. */
function syncLocalVoiceMedia(): void {
  applyLocalAudioState();
  void webRtcManager.syncMicrophonePublication().catch((error: unknown) => {
    clientLog.warn('AUDIO', 'Could not publish the microphone after Speak was allowed', { error: String(error) });
  });
  if (voiceStore.permissionMuted && voiceStore.currentVoiceChannelId && voiceStore.isScreenSharing) {
    callClient().send(MessageType.VOICE_STATE_UPDATE, webRtcManager.getLocalScreenState());
  }
}

/** What the call's server imposes on this member, applied to the store and the media at once. */
function applyCallModeration(restrictions: VoiceRestrictions): void {
  voiceStore.applyModeration({
    serverMuted: restrictions.serverMuted,
    serverDeafened: restrictions.serverDeafened,
    permissionMuted: !!restrictions.permissionMuted,
  });
  syncLocalVoiceMedia();
}

/** The call as a new sign-in found it. */
export interface CallBeforeSignIn {
  /** The signed-in server hosts the call, or there is none. */
  readonly ownsCall: boolean;
  /** The room to return to after an automatic reconnection; null on a fresh connection. */
  readonly channelId: string | null;
}

export function callBeforeSignIn(origin: string | null): CallBeforeSignIn {
  // Voice is a single physical resource shared by every session (#400), so
  // only the connection actually hosting the call may touch it. Without
  // this, connecting to a second server would tear down an ongoing call.
  const ownsCall = !voiceStore.voiceSessionKey || voiceStore.voiceSessionKey === origin;
  return { ownsCall, channelId: ownsCall ? voiceStore.currentVoiceChannelId : null };
}

/**
 * Hands a fresh sign-in to the media stack. A room the server still remembers
 * but the user is no longer in is let go; the server hosting the call gives
 * it its moderation, its relay and the new session.
 */
export function adoptCallAfterSignIn(payload: AuthSuccessPayload, call: CallBeforeSignIn): void {
  const myVoiceState = payload.currentUser.sessionId
    ? payload.server.voiceStates[payload.currentUser.sessionId]
    : undefined;
  if (myVoiceState && (!call.ownsCall || !call.channelId)) {
    // A half-open server socket may still remember the room the user left
    // while offline. Authentication must not restore that abandoned call.
    networkClient.send(MessageType.VOICE_LEAVE, { channelId: myVoiceState.channelId });
    participantManager.removeVoiceState(myVoiceState.sessionId);
  }
  if (!call.ownsCall) return;
  const resumingChannel = myVoiceState?.channelId === call.channelId;
  applyCallModeration({
    serverMuted: resumingChannel && !!myVoiceState?.serverMuted,
    serverDeafened: resumingChannel && !!myVoiceState?.serverDeafened,
    permissionMuted: resumingChannel && !!myVoiceState?.permissionMuted,
  });
  webRtcManager.setCurrentSessionId(payload.currentUser.sessionId || payload.currentUser.id);
  // Adopt the relay this server offers before any peer connection is
  // opened, so calls started right after login can already use it (#425).
  webRtcManager.setIceServers(payload.iceServers);
  // Drop any stale peer connections left over from a dropped session.
  webRtcManager.closeAllPeers();
}

/** Returns to the room an automatic reconnection interrupted, or ends the call if that room is gone. */
export function resumeCallAfterSignIn(
  payload: AuthSuccessPayload,
  call: CallBeforeSignIn,
  origin: string | null,
  rejoinOnScreen: (channelId: string) => void,
): void {
  const channelId = call.channelId;
  if (!channelId) return;
  if (payload.server.channels.some((channel) => channel.id === channelId && channel.type === 'VOICE')) {
    // A background server that reconnected has to rejoin through its own
    // session: the view-driven path would migrate the call here (#400).
    if (isForegroundEvent()) rejoinOnScreen(channelId);
    else if (origin) void rejoinCallOnSession(origin, channelId);
    return;
  }
  leaveCurrentCall(false);
  clientLog.warn('CONNECTION', 'Voice channel is no longer available after reconnection', { channelId });
  emitOutsideRouting(() => appEvents.emit('voice.rejoin_failed', { error: t('voiceReconnect.unavailable') }));
}

/**
 * Voice traffic of every connected server and the local media around the call.
 * Only the server hosting the call touches the microphone and the peers (#400).
 */
export function bindVoiceEvents(host: VoiceEventsHost): () => void {
  const unbind = [
    appEvents.on('network.status', (status: ConnectionStatus) => {
      if (status !== 'RECONNECTING') return;
      const origin = currentEventOrigin();
      if (origin) suspendCallForNetworkLoss(origin);
    }),

    appEvents.on(`message.${MessageType.VOICE_USER_JOINED}`, (payload: VoiceUserJoinedPayload) => {
      if (serverStore.isMySession(payload.sessionId) && eventOwnsCall()
        && voiceStore.currentVoiceChannelId === payload.channelId) {
        applyCallModeration(payload.voiceState);
      }
      if (payload.user) participantManager.addUser(payload.user);
      if (payload.participants) {
        participantManager.reconcileVoiceChannel(payload.channelId, payload.participants);
        if (eventOwnsCall() && voiceStore.currentVoiceChannelId === payload.channelId && !webRtcManager.isSfuMode()) {
          for (const { voiceState } of payload.participants) {
            if (!serverStore.isMySession(voiceState.sessionId)) {
              void webRtcManager.connectToPeer(voiceState.sessionId, true);
            }
          }
        }
      }
      // Read before the state is overwritten: an admin move announces the
      // arrival once itself and once more when the moved client re-joins, so
      // the room would hear the join sound twice (#500). A repeated
      // announcement for a session already listed in this channel is that
      // second copy — the mesh still reconnects, only the cue is skipped.
      const alreadyInChannel =
        participantManager.get(payload.sessionId)?.voiceState?.channelId === payload.channelId;

      participantManager.updateVoiceState(payload.voiceState);

      if (eventOwnsCall()) webRtcManager.reconcileScreenSources();
      // Someone else joined the room of our call: connect the P2P mesh to them.
      if (eventOwnsCall() && voiceStore.currentVoiceChannelId === payload.channelId
        && !serverStore.isMySession(payload.sessionId)) {
        webRtcManager.connectToPeer(payload.sessionId, false);
        // Let everyone already in the channel hear that someone joined (#54).
        // App cues ignore deafen, which only silences voices and the soundboard.
        if (!alreadyInChannel) soundEffects.play('join_voice');
      }
    }),

    appEvents.on(`message.${MessageType.VOICE_USER_LEFT}`, (payload: VoiceUserLeftPayload) => {
      const isMySession = serverStore.isMySession(payload.sessionId);
      const origin = currentEventOrigin();
      // A delayed acknowledgement belongs to the local leave, never a newer admission.
      if (isMySession && networkClient.isLocalVoiceLeaveAcknowledgement(payload)) {
        if (participantManager.get(payload.sessionId)?.voiceState?.channelId === payload.channelId
          && !(eventOwnsCall() && voiceStore.currentVoiceChannelId === payload.channelId)) {
          participantManager.removeVoiceState(payload.sessionId);
        }
        return;
      }
      if (isMySession && origin) {
        const transition = host.reconnect.departed(origin, payload);
        if (transition) {
          if (transition === 'reconnect') participantManager.removeVoiceState(payload.sessionId);
          return;
        }
      }
      if (eventOwnsCall()) {
        if (isMySession && voiceStore.currentVoiceChannelId === payload.channelId) {
          leaveCurrentCall(false);
          if (isForegroundEvent()) host.render();
        } else {
          if (voiceStore.currentVoiceChannelId === payload.channelId) soundEffects.play('leave_voice');
          webRtcManager.removePeer(payload.sessionId);
        }
      }
      participantManager.removeVoiceState(payload.sessionId);
    }),

    appEvents.on(`message.${MessageType.VOICE_STATE_CHANGED}`, (payload: VoiceStateChangedPayload) => {
      const previousVoiceState = participantManager.get(payload.voiceState.sessionId)?.voiceState;
      const isRemoteUser = !serverStore.isMySession(payload.voiceState.sessionId);
      const isSameVoiceChannel = eventOwnsCall() && voiceStore.currentVoiceChannelId === payload.voiceState.channelId;

      if (isRemoteUser && isSameVoiceChannel) {
        if (previousVoiceState?.isScreenSharing === false && payload.voiceState.isScreenSharing === true) {
          soundEffects.play('screen_share_start');
        } else if (previousVoiceState?.isScreenSharing === true && payload.voiceState.isScreenSharing === false) {
          soundEffects.play('screen_share_stop');
        }
      }

      participantManager.updateVoiceState(payload.voiceState);
      if (eventOwnsCall()) webRtcManager.reconcileScreenSources();
      if (isRemoteUser && isSameVoiceChannel && (
        previousVoiceState?.receivesVoice !== payload.voiceState.receivesVoice ||
        previousVoiceState?.isDeafened !== payload.voiceState.isDeafened ||
        previousVoiceState?.serverDeafened !== payload.voiceState.serverDeafened
      )) webRtcManager.syncBotVoiceReception(payload.voiceState.sessionId);
      if (serverStore.isMySession(payload.voiceState.sessionId) && eventOwnsCall()
        && voiceStore.currentVoiceChannelId === payload.voiceState.channelId) {
        applyCallModeration(payload.voiceState);
      }
    }),

    appEvents.on(`message.${MessageType.VOICE_RESTRICTIONS_UPDATED}`, (payload: VoiceRestrictionsUpdatedPayload) => {
      serverStore.updateVoiceRestrictions(payload.userId, payload);
    }),

    // Being kicked is still leaving the call, by the same path as hanging up:
    // the admission in flight is cancelled, our own row leaves the room at
    // once and the leave cue plays, as on any other ending (#533).
    appEvents.on(`message.${MessageType.ADMIN_KICK_VOICE}`, (payload: AdminKickVoicePayload) => {
      if (!serverStore.isMySession(payload.targetSessionId) || !eventOwnsCall()) return;
      leaveCurrentCall(false);
      if (isForegroundEvent()) host.render();
    }),

    appEvents.on(`message.${MessageType.ADMIN_MOVE_USER}`, (payload: AdminMoveUserPayload) => {
      // Being moved only makes sense on the server hosting the call; obeying it
      // elsewhere would silently drag the call to another server (#400).
      if (!serverStore.isMySession(payload.targetSessionId) || !eventOwnsCall()) return;
      // The server muted the microphone in there; say why before the call follows.
      if (payload.channelId === afkChannelIdOf(serverStore.serverDetails)) showInfoToast(t('afk.movedToast'), 8000);
      if (isForegroundEvent()) {
        host.rejoinOnScreen(payload.channelId, payload.moveId);
      } else {
        const origin = currentEventOrigin();
        if (origin) void rejoinCallOnSession(origin, payload.channelId, undefined, payload.moveId);
      }
    }),

    // Local VAD speaking state
    appEvents.on('local.speaking', updateLocalSpeaking),

    // Screen-share start/stop sound cue (picker, quick-stop and source-ended).
    appEvents.on('local.screen_started', () => soundEffects.play('screen_share_start')),
    appEvents.on('local.screen_stopped', () => soundEffects.play('screen_share_stop')),

    // The shared window/app was closed (or the OS "stop sharing" button was
    // used): finish tearing down that one screen share so peers stop seeing a
    // frozen frame and the local controls return to the idle state (#159, #253).
    appEvents.on('local.screen_ended_externally', (shareId: string) => {
      if (!voiceStore.screenShareIds.includes(shareId) && !videoService.getScreenStream(shareId)) return;
      void stopLocalScreenShares({ shareIds: [shareId] }).catch((error: unknown) => {
        clientLog.error('SCREEN_SHARE', 'Failed to stop an ended screen share', { shareId, error: String(error) });
      });
    }),

    // The SFU link dropped and is being rebuilt. Instead of a blocking modal,
    // this surfaces in the sidebar voice indicator (yellow) plus a recurring
    // audio cue, and clears itself once media flows again (#553).
    appEvents.on('sfu.reconnecting', () => voiceStore.setReconnecting(true)),
    appEvents.on('sfu.reconnected', () => voiceStore.setReconnecting(false)),

    // Drives the recurring reconnection cue for the whole attempt, stopping as
    // soon as the call recovers or the user leaves the channel (#553).
    appEvents.on('voice.reconnecting_changed', (reconnecting: boolean) => {
      if (reconnecting) soundEffects.startReconnectingLoop();
      else soundEffects.stopReconnectingLoop();
    }),
  ];
  return () => unbind.forEach(off => off());
}
