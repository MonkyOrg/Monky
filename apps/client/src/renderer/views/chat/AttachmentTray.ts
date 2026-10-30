import type { AttachmentMeta } from '@monky/shared';
import type { UploadHandle } from '../../core/AttachmentUploader';
import { getLanguage, t } from '../../i18n';
import { formatBytes } from '../../utils/attachment';
import { errorMessage, reportError } from '../../utils/feedback';
import { html, type SafeHtml } from '../../utils/html';
import { setSurfaceVisible } from '../../utils/surfaceVisibility';

/** Sends a picked file right away, reporting progress from 0 to 1. */
export type TrayUpload = (file: File, progress: (fraction: number) => void) => UploadHandle;

export interface AttachmentTrayOptions {
  /** Most files one message carries. */
  maxFiles: number;
  /** Largest file accepted, in bytes; 0 or less accepts any size. Read whenever files arrive. */
  maxBytes(): number;
  /** Explains why `files`, refused together, are over `limit`. */
  tooLarge(files: readonly File[], limit: number): string;
  /** Explains that a message carries at most `max` files. */
  tooMany(max: number): string;
  /**
   * Uploads each file as soon as it is picked, as server channels do. Without
   * it the files wait in the tray until the message goes out (direct messages).
   */
  upload?: TrayUpload;
  /** The tray steps aside without losing its files, e.g. while a sent message is being edited. */
  hidden?(): boolean;
  /** The files or their uploads changed: the send button may change with them. */
  onChange?(): void;
}

/** `refused`: over the size limit, kept in sight but never sent. `failed`: its upload did not go through. */
type TrayStatus = 'staged' | 'uploading' | 'done' | 'failed' | 'refused';

interface TrayFile {
  id: string;
  file: File;
  previewUrl: string | null;
  status: TrayStatus;
  progress: number;
  meta?: AttachmentMeta;
  handle?: UploadHandle;
  /** The size limit a refused file is over. */
  limit?: number;
  /** Why the upload failed. */
  failure?: string;
}

/** `"a.txt", "b.txt" e "c.txt"`: file names listed in the app's language. */
export function listFileNames(files: readonly File[]): string {
  return new Intl.ListFormat(getLanguage(), { type: 'conjunction' }).format(files.map((file) => `"${file.name}"`));
}

/**
 * Files picked for the next message, shared by server channels and direct
 * messages (R-CHAT-5): previews and their object URLs, the per-message limits
 * (a file over the size limit stays marked in the tray; the explanation goes
 * to the shared toast), removal and, when the view uploads at once, progress
 * and cancelling.
 */
export class AttachmentTray {
  private items: TrayFile[] = [];
  private element: HTMLElement | null = null;
  private listeners: AbortController | null = null;
  private sequence = 0;

  constructor(private readonly options: AttachmentTrayOptions) {}

