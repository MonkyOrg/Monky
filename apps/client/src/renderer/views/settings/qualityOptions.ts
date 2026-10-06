/**
 * Catalogues of common values offered by the custom quality profile (#476).
 *
 * The custom preset used to be four naked number boxes, which meant the user
 * had to already know which resolutions, frame rates and bitrates make sense.
 * These lists go from the cheapest to the most demanding option, and every
 * dropdown still keeps an escape hatch back to a free-form number.
 */

export interface ResolutionOption {
  width: number;
  height: number;
  /** Short name shown next to the numbers, e.g. "Full HD". */
  tag?: string;
}

export interface AspectRatioGroup {
  id: string;
  label: string;
  resolutions: ResolutionOption[];
}

/** Marks the "custom" entry of every dropdown. */
export const CUSTOM_OPTION = '__custom__';

export const ASPECT_RATIO_GROUPS: AspectRatioGroup[] = [
  {
    id: '16:9',
    label: '16:9',
    resolutions: [
      { width: 426, height: 240 },
      { width: 640, height: 360, tag: 'nHD' },
      { width: 854, height: 480, tag: 'FWVGA' },
      { width: 1280, height: 720, tag: 'HD' },
      { width: 1600, height: 900, tag: 'HD+' },
      { width: 1920, height: 1080, tag: 'Full HD' },
      { width: 2560, height: 1440, tag: 'QHD' },
      { width: 3840, height: 2160, tag: '4K' },
    ],
  },
  {
    id: '16:10',
    label: '16:10',
    resolutions: [
      { width: 640, height: 400 },
      { width: 1280, height: 800, tag: 'WXGA' },
      { width: 1440, height: 900, tag: 'WXGA+' },
      { width: 1680, height: 1050, tag: 'WSXGA+' },
      { width: 1920, height: 1200, tag: 'WUXGA' },
      { width: 2560, height: 1600, tag: 'WQXGA' },
      { width: 3840, height: 2400, tag: 'WQUXGA' },
    ],
  },
  {
    id: '4:3',
    label: '4:3',
    resolutions: [
      { width: 320, height: 240, tag: 'QVGA' },
      { width: 640, height: 480, tag: 'VGA' },
      { width: 800, height: 600, tag: 'SVGA' },
      { width: 1024, height: 768, tag: 'XGA' },
      { width: 1280, height: 960 },
      { width: 1600, height: 1200, tag: 'UXGA' },
      { width: 2048, height: 1536, tag: 'QXGA' },
    ],
  },
  {
    id: '21:9',
    label: '21:9',
    resolutions: [
      { width: 1280, height: 540 },
      { width: 1720, height: 720 },
      { width: 2560, height: 1080, tag: 'UW-FHD' },
      { width: 3440, height: 1440, tag: 'UW-QHD' },
      { width: 5120, height: 2160, tag: 'UW-4K' },
    ],
  },
];

/** From the least to the most demanding, all of them realistic for WebRTC. */
export const FPS_OPTIONS = [5, 10, 15, 20, 24, 30, 48, 60, 90, 120, 144, 165, 240];

/** Opus does the work here, so the range mirrors what Opus is usually run at. */
export const AUDIO_BITRATE_OPTIONS = [16, 24, 32, 48, 64, 96, 128, 192, 256, 320];

export const VIDEO_BITRATE_OPTIONS = [
  250, 500, 800, 1200, 1500, 2000, 2500, 3500, 5000, 6000, 8000, 12000, 16000, 20000,
];

export const SCREEN_BITRATE_OPTIONS = [...VIDEO_BITRATE_OPTIONS, 30000, 40000, 60000, 80000];

export function formatResolution(option: ResolutionOption): string {
  return option.tag ? `${option.width}×${option.height} (${option.tag})` : `${option.width}×${option.height}`;
}

/**
 * Finds which aspect-ratio group a resolution belongs to. Falls back to the
 * mathematically closest group so a profile saved by hand (or by an older
 * version) still opens on a sensible tab instead of always landing on 16:9.
 */
export function aspectRatioIdFor(width: number, height: number): string {
  const exact = ASPECT_RATIO_GROUPS.find((group) =>
    group.resolutions.some((r) => r.width === width && r.height === height)
  );
  if (exact) return exact.id;

  if (height <= 0) return ASPECT_RATIO_GROUPS[0].id;
  const ratio = width / height;
  let closest = ASPECT_RATIO_GROUPS[0];
  let smallestGap = Number.POSITIVE_INFINITY;
  for (const group of ASPECT_RATIO_GROUPS) {
    const reference = group.resolutions[0];
    const gap = Math.abs(reference.width / reference.height - ratio);
    if (gap < smallestGap) {
      smallestGap = gap;
      closest = group;
    }
  }
  return closest.id;
}

export function aspectRatioGroup(id: string): AspectRatioGroup {
  return ASPECT_RATIO_GROUPS.find((group) => group.id === id) ?? ASPECT_RATIO_GROUPS[0];
}

/** The entry of a group closest in height to the current resolution. */
export function closestResolution(group: AspectRatioGroup, height: number): ResolutionOption {
  return group.resolutions.reduce((best, option) =>
    Math.abs(option.height - height) < Math.abs(best.height - height) ? option : best
  );
}
