import { videoService, type CameraPreviewLease, type CameraState } from '../../core/VideoService';
import { cameraEffectsStore } from '../../stores/cameraEffectsStore';
import {
  CAMERA_EFFECT_MODES, CameraEffectError, isCameraEffectMode, isCameraOperationCancelled, needsBackgroundImage,
  needsPersonSegmentation, type CameraEffectMode, type CameraEffectSettings,
} from '../../utils/cameraEffects';
import { CameraPreferenceError, cameraDeviceSelectionError, selectCameraDevice } from './CameraDeviceSelection';
import { ColorPicker } from '../ColorPicker';
import { escapeHtml } from '../../utils/html';
import { t, type TranslationKey } from '../../i18n';
import licenseUrl from '../../assets/camera-effects/LICENSE?url';
import sourcesUrl from '../../assets/camera-effects/SOURCES.json?url';
import './cameraEffects.css';

const modeLabels: Record<CameraEffectMode, TranslationKey> = {
  off: 'cameraEffects.modeOff',
  blur: 'cameraEffects.modeBlur',
  color: 'cameraEffects.modeColor',
  image: 'cameraEffects.modeImage',
  chroma: 'cameraEffects.modeChroma',
};

const modeDescriptions: Record<CameraEffectMode, TranslationKey> = {
  off: 'cameraEffects.offDescription',
  blur: 'cameraEffects.blurDescription',
  color: 'cameraEffects.colorDescription',
  image: 'cameraEffects.imageDescription',
  chroma: 'cameraEffects.chromaDescription',
};

const icons: Record<CameraEffectMode, string> = {
  off: 'videocam', blur: 'blur_on', color: 'palette', image: 'image', chroma: 'filter_center_focus',
};

const ranges = [
  { setting: 'blurRadius', label: 'cameraEffects.blurStrength', help: 'cameraEffects.blurStrengthHelp', min: 4, max: 32, unit: 'cameraEffects.pixels' },
  { setting: 'personThreshold', label: 'cameraEffects.personThreshold', help: 'cameraEffects.personThresholdHelp', min: 30, max: 90, unit: 'cameraEffects.percentage' },
  { setting: 'edgeSoftness', label: 'cameraEffects.edgeSoftness', help: 'cameraEffects.edgeSoftnessHelp', min: 0, max: 20, unit: 'cameraEffects.percentage' },
  { setting: 'keyTolerance', label: 'cameraEffects.keyTolerance', help: 'cameraEffects.keyToleranceHelp', min: 5, max: 60, unit: 'cameraEffects.percentage' },
  { setting: 'keySoftness', label: 'cameraEffects.keySoftness', help: 'cameraEffects.keySoftnessHelp', min: 1, max: 30, unit: 'cameraEffects.percentage' },
  { setting: 'spillReduction', label: 'cameraEffects.spillReduction', help: 'cameraEffects.spillReductionHelp', min: 0, max: 100, unit: 'cameraEffects.percentage' },
] as const;

export class CameraEffectsControl {
  private root: HTMLElement | null = null;
  private unbind: Array<() => void> = [];
  private generation = 0;
  private busy = false;
  private activeActions = 0;
  private failure: unknown = null;
  private previewWanted = false;
  private previewEnabled = false;
  private active = false;
  private intersecting = false;
  private previewGeneration = 0;
  private previewPlaybackGeneration = 0;
  private previewAbort: AbortController | null = null;
  private previewLease: CameraPreviewLease | null = null;
  private thumbnailUrl: string | null = null;
  private thumbnailId: string | null = null;
  private readonly colorPickers: Record<'keyColor' | 'backgroundColor', ColorPicker>;

