import type { CommandLine } from 'electron';

export function configureVideoPresentation(
  commandLine: Pick<CommandLine, 'appendSwitch' | 'removeSwitch'>,
  platform: NodeJS.Platform,
): void {
  if (platform !== 'win32') return;

  // Native reception plus capture can stall DWM through video-overlay promotion.
  // Keep GPU rendering/codecs; the underscored name is a Chromium driver workaround.
  commandLine.removeSwitch('enable-direct-composition-video-overlays');
  commandLine.appendSwitch('disable_direct_composition_video_overlays', '1');
}
