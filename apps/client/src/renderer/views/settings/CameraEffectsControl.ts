import { videoService, type CameraPreviewLease, type CameraState } from '../../core/VideoService';
import { cameraEffectsStore } from '../../stores/cameraEffectsStore';
import {
  CAMERA_BACKGROUND_ZOOM, CAMERA_EFFECT_MODES, CAMERA_FRAMING_KEYS, CAMERA_PERSON_FOCUS, CameraEffectError, DEFAULT_CAMERA_EFFECT_SETTINGS,
  backgroundImageRect, backgroundPositionForOffset, isCameraEffectMode, isCameraOperationCancelled, needsBackgroundImage,
  needsCameraProcessing, needsPersonSegmentation, zoomBackgroundAt, type CameraBackgroundFraming, type CameraEffectMode, type CameraEffectSettings,
  type CameraPersonFocus,
} from '../../utils/cameraEffects';
import { CameraPreferenceError, cameraDeviceSelectionError, selectCameraDevice } from './CameraDeviceSelection';
import { ColorPicker } from '../ColorPicker';
import { escapeHtml } from '../../utils/html';
import { t, type TranslationKey } from '../../i18n';
import licenseUrl from '../../assets/camera-effects/LICENSE?url';
import rvmLicenseUrl from '../../assets/camera-effects/RVM-LICENSE?url';
import sourcesUrl from '../../assets/camera-effects/SOURCES.json?url&no-inline';
import { openFileInputPicker } from '../../utils/buttonLoading';
import { setSurfaceVisible } from '../../utils/surfaceVisibility';
import { isShowingStream, showInlineStream } from '../../utils/inlineVideo';
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
  { setting: 'keyTolerance', label: 'cameraEffects.keyTolerance', help: 'cameraEffects.keyToleranceHelp', min: 5, max: 60, unit: 'cameraEffects.percentage' },
  { setting: 'keySoftness', label: 'cameraEffects.keySoftness', help: 'cameraEffects.keySoftnessHelp', min: 1, max: 30, unit: 'cameraEffects.percentage' },
  { setting: 'spillReduction', label: 'cameraEffects.spillReduction', help: 'cameraEffects.spillReductionHelp', min: 0, max: 100, unit: 'cameraEffects.percentage' },
  {
    setting: 'backgroundZoom', label: 'cameraEffects.backgroundZoom', help: 'cameraEffects.backgroundZoomHelp',
    min: CAMERA_BACKGROUND_ZOOM.min, max: CAMERA_BACKGROUND_ZOOM.max, unit: 'cameraEffects.percentage',
  },
] as const;

const focusChoices: ReadonlyArray<{ value: CameraPersonFocus; label: TranslationKey; icon: string }> = [
  { value: 'all', label: 'cameraEffects.focusAll', icon: 'groups' },
  { value: 'main', label: 'cameraEffects.focusMain', icon: 'person' },
];

/** Keyboard nudges and wheel zooms of the framing are saved together once they rest. */
const FRAMING_COMMIT_DELAY_MS = 500;
const FRAMING_KEY_STEP = 2;
const FRAMING_KEY_STEP_LARGE = 10;
/** Zoom change per wheel pixel: one mouse notch (~100 px) zooms about 20%. */
const FRAMING_WHEEL_RATE = 0.002;
const FRAMING_WHEEL_LINE_PX = 16;

function isCameraPersonFocus(value: unknown): value is CameraPersonFocus {
  return CAMERA_PERSON_FOCUS.some((focus) => focus === value);
}

function clampPosition(value: number): number {
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}


