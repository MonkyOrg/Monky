import type {
  OverlayConfig,
  OverlayParticipantState,
  OverlaySyncState,
  OverlayCardSize,
} from '@monky/shared';
import { escapeHtml } from '../utils/html';
import { t } from '../i18n';
import { renderAudioMuteIndicators } from './AudioStateIcon';
import { arrangeOverlayCards, fitOverlayCards, OVERLAY_RESIZE_HINTS, overlayResizeHint } from '../utils/overlayLayout';
import { getOverlayCardSize, overlayCardAspect } from '@monky/shared';

type OverlayTile = {
  p: OverlayParticipantState;
  kind: 'camera' | 'screen' | 'voice';
  shareId?: string;
  slotIndex?: number;
  key: string;
};

/** Deve acompanhar a duração das animações overlayCardIn/Out do theme.css. */
const CARD_FADE_MS = 260;

export class OverlayStageView {
  private container: HTMLElement;
  private currentState: OverlaySyncState | null = null;
  private localPeerConnection: RTCPeerConnection | null = null;
  private slotStreams: MediaStream[] = [];
  private unbindListeners: Array<() => void> = [];
  private leavingTimers = new Map<string, number>();
  private isHovered = false;
  private isResizing = false;
  private pointer: { x: number; y: number } | undefined;
  private layoutObserver: ResizeObserver | null = null;
  private cardSize: OverlayCardSize | null = null;
  private layoutRequestKey = '';

  constructor(container: HTMLElement) {
    this.container = container;
  }

  public init(): void {
    document.body.classList.add('overlay-window-mode');
    document.getElementById('titlebar')?.remove();

    this.initLocalPeerConnection();
    this.layoutObserver = new ResizeObserver(() => {
      this.applyCardLayout();
      this.applyHoverState();
    });
    this.layoutObserver.observe(this.container);
    if (window.api?.onOverlayResizeStateChanged) {
      this.unbindListeners.push(window.api.onOverlayResizeStateChanged(resizing => {
        this.isResizing = resizing;
        if (!resizing) {
          this.cardSize = null;
          this.layoutRequestKey = '';
        }
        this.applyCardLayout(!resizing);
        this.applyHoverState();
      }));
    }

    if (window.api?.onOverlaySyncStateReceived) {
      this.unbindListeners.push(
        window.api.onOverlaySyncStateReceived((state) => {
          if (!this.currentState || !!state.config.minimalistMode !== !!this.currentState.config.minimalistMode) {
            this.acceptCardConfig(state.config);
          }
          this.currentState = state;
          this.render();
        })
      );
    }

    if (window.api?.onOverlayConfigUpdated) {
      this.unbindListeners.push(
        window.api.onOverlayConfigUpdated((config) => {
          this.acceptCardConfig(config);
          if (this.currentState) {
            this.currentState.config = config;
            this.render();
          }
        })
      );
    }

    if (window.api?.onOverlayHoverChanged) {
      this.unbindListeners.push(
        window.api.onOverlayHoverChanged((hovered, point) => {
          this.isHovered = hovered;
          this.pointer = point;
          this.applyHoverState();
        })
      );
    }

    if (window.api?.onOverlaySignalReceived) {
      this.unbindListeners.push(
        window.api.onOverlaySignalReceived(async (signalJson) => {
          try {
            const signal = JSON.parse(signalJson);
            if (signal.type === 'offer' && this.localPeerConnection) {
              await this.localPeerConnection.setRemoteDescription(new RTCSessionDescription(signal));
              const answer = await this.localPeerConnection.createAnswer();
              await this.localPeerConnection.setLocalDescription(answer);

              // Aguarda colheita completa de candidatos host no localhost
              await new Promise<void>((resolve) => {
                if (this.localPeerConnection?.iceGatheringState === 'complete') {
                  resolve();
                } else {
                  const handler = () => {
                    if (this.localPeerConnection?.iceGatheringState === 'complete') {
                      this.localPeerConnection?.removeEventListener('icegatheringstatechange', handler);
                      resolve();
                    }
                  };
                  this.localPeerConnection?.addEventListener('icegatheringstatechange', handler);
                  setTimeout(resolve, 300);
                }
              });

              const completeAnswer = this.localPeerConnection.localDescription || answer;
              if (window.api?.sendOverlaySignal) {
                await window.api.sendOverlaySignal({
                  target: 'main',
                  signal: JSON.stringify(completeAnswer),
                });
              }
            }
          } catch (e) {
            console.warn('[OverlayStage] Erro ao processar sinal WebRTC:', e);
          }
        })
      );
    }

    this.render();

    // Sinaliza ao main bridge que o overlay está pronto para receber a offer WebRTC.
    if (window.api?.sendOverlaySignal) {
      window.api.sendOverlaySignal({
        target: 'main',
        signal: JSON.stringify({ type: 'ready' }),
      }).catch(() => {});
    }
  }