  public constructor(private readonly prefix = '') {
    this.colorPickers = {
      keyColor: new ColorPicker({
        id: this.id('camera-effect-keyColor'), name: 'keyColor', label: 'cameraEffects.keyColor',
        describedBy: this.id('camera-effect-keyColor-help'),
        presets: ['#00ff00', '#0000ff', '#ff0000', '#00ffff', '#ff00ff', '#ffff00'],
      }),
      backgroundColor: new ColorPicker({
        id: this.id('camera-effect-backgroundColor'), name: 'backgroundColor', label: 'cameraEffects.backgroundColor',
        describedBy: this.id('camera-effect-backgroundColor-help'),
      }),
    };
  }

  private id(name: string): string {
    return this.prefix ? `${this.prefix}-${name}` : name;
  }

  private element<T extends Element>(id: string): T | null {
    return this.root?.querySelector<T>(`#${CSS.escape(this.id(id))}`) ?? null;
  }

  public renderHtml(): string {
    const settings = cameraEffectsStore.snapshot.settings;
    const helpId = (setting: string) => this.id(`camera-effect-${setting}-help`);
    const help = (setting: string, label: TranslationKey, description: TranslationKey) => `
      <button type="button" class="camera-effects-help" data-camera-help="${setting}"
        data-tooltip-source="${helpId(setting)}" aria-label="${escapeHtml(t('cameraEffects.adjustmentHelp', { name: t(label) }))}">
        <span aria-hidden="true">?</span>
      </button>
      <span id="${helpId(setting)}" hidden>${escapeHtml(t(description))}</span>`;
    const range = (setting: typeof ranges[number]['setting']) => {
      const field = ranges.find((entry) => entry.setting === setting);
      if (!field) throw new Error('Camera range definition is missing');
      const id = this.id(`camera-effect-${field.setting}`);
      return `<div class="camera-effects-field">
        <div class="camera-effects-field-heading">
          <span class="camera-effects-label">
            <label for="${id}">${t(field.label)}</label>${help(field.setting, field.label, field.help)}
          </span>
          <output id="${id}-value" for="${id}">${t(field.unit, { value: settings[field.setting] })}</output>
        </div>
        <input id="${id}" data-camera-setting="${field.setting}" class="sb-slider" type="range"
          min="${field.min}" max="${field.max}" step="1" value="${settings[field.setting]}" aria-describedby="${helpId(field.setting)} ${this.id('camera-effects-status')}">
      </div>`;
    };
    return `
      <section id="${this.id('camera-effects')}" class="camera-effects">
        <div class="camera-effects-preview-controls">
          <span id="${this.id('camera-effects-preview-label')}">${t('cameraEffects.showPreview')}</span>
          <button type="button" class="camera-effects-switch camera-effects-preview-toggle" data-camera-preview-toggle role="switch" aria-checked="false"
            aria-labelledby="${this.id('camera-effects-preview-label')}" aria-controls="${this.id('camera-effects-preview-frame')}"
            aria-describedby="${this.id('camera-effects-preview-hint')} ${this.id('camera-effects-status')}"><span aria-hidden="true"></span></button>
        </div>
        <div id="${this.id('camera-effects-preview-frame')}" class="camera-effects-preview-frame" data-camera-preview-frame>
          <video id="${this.id('camera-effects-preview')}" class="camera-effects-preview" autoplay playsinline muted hidden aria-label="${escapeHtml(t('settings.previewCamera'))}"></video>
          <div class="camera-effects-preview-placeholder" data-camera-preview-placeholder>${t('cameraEffects.previewOff')}</div>
        </div>
        <p id="${this.id('camera-effects-preview-hint')}" class="camera-effects-hint">${t('cameraEffects.previewHint')}</p>
        <div id="${this.id('camera-effects-status')}" class="camera-effects-status" role="status" aria-live="polite"></div>
        <div class="camera-effects-actions" data-camera-error-actions hidden>
          <button type="button" class="btn btn-secondary" data-camera-retry>${t('cameraEffects.retryPreview')}</button>
          <button type="button" class="btn btn-secondary" data-camera-disable>${t('cameraEffects.disableEffect')}</button>
        </div>
        <div data-settings-section="camera-effects" data-settings-label="${escapeHtml(t('cameraEffects.title'))}">
        <h3>${t('cameraEffects.title')}</h3>
        <p class="camera-effects-hint" id="${this.id('camera-effects-local')}">${t('cameraEffects.localOnly')}</p>
        <div class="camera-effects-cards" role="group" aria-label="${escapeHtml(t('cameraEffects.title'))}" aria-describedby="${this.id('camera-effects-local')} ${this.id('camera-effects-description')}">
          ${CAMERA_EFFECT_MODES.map((mode) => `
            <button class="voice-mode-card camera-effect-card" type="button" data-camera-mode="${mode}" aria-pressed="${settings.mode === mode}">
              <span class="material-symbols-outlined md-20" aria-hidden="true">${icons[mode]}</span>
              <span>${t(modeLabels[mode])}</span>
            </button>`).join('')}
        </div>
        <p id="${this.id('camera-effects-description')}" class="camera-effects-hint">${t(modeDescriptions[settings.mode])}</p>
        <div data-camera-panel="blur" hidden>${range('blurRadius')}</div>
        <div data-camera-panel="person" hidden>
          ${range('personThreshold')}${range('edgeSoftness')}
          <p class="camera-effects-hint">${t('cameraEffects.approximation')}</p>
        </div>
        <div data-camera-panel="chroma" hidden>
          <div class="camera-effects-color-row">
            <span class="camera-effects-label">
              <label for="${this.id('camera-effect-keyColor')}">${t('cameraEffects.keyColor')}</label>
              ${help('keyColor', 'cameraEffects.keyColor', 'cameraEffects.keyColorHelp')}
            </span>
            ${this.colorPickers.keyColor.renderHtml(settings.keyColor)}
          </div>
          ${range('keyTolerance')}${range('keySoftness')}${range('spillReduction')}
          <div class="camera-effects-field-heading">
            <span class="camera-effects-label">
              <span id="${this.id('camera-effects-replacement-label')}">${t('cameraEffects.chromaReplacement')}</span>
              ${help('backgroundSource', 'cameraEffects.chromaReplacement', 'cameraEffects.chromaReplacementHelp')}
            </span>
          </div>
          <div class="camera-effects-cards camera-effects-background-cards" role="group"
            aria-labelledby="${this.id('camera-effects-replacement-label')}" aria-describedby="${helpId('backgroundSource')}">
            <button type="button" class="voice-mode-card camera-effect-card" data-camera-background="color" aria-pressed="${settings.backgroundSource === 'color'}">${t('cameraEffects.replacementColor')}</button>
            <button type="button" class="voice-mode-card camera-effect-card" data-camera-background="image" aria-pressed="${settings.backgroundSource === 'image'}">${t('cameraEffects.replacementImage')}</button>
          </div>
          <p class="camera-effects-hint">${t('cameraEffects.chromaCompositeHint')}</p>
        </div>
        <div data-camera-panel="color" class="camera-effects-color-row" hidden>
          <span class="camera-effects-label">
            <label for="${this.id('camera-effect-backgroundColor')}">${t('cameraEffects.backgroundColor')}</label>
            ${help('backgroundColor', 'cameraEffects.backgroundColor', 'cameraEffects.backgroundColorHelp')}
          </span>
          ${this.colorPickers.backgroundColor.renderHtml(settings.backgroundColor)}
        </div>
        <div data-camera-panel="image" hidden>
          <div class="camera-effects-field-heading">
            <span class="camera-effects-label">
              <span>${t('cameraEffects.modeImage')}</span>
              ${help('backgroundImage', 'cameraEffects.modeImage', 'cameraEffects.imageHelp')}
            </span>
          </div>
          <div class="camera-effects-image-row">
            <img id="${this.id('camera-effects-image-preview')}" alt="${escapeHtml(t('cameraEffects.imagePreview'))}" hidden>
            <span id="${this.id('camera-effects-image-name')}" class="camera-effects-hint"></span>
          </div>
          <div class="camera-effects-actions">
            <button type="button" class="btn btn-secondary" data-camera-pick-image aria-controls="${this.id('camera-effects-file')}" aria-describedby="${helpId('backgroundImage')}">${t('cameraEffects.chooseImage')}</button>
            <button type="button" class="btn btn-secondary" data-camera-remove-image aria-describedby="${helpId('backgroundImage')}">${t('cameraEffects.removeImage')}</button>
          </div>
          <input id="${this.id('camera-effects-file')}" type="file" accept="image/png,image/jpeg,image/webp" hidden>
          <p class="camera-effects-hint">${t('cameraEffects.imageHint')}</p>
        </div>
        <div data-camera-panel="performance" hidden>
          <div class="camera-effects-field-heading">
            <span class="camera-effects-label">
              <span id="${this.id('camera-effect-limitQuality-label')}">${t('cameraEffects.limitQuality')}</span>
              ${help('limitQuality', 'cameraEffects.limitQuality', 'cameraEffects.limitQualityHelp')}
            </span>
            <button id="${this.id('camera-effect-limitQuality')}" type="button" class="camera-effects-switch"
              data-camera-setting="limitQuality" data-camera-quality-limit role="switch" aria-checked="${settings.limitQuality}"
              aria-labelledby="${this.id('camera-effect-limitQuality-label')}"
              aria-describedby="${helpId('limitQuality')} ${this.id('camera-effects-status')}"><span aria-hidden="true"></span></button>
          </div>
          <p class="camera-effects-hint">${t('cameraEffects.performanceHint')}</p>
        </div>
        <div class="camera-effects-notices">
          <a href="${escapeHtml(licenseUrl)}" download="MediaPipe-LICENSE.txt">${t('cameraEffects.license')}</a>
          <a href="${escapeHtml(sourcesUrl)}" download="camera-effects-sources.json">${t('cameraEffects.sources')}</a>
        </div>
        </div>
      </section>`;
  }