/** Which adjustment panels the chosen effect uses. */
function visiblePanels(settings: CameraEffectSettings): Record<string, boolean> {
  return {
    blur: settings.mode === 'blur',
    person: needsPersonSegmentation(settings.mode),
    chroma: settings.mode === 'chroma',
    color: settings.mode === 'color' || (settings.mode === 'chroma' && settings.backgroundSource === 'color'),
    image: needsBackgroundImage(settings),
    // The mirror alone also runs through the processor, so its limits apply too.
    performance: needsCameraProcessing(settings),
  };
}

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
  /** Framing shown while it is dragged, zoomed or nudged, before it is saved. */
  private framingDraft: Partial<CameraBackgroundFraming> | null = null;
  private framingTimer: ReturnType<typeof setTimeout> | null = null;
  private framingDrag: {
    pointerId: number; startX: number; startY: number;
    originX: number; originY: number; frameWidth: number; frameHeight: number; imageWidth: number; imageHeight: number;
  } | null = null;
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
    // Rendered as they are; only later changes unfold or fold with motion.
    const visible = visiblePanels(settings);
    const shown = (panel: string): string => visible[panel] ? '' : 'hidden';
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
        <div class="camera-effects-field-heading camera-effects-mirror-row">
          <span class="camera-effects-label">
            <span id="${this.id('camera-effect-mirror-label')}">${t('cameraEffects.mirror')}</span>
            ${help('mirror', 'cameraEffects.mirror', 'cameraEffects.mirrorHelp')}
          </span>
          <button id="${this.id('camera-effect-mirror')}" type="button" class="camera-effects-switch"
            data-camera-setting="mirror" data-camera-mirror role="switch" aria-checked="${settings.mirror}"
            aria-labelledby="${this.id('camera-effect-mirror-label')}"
            aria-describedby="${helpId('mirror')} ${this.id('camera-effects-status')}"><span aria-hidden="true"></span></button>
        </div>
        <div class="camera-effects-cards" role="group" aria-label="${escapeHtml(t('cameraEffects.title'))}" aria-describedby="${this.id('camera-effects-local')} ${this.id('camera-effects-description')}">
          ${CAMERA_EFFECT_MODES.map((mode) => `
            <button class="voice-mode-card camera-effect-card" type="button" data-camera-mode="${mode}" aria-pressed="${settings.mode === mode}">
              <span class="material-symbols-outlined md-20" aria-hidden="true">${icons[mode]}</span>
              <span>${t(modeLabels[mode])}</span>
            </button>`).join('')}
        </div>
        <p id="${this.id('camera-effects-description')}" class="camera-effects-hint">${t(modeDescriptions[settings.mode])}</p>
        <div data-camera-panel="blur" ${shown('blur')}>${range('blurRadius')}</div>
        <div data-camera-panel="person" ${shown('person')}>
          <div class="camera-effects-field-heading">
            <span class="camera-effects-label">
              <span id="${this.id('camera-effects-focus-label')}">${t('cameraEffects.personFocus')}</span>
              ${help('personFocus', 'cameraEffects.personFocus', 'cameraEffects.personFocusHelp')}
            </span>
          </div>
          <div class="camera-effects-cards camera-effects-pair" role="group"
            aria-labelledby="${this.id('camera-effects-focus-label')}" aria-describedby="${helpId('personFocus')}">
            ${focusChoices.map((choice) => `
              <button type="button" class="voice-mode-card camera-effect-card" data-camera-focus="${choice.value}" aria-pressed="${settings.personFocus === choice.value}">
                <span class="material-symbols-outlined md-20" aria-hidden="true">${choice.icon}</span>
                <span>${t(choice.label)}</span>
              </button>`).join('')}
          </div>
          <p class="camera-effects-hint">${t('cameraEffects.focusMainHint')}</p>
          <p class="camera-effects-hint">${t('cameraEffects.mattingHint')}</p>
          <p class="camera-effects-hint">${t('cameraEffects.approximation')}</p>
        </div>
        <div data-camera-panel="chroma" ${shown('chroma')}>
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
        <div data-camera-panel="color" class="camera-effects-color-row" ${shown('color')}>
          <span class="camera-effects-label">
            <label for="${this.id('camera-effect-backgroundColor')}">${t('cameraEffects.backgroundColor')}</label>
            ${help('backgroundColor', 'cameraEffects.backgroundColor', 'cameraEffects.backgroundColorHelp')}
          </span>
          ${this.colorPickers.backgroundColor.renderHtml(settings.backgroundColor)}
        </div>
        <div data-camera-panel="image" ${shown('image')}>
          <div class="camera-effects-field-heading">
            <span class="camera-effects-label">
              <span>${t('cameraEffects.modeImage')}</span>
              ${help('backgroundImage', 'cameraEffects.modeImage', 'cameraEffects.imageHelp')}
            </span>
          </div>
          <div class="camera-effects-image-row">
            <span id="${this.id('camera-effects-image-name')}" class="camera-effects-hint"></span>
          </div>
          <div class="camera-effects-actions">
            <button type="button" class="btn btn-secondary" data-camera-pick-image aria-controls="${this.id('camera-effects-file')}" aria-describedby="${helpId('backgroundImage')}">${t('cameraEffects.chooseImage')}</button>
            <button type="button" class="btn btn-secondary" data-camera-remove-image aria-describedby="${helpId('backgroundImage')}">${t('cameraEffects.removeImage')}</button>
          </div>
          <input id="${this.id('camera-effects-file')}" type="file" accept="image/png,image/jpeg,image/webp" hidden>
          <p class="camera-effects-hint">${t('cameraEffects.imageHint')}</p>
          <div class="camera-effects-framing" data-camera-framing ${cameraEffectsStore.snapshot.image ? '' : 'hidden'}>
            <div class="camera-effects-field-heading">
              <span class="camera-effects-label">
                <span id="${this.id('camera-effects-framing-label')}">${t('cameraEffects.framing')}</span>
                ${help('backgroundFraming', 'cameraEffects.framing', 'cameraEffects.framingHelp')}
              </span>
              <output id="${this.id('camera-effects-framing-value')}"></output>
            </div>
            <div id="${this.id('camera-effects-framing-frame')}" class="camera-effects-framing-frame" data-camera-framing-frame
              tabindex="0" role="group" aria-labelledby="${this.id('camera-effects-framing-label')}"
              aria-describedby="${this.id('camera-effects-framing-value')} ${helpId('backgroundFraming')}">
              <img id="${this.id('camera-effects-image-preview')}" alt="${escapeHtml(t('cameraEffects.imagePreview'))}" draggable="false" hidden>
              <span class="material-symbols-outlined md-18 camera-effects-framing-move" aria-hidden="true">open_with</span>
            </div>
            ${range('backgroundZoom')}
            <div class="camera-effects-actions">
              <button type="button" class="btn btn-secondary" data-camera-framing-reset>${t('cameraEffects.resetFraming')}</button>
            </div>
          </div>
        </div>
        <div data-camera-panel="performance" ${shown('performance')}>
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
          <a href="${escapeHtml(rvmLicenseUrl)}" download="RVM-LICENSE.txt">${t('cameraEffects.license')} (RVM)</a>
          <a href="${escapeHtml(licenseUrl)}" download="TensorFlow-LICENSE.txt">${t('cameraEffects.license')} (TensorFlow.js)</a>
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
          await this.changeEffects({ mode });
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
          await this.changeEffects({ backgroundSource });
        });
      });
    }
    for (const card of root.querySelectorAll<HTMLButtonElement>('[data-camera-focus]')) {
      bind(card, 'click', () => {
        void this.apply(async () => {
          const personFocus = card.dataset.cameraFocus;
          if (!isCameraPersonFocus(personFocus)) {
            videoService.stopCamera();
            throw new CameraEffectError('settings');
          }
          await videoService.setCameraEffects({ personFocus });
        });
      });
    }
    for (const field of ranges) {
      const input = this.element<HTMLInputElement>(`camera-effect-${field.setting}`);
      if (!input) continue;
      bind(input, 'input', () => {
        const value = Number(input.value);
        this.showRangeValue(field.setting, value);
        if (field.setting === 'backgroundZoom') this.draftFraming({ backgroundZoom: value });
      });
      bind(input, 'change', () => {
        if (field.setting === 'backgroundZoom') {
          this.draftFraming({ backgroundZoom: Number(input.value) });
          this.commitFraming();
          return;
        }
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
    onClick('[data-camera-mirror]', () => {
      void this.apply(() => videoService.setCameraEffects({ mirror: !cameraEffectsStore.snapshot.settings.mirror }));
    });
    onClick('[data-camera-framing-reset]', () => {
      this.draftFraming({
        backgroundZoom: DEFAULT_CAMERA_EFFECT_SETTINGS.backgroundZoom,
        backgroundPositionX: DEFAULT_CAMERA_EFFECT_SETTINGS.backgroundPositionX,
        backgroundPositionY: DEFAULT_CAMERA_EFFECT_SETTINGS.backgroundPositionY,
      });
      this.commitFraming();
    });
    this.bindFraming(bind);
    const imagePicker = root.querySelector<HTMLButtonElement>('[data-camera-pick-image]');
    onClick('[data-camera-pick-image]', () => openFileInputPicker(fileInput, imagePicker));
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
      if (generation === this.generation) {
        this.refresh();
        this.updatePreviewVisibility();
      }
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

  private get missingBackground(): boolean {
    const { settings, image } = cameraEffectsStore.snapshot;
    return cameraEffectsStore.isLoaded && needsBackgroundImage(settings) && !image;
  }

  private async changeEffects(patch: Partial<CameraEffectSettings>): Promise<void> {
    const { settings, image } = cameraEffectsStore.snapshot;
    if (needsBackgroundImage({ ...settings, ...patch }) && !image) {
      // An unfinished preference is editable, not a failed camera operation.
      this.stopPreview();
      videoService.stopCamera();
    }
    await videoService.setCameraEffects(patch);
  }

  /** Saved settings with the framing being edited on top. */
  private framingSettings(): CameraEffectSettings {
    return { ...cameraEffectsStore.snapshot.settings, ...this.framingDraft };
  }

  /** The image's place in the camera frame, in the camera profile's pixels. */
  private framingGeometry(): { frameWidth: number; frameHeight: number; rect: ReturnType<typeof backgroundImageRect> } | null {
    const image = this.element<HTMLImageElement>('camera-effects-image-preview');
    if (!image || image.hidden || !image.naturalWidth || !image.naturalHeight) return null;
    const { cameraWidth, cameraHeight } = videoService.getProfile();
    return {
      frameWidth: cameraWidth,
      frameHeight: cameraHeight,
      rect: backgroundImageRect(cameraWidth, cameraHeight, image.naturalWidth, image.naturalHeight, this.framingSettings()),
    };
  }

  private framingEditable(): boolean {
    return !this.busy && cameraEffectsStore.isLoaded && !!cameraEffectsStore.snapshot.image && this.framingGeometry() !== null;
  }

  private draftFraming(patch: Partial<CameraBackgroundFraming>): void {
    this.framingDraft = { ...this.framingDraft, ...patch };
    this.renderFraming();
  }

  private cancelFramingCommit(): void {
    if (this.framingTimer !== null) clearTimeout(this.framingTimer);
    this.framingTimer = null;
  }

  /** What the draft changes from the saved framing. */
  private framingChanges(): Partial<CameraBackgroundFraming> | null {
    const draft = this.framingDraft;
    if (!draft) return null;
    const saved = cameraEffectsStore.snapshot.settings;
    const changes: Partial<CameraBackgroundFraming> = {};
    for (const key of CAMERA_FRAMING_KEYS) {
      const value = draft[key];
      if (value !== undefined && value !== saved[key]) changes[key] = value;
    }
    return Object.keys(changes).length > 0 ? changes : null;
  }

  /**
   * A gesture is saved once, when it ends. Framing reaches the running camera without
   * reconfiguring it, so saving never marks the control busy: that would flash the editor.
   */
  private commitFraming(): void {
    this.cancelFramingCommit();
    const draft = this.framingDraft;
    const changes = this.framingChanges();
    if (!changes) {
      this.framingDraft = null;
      this.refresh();
      return;
    }
    const generation = this.generation;
    void videoService.setCameraEffects(changes).catch((error: unknown) => {
      if (!isCameraOperationCancelled(error) && generation === this.generation) this.failure = error;
    }).finally(() => {
      if (generation !== this.generation) return;
      if (this.framingDraft === draft) this.framingDraft = null;
      this.refresh();
    });
  }

  private bindFraming(bind: (element: Element, event: string, listener: EventListener) => void): void {
    const frame = this.element<HTMLElement>('camera-effects-framing-frame');
    const image = this.element<HTMLImageElement>('camera-effects-image-preview');
    if (!frame || !image) return;
    bind(image, 'load', () => this.renderFraming());
    bind(frame, 'pointerdown', (event) => {
      if (!(event instanceof PointerEvent) || event.button !== 0 || !this.framingEditable()) return;
      const geometry = this.framingGeometry();
      const box = frame.getBoundingClientRect();
      if (!geometry || box.width <= 0 || box.height <= 0) return;
      event.preventDefault();
      this.cancelFramingCommit();
      const scaleX = box.width / geometry.frameWidth;
      const scaleY = box.height / geometry.frameHeight;
      this.framingDrag = {
        pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
        originX: geometry.rect.x * scaleX, originY: geometry.rect.y * scaleY,
        frameWidth: box.width, frameHeight: box.height,
        imageWidth: geometry.rect.width * scaleX, imageHeight: geometry.rect.height * scaleY,
      };
      frame.setPointerCapture(event.pointerId);
      frame.focus({ preventScroll: true });
      frame.classList.add('is-dragging');
    });
    bind(frame, 'pointermove', (event) => {
      const drag = this.framingDrag;
      if (!(event instanceof PointerEvent) || !drag || event.pointerId !== drag.pointerId) return;
      const current = this.framingSettings();
      // An axis the image already fills exactly has nothing to move and keeps its value.
      const axis = (frameSize: number, imageSize: number, offset: number, value: number) => imageSize - frameSize > 0.5
        ? clampPosition(backgroundPositionForOffset(frameSize, imageSize, offset)) : value;
      this.draftFraming({
        backgroundPositionX: axis(drag.frameWidth, drag.imageWidth, drag.originX + event.clientX - drag.startX, current.backgroundPositionX),
        backgroundPositionY: axis(drag.frameHeight, drag.imageHeight, drag.originY + event.clientY - drag.startY, current.backgroundPositionY),
      });
    });
    const end = (event: Event) => {
      const drag = this.framingDrag;
      if (!(event instanceof PointerEvent) || !drag || event.pointerId !== drag.pointerId) return;
      this.framingDrag = null;
      frame.classList.remove('is-dragging');
      if (event.type !== 'pointercancel') {
        this.commitFraming();
        return;
      }
      this.framingDraft = null;
      this.refresh();
    };
    bind(frame, 'pointerup', end);
    bind(frame, 'pointercancel', end);
    bind(frame, 'lostpointercapture', end);
    bind(frame, 'keydown', (event) => {
      if (event instanceof KeyboardEvent) this.nudgeFraming(event);
    });
    bind(frame, 'wheel', (event) => {
      if (event instanceof WheelEvent) this.zoomFraming(event, frame);
    });
    bind(frame, 'blur', () => {
      if (this.framingTimer !== null) this.commitFraming();
    });
  }

  /** Arrows move the image the way a drag in that direction would. */
  private nudgeFraming(event: KeyboardEvent): void {
    const step = event.shiftKey ? FRAMING_KEY_STEP_LARGE : FRAMING_KEY_STEP;
    const moves: Partial<Record<string, readonly [number, number]>> = {
      ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const move = moves[event.key];
    if (!move || event.altKey || event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    const geometry = this.framingGeometry();
    if (!geometry || this.framingDrag || !this.framingEditable()) return;
    const current = this.framingSettings();
    const { rect, frameWidth, frameHeight } = geometry;
    this.draftFraming({
      backgroundPositionX: rect.width - frameWidth > 0.5 ? clampPosition(current.backgroundPositionX + move[0]) : current.backgroundPositionX,
      backgroundPositionY: rect.height - frameHeight > 0.5 ? clampPosition(current.backgroundPositionY + move[1]) : current.backgroundPositionY,
    });
    this.cancelFramingCommit();
    this.framingTimer = setTimeout(() => this.commitFraming(), FRAMING_COMMIT_DELAY_MS);
  }

  /** The wheel zooms around the pointer; over an editable frame it never scrolls the page. */
  private zoomFraming(event: WheelEvent, frame: HTMLElement): void {
    if (event.deltaY === 0 || this.framingDrag || !this.framingEditable()) return;
    const geometry = this.framingGeometry();
    const image = this.element<HTMLImageElement>('camera-effects-image-preview');
    const box = frame.getBoundingClientRect();
    if (!geometry || !image || box.width <= 0 || box.height <= 0) return;
    event.preventDefault();
    const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? FRAMING_WHEEL_LINE_PX
      : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? box.height : 1;
    const current = this.framingSettings();
    let zoom = Math.round(current.backgroundZoom * Math.exp(-event.deltaY * unit * FRAMING_WHEEL_RATE));
    // Touchpads send tiny deltas; each one still moves the zoom by at least a step.
    if (zoom === current.backgroundZoom) zoom -= Math.sign(event.deltaY);
    const { frameWidth, frameHeight } = geometry;
    const next = zoomBackgroundAt(
      frameWidth, frameHeight, image.naturalWidth, image.naturalHeight, current, zoom,
      (event.clientX - box.left) / box.width * frameWidth, (event.clientY - box.top) / box.height * frameHeight,
    );
    if (next.backgroundZoom === current.backgroundZoom) return;
    this.draftFraming({
      backgroundZoom: next.backgroundZoom,
      backgroundPositionX: clampPosition(next.backgroundPositionX),
      backgroundPositionY: clampPosition(next.backgroundPositionY),
    });
    this.cancelFramingCommit();
    this.framingTimer = setTimeout(() => this.commitFraming(), FRAMING_COMMIT_DELAY_MS);
  }

  private renderFraming(): void {
    const frame = this.element<HTMLElement>('camera-effects-framing-frame');
    const image = this.element<HTMLImageElement>('camera-effects-image-preview');
    if (!frame || !image) return;
    const settings = this.framingSettings();
    const { cameraWidth, cameraHeight } = videoService.getProfile();
    frame.style.aspectRatio = `${cameraWidth} / ${cameraHeight}`;
    frame.setAttribute('aria-disabled', String(!this.framingEditable()));
    const zoomInput = this.element<HTMLInputElement>('camera-effect-backgroundZoom');
    if (zoomInput && zoomInput.value !== String(settings.backgroundZoom)) zoomInput.value = String(settings.backgroundZoom);
    this.showRangeValue('backgroundZoom', settings.backgroundZoom);
    const value = this.element<HTMLOutputElement>('camera-effects-framing-value');
    if (value) {
      value.value = t('cameraEffects.framingPosition', {
        x: Math.round(settings.backgroundPositionX), y: Math.round(settings.backgroundPositionY),
      });
    }
    const geometry = this.framingGeometry();
    if (!geometry) return;
    const { rect, frameWidth, frameHeight } = geometry;
    image.style.left = `${rect.x / frameWidth * 100}%`;
    image.style.top = `${rect.y / frameHeight * 100}%`;
    image.style.width = `${rect.width / frameWidth * 100}%`;
    image.style.height = `${rect.height / frameHeight * 100}%`;
    frame.classList.toggle('is-movable', rect.width - frameWidth > 0.5 || rect.height - frameHeight > 0.5);
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
    this.previewEnabled = !this.missingBackground;
    this.updatePreviewVisibility();
  }

  private previewIsVisible(): boolean {
    return cameraEffectsStore.isLoaded && !this.missingBackground
      && this.active && this.previewEnabled && this.intersecting && document.visibilityState === 'visible'
      && !!this.root?.isConnected && this.root.checkVisibility({ checkVisibilityCSS: true });
  }

  private updatePreviewVisibility(): void {
    if (this.missingBackground) this.previewEnabled = false;
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
    const pending = this.framingTimer !== null ? this.framingChanges() : null;
    this.cancelFramingCommit();
    // Closing keeps the nudges already shown; a failure surfaces through the camera state.
    if (pending) void videoService.setCameraEffects(pending).catch(() => undefined);
    this.framingDraft = null;
    this.framingDrag = null;
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
    if (!video || isShowingStream(video, stream)) return;
    const playback = ++this.previewPlaybackGeneration;
    const started = showInlineStream(video, stream);
    video.hidden = !stream;
    if (stream) {
      const generation = this.previewGeneration;
      void started.catch((error: unknown) => {
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
    for (const card of root.querySelectorAll<HTMLButtonElement>('[data-camera-focus]')) {
      card.setAttribute('aria-pressed', String(card.dataset.cameraFocus === settings.personFocus));
    }
    root.querySelector('[data-camera-quality-limit]')?.setAttribute('aria-checked', String(settings.limitQuality));
    root.querySelector('[data-camera-mirror]')?.setAttribute('aria-checked', String(settings.mirror));
    const description = this.element<HTMLElement>('camera-effects-description');
    if (description) description.textContent = t(modeDescriptions[settings.mode]);
    const visible = visiblePanels(settings);
    for (const panel of root.querySelectorAll<HTMLElement>('[data-camera-panel]')) {
      setSurfaceVisible(panel, visible[panel.dataset.cameraPanel ?? ''] === true, 'panel');
    }
    const framing = this.framingSettings();
    for (const field of ranges) {
      const input = this.element<HTMLInputElement>(`camera-effect-${field.setting}`);
      if (input) input.value = String(framing[field.setting]);
      this.showRangeValue(field.setting, framing[field.setting]);
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
    const framingPanel = root.querySelector<HTMLElement>('[data-camera-framing]');
    if (framingPanel) setSurfaceVisible(framingPanel, !!image, 'panel');
    const reset = root.querySelector<HTMLButtonElement>('[data-camera-framing-reset]');
    if (reset) {
      reset.disabled = this.busy || !image
        || CAMERA_FRAMING_KEYS.every((key) => framing[key] === DEFAULT_CAMERA_EFFECT_SETTINGS[key]);
    }
    this.renderFraming();
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
    const missingBackground = this.missingBackground;
    if (missingBackground) this.previewEnabled = false;
    const state = videoService.getCameraState();
    const status = this.element<HTMLElement>('camera-effects-status');
    if (status) {
      status.textContent = missingBackground ? t('cameraEffects.errorImageMissing')
        : this.failure ? cameraDeviceSelectionError(this.failure)
        : this.busy ? t('cameraEffects.applying')
          : !cameraEffectsStore.isLoaded ? t('cameraEffects.loading')
            : this.previewWanted ? t(state.status === 'ready' ? 'cameraEffects.previewActive' : 'cameraEffects.previewStarting')
              : '';
      status.classList.toggle('is-error', missingBackground || !!this.failure);
    }
    const toggle = this.root.querySelector<HTMLButtonElement>('[data-camera-preview-toggle]');
    if (toggle) {
      toggle.setAttribute('aria-checked', String(this.previewEnabled));
      toggle.disabled = missingBackground || (!this.previewEnabled && (this.busy || !cameraEffectsStore.isLoaded));
    }
    const placeholder = this.root.querySelector<HTMLElement>('[data-camera-preview-placeholder]');
    if (placeholder) {
      placeholder.hidden = !!this.element<HTMLVideoElement>('camera-effects-preview')?.srcObject;
      placeholder.textContent = t(this.previewEnabled && this.active && !this.failure
        ? 'cameraEffects.previewStarting' : 'cameraEffects.previewOff');
    }
    const actions = this.root.querySelector<HTMLElement>('[data-camera-error-actions]');
    if (actions) actions.hidden = missingBackground || !this.failure || this.failure instanceof CameraPreferenceError;
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
