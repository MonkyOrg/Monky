import type { OverlayCardSize, OverlayConfig } from './ipc';
import { OVERLAY_DEFAULT_CARD_WIDTH, OVERLAY_DEFAULT_CARD_HEIGHT, OVERLAY_MINIMALIST_CARD_HEIGHT } from './constants';

export function overlayCardAspect(minimalist = false): number {
  return OVERLAY_DEFAULT_CARD_WIDTH / (minimalist ? OVERLAY_MINIMALIST_CARD_HEIGHT : OVERLAY_DEFAULT_CARD_HEIGHT);
}

export function getOverlayCardSize(config: OverlayConfig): OverlayCardSize {
  const saved = config.minimalistMode ? config.minimalistCardSize : config.cardSize;
  const width = saved?.width ?? OVERLAY_DEFAULT_CARD_WIDTH;
  const height = saved?.height ?? (config.minimalistMode ? OVERLAY_MINIMALIST_CARD_HEIGHT : OVERLAY_DEFAULT_CARD_HEIGHT);
  return { width, height: config.preserveAspectRatio !== false ? width / overlayCardAspect(config.minimalistMode) : height };
}

export function isOverlayCardSizeCustom(config: OverlayConfig): boolean {
  const size = getOverlayCardSize(config);
  const defaultHeight = config.minimalistMode ? OVERLAY_MINIMALIST_CARD_HEIGHT : OVERLAY_DEFAULT_CARD_HEIGHT;
  return Math.abs(size.width - OVERLAY_DEFAULT_CARD_WIDTH) > 0.01 || Math.abs(size.height - defaultHeight) > 0.01;
}