  public attachEvents(container: HTMLElement): void {
    this.cleanup();
    const root = container.querySelector<HTMLElement>(`#${CSS.escape(this.id('camera-effects'))}`);
    if (!root) throw new Error('Camera effect controls are missing');
    this.root = root;
    const generation = this.generation;
    const bind = (element: Element, event: string, listener: EventListener) => {
      element.addEventListener(event, listener);
      this.unbind.push(() => element.removeEventListener(event, listener));
    };
    for (const card of root.querySelectorAll<HTMLButtonElement>('[data-camera-mode]')) {
      bind(card, 'click', () => {
        void this.apply(async () => {
          const mode = card.dataset.cameraMode;
          if (!isCameraEffectMode(mode)) {
            videoService.stopCamera();
            throw new CameraEffectError('settings');
          }
          await videoService.setCameraEffects({ mode });
        });
      });
    }
    for (const card of root.querySelectorAll<HTMLButtonElement>('[data-camera-background]')) {
      bind(card, 'click', () => {
        void this.apply(async () => {
          const backgroundSource = card.dataset.cameraBackground;
          if (backgroundSource !== 'color' && backgroundSource !== 'image') {
            videoService.stopCamera();
            throw new CameraEffectError('settings');
          }
          await videoService.setCameraEffects({ backgroundSource });
        });
      });
    }
    for (const field of ranges) {
      const input = this.element<HTMLInputElement>(`camera-effect-${field.setting}`);
      if (!input) continue;
      bind(input, 'input', () => this.showRangeValue(field.setting, Number(input.value)));
      bind(input, 'change', () => {
        const patch: Partial<CameraEffectSettings> = { [field.setting]: Number(input.value) };
        void this.apply(() => videoService.setCameraEffects(patch));
      });
    }
    for (const setting of ['backgroundColor', 'keyColor'] as const) {
      this.colorPickers[setting].attachEvents(root, color => {
        void this.apply(() => videoService.setCameraEffects({ [setting]: color }));
      });
    }
    const onClick = (selector: string, listener: () => void) => {
      const button = root.querySelector<HTMLButtonElement>(selector);
      if (button) bind(button, 'click', listener);
    };
    const fileInput = this.element<HTMLInputElement>('camera-effects-file');
    onClick('[data-camera-quality-limit]', () => {
      void this.apply(() => videoService.setCameraEffects({ limitQuality: !cameraEffectsStore.snapshot.settings.limitQuality }));
    });
    onClick('[data-camera-pick-image]', () => fileInput?.click());
    onClick('[data-camera-remove-image]', () => { void this.apply(() => videoService.removeCameraBackgroundImage()); });
    onClick('[data-camera-preview-toggle]', () => {
      if (this.previewEnabled) this.stopPreview();
      else this.showPreview();
    });
    onClick('[data-camera-retry]', () => this.showPreview());
    onClick('[data-camera-disable]', () => {
      void this.apply(async () => {
        videoService.stopCamera();
        await videoService.setCameraEffects({ mode: 'off' });
      });
    });
    if (fileInput) bind(fileInput, 'change', () => {
      const file = fileInput.files?.[0];
      fileInput.value = '';
      // A confirmed preference change outlives this UI; closing it only cancels its preview lease.
      if (file) void this.apply(() => videoService.setCameraBackgroundImage(file));
    });
    const observer = new IntersectionObserver(([entry]) => {
      if (generation !== this.generation || !entry) return;
      this.intersecting = entry.isIntersecting;
      this.updatePreviewVisibility();
    });
    observer.observe(root);
    const visibility = () => this.updatePreviewVisibility();
    document.addEventListener('visibilitychange', visibility);
    this.unbind.push(() => observer.disconnect(), () => document.removeEventListener('visibilitychange', visibility));
    this.unbind.push(videoService.subscribeCameraState((state) => this.cameraStateChanged(state)));
    void cameraEffectsStore.load().then(() => {
      if (generation === this.generation) this.refresh();
    }).catch((error: unknown) => {
      if (generation === this.generation) {
        this.failure = error;
        this.refresh();
      }
    });
    this.refresh();
  }

