import { encodeSoundboardEdit } from '@monky/shared';
import { decodeSoundboardEdit, soundboardFileMessage, soundboardFileValue, validateSoundboardName, SoundboardLibraryError } from '../core/SoundboardLibrary';
import { soundboardService, type SoundItem } from '../core/SoundboardService';
import { t } from '../i18n';
import { escapeHtml } from '../utils/html';
import { enableBackdropClose } from '../utils/modal';
import { SoundboardEditorPlayer } from './SoundboardEditorPlayer';
import { SoundboardTimeline } from './SoundboardTimeline';
import { showConfirm } from './Dialog';

export class SoundboardEditor {
  private backdrop: HTMLElement | null = null;
  private controller = new AbortController();
  private player: SoundboardEditorPlayer | null = null;
  private removeKeys: (() => void) | null = null;
  private timeline: SoundboardTimeline | null = null;

  public async open(sound: SoundItem, folder: string, onSaved: (fileName: string, overwritten: boolean) => void): Promise<void> {
    this.close();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const previousFocus = document.activeElement;
    const backdrop = document.createElement('div');
    this.backdrop = backdrop;
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal-card sb-editor-card" role="dialog" aria-modal="true" aria-labelledby="sb-editor-title">
        <div class="modal-header"><div id="sb-editor-title" class="modal-title">${t('soundboard.edit')}</div>
          <button class="modal-close-btn" data-editor-close aria-label="${t('common.close')}">&times;</button></div>
        <p class="sb-editor-source">${escapeHtml(sound.fileName)}</p>
        <p class="sb-editor-help">${t('soundboard.editorHelp')}</p>
        <form data-editor-form>
          <fieldset disabled>
            <div data-editor-timeline></div>
            <div data-editor-player></div>
            <label for="sb-edit-name">${t('soundboard.copyName')}</label>
            <div class="dialog-text-input-row"><input class="input-field" id="sb-edit-name" name="name" maxlength="110"
              value="${escapeHtml(`${sound.name.slice(0, 95)}${t('soundboard.editedSuffix')}`)}" required><span>.wav</span></div>
            <p data-editor-summary class="sb-editor-help"></p>
            <p data-overwrite-unavailable class="sb-editor-help" hidden>${t('soundboard.fileError.encoder_unavailable')}</p>
            <div class="sb-editor-buttons">
              <button type="button" class="btn btn-secondary" data-editor-overwrite>${t('soundboard.overwrite')}</button>
              <button type="submit" class="btn btn-primary" data-editor-save>${t('soundboard.saveCopy')}</button>
            </div>
          </fieldset>
        </form>
        <p data-editor-status role="status">${t('common.loading')}</p>
      </div>`;
    document.body.appendChild(backdrop);
    const close = () => {
      this.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
    backdrop.querySelector('[data-editor-close]')?.addEventListener('click', close);
    enableBackdropClose(backdrop, close);
    const keys = (event: KeyboardEvent) => {
      if (document.querySelector('.modal-backdrop:last-of-type') !== backdrop) return;
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!this.timeline?.cancelDrag()) close();
      }
      if (event.key === 'Tab') {
        const inputs = [...backdrop.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)')];
        if (event.shiftKey && document.activeElement === inputs[0]) { event.preventDefault(); inputs.at(-1)?.focus(); }
        else if (!event.shiftKey && document.activeElement === inputs.at(-1)) { event.preventDefault(); inputs[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', keys, true);
    this.removeKeys = () => document.removeEventListener('keydown', keys, true);
    backdrop.querySelector<HTMLButtonElement>('[data-editor-close]')?.focus();
    const status = backdrop.querySelector<HTMLElement>('[data-editor-status]')!;
    try {
      const result = await window.api.openSoundboardEditor({ folder, fileName: sound.fileName });
      if (signal.aborted) return;
      const source = soundboardFileValue(result);
      const decoded = await decodeSoundboardEdit(source.bytes, signal);
      if (signal.aborted) return;
      const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
      const form = backdrop.querySelector<HTMLFormElement>('[data-editor-form]')!;
      const fieldset = form.querySelector('fieldset')!;
      const input = (name: string) => form.elements.namedItem(name) as HTMLInputElement;
      const timeline = new SoundboardTimeline(backdrop.querySelector<HTMLElement>('[data-editor-timeline]')!, decoded, () => update());
      this.timeline = timeline;
      const values = () => timeline.values();
      const overwrite = form.querySelector<HTMLButtonElement>('[data-editor-overwrite]')!;
      overwrite.disabled = !source.overwriteAvailable;
      backdrop.querySelector<HTMLElement>('[data-overwrite-unavailable]')!.hidden = source.overwriteAvailable;
      let busy = false;
      const encode = () => {
        try { return encodeSoundboardEdit(channels, decoded.sampleRate, values()); }
        catch (error: unknown) {
          throw new SoundboardLibraryError(soundboardFileMessage(error instanceof RangeError && error.message === 'too_large' ? 'too_large' : 'invalid_request'));
        }
      };
      const summary = form.querySelector<HTMLElement>('[data-editor-summary]')!;
      const player = new SoundboardEditorPlayer(
        form.querySelector<HTMLElement>('[data-editor-player]')!, sound.name, encode,
        seconds => timeline.setPlaybackTime(seconds),
        error => {
          if (signal.aborted) return;
          status.setAttribute('role', error ? 'alert' : 'status');
          status.textContent = error instanceof SoundboardLibraryError ? error.message : error ? t('soundboard.previewFailed') : '';
        },
      );
      this.player = player;
      const update = () => {
        const times = values();
        player.reset(times.end - times.start);
        summary.textContent = t('soundboard.editSummary', {
          duration: Math.max(0, times.end - times.start).toFixed(3), channels: decoded.numberOfChannels,
          size: ((44 + Math.round((times.end - times.start) * decoded.sampleRate) * decoded.numberOfChannels * 3) / 1024 / 1024).toFixed(2),
        });
        status.textContent = '';
        status.setAttribute('role', 'status');
      };
      fieldset.disabled = false;
      update();
      const action = async (kind: 'copy' | 'overwrite') => {
        if (busy || signal.aborted) return;
        busy = true;
        try {
          if (kind === 'copy') {
            const nameError = validateSoundboardName(input('name').value);
            if (nameError) throw new SoundboardLibraryError(nameError);
          }
          const times = values();
          player.stop();
          player.setDisabled(true);
          fieldset.disabled = true;
          timeline.setDisabled(true);
          status.textContent = t('common.loading');
          if (kind === 'overwrite') {
            if (!source.overwriteAvailable) throw new SoundboardLibraryError(t('soundboard.fileError.encoder_unavailable'));
            const confirmed = await showConfirm({
              title: t('soundboard.overwrite'), message: t('soundboard.overwriteConfirm', { name: sound.fileName }),
              confirmLabel: t('soundboard.overwrite'), variant: 'danger', signal, requireUserGesture: true,
            });
            if (!confirmed || signal.aborted) { status.textContent = ''; return; }
          }
          const request = { folder, fileName: sound.fileName, sampleRate: decoded.sampleRate, channels, ...times };
          const result = kind === 'overwrite'
            ? await window.api.overwriteSoundboardAudio({ ...request, revision: source.revision })
            : await window.api.saveSoundboardEdit({ ...request, newFileName: `${input('name').value}.wav` });
          const saved = soundboardFileValue(result);
          if (kind === 'overwrite') soundboardService.stopLocalFile(sound.name);
          await soundboardService.loadSounds();
          onSaved(saved.fileName, kind === 'overwrite');
          if (!signal.aborted) close();
        } catch (error: unknown) {
          if (!signal.aborted) {
            status.setAttribute('role', 'alert');
            status.textContent = error instanceof SoundboardLibraryError ? error.message : t('soundboard.fileError.io_failed');
          }
        } finally {
          busy = false;
          if (!signal.aborted) { fieldset.disabled = false; timeline.setDisabled(false); player.setDisabled(false); }
        }
      };
      form.addEventListener('submit', event => { event.preventDefault(); void action('copy'); });
      overwrite.addEventListener('click', () => { void action('overwrite'); });
      backdrop.querySelector<HTMLButtonElement>('[data-handle="start"]')?.focus();
    } catch (error: unknown) {
      if (!signal.aborted) {
        status.setAttribute('role', 'alert');
        status.textContent = error instanceof SoundboardLibraryError ? error.message : t('soundboard.fileError.io_failed');
      }
    }
  }

  public close(): void {
    this.controller.abort();
    this.player?.dispose();
    this.player = null;
    this.timeline?.dispose();
    this.timeline = null;
    this.removeKeys?.();
    this.removeKeys = null;
    soundboardService.stopEditorPreview();
    this.backdrop?.remove();
    this.backdrop = null;
  }
}