  private initLocalPeerConnection(): void {
    try {
      this.localPeerConnection = new RTCPeerConnection({ iceServers: [] });
      this.slotStreams = [];

      this.localPeerConnection.ontrack = (event) => {
        const mid = event.transceiver?.mid;
        const slotIndex = mid !== undefined && mid !== null ? parseInt(mid, 10) : this.slotStreams.length;
        const stream = event.streams[0] || new MediaStream([event.track]);
        this.slotStreams[slotIndex] = stream;

        event.track.onunmute = () => {
          this.bindVideos();
        };

        this.bindVideos();
      };
    } catch (e) {
      console.warn('[OverlayStage] Erro ao inicializar RTCPeerConnection:', e);
    }
  }

  public render(): void {
    if (!this.currentState || !this.currentState.participants || this.currentState.participants.length === 0) {
      // With "hide myself" on, an empty list means nobody else is around —
      // saying we're waiting for a voice channel would be wrong (#169).
      this.renderEmptyState(!!this.currentState?.config?.hideSelf);
      return;
    }

    const config = this.currentState.config;
    const opacity = typeof config.cardOpacity === 'number' ? config.cardOpacity : 0.85;
    const isFocusSpeaker = config.mode === 'cameras-only' && config.focusActiveSpeaker && !config.minimalistMode;
    const isMinimalist = !!config.minimalistMode;

    let displayParticipants: OverlayParticipantState[] = [];
    if (isFocusSpeaker) {
      const speaker = this.currentState.participants.find((p) => p.sessionId === this.currentState?.activeSpeakerSessionId)
        || this.currentState.participants[0];
      displayParticipants = speaker ? [speaker] : [];
    } else {
      displayParticipants = this.currentState.participants;
    }

    const tiles: OverlayTile[] = [];
    for (const p of displayParticipants) {
      if (isMinimalist) {
        // Modo Minimalista: 1 item por participante sem vídeo
        tiles.push({ p, kind: 'voice', key: `${p.sessionId}-mini` });
      } else if (config.mode === 'cameras-and-screens') {
        if (p.isCameraOn) {
          tiles.push({ p, kind: 'camera', slotIndex: p.videoSlotIndex, key: `${p.sessionId}-cam` });
        }
        for (const shareId of p.screenShareIds) {
          const slot = p.screenSlotIndexes ? p.screenSlotIndexes[shareId] : undefined;
          tiles.push({ p, kind: 'screen', shareId, slotIndex: slot, key: `${p.sessionId}-screen-${shareId}` });
        }
        if (!p.isCameraOn && p.screenShareIds.length === 0) {
          tiles.push({ p, kind: 'voice', key: `${p.sessionId}-voice` });
        }
      } else {
        if (p.isCameraOn) {
          tiles.push({ p, kind: 'camera', slotIndex: p.videoSlotIndex, key: `${p.sessionId}-cam` });
        } else {
          tiles.push({ p, kind: 'voice', key: `${p.sessionId}-voice` });
        }
      }
    }

    let layoutClass = 'layout-grid';
    if (isMinimalist) layoutClass = 'layout-minimalist';
    else if (config.layout === 'vertical') layoutClass = 'layout-vertical';
    else if (config.layout === 'horizontal') layoutClass = 'layout-horizontal';
    if (isFocusSpeaker) layoutClass = 'layout-focus-speaker';

    this.ensureBaseStructure();

    // Atualiza propriedades do container root
    const rootEl = this.container.querySelector('.overlay-stage-root') as HTMLElement | null;
    if (rootEl) {
      rootEl.style.setProperty('--overlay-card-opacity', String(opacity));
      rootEl.classList.toggle('minimalist-mode', isMinimalist);
    }

    // The DOM may have just been rebuilt, so re-apply the hover flag and the
    // corner the resize hint belongs in (#543).
    this.applyHoverState();

    // Atualiza nome do canal
    const titleEl = this.container.querySelector('.overlay-channel-title') as HTMLElement | null;
    if (titleEl && this.currentState.channelName) {
      titleEl.textContent = this.currentState.channelName;
    }

    // Atualiza container de cards cirurgicamente sem destruir os elementos <video>
    const cardsContainer = this.container.querySelector('.overlay-cards-container') as HTMLElement | null;
    if (cardsContainer) {
      cardsContainer.className = `overlay-cards-container ${layoutClass}`;
      this.reconcileCards(cardsContainer, tiles, isMinimalist, isFocusSpeaker);
      this.applyCardLayout();
    }

    if (!isMinimalist) {
      this.bindVideos();
    }
  }