  public async changeDevice(deviceId: string): Promise<void> {
    await this.apply(() => selectCameraDevice(deviceId));
  }

  public activate(): void {
    if (this.active) return;
    this.showPreview();
  }

  public deactivate(): void {
    this.active = false;
    this.previewEnabled = false;
    this.releasePreview();
  }

  private showPreview(): void {
    this.active = true;
    this.previewEnabled = true;
    this.updatePreviewVisibility();
  }

  private previewIsVisible(): boolean {
    return this.active && this.previewEnabled && this.intersecting && document.visibilityState === 'visible'
      && !!this.root?.isConnected && this.root.checkVisibility({ checkVisibilityCSS: true });
  }

  private updatePreviewVisibility(): void {
    if (!this.previewIsVisible()) this.releasePreview();
    else if (!this.previewWanted) void this.startPreview();
    this.refreshStatus();
  }

  public stopPreview(): void {
    this.previewEnabled = false;
    this.releasePreview();
  }

  private releasePreview(): void {
    this.previewGeneration++;
    this.previewWanted = false;
    this.previewAbort?.abort();
    this.previewAbort = null;
    this.previewLease?.release();
    this.previewLease = null;
    this.setPreviewStream(null);
    this.refreshStatus();
  }

  public cleanup(): void {
    this.generation++;
    this.deactivate();
    this.previewEnabled = false;
    this.intersecting = false;
    this.unbind.forEach((off) => off());
    this.unbind = [];
    for (const picker of Object.values(this.colorPickers)) picker.cleanup();
    this.releaseThumbnail();
    this.root = null;
    this.busy = false;
    this.activeActions = 0;
    this.failure = null;
  }

