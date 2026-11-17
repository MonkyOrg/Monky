import { reportCameraError } from '../../core/CameraPublication';
import { videoService, type CameraState } from '../../core/VideoService';
import { t } from '../../i18n';
import { html, type SafeHtml } from '../../utils/html';

const FLIP_SELECTOR = '[data-camera-flip]';

function hiddenFor(state: CameraState): boolean {
  return !state.publishing || !state.canSwitchFacing;
}

/**
 * Swaps the front and rear camera of a phone, beside the fullscreen button of the local camera's tile;
 * shown only while that camera is on the call.
 */
export function renderCameraFlipButton(): SafeHtml {
  const state = videoService.getCameraState();
  return html`<button type="button" class="stage-camera-flip-btn" data-camera-flip data-haptic="impact" title="${t('stage.switchCamera')}"
    aria-label="${t('stage.switchCamera')}" ${hiddenFor(state) ? html`hidden` : null} ${state.status === 'ready' ? null : html`disabled`}>
    <span class="material-symbols-outlined md-18" aria-hidden="true">flip_camera_ios</span>
  </button>`;
}

/** Drives every flip button `root` holds, including those its tiles render later. */
export function bindCameraFlip(root: HTMLElement): () => void {
  const controller = new AbortController();
  const sync = (state: CameraState): void => {
    for (const button of root.querySelectorAll<HTMLButtonElement>(FLIP_SELECTOR)) {
      button.hidden = hiddenFor(state);
      // While the other camera opens, a second tap would only restart it.
      button.disabled = state.status !== 'ready';
    }
  };
  root.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(FLIP_SELECTOR) : null;
    if (!button || button.disabled) return;
    event.stopPropagation();
    void videoService.switchCameraFacing().catch(reportCameraError);
  }, { signal: controller.signal });
  const unsubscribe = videoService.subscribeCameraState(sync);
  return () => {
    controller.abort();
    unsubscribe();
  };
}