  private renderEmptyState(isAlone: boolean = false): void {
    this.layoutRequestKey = '';
    this.container.innerHTML = `
      <div class="overlay-stage-root">
        <div class="overlay-stage-topbar">
          <div class="overlay-drag-handle">
            <span class="material-symbols-outlined md-14" style="color: var(--text-muted); margin-right: 4px;">drag_indicator</span>
            <span class="overlay-channel-title" style="font-size: 11px; font-weight: 600; color: var(--text-muted);">Monky Overlay</span>
          </div>
          <div class="overlay-topbar-actions">
            <button id="btn-overlay-close" class="overlay-action-btn close" title="${t('overlay.closeOverlayBtn')}">
              <span class="material-symbols-outlined md-14">close</span>
            </button>
          </div>
        </div>
        <div class="overlay-empty-state">
          <span class="material-symbols-outlined md-20" style="color: var(--text-muted); opacity: 0.6;">group</span>
          <span>${this.currentState?.config.hideInactiveParticipants
            ? t('overlay.noActiveVideo') : isAlone ? t('overlay.aloneInChannel') : t('overlay.waitingChannel')}</span>
        </div>
        ${this.renderResizeHint()}
      </div>
    `;
    this.attachControls();
    this.applyHoverState();
  }

  private ensureBaseStructure(): void {
    let rootEl = this.container.querySelector('.overlay-stage-root');
    const emptyState = this.container.querySelector('.overlay-empty-state');
    if (!rootEl || emptyState) {
      this.container.innerHTML = `
        <div class="overlay-stage-root">
          <div class="overlay-stage-topbar">
            <div class="overlay-drag-handle">
              <span class="material-symbols-outlined md-14" style="color: var(--text-muted); margin-right: 4px;">drag_indicator</span>
              <span class="overlay-channel-title" style="font-size: 11px; font-weight: 600; color: var(--text-muted);"></span>
            </div>
            <div class="overlay-topbar-actions">
              <button id="btn-overlay-close" class="overlay-action-btn close" title="${t('overlay.closeOverlayBtn')}">
                <span class="material-symbols-outlined md-14">close</span>
              </button>
            </div>
          </div>
          <div class="overlay-cards-container"></div>
          ${this.renderResizeHint()}
        </div>
      `;
      this.attachControls();
    }
  }