  private async apply(action: () => Promise<void>): Promise<void> {
    const generation = this.generation;
    this.activeActions++;
    this.busy = true;
    this.failure = null;
    this.refresh();
    try {
      await action();
    } catch (error) {
      if (!isCameraOperationCancelled(error) && generation === this.generation) this.failure = error;
    } finally {
      if (generation === this.generation) {
        this.activeActions--;
        this.busy = this.activeActions > 0;
        this.refresh();
      }
    }
  }

  private async startPreview(): Promise<void> {
    if (!this.previewIsVisible()) return;
    this.releasePreview();
    this.failure = null;
    this.previewWanted = true;
    this.previewAbort = new AbortController();
    const generation = this.previewGeneration;
    this.refreshStatus();
    try {
      const lease = await videoService.acquireCameraPreview(this.previewAbort.signal);
      if (generation !== this.previewGeneration || !this.previewIsVisible()) {
        lease.release();
        return;
      }
      this.previewLease = lease;
      this.setPreviewStream(lease.stream);
      this.refreshStatus();
    } catch (error) {
      if (generation !== this.previewGeneration) return;
      this.stopPreview();
      if (!isCameraOperationCancelled(error)) this.failure = error;
      this.refreshStatus();
    }
  }

  private cameraStateChanged(state: CameraState): void {
    if (state.error) this.failure = state.error;
    else if (state.status === 'ready') this.failure = null;
    if (this.previewWanted) {
      if (state.status === 'idle' || state.status === 'error') this.stopPreview();
      else this.setPreviewStream(state.stream);
    }
    this.refresh();
  }

