import { OverlayConfig, OverlayLayout, OverlayMode, OverlayPosition, isOverlayCardSizeCustom } from '@monky/shared';
import { settingsStore } from '../stores/settingsStore';
import { overlayBridgeService } from '../core/OverlayBridgeService';
import { appEvents } from '../core/EventBus';
import { t } from '../i18n';

export class OverlayConfigModal {
  private modalEl: HTMLElement | null = null;
  private currentMode: OverlayMode = 'cameras-only';
  private currentLayout: OverlayLayout = 'grid';
  private currentPosition: OverlayPosition = 'bottom-right';
  private positionChanged = false;
  private currentCardOpacity: number = 85;
  private currentFocusActiveSpeaker: boolean = false;
  private currentAutoOpenOnLeaveStage: boolean = false;
  private currentMinimalistMode: boolean = false;
  private currentHideSelf: boolean = false;
  private currentHideStagePreviews = false;
  private currentHideInactiveParticipants = false;
  private currentPreserveAspectRatio = true;
  private overlaySettingsUnbind: (() => void) | null = null;

  public open(): void {
    this.close();

    const config = settingsStore.getOverlayConfig();
    this.currentMode = config.mode;
    this.currentLayout = config.layout;
    this.currentPosition = config.position;
    this.positionChanged = false;
    this.currentCardOpacity = Math.round(config.cardOpacity * 100);
    this.currentFocusActiveSpeaker = config.focusActiveSpeaker;
    this.currentAutoOpenOnLeaveStage = !!config.autoOpenOnLeaveStage;
    this.currentMinimalistMode = !!config.minimalistMode;
    this.currentHideSelf = !!config.hideSelf;
    this.currentHideStagePreviews = !!config.hideStagePreviews;
    this.currentHideInactiveParticipants = !!config.hideInactiveParticipants;
    this.currentPreserveAspectRatio = config.preserveAspectRatio !== false;

    const overlaySizeChanged = isOverlayCardSizeCustom(config);

    this.modalEl = document.createElement('div');
    this.modalEl.className = 'modal-backdrop';
    this.modalEl.innerHTML = `
      <div class="modal-card" style="max-width: 520px; width: 100%; display: flex; flex-direction: column; padding: 0; overflow: hidden; border-radius: var(--radius-lg); background-color: var(--bg-panel); border: 1px solid var(--border-color); box-shadow: 0 16px 48px rgba(0, 0, 0, 0.6); animation: modalFadeIn 0.2s ease;">
        <!-- Header -->
        <div class="modal-header" style="padding: 16px 20px 14px; border-bottom: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between;">
          <div class="modal-title" style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);">picture_in_picture_alt</span>
            <span style="font-size: 16px; font-weight: 700; color: var(--text-primary);">${t('overlay.modalTitle')}</span>
          </div>
          <button id="modal-close" class="modal-close-btn">&times;</button>
        </div>

        <!-- Body -->
        <div style="padding: 20px; max-height: 70vh; overflow-y: auto; display: flex; flex-direction: column; gap: 16px;">
          <!-- 1. Modo de Exibição -->
          <div id="overlay-mode-section" style="${this.currentMinimalistMode ? 'opacity: 0.5; pointer-events: none;' : ''}">
            <label style="display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 8px;">
              ${t('overlay.sectionMode')}
            </label>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
              <div class="overlay-option-card ${this.currentMode === 'cameras-only' ? 'selected' : ''}" id="opt-mode-cameras" data-mode="cameras-only">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                  <span class="material-symbols-outlined md-18">videocam</span>
                  <span style="font-weight: 600; font-size: 13px;">${t('overlay.modeCamerasOnly')}</span>
                </div>
                <p style="margin: 0; font-size: 11px; color: var(--text-muted); line-height: 1.4;">${t('overlay.modeCamerasOnlyDesc')}</p>
              </div>

              <div class="overlay-option-card ${this.currentMode === 'cameras-and-screens' ? 'selected' : ''}" id="opt-mode-both" data-mode="cameras-and-screens">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                  <span class="material-symbols-outlined md-18">screen_share</span>
                  <span style="font-weight: 600; font-size: 13px;">${t('overlay.modeCamerasAndScreens')}</span>
                </div>
                <p style="margin: 0; font-size: 11px; color: var(--text-muted); line-height: 1.4;">${t('overlay.modeCamerasAndScreensDesc')}</p>
              </div>
            </div>

            <!-- Switch de Foco no Orador Ativo (quando cameras-only) -->
            <div id="overlay-focus-speaker-row" style="margin-top: 10px; display: ${this.currentMode === 'cameras-only' && !this.currentMinimalistMode ? 'flex' : 'none'}; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 10px 14px;">
              <div style="display: flex; align-items: center; gap: 8px;">
                <span class="material-symbols-outlined md-18" style="color: var(--primary);">record_voice_over</span>
                <div>
                  <div style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${t('overlay.focusActiveSpeakerTitle')}</div>
                  <div style="font-size: 11px; color: var(--text-muted);">${t('overlay.focusActiveSpeakerDesc')}</div>
                </div>
              </div>
              <label class="toggle-switch" aria-label="${t('overlay.focusActiveSpeakerTitle')}">
                <input type="checkbox" id="overlay-focus-speaker-cb" ${this.currentFocusActiveSpeaker ? 'checked' : ''} />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>

          <div class="overlay-aspect-option" style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 10px 14px;">
            <div style="display: flex; align-items: center; gap: 8px; min-width: 0;">
              <span class="material-symbols-outlined md-18" style="color: var(--text-secondary);" aria-hidden="true">aspect_ratio</span>
              <div style="min-width: 0;">
                <label id="overlay-aspect-label" for="overlay-aspect-ratio" style="display: block; font-size: 12px; font-weight: 600; color: var(--text-primary); cursor: pointer;">${t('overlay.preserveAspectRatio')}</label>
                <div id="overlay-aspect-description" style="font-size: 11px; color: var(--text-muted);">${t('overlay.preserveAspectRatioDesc')}</div>
              </div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" role="switch" id="overlay-aspect-ratio" aria-labelledby="overlay-aspect-label"
                aria-describedby="overlay-aspect-description" ${this.currentPreserveAspectRatio ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <!-- 2. Switch Ocultar-me -->
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 10px 14px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="material-symbols-outlined md-18" style="color: var(--text-secondary);">visibility_off</span>
              <div>
                <div style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${t('overlay.hideSelfTitle')}</div>
                <div style="font-size: 11px; color: var(--text-muted);">${t('overlay.hideSelfDesc')}</div>
              </div>
            </div>
            <label class="toggle-switch" aria-label="${t('overlay.hideSelfTitle')}">
              <input type="checkbox" id="overlay-hide-self-cb" ${this.currentHideSelf ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <div class="overlay-visibility-option">
            <div class="overlay-visibility-description">
              <span class="material-symbols-outlined md-18" aria-hidden="true">picture_in_picture</span>
              <div>
                <label id="overlay-hide-stage-label" for="overlay-hide-stage-cb">${t('overlay.hideStagePreviewsTitle')}</label>
                <div id="overlay-hide-stage-description">${t('overlay.hideStagePreviewsDesc')}</div>
              </div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" role="switch" id="overlay-hide-stage-cb" aria-labelledby="overlay-hide-stage-label"
                aria-describedby="overlay-hide-stage-description" ${this.currentHideStagePreviews ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>
          <div class="overlay-visibility-option">
            <div class="overlay-visibility-description">
              <span class="material-symbols-outlined md-18" aria-hidden="true">videocam_off</span>
              <div>
                <label id="overlay-hide-inactive-label" for="overlay-hide-inactive-cb">${t('overlay.hideInactiveParticipantsTitle')}</label>
                <div id="overlay-hide-inactive-description">${t('overlay.hideInactiveParticipantsDesc')}</div>
              </div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" role="switch" id="overlay-hide-inactive-cb" aria-labelledby="overlay-hide-inactive-label"
                aria-describedby="overlay-hide-inactive-description" ${this.currentHideInactiveParticipants ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- 3. Switch Modo Minimalista -->
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 10px 14px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="material-symbols-outlined md-18" style="color: var(--warning);">view_compact</span>
              <div>
                <div style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${t('overlay.minimalistModeTitle')}</div>
                <div style="font-size: 11px; color: var(--text-muted);">${t('overlay.minimalistModeDesc')}</div>
              </div>
            </div>
            <label class="toggle-switch" aria-label="${t('overlay.minimalistModeTitle')}">
              <input type="checkbox" id="overlay-minimalist-cb" ${this.currentMinimalistMode ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- 4. Switch Ativar ao Sair do Palco -->
          <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; background: var(--bg-card); border: 1px solid var(--border-color); border-radius: var(--radius-md); padding: 10px 14px;">
            <div style="display: flex; align-items: center; gap: 8px;">
              <span class="material-symbols-outlined md-18" style="color: var(--success);">smart_toy</span>
              <div>
                <div style="font-size: 12px; font-weight: 600; color: var(--text-primary);">${t('overlay.autoOpenOnLeaveStageTitle')}</div>
                <div style="font-size: 11px; color: var(--text-muted);">${t('overlay.autoOpenOnLeaveStageDesc')}</div>
              </div>
            </div>
            <label class="toggle-switch" aria-label="${t('overlay.autoOpenOnLeaveStageTitle')}">
              <input type="checkbox" id="overlay-auto-open-cb" ${this.currentAutoOpenOnLeaveStage ? 'checked' : ''} />
              <span class="toggle-slider"></span>
            </label>
          </div>

          <!-- 5. Disposição dos Cards -->
          <div>
            <label style="display: block; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin-bottom: 8px;">
              ${t('overlay.sectionLayout')}
            </label>
            <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
              <div class="overlay-option-card ${this.currentLayout === 'grid' ? 'selected' : ''}" id="opt-layout-grid" data-layout="grid" style="text-align: center; align-items: center;">
                <span class="material-symbols-outlined md-20" style="margin-bottom: 4px;">grid_view</span>
                <span style="font-size: 12px; font-weight: 600;">${t('overlay.layoutGrid')}</span>
              </div>
              <div class="overlay-option-card ${this.currentLayout === 'vertical' ? 'selected' : ''}" id="opt-layout-vertical" data-layout="vertical" style="text-align: center; align-items: center;">
                <span class="material-symbols-outlined md-20" style="margin-bottom: 4px;">view_agenda</span>
                <span style="font-size: 12px; font-weight: 600;">${t('overlay.layoutVertical')}</span>
              </div>
              <div class="overlay-option-card ${this.currentLayout === 'horizontal' ? 'selected' : ''}" id="opt-layout-horizontal" data-layout="horizontal" style="text-align: center; align-items: center;">
                <span class="material-symbols-outlined md-20" style="margin-bottom: 4px;">view_column</span>
                <span style="font-size: 12px; font-weight: 600;">${t('overlay.layoutHorizontal')}</span>
              </div>
            </div>
          </div>

          <!-- 6. Posição na Tela & Redimensionamento -->
          <div>
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;">
              <label style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin: 0;">
                ${t('overlay.sectionPosition')}
              </label>
              <button type="button" id="btn-overlay-reset-size" class="btn btn-secondary btn-sm" style="display: ${overlaySizeChanged ? 'inline-flex' : 'none'}; align-items: center; gap: 4px; padding: 3px 8px; font-size: 11px; height: 26px;">
                <span class="material-symbols-outlined md-14">restart_alt</span>
                <span>${t('overlay.resetSizeBtn')}</span>
              </button>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
              <button type="button" class="btn overlay-pos-btn ${this.currentPosition === 'top-left' ? 'selected' : ''}" data-pos="top-left">
                <span class="material-symbols-outlined md-16">north_west</span>
                <span>${t('overlay.posTopLeft')}</span>
              </button>
              <button type="button" class="btn overlay-pos-btn ${this.currentPosition === 'top-right' ? 'selected' : ''}" data-pos="top-right">
                <span class="material-symbols-outlined md-16">north_east</span>
                <span>${t('overlay.posTopRight')}</span>
              </button>
              <button type="button" class="btn overlay-pos-btn ${this.currentPosition === 'bottom-left' ? 'selected' : ''}" data-pos="bottom-left">
                <span class="material-symbols-outlined md-16">south_west</span>
                <span>${t('overlay.posBottomLeft')}</span>
              </button>
              <button type="button" class="btn overlay-pos-btn ${this.currentPosition === 'bottom-right' ? 'selected' : ''}" data-pos="bottom-right">
                <span class="material-symbols-outlined md-16">south_east</span>
                <span>${t('overlay.posBottomRight')}</span>
              </button>
            </div>
          </div>

          <!-- 7. Opacidade dos Cards -->
          <div id="overlay-opacity-group">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
              <label style="font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-muted); margin: 0;">
                ${t('overlay.sectionOpacity')}
              </label>
              <span id="overlay-opacity-value-label" style="font-size: 12px; font-weight: 700; color: var(--primary);">
                ${this.currentCardOpacity}%
              </span>
            </div>
            <input type="range" id="overlay-opacity-slider" min="20" max="100" value="${this.currentCardOpacity}" style="width: 100%; accent-color: var(--primary); cursor: pointer;" />
            <div style="display: flex; justify-content: space-between; font-size: 10px; color: var(--text-muted); margin-top: 4px;">
              <span>${t('overlay.opacityTranslucent')} (20%)</span>
              <span>${t('overlay.opacitySolid')} (100%)</span>
            </div>
          </div>
        </div>

        <!-- Footer -->
        <div class="modal-footer" id="overlay-modal-footer" style="padding: 14px 20px; border-top: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; background: var(--bg-tertiary); gap: 12px;">
          ${this.renderFooterHtml()}
        </div>
      </div>
    `;

    document.body.appendChild(this.modalEl);
    this.attachEvents();

    // Resizing the overlay window while this modal is open must reveal (or hide)
    // the "reset size" control right away — before this it only re-evaluated when
    // the modal was closed and reopened (#543).
    const unbindSettings = appEvents.on('overlay_settings.updated', () => {
      this.refreshResetSizeButton();
      if (!this.positionChanged) {
        this.currentPosition = settingsStore.getOverlayConfig().position;
        this.modalEl?.querySelectorAll<HTMLElement>('.overlay-pos-btn').forEach(btn => {
          btn.classList.toggle('selected', btn.dataset.pos === this.currentPosition);
        });
      }
    });
    const unbindState = appEvents.on('overlay.state_changed', () => this.refreshFooter());
    this.overlaySettingsUnbind = () => {
      unbindSettings();
      unbindState();
    };
  }