  /**
   * Reconciliação cirúrgica de cards do DOM.
   * Preserva a tag <video> e seu srcObject para evitar piscadas e repaints desnecessários.
   */
  private reconcileCards(
    cardsContainer: HTMLElement,
    tiles: OverlayTile[],
    isMinimalist: boolean,
    useCrossfade: boolean
  ): void {
    const existingItems = new Map<string, HTMLElement>();
    cardsContainer.querySelectorAll('.overlay-card, .overlay-mini-item').forEach((item) => {
      const key = item.getAttribute('data-tile-key');
      if (key) existingItems.set(key, item as HTMLElement);
    });

    const activeKeys = new Set(tiles.map((t) => t.key));

    // Remove cards obsoletos. No modo foco a troca de orador seria um corte
    // seco, então o card antigo sai em fade por cima do novo (#169).
    existingItems.forEach((item, key) => {
      if (!activeKeys.has(key)) {
        if (useCrossfade && item.classList.contains('overlay-card')) {
          this.startCardFadeOut(item, key);
        } else {
          this.cancelCardFadeOut(item, key);
          item.remove();
        }
      }
    });

    // Atualiza ou insere cards/itens
    tiles.forEach((tile, index) => {
      const isSpeaking = tile.p.isSpeaking;
      const name = tile.p.displayName;
      const hasVideo = !isMinimalist && (tile.kind === 'camera' || tile.kind === 'screen') && tile.slotIndex !== undefined;
      const slotStr = tile.slotIndex !== undefined ? String(tile.slotIndex) : '';

      let item = existingItems.get(tile.key);
      if (item) this.cancelCardFadeOut(item, tile.key);

      if (isMinimalist) {
        // Renderização minimalista
        if (!item || !item.classList.contains('overlay-mini-item')) {
          item?.remove();
          item = document.createElement('div');
          item.className = `overlay-mini-item ${isSpeaking ? 'speaking' : ''}`;
          item.setAttribute('data-tile-key', tile.key);
          item.innerHTML = this.getMinimalistInnerHtml(tile.p, name, isSpeaking);
          cardsContainer.appendChild(item);
        } else {
          item.className = `overlay-mini-item ${isSpeaking ? 'speaking' : ''}`;
          const nameEl = item.querySelector('.overlay-mini-name');
          if (nameEl && nameEl.textContent !== name) nameEl.textContent = name;

          const avatarImg = item.querySelector('.overlay-mini-avatar') as HTMLImageElement | null;
          if (avatarImg && tile.p.avatarUrl && avatarImg.src !== tile.p.avatarUrl) {
            avatarImg.src = tile.p.avatarUrl;
          }

          const pulseEl = item.querySelector('.overlay-mini-avatar, .overlay-mini-avatar-placeholder');
          if (pulseEl) pulseEl.classList.toggle('speaking-pulse', isSpeaking);

          const iconsEl = item.querySelector('.overlay-mini-icons');
          if (iconsEl) iconsEl.innerHTML = this.getMiniIconsHtml(tile.p);
        }
      } else {
        // Renderização padrão de cards
        if (!item || item.classList.contains('overlay-mini-item')) {
          item?.remove();
          item = document.createElement('div');
          item.setAttribute('data-tile-key', tile.key);
          item.innerHTML = this.getCardInnerHtml(tile, hasVideo, name, isSpeaking);
          cardsContainer.appendChild(item);
        } else {
          const hadVideo = item.classList.contains('has-video');
          if (hadVideo !== hasVideo) {
            item.innerHTML = this.getCardInnerHtml(tile, hasVideo, name, isSpeaking);
          } else {
            const nameEl = item.querySelector('.overlay-user-name');
            if (nameEl && nameEl.textContent !== name) {
              nameEl.textContent = name;
            }

            const avatarImg = item.querySelector('.overlay-avatar-img') as HTMLImageElement | null;
            if (avatarImg && tile.p.avatarUrl && avatarImg.src !== tile.p.avatarUrl) {
              avatarImg.src = tile.p.avatarUrl;
            }

            const avatarPulse = item.querySelector('.overlay-avatar-img, .overlay-avatar-placeholder');
            if (avatarPulse) {
              avatarPulse.classList.toggle('speaking-pulse', isSpeaking);
            }

            const badgesEl = item.querySelector('.overlay-user-badges');
            if (badgesEl) {
              badgesEl.innerHTML = this.getBadgesHtml(tile);
            }
          }
        }

        item.className = `overlay-card ${hasVideo ? 'has-video' : 'voice-only'} ${isSpeaking ? 'speaking' : ''}`;
        item.setAttribute('data-slot', slotStr);
      }

      // Garante a ordem correta no DOM, ignorando os cards que estão saindo
      const liveChildren = Array.from(cardsContainer.children).filter(
        (child) => !child.classList.contains('leaving')
      );
      if (liveChildren[index] !== item) {
        cardsContainer.insertBefore(item, liveChildren[index] || null);
      }
    });
  }