  private setPreviewStream(stream: MediaStream | null): void {
    const video = this.element<HTMLVideoElement>('camera-effects-preview');
    if (!video || video.srcObject === stream) return;
    const playback = ++this.previewPlaybackGeneration;
    video.pause();
    video.srcObject = stream;
    video.hidden = !stream;
    if (stream) {
      const generation = this.previewGeneration;
      void video.play().catch((error: unknown) => {
        if (generation === this.previewGeneration && playback === this.previewPlaybackGeneration && this.previewWanted) {
          this.stopPreview();
          this.failure = error;
          this.refreshStatus();
        }
      });
    } else {
      video.removeAttribute('src');
      video.load();
    }
  }

  private refresh(): void {
    const root = this.root;
    if (!root) return;
    const { settings, image } = cameraEffectsStore.snapshot;
    const loaded = cameraEffectsStore.isLoaded;
    for (const button of root.querySelectorAll<HTMLButtonElement>('button')) {
      if (button.closest('.color-picker')) continue;
      button.disabled = !button.hasAttribute('data-camera-help') && (this.busy || (!loaded && !this.failure));
    }
    for (const input of root.querySelectorAll<HTMLInputElement>('input')) {
      if (!input.closest('.color-picker')) input.disabled = this.busy || !loaded;
    }
    for (const card of root.querySelectorAll<HTMLButtonElement>('[data-camera-mode]')) {
      card.setAttribute('aria-pressed', String(card.dataset.cameraMode === settings.mode));
    }
    for (const card of root.querySelectorAll<HTMLButtonElement>('[data-camera-background]')) {
      card.setAttribute('aria-pressed', String(card.dataset.cameraBackground === settings.backgroundSource));
    }
    root.querySelector('[data-camera-quality-limit]')?.setAttribute('aria-checked', String(settings.limitQuality));
    const description = this.element<HTMLElement>('camera-effects-description');
    if (description) description.textContent = t(modeDescriptions[settings.mode]);
    const visible: Record<string, boolean> = {
      blur: settings.mode === 'blur',
      person: needsPersonSegmentation(settings.mode),
      chroma: settings.mode === 'chroma',
      color: settings.mode === 'color' || (settings.mode === 'chroma' && settings.backgroundSource === 'color'),
      image: needsBackgroundImage(settings),
      performance: settings.mode !== 'off',
    };
    for (const panel of root.querySelectorAll<HTMLElement>('[data-camera-panel]')) {
      panel.hidden = !visible[panel.dataset.cameraPanel ?? ''];
    }
    for (const field of ranges) {
      const input = this.element<HTMLInputElement>(`camera-effect-${field.setting}`);
      if (input) input.value = String(settings[field.setting]);
      this.showRangeValue(field.setting, settings[field.setting]);
    }
    for (const setting of ['backgroundColor', 'keyColor'] as const) {
      const picker = this.colorPickers[setting];
      picker.setValue(settings[setting], this.busy);
      picker.setDisabled(!loaded || (this.busy && !picker.isOpen));
    }
    const imageName = this.element<HTMLElement>('camera-effects-image-name');
    if (imageName) imageName.textContent = image?.name || t('cameraEffects.noImage');
    const remove = root.querySelector<HTMLButtonElement>('[data-camera-remove-image]');
    if (remove) remove.disabled = this.busy || !image;
    if (this.thumbnailId !== (image?.id ?? null)) {
      this.releaseThumbnail();
      const thumbnail = this.element<HTMLImageElement>('camera-effects-image-preview');
      if (thumbnail && image) {
        this.thumbnailUrl = URL.createObjectURL(image.blob);
        this.thumbnailId = image.id;
        thumbnail.src = this.thumbnailUrl;
        thumbnail.hidden = false;
      }
    }
    this.refreshStatus();
  }

