/** The parts of a `<video>` that showing a live stream touches. */
export type InlineVideo = Pick<HTMLVideoElement,
  'muted' | 'autoplay' | 'playsInline' | 'srcObject' | 'isConnected' | 'setAttribute' | 'pause' | 'play'>;

/** The video tracks each element was given its stream with. */
const shownTracks = new WeakMap<InlineVideo, string>();
const awaitingGesture = new Set<InlineVideo>();
let gesture: AbortController | null = null;

function trackSignature(stream: MediaStream | null): string {
  return stream ? stream.getVideoTracks().map(track => track.id).join(' ') : '';
}

/**
 * Whether `video` already shows `stream` with the tracks it has now. WebKit keeps painting the tracks a
 * stream had when it was assigned, so one that gained or swapped a track (the local screen preview arrives
 * after its stream is on the stage) is not being shown yet and must be assigned again.
 */
export function isShowingStream(video: InlineVideo, stream: MediaStream | null): boolean {
  return video.srcObject === stream && (shownTracks.get(video) ?? '') === trackSignature(stream);
}

/**
 * Shows a live stream and starts it. The iPhone plays a stream only in a muted, inline video that is
 * marked so before it gets the stream; without that it stays black. Where the system blocks autoplay
 * (iOS Low Power Mode), the picture starts at the next touch or key instead of staying black.
 */
export function showInlineStream(video: InlineVideo, stream: MediaStream | null): Promise<void> {
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.pause();
  if (video.srcObject === stream) video.srcObject = null;
  video.srcObject = stream;
  shownTracks.set(video, trackSignature(stream));
  awaitingGesture.delete(video);
  return stream ? startPlaying(video) : Promise.resolve();
}

function startPlaying(video: InlineVideo): Promise<void> {
  return video.play().catch((error: unknown) => {
    if (!(error instanceof DOMException) || error.name !== 'NotAllowedError') throw error;
    playAfterGesture(video);
  });
}

/**
 * Plays again a stream the system left paused. The iPhone's fullscreen player pauses the video it closes,
 * so the tile it returns to would freeze on its last frame until shown again.
 */
export function resumeInlineStream(video: InlineVideo & Pick<HTMLVideoElement, 'paused'>): Promise<void> {
  return video.isConnected && video.srcObject && video.paused ? startPlaying(video) : Promise.resolve();
}

function playAfterGesture(video: InlineVideo): void {
  awaitingGesture.add(video);
  if (gesture) return;
  const controller = gesture = new AbortController();
  const resume = (): void => {
    controller.abort();
    gesture = null;
    const videos = [...awaitingGesture];
    awaitingGesture.clear();
    for (const entry of videos) {
      if (entry.isConnected && entry.srcObject) void startPlaying(entry).catch(() => {});
    }
  };
  document.addEventListener('pointerdown', resume, { capture: true, signal: controller.signal });
  document.addEventListener('keydown', resume, { capture: true, signal: controller.signal });
}

type FrameVideo = Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight' | 'addEventListener'>;

/**
 * Calls `presented` once `video` has a frame of its stream. `playing` alone is no proof: a browser may play
 * a remote stream before decoding any of it, and taking that as the first frame cancels the startup check,
 * leaving a screen the browser cannot decode loading forever (Firefox watching an iPhone). Only a decoded
 * frame gives the element its size.
 */
export function onPresentedFrame(video: FrameVideo, presented: () => void, signal: AbortSignal): void {
  const check = (): void => { if (video.videoWidth > 0 && video.videoHeight > 0) presented(); };
  for (const type of ['playing', 'loadeddata', 'resize'] as const) video.addEventListener(type, check, { signal });
}
