import {
  CAMERA_EFFECT_LIMITS, CameraEffectError, DEFAULT_CAMERA_EFFECT_SETTINGS,
  restoreCameraEffectSettings, type CameraEffectSettings,
} from '../utils/cameraEffects';
import { validateStoredCameraBackground, type CameraBackgroundImage } from '../utils/cameraBackgroundImage';

export interface CameraEffectsSnapshot {
  readonly settings: Readonly<CameraEffectSettings>;
  readonly image: CameraBackgroundImage | null;
}

interface StoredCameraEffects extends CameraEffectsSnapshot {
  readonly version: 1;
}

const DATABASE = 'monky-camera-effects';
const STORE = 'preferences';
const RECORD = 'current';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function restoreSnapshot(value: unknown): CameraEffectsSnapshot {
  if (!isRecord(value) || value.version !== 1) throw new CameraEffectError('settings');
  const settings = restoreCameraEffectSettings(value.settings);
  const image = value.image;
  if (image === null) return { settings, image: null };
  if (!isRecord(image) || typeof image.id !== 'string' || !image.id || image.id.length > 128
    || typeof image.name !== 'string' || image.name.length > 160 || !(image.blob instanceof Blob)
    || !image.blob.size || image.blob.size > CAMERA_EFFECT_LIMITS.maxStoredImageBytes
    || !['image/jpeg', 'image/png', 'image/webp'].includes(image.blob.type)) {
    throw new CameraEffectError('settings');
  }
  return { settings, image: { id: image.id, name: image.name, blob: image.blob } };
}

export class CameraEffectsStore {
  private value: CameraEffectsSnapshot = { settings: { ...DEFAULT_CAMERA_EFFECT_SETTINGS }, image: null };
  private loaded = false;
  private loading: Promise<CameraEffectsSnapshot> | null = null;
  private writes: Promise<void> = Promise.resolve();

  public get snapshot(): CameraEffectsSnapshot {
    return { settings: { ...this.value.settings }, image: this.value.image ? { ...this.value.image } : null };
  }

  public get isLoaded(): boolean {
    return this.loaded;
  }

  public async load(): Promise<CameraEffectsSnapshot> {
    if (this.loaded) return this.snapshot;
    if (this.loading) return this.loading;
    const operation = this.read().then(async (value) => {
      const restored = value === undefined
        ? { settings: { ...DEFAULT_CAMERA_EFFECT_SETTINGS }, image: null }
        : restoreSnapshot(value);
      if (restored.image) {
        try {
          await validateStoredCameraBackground(restored.image);
        } catch (error) {
          throw new CameraEffectError('settings', { cause: error });
        }
      }
      this.value = restored;
      this.loaded = true;
      return this.snapshot;
    }).finally(() => {
      if (this.loading === operation) this.loading = null;
    });
    this.loading = operation;
    return operation;
  }

  public update(patch: Partial<CameraEffectSettings>): Promise<CameraEffectsSnapshot> {
    return this.write(async () => {
      let previous: CameraEffectsSnapshot;
      try {
        previous = await this.load();
      } catch (error) {
        // Only explicitly choosing Off may replace a corrupt saved privacy configuration.
        if (!(error instanceof CameraEffectError) || error.code !== 'settings' || patch.mode !== 'off') throw error;
        previous = { settings: { ...DEFAULT_CAMERA_EFFECT_SETTINGS }, image: null };
      }
      return { settings: restoreCameraEffectSettings({ ...previous.settings, ...patch }), image: previous.image };
    });
  }

  public setImage(image: CameraBackgroundImage): Promise<CameraEffectsSnapshot> {
    return this.write(async () => {
      const previous = await this.load();
      return { settings: previous.settings, image };
    });
  }

  public removeImage(): Promise<CameraEffectsSnapshot> {
    return this.write(async () => {
      const previous = await this.load();
      return {
        settings: {
          ...previous.settings,
          mode: previous.settings.mode === 'image' ? 'color' : previous.settings.mode,
          backgroundSource: 'color',
        },
        image: null,
      };
    });
  }

  private write(create: () => Promise<CameraEffectsSnapshot>): Promise<CameraEffectsSnapshot> {
    const operation = this.writes.then(async () => {
      const next = await create();
      const record: StoredCameraEffects = { version: 1, ...next };
      const validated = restoreSnapshot(record);
      if (validated.image) await validateStoredCameraBackground(validated.image);
      const database = await this.open();
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction(STORE, 'readwrite');
          transaction.objectStore(STORE).put(record, RECORD);
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(new CameraEffectError('storage', { cause: transaction.error }));
          transaction.onerror = () => reject(new CameraEffectError('storage', { cause: transaction.error }));
        });
      } catch (error) {
        throw error instanceof CameraEffectError ? error : new CameraEffectError('storage', { cause: error });
      } finally {
        database.close();
      }
      this.value = validated;
      this.loaded = true;
      return this.snapshot;
    });
    // Keep the queue usable after a failed write; the caller still receives the original rejection.
    this.writes = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async read(): Promise<unknown> {
    const database = await this.open();
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction(STORE, 'readonly');
        const request = transaction.objectStore(STORE).get(RECORD);
        let result: unknown;
        request.onsuccess = () => { result = request.result; };
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(new CameraEffectError('storage', { cause: transaction.error }));
        transaction.onerror = () => reject(new CameraEffectError('storage', { cause: transaction.error }));
      });
    } catch (error) {
      throw error instanceof CameraEffectError ? error : new CameraEffectError('storage', { cause: error });
    } finally {
      database.close();
    }
  }

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new CameraEffectError('storage'));
        return;
      }
      let settled = false;
      const finishError = (cause: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new CameraEffectError('storage', { cause }));
      };
      const timeout = setTimeout(() => finishError(new Error('Camera preferences storage timed out')), 5000);
      let request: IDBOpenDBRequest;
      try {
        request = indexedDB.open(DATABASE, 1);
      } catch (error) {
        finishError(error);
        return;
      }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      };
      request.onerror = () => finishError(request.error);
      request.onblocked = () => finishError(new Error('Camera preferences storage is blocked'));
    });
  }
}

export const cameraEffectsStore = new CameraEffectsStore();
