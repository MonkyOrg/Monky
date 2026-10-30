import * as screenAudio from '@monky/screen-audio';

/**
 * What a source's audio capture contains (#253). A monitor captures the whole system mix, and so does
 * every source on macOS, where ScreenCaptureKit cannot isolate one application; a window captures its
 * application's process tree, known once the selected window is resolved.
 */
export type AudioScope = { system: boolean; processId: number | null };

interface AudibleCall {
  readonly sources: ReadonlyMap<string, { readonly source: { readonly audio: boolean }; readonly audioScope: AudioScope | null }>;
  readonly sourceSelections: ReadonlyMap<string, { readonly audioScope: AudioScope | null }>;
}

/** Audio already captured or reserved in any call, except by the sources a new one supersedes. */
export function audioScopes(calls: Iterable<AudibleCall>, superseded: ReadonlySet<object>): AudioScope[] {
  return [...calls].flatMap(call => [
    ...[...call.sources.values()].filter(entry => entry.source.audio && !superseded.has(entry))
      .map(entry => entry.audioScope ?? { system: true, processId: null }),
    ...[...call.sourceSelections.values()].flatMap(entry => entry.audioScope ? [entry.audioScope] : []),
  ]);
}

/**
 * Whether an application's audio overlaps audio already shared. Windows captures each application
 * together with the processes it started, so another window of it, or a launcher and the game it
 * opened, would share the same audio twice (#253).
 */
export function sharesApplicationAudio(processId: number, shared: readonly number[]): boolean {
  if (shared.includes(processId)) return true;
  if (!shared.length || process.platform !== 'win32') return false;
  try {
    const [own, ...others] = screenAudio.getProcessAncestry([processId, ...shared]);
    return shared.some((other, index) => !!own?.includes(other) || !!others[index]?.includes(processId));
  } catch (error) {
    // Without a process snapshot, distinct processes are treated as unrelated instead of blocking the share.
    console.warn('[NativeScreen] Could not compare the shared applications\' process trees:', error);
    return false;
  }
}
