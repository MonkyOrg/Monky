import type { NativeScreenCaptureKind, ScreenShareAudience } from '@monky/shared';
import { voiceStore } from '../stores/voiceStore';
import { ScreenShareUserError } from '../utils/screenShareFailure';
import {
  discardUnpublishedScreen, notifyScreenShareState, stopLocalScreenShares, type ScreenShareCall,
} from './screenShareControls';
import { videoService } from './VideoService';
import { webRtcManager } from './WebRtcManager';

/** The sound of a new share: who hands theirs over directly, and which applications are asked to (#253). */
export interface ScreenAudioHandover {
  /** Shares being replaced: their sound moves to the new capture. */
  readonly handedOver: readonly string[];
  /** Applications sharing their own sound, which a whole screen's would duplicate; the person decides. */
  readonly askTakeover: readonly string[];
}

/** A selection confirmed in the picker. */
export interface ScreenShareStart {
  readonly mode: 'add' | 'replace';
  /** With several live shares, the one a switch replaces; without it a switch replaces every share. */
  readonly targetShareId?: string;
  readonly sourceId: string;
  readonly label: string;
  readonly captureKind: NativeScreenCaptureKind;
  readonly audio: boolean;
  readonly audioHandover: ScreenAudioHandover | null;
  /** On macOS a window's sound is still the whole computer's (#298). */
  readonly macSystemMix: boolean;
  readonly preserveAspectRatio: boolean;
  readonly audience?: ScreenShareAudience;
}

/** What the picker answers while its selection starts. */
export interface ScreenShareStartSteps {
  readonly call: ScreenShareCall;
  /** The picker is still open: closing it cancels the start. */
  readonly isOpen: () => boolean;
  /** The picker still shows this selection: Main captures only what is still selected. */
  readonly isSelected: () => boolean;
  readonly confirmExtraScreen: () => Promise<boolean>;
  readonly confirmAudioTakeover: (shareIds: readonly string[]) => Promise<boolean>;
  readonly confirmMacSystemAudio: () => Promise<boolean>;
  /** Why native capture cannot take the selection with this audio, or null when it can. */
  readonly captureBlocked: (audio: boolean) => string | null;
}

const cancelled = (): DOMException => new DOMException('Screen share was cancelled', 'AbortError');

/**
 * Starts a screen share. 'replace' swaps the current source (#264), only `targetShareId` when given; 'add'
 * broadcasts another screen beside the live ones (#253). Every question comes before anything is captured or
 * replaced, and the shares being replaced give their sound to the new capture. Resolves 'declined' when the
 * person said no, and rejects with an AbortError once the picker closed or the call changed; a capture that
 * never went on air is retired either way.
 */
export async function startScreenShare(start: ScreenShareStart, steps: ScreenShareStartSteps): Promise<'published' | 'declined'> {
  const { call } = steps;
  let stream: MediaStream | null = null;
  let published = false;
  let retiringPrevious = false;
  const assertCurrent = (): void => {
    if (!steps.isOpen() || !call.isCurrent() || (stream && videoService.getScreenStream(stream.id) !== stream)) throw cancelled();
  };
  try {
    if (start.mode === 'add' && !await steps.confirmExtraScreen()) return 'declined';
    assertCurrent();
    let shareAudio = start.audio;
    // Shares whose audio this one takes over, and those that keep running without it.
    let audioOwners = [...start.audioHandover?.handedOver ?? []];
    let withdrawn: readonly string[] = [];
    const askTakeover = start.audioHandover?.askTakeover ?? [];
    if (askTakeover.length) {
      if (await steps.confirmAudioTakeover(askTakeover)) {
        withdrawn = askTakeover;
        audioOwners = [...audioOwners, ...askTakeover];
      } else {
        shareAudio = false;
        audioOwners = [];
      }
      assertCurrent();
    }
    // ScreenCaptureKit captures the entire system mix even for one window.
    // Confirm before capturing or replacing anything (#298).
    if (start.macSystemMix && shareAudio && !await steps.confirmMacSystemAudio()) return 'declined';
    assertCurrent();
    await window.api.cancelDesktopSourcePreviews?.();
    assertCurrent();
    const blocked = steps.captureBlocked(shareAudio);
    if (blocked !== null) throw new ScreenShareUserError(blocked);
    // Prepare the selection before retiring existing shares. Audible replacements defer preview
    // until the previous PCM owners give their audio up.
    const previousShareIds = start.mode !== 'replace' ? []
      : start.targetShareId !== undefined ? [start.targetShareId] : [...voiceStore.screenShareIds];
    const retirePrevious = async (): Promise<void> => {
      assertCurrent();
      retiringPrevious = true;
      await stopLocalScreenShares({ shareIds: previousShareIds, notify: false });
      assertCurrent();
    };
    const handOverAudio = async (): Promise<void> => {
      if (previousShareIds.length > 0) await retirePrevious();
      for (const shareId of withdrawn) {
        assertCurrent();
        await webRtcManager.withdrawScreenAudio(shareId);
      }
      assertCurrent();
    };
    // A minimized window draws nothing: it is restored before its capture starts.
    const restored = start.captureKind !== 'monitor' && await window.api.prepareScreenShareWindow(start.sourceId);
    if (restored) await new Promise(resolve => setTimeout(resolve, 350));
    assertCurrent();
    stream = await webRtcManager.startNativeScreenShare(start.sourceId, shareAudio,
      () => steps.isOpen() && call.isCurrent() && steps.isSelected(),
      start.captureKind, start.preserveAspectRatio,
      shareAudio && audioOwners.length > 0 ? {
        shareIds: audioOwners.filter(shareId => !!videoService.getNativeScreenCapture(shareId)),
        retirePrevious: handOverAudio,
      } : undefined, start.audience);
    assertCurrent();
    videoService.setScreenShareLabel(stream.id, start.label);
    if (previousShareIds.length > 0 && !retiringPrevious) await retirePrevious();
    assertCurrent();
    if (shareAudio) {
      voiceStore.addScreenAudioShare(stream.id);
      assertCurrent();
    }
    voiceStore.addScreenShare(stream.id);
    // Camera and screen are independent (#26) — do not disturb camera state.
    notifyScreenShareState(call);
    published = true;
    return 'published';
  } catch (error) {
    if (retiringPrevious && !published) notifyScreenShareState(call);
    if (stream && !published) await discardUnpublishedScreen(call, stream);
    throw error;
  }
}
