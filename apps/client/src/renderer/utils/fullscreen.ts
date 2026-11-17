import { resumeInlineStream, type InlineVideo } from './inlineVideo';

/** The fullscreen WebKit gives a `<video>` on the iPhone, where no other element can go fullscreen. */
type WebKitFullscreenVideo = InlineVideo & Pick<HTMLVideoElement, 'paused' | 'addEventListener'> & {
  webkitEnterFullscreen: () => void;
};

function entersVideoFullscreen(video: object): video is WebKitFullscreenVideo {
  return typeof Reflect.get(video, 'webkitEnterFullscreen') === 'function' && video instanceof EventTarget;
}

/**
 * Shows `target` in fullscreen, or brings it back. Where the browser has no element fullscreen (Safari on
 * the iPhone), its `video` goes fullscreen in the system player instead. The request runs before any wait,
 * inside the tap that asked for it, which is the only moment the browser allows it. The system player pauses
 * the video it closes, so a live stream plays on in its tile instead of freezing there.
 * Resolves `false` when this browser cannot show it in fullscreen at all.
 */
export async function toggleFullscreen(
  target: Pick<Element, 'requestFullscreen'>,
  video: object | null = null,
): Promise<boolean> {
  if (document.fullscreenElement === target) {
    await document.exitFullscreen();
    return true;
  }
  if (document.fullscreenEnabled && typeof target.requestFullscreen === 'function') {
    await target.requestFullscreen();
    return true;
  }
  if (!video || !entersVideoFullscreen(video)) return false;
  video.addEventListener('webkitendfullscreen', () => {
    void resumeInlineStream(video).catch((error: unknown) => console.warn('[fullscreen] The video did not play again:', error));
  }, { once: true });
  video.webkitEnterFullscreen();
  return true;
}
