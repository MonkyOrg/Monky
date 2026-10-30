import type { DesktopSource, NativeScreenCapabilities, NativeScreenCaptureKind } from '@monky/shared';
import { t } from '../../i18n';

/**
 * The rules of the screen share picker that need no screen: which capture methods the native runtime
 * offers, which sources a tab lists, and how the sound of a new share fits beside the live ones (#253).
 */

export const SOURCE_TABS = [
  { id: 'screen', label: 'screenShare.screensTab', icon: 'desktop_windows' },
  { id: 'window', label: 'screenShare.windowsTab', icon: 'web_asset' },
] as const;
export type SourceTab = typeof SOURCE_TABS[number]['id'];

export const WINDOW_CAPTURE_METHODS = [
  { id: 'window', label: 'screenShare.windowCapture', description: 'screenShare.windowCaptureDescription', icon: 'web_asset' },
  { id: 'game', label: 'screenShare.gameCapture', description: 'screenShare.gameCaptureDescription', icon: 'sports_esports' },
] as const;
export type WindowCaptureMethod = typeof WINDOW_CAPTURE_METHODS[number]['id'];

/** Why a share cannot carry sound beside the existing ones (#253). */
export type AudioBlock = 'system' | 'mac' | 'app';
export type AudioPlan =
  | { kind: 'free'; handedOver: string[] }
  | { kind: 'ask'; apps: string[]; handedOver: string[] }
  | { kind: 'blocked'; reason: AudioBlock };

/** The local shares as the audio rules see them. */
export interface LiveScreens {
  readonly shareIds: readonly string[];
  readonly audioShareIds: readonly string[];
  /** What a live share captures, when it is a native capture. */
  capture(shareId: string): { readonly captureKind?: NativeScreenCaptureKind; readonly desktopSourceId?: string } | null;
}

/** What decides whether native capture can take a selection, and how to explain it when it cannot. */
export interface CaptureContext {
  readonly capabilities: NativeScreenCapabilities | null;
  /** Capabilities and sources are still being read. */
  readonly loading: boolean;
  /** The selected window is one of Monky's own, whose sound would echo the call. */
  readonly ownWindow: boolean;
  /** Sound is still held by a share being set up. */
  readonly unownedAudio: boolean;
  /** The quality profile has a native screen rendition. */
  readonly profileAvailable: boolean;
}

export function isMacPlatform(): boolean {
  return typeof window !== 'undefined' && window.api?.platform === 'darwin';
}

/** macOS captures windows through ScreenCaptureKit only; Game Capture is a Windows hook. */
export function windowCaptureMethods(isMac: boolean): ReadonlyArray<typeof WINDOW_CAPTURE_METHODS[number]> {
  return WINDOW_CAPTURE_METHODS.filter(method => !isMac || method.id === 'window');
}

export function captureKindOf(tab: SourceTab, method: WindowCaptureMethod): NativeScreenCaptureKind {
  return tab === 'screen' ? 'monitor' : method;
}

export function supportsCaptureKind(capabilities: NativeScreenCapabilities | null, kind: NativeScreenCaptureKind): boolean {
  return !!capabilities && (capabilities.capture === true || capabilities.requiresSelectionProbe === true)
    && (capabilities.captureKinds ?? (capabilities.capture === true ? ['window'] : [])).includes(kind);
}

export function supportsTab(capabilities: NativeScreenCapabilities | null, tab: SourceTab): boolean {
  return tab === 'screen' ? supportsCaptureKind(capabilities, 'monitor')
    : supportsCaptureKind(capabilities, 'window') || supportsCaptureKind(capabilities, 'game');
}

export function sourceMatchesTab(source: DesktopSource, tab: SourceTab): boolean {
  const type = tab === 'screen' ? 'screen' : 'window';
  return source.type === type && source.id.startsWith(tab === 'screen' ? 'native-monitor:' : 'window:');
}

/** A share's audio is the whole system mix on a monitor, and on macOS for any source (#298). */
export function isSystemAudio(kind: NativeScreenCaptureKind | undefined, isMac: boolean): boolean {
  return isMac || kind === undefined || kind === 'monitor';
}

/** Audio held outside any live share: an association still being set up. */
export function hasUnownedAudio(live: LiveScreens): boolean {
  return live.audioShareIds.some(shareId => !live.shareIds.includes(shareId));
}

