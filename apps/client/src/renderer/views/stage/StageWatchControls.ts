import { webRtcManager } from '../../core/WebRtcManager';
import { t } from '../../i18n';
import { html, type SafeHtml } from '../../utils/html';
import { stageTileKey } from './stageTiles';

export function renderWatchOverlay(sessionId: string, shareId: string | undefined, name: string, mini: boolean): SafeHtml {
  const camera = shareId === undefined;
  const label = t(camera ? 'stage.watchCamera' : 'stage.watchBroadcast');
  return html`
    <div class="stage-watch-overlay${mini ? ' stage-watch-overlay--mini' : ''}">
      <button type="button" class="stage-watch-btn" data-watch-session="${sessionId}" data-watch-share="${shareId ?? ''}"
        data-watch-kind="${camera ? 'camera' : 'screen'}" title="${label}" aria-label="${label}">
        <span class="material-symbols-outlined" aria-hidden="true">${camera ? 'videocam' : 'smart_display'}</span>
        ${mini ? '' : html`<span>${label}</span>`}
      </button>
      ${mini ? '' : html`<div class="stage-watch-caption">${t(camera ? 'stage.watchCameraCaption' : 'stage.watchCaption', { name })}</div>`}
    </div>
  `;
}

export function renderStopWatchingButton(sessionId: string, shareId?: string): SafeHtml {
  return html`
    <button type="button" class="stage-stopwatch-btn" data-stopwatch-session="${sessionId}" data-stopwatch-share="${shareId ?? ''}"
      data-watch-kind="${shareId === undefined ? 'camera' : 'screen'}" title="${t('stage.stopWatching')}" aria-label="${t('stage.stopWatching')}">
      <span class="material-symbols-outlined md-18" aria-hidden="true">visibility_off</span>
    </button>
  `;
}

export function bindWatchControls(
  card: HTMLElement,
  isCurrent: () => boolean,
  changeFocus: (tileKey: string, watching: boolean, apply: () => void, afterRender: () => void) => void,
): () => void {
  const controller = new AbortController();
  for (const button of card.querySelectorAll<HTMLButtonElement>('.stage-watch-btn, .stage-stopwatch-btn')) {
    button.addEventListener('click', event => {
      event.stopPropagation();
      if (!isCurrent()) return;
      const watching = button.classList.contains('stage-watch-btn');
      const sessionId = watching ? button.dataset.watchSession : button.dataset.stopwatchSession;
      const shareId = watching ? button.dataset.watchShare : button.dataset.stopwatchShare;
      if (!sessionId) return;
      const focused = document.activeElement === button;
      const stage = card.closest('.voice-stage-container');
      const tileKey = button.dataset.watchKind === 'camera' ? stageTileKey.camera(sessionId)
        : shareId ? stageTileKey.screen(sessionId, shareId) : null;
      if (!tileKey) return;
      const afterRender = () => {
        if (focused && stage?.isConnected) stage.querySelector<HTMLButtonElement>(
          `[data-tile-key="${CSS.escape(tileKey)}"] ${watching ? '.stage-stopwatch-btn' : '.stage-watch-btn'}`,
        )?.focus({ preventScroll: true });
      };
      if (button.dataset.watchKind === 'camera') {
        changeFocus(tileKey, watching, () => webRtcManager.setRemoteCameraWatching(sessionId, watching), afterRender);
      } else if (shareId) {
        changeFocus(tileKey, watching, () => webRtcManager.setRemoteScreenWatching(sessionId, shareId, watching), afterRender);
      }
    }, { signal: controller.signal });
  }
  return () => controller.abort();
}