  /** The tray element of the composer on screen; a rebuilt composer brings a new one. */
  public mount(element: HTMLElement | null): void {
    this.listeners?.abort();
    this.listeners = null;
    this.element = element;
    if (element) {
      this.listeners = new AbortController();
      element.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tray-remove]') : null;
        if (button?.dataset.trayRemove) this.remove(button.dataset.trayRemove);
      }, { signal: this.listeners.signal });
    }
    this.render();
  }

  /** The files that will go with the message: refused files and failed uploads do not. */
  public get count(): number {
    return this.items.filter((item) => this.goes(item)).length;
  }

  /** Whether an upload is still running: the message has to wait for it. */
  public get uploading(): boolean {
    return this.items.some((item) => item.status === 'uploading');
  }

  /** The files that will go with the message, in order. */
  public files(): File[] {
    return this.items.filter((item) => this.goes(item)).map((item) => item.file);
  }

  /** What the server stored for each finished upload, in order. */
  public uploaded(): AttachmentMeta[] {
    return this.items.flatMap((item) => item.status === 'done' && item.meta ? [item.meta] : []);
  }

  /**
   * Takes files that were picked, pasted or dropped. A file over the size limit
   * stays in the tray, marked, so it is plain what will not go. Whatever one
   * batch breaks is explained together: the toast shows one message at a time.
   */
  public add(files: Iterable<File>): void {
    const limit = this.options.maxBytes();
    const tooLarge: File[] = [];
    let added = 0;
    let leftOut = false;
    for (const file of files) {
      if (this.items.length >= this.options.maxFiles) {
        leftOut = true;
        break;
      }
      added++;
      if (limit > 0 && file.size > limit) {
        tooLarge.push(file);
        this.stage(file, limit);
        continue;
      }
      const item = this.stage(file);
      if (this.options.upload) this.upload(item, this.options.upload);
    }
    if (added > 0) this.changed();
    const refused = [
      tooLarge.length > 0 ? this.options.tooLarge(tooLarge, limit) : '',
      leftOut ? this.options.tooMany(this.options.maxFiles) : '',
      // The tray shows fewer files that will go than the maximum: the marked ones count until removed.
      leftOut && this.items.some((item) => item.status === 'refused') ? t('chat.attachmentsOverLimitTakeSlots') : '',
    ].filter(Boolean);
    if (refused.length > 0) reportError(refused.join(' '));
  }

  /** Puts back files kept from an earlier visit as they were picked, without checking the limits again. */
  public restore(files: readonly File[]): void {
    for (const file of files) this.stage(file);
    if (files.length > 0) this.changed();
  }

  public remove(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [item] = this.items.splice(index, 1);
    this.release(item);
    this.changed();
  }

  /** Forgets every file, cancelling the uploads still running. */
  public clear(): void {
    if (this.items.length === 0) return;
    for (const item of this.items.splice(0)) this.release(item);
    this.changed();
  }

  public render(): void {
    const tray = this.element;
    if (!tray) return;
    if (this.items.length === 0) {
      setSurfaceVisible(tray, false, 'panel', undefined, () => tray.replaceChildren());
      return;
    }
    tray.innerHTML = html`${this.items.map((item) => this.renderItem(item))}`.toString();
    setSurfaceVisible(tray, !this.options.hidden?.(), 'panel', 'flex');
  }

  public destroy(): void {
    this.listeners?.abort();
    this.listeners = null;
    for (const item of this.items.splice(0)) this.release(item);
    this.element = null;
  }

  /** Adds a file to the tray; one over `refusedOver` bytes is kept marked, with no preview, and never sent. */
  private stage(file: File, refusedOver?: number): TrayFile {
    const refused = refusedOver !== undefined;
    const item: TrayFile = {
      id: `tray-${++this.sequence}`,
      file,
      // Decoding an image over the limit for a thumbnail is not worth it.
      previewUrl: !refused && file.type.startsWith('image/') ? URL.createObjectURL(file) : null,
      status: refused ? 'refused' : 'staged',
      progress: 0,
      limit: refusedOver,
    };
    this.items.push(item);
    return item;
  }

  private goes(item: TrayFile): boolean {
    return item.status !== 'refused' && item.status !== 'failed';
  }

  private upload(item: TrayFile, upload: TrayUpload): void {
    item.status = 'uploading';
    item.handle = upload(item.file, (fraction) => {
      item.progress = fraction;
      this.renderProgress(item);
    });
    item.handle.promise.then((meta) => {
      if (!this.items.includes(item)) return;
      item.status = 'done';
      item.meta = meta;
      item.handle = undefined;
      this.changed();
    }, (error: unknown) => {
      // A cancelled upload already left the tray.
      if (!this.items.includes(item)) return;
      item.status = 'failed';
      item.failure = errorMessage(error, t('upload.failed'));
      item.handle = undefined;
      this.reportFailures();
      this.changed();
    });
  }

  /**
   * Uploads fail one by one, often together (the server's storage is full):
   * each report covers every failed file still in the tray, so a later one
   * does not hide an earlier one in the single toast.
   */
  private reportFailures(): void {
    const failed = this.items.filter((item) => item.status === 'failed');
    const [first] = failed;
    if (!first) return;
    const reason = [...new Set(failed.map((item) => item.failure ?? t('upload.failed')))].join('; ');
    reportError(failed.length === 1
      ? t('chat.attachmentUploadFailed', { name: first.file.name, reason })
      : t('chat.attachmentsUploadFailed', { names: listFileNames(failed.map((item) => item.file)), reason }));
  }

  private release(item: TrayFile): void {
    item.handle?.cancel();
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }

  private changed(): void {
    this.render();
    this.options.onChange?.();
  }

  private renderProgress(item: TrayFile): void {
    const percent = Math.round(item.progress * 100);
    const bar = this.element?.querySelector<HTMLElement>(`[data-tray-progress="${CSS.escape(item.id)}"]`);
    if (bar) bar.style.width = `${percent}%`;
    const label = this.element?.querySelector<HTMLElement>(`[data-tray-progress-label="${CSS.escape(item.id)}"]`);
    if (label) label.textContent = `${percent}%`;
  }

  private renderItem(item: TrayFile): SafeHtml {
    const percent = Math.round(item.progress * 100);
    const marked = item.status === 'failed' || item.status === 'refused';
    const status = item.status === 'uploading'
      ? html`<div class="tray-progress"><div class="tray-progress-bar" data-tray-progress="${item.id}" style="width: ${percent}%;"></div></div>
        <span class="tray-status" data-tray-progress-label="${item.id}">${percent}%</span>`
      : item.status === 'refused' ? html`<span class="tray-status tray-error">${t('chat.attachmentOverLimit', { size: formatBytes(item.limit ?? 0) })}</span>`
        : item.status === 'failed' ? html`<span class="tray-status tray-error">${t('common.error')}</span>`
          : item.status === 'done' ? html`<span class="tray-status tray-done">${t('common.done')}</span>` : '';
    return html`<div class="tray-item${marked ? ' is-error' : ''}" data-tray-item="${item.id}" title="${item.file.name}">
      ${item.previewUrl
        ? html`<img class="tray-thumb" src="${item.previewUrl}" alt="">`
        : html`<span class="material-symbols-outlined md-22 tray-thumb-icon" aria-hidden="true">draft</span>`}
      <div class="tray-info">
        <span class="tray-name">${item.file.name}</span>
        <div class="tray-sub"><span class="tray-size">${formatBytes(item.file.size)}</span>${status}</div>
      </div>
      <button type="button" class="tray-remove" data-tray-remove="${item.id}" title="${t('common.remove')}" aria-label="${t('common.remove')}">
        <span class="material-symbols-outlined md-18" aria-hidden="true">close</span>
      </button>
    </div>`;
  }
}