  private startCardFadeOut(item: HTMLElement, key: string): void {
    if (this.leavingTimers.has(key)) return;
    item.classList.add('leaving');
    item.removeAttribute('data-slot');
    const timer = window.setTimeout(() => {
      this.leavingTimers.delete(key);
      item.remove();
    }, CARD_FADE_MS);
    this.leavingTimers.set(key, timer);
  }

  /** The speaker may come back before the fade ends: reuse the card as-is. */
  private cancelCardFadeOut(item: HTMLElement, key: string): void {
    const timer = this.leavingTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.leavingTimers.delete(key);
    }
    item.classList.remove('leaving');
  }

  private getCardInnerHtml(tile: OverlayTile, hasVideo: boolean, name: string, isSpeaking: boolean): string {
    const escapedName = escapeHtml(name);
    return `
      ${hasVideo ? `
        <div class="overlay-video-wrapper">
          <video id="vid-${tile.key}" autoplay playsinline muted></video>
        </div>
      ` : `
        <div class="overlay-avatar-wrapper">
          ${tile.p.avatarUrl ? `
            <img src="${tile.p.avatarUrl}" alt="${escapedName}" class="overlay-avatar-img ${isSpeaking ? 'speaking-pulse' : ''}" />
          ` : `
            <div class="overlay-avatar-placeholder ${isSpeaking ? 'speaking-pulse' : ''}">${escapedName.charAt(0).toUpperCase()}</div>
          `}
        </div>
      `}

      <div class="overlay-card-footer">
        <span class="overlay-user-name">${escapedName}</span>
        <div class="overlay-user-badges">
          ${this.getBadgesHtml(tile)}
        </div>
      </div>
    `;
  }

  private getMinimalistInnerHtml(p: OverlayParticipantState, name: string, isSpeaking: boolean): string {
    const escapedName = escapeHtml(name);
    return `
      <div class="overlay-mini-avatar-wrapper">
        ${p.avatarUrl ? `
          <img src="${p.avatarUrl}" alt="${escapedName}" class="overlay-mini-avatar ${isSpeaking ? 'speaking-pulse' : ''}" />
        ` : `
          <div class="overlay-mini-avatar-placeholder ${isSpeaking ? 'speaking-pulse' : ''}">${escapedName.charAt(0).toUpperCase()}</div>
        `}
      </div>
      <span class="overlay-mini-name">${escapedName}</span>
      <div class="overlay-mini-icons">
        ${this.getMiniIconsHtml(p)}
      </div>
    `;
  }

  private getMiniIconsHtml(p: OverlayParticipantState): string {
    return `
      ${renderAudioMuteIndicators(p)}
      ${p.screenShareIds.length > 0 ? '<span class="material-symbols-outlined md-14" style="color: var(--success);">screen_share</span>' : ''}
      ${p.isCameraOn ? '<span class="material-symbols-outlined md-14" style="color: var(--primary);">videocam</span>' : ''}
    `;
  }

  private getBadgesHtml(tile: OverlayTile): string {
    const selected = tile.shareId ? tile.p.screenCaptureModes?.[tile.shareId] : undefined;
    const mode = selected === 'normal' || selected === 'game' ? selected : undefined;
    if (selected !== undefined && mode === undefined) console.warn('[OverlayStage] Invalid screen capture mode.');
    const label = mode ? escapeHtml(t(mode === 'game' ? 'screenShare.gameCapture' : 'screenShare.windowCapture')) : '';
    return `
      ${renderAudioMuteIndicators(tile.p, { size: 12 })}
      ${tile.kind === 'camera' ? '<span class="material-symbols-outlined md-12" style="color: var(--primary);">videocam</span>' : ''}
      ${tile.kind === 'screen' ? `<span class="material-symbols-outlined md-12" style="color: var(--success);"
        ${mode ? `data-capture-mode="${mode}" role="img" aria-label="${label}" title="${label}"` : 'aria-hidden="true"'}
        >${mode === 'game' ? 'sports_esports' : 'screen_share'}</span>` : ''}
    `;
  }

  private bindVideos(): void {
    if (this.slotStreams.length === 0) return;

    const cards = this.container.querySelectorAll('.overlay-card.has-video:not(.leaving)');
    cards.forEach((card) => {
      const tileKey = card.getAttribute('data-tile-key');
      const slotStr = card.getAttribute('data-slot');
      if (!tileKey || !slotStr) return;

      const slotIndex = parseInt(slotStr, 10);
      if (isNaN(slotIndex) || slotIndex < 0 || slotIndex >= this.slotStreams.length) return;

      const stream = this.slotStreams[slotIndex];
      const videoEl = card.querySelector('video') as HTMLVideoElement | null;
      if (videoEl && stream) {
        if (videoEl.srcObject !== stream) {
          videoEl.muted = true;
          videoEl.autoplay = true;
          videoEl.playsInline = true;
          videoEl.srcObject = stream;
          videoEl.play().catch(() => {});
        }
      }
    });
  }

  private applyHoverState(): void {
    const root = this.container.querySelector('.overlay-stage-root');
    if (root) {
      root.classList.toggle('is-hovered', this.isHovered || this.isResizing);
      root.classList.toggle('is-resizing', this.isResizing);
    }
    const bounds = root?.getBoundingClientRect();
    const direction = this.isHovered && this.pointer && bounds
      ? overlayResizeHint(bounds.width, bounds.height, { x: this.pointer.x - bounds.left, y: this.pointer.y - bounds.top })
      : undefined;
    for (const hint of this.container.querySelectorAll<HTMLElement>('.overlay-resize-hint')) {
      hint.classList.toggle('near-pointer', hint.dataset.direction === direction);
    }
  }

  private acceptCardConfig(config: OverlayConfig): void {
    if (this.isResizing) return;
    const nextSize = getOverlayCardSize(config);
    if (nextSize.width !== this.cardSize?.width || nextSize.height !== this.cardSize?.height
      || config.minimalistMode !== this.currentState?.config.minimalistMode) {
      this.cardSize = nextSize;
      this.layoutRequestKey = '';
    }
  }

  private applyCardLayout(refit = false): void {
    const cards = this.container.querySelector<HTMLElement>('.overlay-cards-container');
    if (!cards) return;
    const config = this.currentState?.config;
    if (!config) return;
    const preserve = config.preserveAspectRatio !== false;
    const aspect = overlayCardAspect(config.minimalistMode);
    cards.classList.toggle('preserve-aspect', preserve);
    cards.classList.add('fixed-card-size');
    const count = cards.querySelectorAll('.overlay-card:not(.leaving), .overlay-mini-item').length;
    if (!count) return;
    if (this.isResizing || refit) {
      const fitted = fitOverlayCards(cards.clientWidth, cards.clientHeight, count, config.layout, preserve, aspect);
      if (fitted.width < 1 || fitted.height < 1) return;
      this.cardSize = { width: fitted.width, height: fitted.height };
    }
    if (!this.cardSize) this.cardSize = getOverlayCardSize(config);
    const layout = arrangeOverlayCards(this.cardSize, count, config.layout);
    cards.classList.toggle('scrollable', layout.width > cards.clientWidth + 1 || layout.height > cards.clientHeight + 1);
    cards.style.gridTemplateColumns = `repeat(${layout.columns}, ${this.cardSize.width}px)`;
    cards.style.gridAutoRows = `${this.cardSize.height}px`;
    cards.style.setProperty('--overlay-card-width', `${this.cardSize.width}px`);
    cards.style.setProperty('--overlay-card-height', `${this.cardSize.height}px`);
    if (this.isResizing) return;
    const root = this.container.querySelector<HTMLElement>('.overlay-stage-root');
    if (!root || !window.api?.layoutOverlayCards) return;
    const rootStyle = getComputedStyle(root);
    const paddingX = parseFloat(rootStyle.paddingLeft) + parseFloat(rootStyle.paddingRight);
    const paddingY = parseFloat(rootStyle.paddingTop) + parseFloat(rootStyle.paddingBottom);
    const topbar = root.querySelector<HTMLElement>('.overlay-stage-topbar');
    const barHeight = topbar ? topbar.getBoundingClientRect().height + parseFloat(getComputedStyle(topbar).marginBottom) : 0;
    const key = `${!!config.minimalistMode}:${preserve}:${this.cardSize.width}:${this.cardSize.height}:${layout.columns}:${layout.rows}`;
    if (key === this.layoutRequestKey) return;
    this.layoutRequestKey = key;
    void window.api.layoutOverlayCards({
      cardSize: { ...this.cardSize },
      minimalistMode: !!config.minimalistMode,
      preserveAspectRatio: preserve,
      width: Math.ceil(layout.width + paddingX),
      height: Math.ceil(layout.height + paddingY + barHeight),
      resizeAspect: {
        ratio: layout.columns * aspect / layout.rows,
        extraSize: {
          width: Math.round(paddingX + (layout.columns - 1) * 6),
          height: Math.round(paddingY + barHeight + (layout.rows - 1) * 6),
        },
      },
    }).catch((error: unknown) => {
      console.error('[OverlayStage] Could not preserve overlay card dimensions:', error);
    });
  }

  /** Visual hints only: the native window border still handles resizing. */
  private renderResizeHint(): string {
    return OVERLAY_RESIZE_HINTS.map(({ direction, x, y, rotation }) => {
      // The diagonal of the rounded frame is 2px inward from its square corner.
      const inset = x !== 0.5 && y !== 0.5 ? 2 : 0;
      return `
      <div class="overlay-resize-hint" data-direction="${direction}" style="left:calc(${x * 100}% - ${x * (16 + inset * 2)}px + ${inset}px);top:calc(${y * 100}% - ${y * (16 + inset * 2)}px + ${inset}px)" aria-hidden="true">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path transform="rotate(${rotation} 8 8)" d="M8 2V14 M5 5L8 2L11 5 M5 11L8 14L11 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
    `; }).join('');
  }

  private attachControls(): void {
    const btnClose = this.container.querySelector('#btn-overlay-close');
    btnClose?.addEventListener('click', () => {
      if (window.api?.closeOverlay) {
        window.api.closeOverlay().catch(() => {});
      }
    });
  }

  public destroy(): void {
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    this.unbindListeners.forEach((u) => u());
    this.unbindListeners = [];
    this.leavingTimers.forEach((timer) => clearTimeout(timer));
    this.leavingTimers.clear();
    if (this.localPeerConnection) {
      try {
        this.localPeerConnection.close();
      } catch {}
      this.localPeerConnection = null;
    }
  }
}