/**
 * How the audio of a new share fits the existing ones (#253): each application may share its own sound,
 * but a whole screen's sound is the entire system mix, so nothing else may carry sound beside it. The
 * shares being replaced hand their audio over.
 */
export function planAudio(request: {
  readonly mode: 'add' | 'replace';
  readonly targetShareId?: string;
  readonly kind: NativeScreenCaptureKind;
  readonly source: DesktopSource | undefined;
  /** The enumerated sources, to tell the processes of an application apart. */
  readonly sources: readonly DesktopSource[];
}, live: LiveScreens, isMac: boolean): AudioPlan {
  const retiring = request.mode === 'add' ? []
    : request.targetShareId !== undefined ? [request.targetShareId] : [...live.shareIds];
  const owners = live.audioShareIds.filter(shareId => live.shareIds.includes(shareId))
    .map(shareId => ({ shareId, system: isSystemAudio(live.capture(shareId)?.captureKind, isMac) }));
  const handedOver = owners.filter(owner => retiring.includes(owner.shareId)).map(owner => owner.shareId);
  const remaining = owners.filter(owner => !retiring.includes(owner.shareId));
  if (hasUnownedAudio(live) || remaining.some(owner => owner.system))
    return { kind: 'blocked', reason: isMac ? 'mac' : 'system' };
  if (isSystemAudio(request.kind, isMac) && remaining.length)
    return { kind: 'ask', apps: remaining.map(owner => owner.shareId), handedOver };
  if (sharesAppAudio(request.source, remaining.map(owner => owner.shareId), request.sources, live))
    return { kind: 'blocked', reason: 'app' };
  return { kind: 'free', handedOver };
}

/**
 * Windows captures an application's audio together with the processes it started: another window of
 * it, or a launcher and the game it opened, would share the same audio twice.
 */
function sharesAppAudio(source: DesktopSource | undefined, owners: readonly string[], sources: readonly DesktopSource[],
  live: LiveScreens): boolean {
  const processId = source?.processId;
  if (processId === undefined) return false;
  return owners.some(shareId => {
    const desktopSourceId = live.capture(shareId)?.desktopSourceId;
    const owner = sources.find(item => item.id === desktopSourceId);
    const ownerProcess = owner?.processId;
    if (ownerProcess === undefined) return false;
    return ownerProcess === processId || !!source?.processAncestry?.includes(ownerProcess)
      || !!owner?.processAncestry?.includes(processId);
  });
}

/** Whether native capture takes this source with the chosen audio. */
export function canCaptureNatively(sourceId: string | undefined, audio: boolean, kind: NativeScreenCaptureKind,
  context: CaptureContext): boolean {
  return !!sourceId?.startsWith(kind === 'monitor' ? 'native-monitor:' : 'window:')
    && supportsCaptureKind(context.capabilities, kind)
    && (!audio || !context.ownWindow)
    && (!audio || (context.capabilities?.captureAudio === true && !context.unownedAudio))
    && context.profileAvailable;
}

/** Why native capture cannot take the selection, in the app's language. */
export function captureUnavailableMessage(audio: boolean, kind: NativeScreenCaptureKind, context: CaptureContext): string {
  if (audio && context.ownWindow) return t('screenShare.ownWindowAudioUnavailable');
  const capabilities = context.capabilities;
  if (!capabilities && context.loading) return t('common.loading');
  if (!capabilities || (!capabilities.capture && capabilities.requiresSelectionProbe !== true)) {
    if (capabilities?.reason === 'encoder') return t('screenShare.nativeEncoderUnavailable');
    return t(capabilities?.reason === 'runtime' ? 'screenShare.nativeUnavailable' : 'screenShare.platformSoon');
  }
  if (!supportsCaptureKind(capabilities, kind)) {
    return t('screenShare.captureMethodUnavailable', {
      method: t(kind === 'monitor' ? 'screenShare.screensTab'
        : kind === 'window' ? 'screenShare.windowCapture' : 'screenShare.gameCapture'),
    });
  }
  if (audio && context.unownedAudio) return t('screenShare.audioAlreadySharing');
  if (audio && !capabilities.captureAudio) return t('screenShare.nativeAudioUnavailable');
  return t('screenShare.nativeProfileChangeBlocked');
}
