export interface HsvColor {
  h: number;
  s: number;
  v: number;
}

export const COLOR_PRESETS = [
  '#5865f2', '#57f287', '#fee75c', '#eb459e', '#ed4245', '#f47b67',
  '#9b59b6', '#1abc9c', '#3498db', '#e91e63', '#95a5a6', '#e67e22',
] as const;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
}

export function normalizeHexColor(value: string): string | null {
  const hex = value.trim().replace(/^#/, '');
  if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex.toLowerCase()}`;
  if (/^[0-9a-f]{3}$/i.test(hex)) return `#${[...hex].map(channel => channel + channel).join('').toLowerCase()}`;
  return null;
}

export function hexToHsv(value: string, fallbackHue = 0): HsvColor {
  const hex = normalizeHexColor(value);
  if (!hex || !Number.isFinite(fallbackHue)) throw new RangeError('Invalid color');
  const [r, g, b] = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = fallbackHue;
  if (delta) {
    if (max === r) hue = 60 * ((g - b) / delta);
    else if (max === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  return { h: ((hue % 360) + 360) % 360, s: max ? delta / max * 100 : 0, v: max * 100 };
}

export function hsvToHex({ h, s, v }: HsvColor): string {
  if (![h, s, v].every(Number.isFinite)) throw new RangeError('Invalid color');
  const hue = ((h % 360) + 360) % 360 / 60;
  const saturation = Math.max(0, Math.min(100, s)) / 100;
  const value = Math.max(0, Math.min(100, v)) / 100;
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(hue % 2 - 1));
  const channels = hue < 1 ? [chroma, x, 0] : hue < 2 ? [x, chroma, 0]
    : hue < 3 ? [0, chroma, x] : hue < 4 ? [0, x, chroma]
      : hue < 5 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${channels.map(channel => Math.round((channel + value - chroma) * 255).toString(16).padStart(2, '0')).join('')}`;
}