  private showRangeValue(setting: typeof ranges[number]['setting'], value: number): void {
    const field = ranges.find((entry) => entry.setting === setting);
    if (!field || !this.root) return;
    const output = this.element<HTMLOutputElement>(`camera-effect-${setting}-value`);
    const input = this.element<HTMLInputElement>(`camera-effect-${setting}`);
    if (output) output.value = t(field.unit, { value });
    input?.setAttribute('aria-valuetext', t(field.unit, { value }));
    input?.style.setProperty('--slider-progress', `${(value - field.min) / (field.max - field.min) * 100}%`);
  }

  private refreshStatus(): void {
    if (!this.root) return;
    const state = videoService.getCameraState();
    const status = this.element<HTMLElement>('camera-effects-status');
    if (status) {
      status.textContent = this.failure ? cameraDeviceSelectionError(this.failure)
        : this.busy ? t('cameraEffects.applying')
          : !cameraEffectsStore.isLoaded ? t('cameraEffects.loading')
            : this.previewWanted ? t(state.status === 'ready' ? 'cameraEffects.previewActive' : 'cameraEffects.previewStarting')
              : '';
      status.classList.toggle('is-error', !!this.failure);
    }
    const toggle = this.root.querySelector<HTMLButtonElement>('[data-camera-preview-toggle]');
    if (toggle) {
      toggle.setAttribute('aria-checked', String(this.previewEnabled));
      if (this.previewEnabled) toggle.disabled = false;
    }
    const placeholder = this.root.querySelector<HTMLElement>('[data-camera-preview-placeholder]');
    if (placeholder) {
      placeholder.hidden = !!this.element<HTMLVideoElement>('camera-effects-preview')?.srcObject;
      placeholder.textContent = t(this.previewEnabled && this.active && !this.failure
        ? 'cameraEffects.previewStarting' : 'cameraEffects.previewOff');
    }
    const actions = this.root.querySelector<HTMLElement>('[data-camera-error-actions]');
    if (actions) actions.hidden = !this.failure || this.failure instanceof CameraPreferenceError;
  }

  private releaseThumbnail(): void {
    const thumbnail = this.element<HTMLImageElement>('camera-effects-image-preview');
    if (thumbnail) {
      thumbnail.removeAttribute('src');
      thumbnail.hidden = true;
    }
    if (this.thumbnailUrl) URL.revokeObjectURL(this.thumbnailUrl);
    this.thumbnailUrl = null;
    this.thumbnailId = null;
  }
}