  private refreshResetSizeButton(): void {
    const btn = this.modalEl?.querySelector('#btn-overlay-reset-size') as HTMLElement | null;
    if (!btn) return;
    const overlaySizeChanged = isOverlayCardSizeCustom(settingsStore.getOverlayConfig());
    btn.style.display = overlaySizeChanged ? 'inline-flex' : 'none';
  }

  /**
   * The footer follows whether the overlay is *active*, not whether its window
   * happens to be up: with "open on leaving the stage" armed, the window is
   * closed precisely while this modal is on screen, and offering "Start
   * overlay" there would be a lie (#169).
   */
  private renderFooterHtml(): string {
    const isActive = this.isOverlayActive();
    return `
      <div>
        ${isActive ? `
          <button type="button" id="btn-overlay-modal-close-window" class="btn btn-danger" style="display: inline-flex; align-items: center; gap: 6px; padding: 0 16px; height: 38px; flex-shrink: 0; white-space: nowrap;">
            <span class="material-symbols-outlined md-16">close</span>
            <span>${t('overlay.stopOverlayBtn')}</span>
          </button>
        ` : ''}
      </div>
      <div style="display: flex; align-items: center; gap: 8px;">
        <button type="button" id="btn-overlay-modal-apply" class="btn btn-primary" style="display: inline-flex; align-items: center; gap: 6px; padding: 0 20px; height: 38px; font-weight: 600; flex-shrink: 0; white-space: nowrap;">
          <span class="material-symbols-outlined md-16">${isActive ? 'check' : 'rocket_launch'}</span>
          <span>${isActive ? t('common.done') : t('overlay.startOverlayBtn')}</span>
        </button>
      </div>
    `;
  }

