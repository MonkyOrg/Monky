const FRAME = '.stage-focused-main';
const VIDEO = 'video[data-video-tile-key]';

/**
 * Publishes the focused video's shape as `--stage-video-aspect`, so a phone in
 * portrait gives a share on its side a frame on its side and a phone's share a
 * tall one. The shape follows the stream: a sharer turning the phone resizes it.
 */
export function bindFocusedVideoFrame(container: HTMLElement): () => void {
  const controller = new AbortController();
  const update = (event: Event) => {
    if (event.target instanceof HTMLVideoElement && event.target.matches(VIDEO)) publish(event.target);
  };
  // Media events do not bubble; capture still sees them on the way down.
  container.addEventListener('loadedmetadata', update, { capture: true, signal: controller.signal });
  container.addEventListener('resize', update, { capture: true, signal: controller.signal });
  return () => controller.abort();
}

/** For cards moved into focus with their video already playing. */
export function syncFocusedVideoFrames(area: HTMLElement): void {
  area.querySelectorAll<HTMLVideoElement>(`${FRAME} ${VIDEO}`).forEach(publish);
}

function publish(video: HTMLVideoElement): void {
  const frame = video.closest<HTMLElement>(FRAME);
  if (!frame || !video.videoWidth || !video.videoHeight) return;
  frame.style.setProperty('--stage-video-aspect', (video.videoWidth / video.videoHeight).toFixed(4));
}