  /** Active means "showing now" or "armed to show when the stage is left". */
  private isOverlayActive(): boolean {
    return overlayBridgeService.getIsOpen() || this.currentAutoOpenOnLeaveStage;
  }

  private refreshFooter(): void {
    const footer = this.modalEl?.querySelector('#overlay-modal-footer') as HTMLElement | null;
    if (!footer) return;
    footer.innerHTML = this.renderFooterHtml();
    this.attachFooterEvents();
  }

  public close(): void {
    if (this.overlaySettingsUnbind) {
      this.overlaySettingsUnbind();
      this.overlaySettingsUnbind = null;
    }
    if (this.modalEl) {
      this.modalEl.remove();
      this.modalEl = null;
    }
  }

  private attachEvents(): void {
    if (!this.modalEl) return;

    // Fechar no X ou clique fora no backdrop
    this.modalEl.querySelector('#modal-close')?.addEventListener('click', () => this.close());
    this.modalEl.addEventListener('click', (e) => {
      if (e.target === this.modalEl) this.close();
    });
    this.attachFooterEvents();

    const aspectRatio = this.modalEl.querySelector<HTMLInputElement>('#overlay-aspect-ratio');
    aspectRatio?.addEventListener('change', () => {
      this.currentPreserveAspectRatio = aspectRatio.checked;
      this.syncLiveIfActive();
    });
    // Seleção de modo
    const modeCards = this.modalEl.querySelectorAll('.overlay-option-card[data-mode]');
    const focusWrapper = this.modalEl.querySelector('#overlay-focus-speaker-row') as HTMLElement | null;
    modeCards.forEach((card) => {
      card.addEventListener('click', () => {
        modeCards.forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        this.currentMode = card.getAttribute('data-mode') as OverlayMode;
        if (focusWrapper) {
          focusWrapper.style.display = this.currentMode === 'cameras-only' && !this.currentMinimalistMode ? 'flex' : 'none';
        }
        this.syncLiveIfActive();
      });
    });

    // Toggle foco no orador ativo
    const chkFocus = this.modalEl.querySelector('#overlay-focus-speaker-cb') as HTMLInputElement | null;
    chkFocus?.addEventListener('change', () => {
      this.currentFocusActiveSpeaker = chkFocus.checked;
      this.syncLiveIfActive();
    });

    // Toggle Modo Minimalista
    const chkMinimalist = this.modalEl.querySelector('#overlay-minimalist-cb') as HTMLInputElement | null;
    const modeSection = this.modalEl.querySelector('#overlay-mode-section') as HTMLElement | null;
    chkMinimalist?.addEventListener('change', () => {
      this.currentMinimalistMode = chkMinimalist.checked;
      if (modeSection) {
        modeSection.style.opacity = this.currentMinimalistMode ? '0.5' : '1';
        modeSection.style.pointerEvents = this.currentMinimalistMode ? 'none' : 'auto';
      }
      if (focusWrapper) {
        focusWrapper.style.display = this.currentMode === 'cameras-only' && !this.currentMinimalistMode ? 'flex' : 'none';
      }
      this.syncLiveIfActive();
    });

    // Toggle Ativar ao Sair do Palco
    const chkAutoOpen = this.modalEl.querySelector('#overlay-auto-open-cb') as HTMLInputElement | null;
    chkAutoOpen?.addEventListener('change', () => {
      this.currentAutoOpenOnLeaveStage = chkAutoOpen.checked;
      this.saveCurrentConfig();
      // Arming the overlay makes it active right away, so the footer has to stop
      // offering "Start overlay" (#169).
      this.refreshFooter();
    });

    // Toggle Ocultar-me
    const chkHideSelf = this.modalEl.querySelector('#overlay-hide-self-cb') as HTMLInputElement | null;
    chkHideSelf?.addEventListener('change', () => {
      this.currentHideSelf = chkHideSelf.checked;
      this.syncLiveIfActive();
    });
    const hideStage = this.modalEl.querySelector<HTMLInputElement>('#overlay-hide-stage-cb');
    hideStage?.addEventListener('change', () => {
      this.currentHideStagePreviews = hideStage.checked;
      this.syncLiveIfActive();
    });
    const hideInactive = this.modalEl.querySelector<HTMLInputElement>('#overlay-hide-inactive-cb');
    hideInactive?.addEventListener('change', () => {
      this.currentHideInactiveParticipants = hideInactive.checked;
      this.syncLiveIfActive();
    });

    // Seleção de layout
    const layoutCards = this.modalEl.querySelectorAll('.overlay-option-card[data-layout]');
    layoutCards.forEach((card) => {
      card.addEventListener('click', () => {
        layoutCards.forEach((c) => c.classList.remove('selected'));
        card.classList.add('selected');
        this.currentLayout = card.getAttribute('data-layout') as OverlayLayout;
        this.syncLiveIfActive();
      });
    });

    // Seleção de posição
    const posButtons = this.modalEl.querySelectorAll('.overlay-pos-btn');
    posButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        posButtons.forEach((b) => b.classList.remove('selected'));
        btn.classList.add('selected');
        this.currentPosition = btn.getAttribute('data-pos') as OverlayPosition;
        this.positionChanged = true;
        this.syncLiveIfActive();
      });
    });

    // Botão Resetar Tamanho Padrão
    const btnResetSize = this.modalEl.querySelector('#btn-overlay-reset-size');
    btnResetSize?.addEventListener('click', () => {
      if (window.api?.resetOverlayBounds) {
        window.api.resetOverlayBounds().catch(() => {});
      }
      this.syncLiveIfActive();
    });

    // Slider de opacidade
    const opacitySlider = this.modalEl.querySelector('#overlay-opacity-slider') as HTMLInputElement | null;
    const opacityLabel = this.modalEl.querySelector('#overlay-opacity-value-label');
    opacitySlider?.addEventListener('input', () => {
      this.currentCardOpacity = parseInt(opacitySlider.value, 10);
      if (opacityLabel) opacityLabel.textContent = `${this.currentCardOpacity}%`;
      this.syncLiveIfActive();
    });
  }

  private attachFooterEvents(): void {
    if (!this.modalEl) return;

    // Botão Parar Sobreposição (desarma o modo automático e fecha a janela)
    const btnCloseWindow = this.modalEl.querySelector('#btn-overlay-modal-close-window');
    btnCloseWindow?.addEventListener('click', async () => {
      await overlayBridgeService.deactivate();
      this.close();
    });

    // Botão Ativar / Pronto
    const btnApply = this.modalEl.querySelector('#btn-overlay-modal-apply');
    btnApply?.addEventListener('click', async () => {
      if (!this.isOverlayActive()) {
        this.saveCurrentConfig();
        await overlayBridgeService.open(settingsStore.getOverlayConfig());
      }
      this.close();
    });
  }

  private syncLiveIfActive(): void {
    if (this.isOverlayActive()) this.syncLive();
  }

  private saveCurrentConfig(): Partial<OverlayConfig> {
    const config: Partial<OverlayConfig> = {
      mode: this.currentMode,
      layout: this.currentLayout,
      ...(this.positionChanged ? { position: this.currentPosition } : {}),
      cardOpacity: this.currentCardOpacity / 100,
      focusActiveSpeaker: this.currentFocusActiveSpeaker,
      autoOpenOnLeaveStage: this.currentAutoOpenOnLeaveStage,
      minimalistMode: this.currentMinimalistMode,
      hideSelf: this.currentHideSelf,
      hideStagePreviews: this.currentHideStagePreviews,
      hideInactiveParticipants: this.currentHideInactiveParticipants,
      preserveAspectRatio: this.currentPreserveAspectRatio,
    };
    settingsStore.setOverlayConfig(config);
    this.positionChanged = false;
    return config;
  }

  private syncLive(): void {
    const config = this.saveCurrentConfig();
    if (window.api?.setOverlayConfig) {
      window.api.setOverlayConfig(config).catch(() => {});
    }
    overlayBridgeService.syncState();
  }
}

export const overlayConfigModal = new OverlayConfigModal();
