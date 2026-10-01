import {
  MessageType,
  LIMITS,
  recentSoundEntrySchema,
  recentSoundDownloadSchema,
  recentSoundsListSchema,
  type RecentSoundDownload,
  type RecentSoundEntry,
  type RecentSoundsList,
} from '@monky/shared';
import { t } from '../i18n';
import { appEvents } from '../core/EventBus';
import { sessionManager } from '../core/SessionManager';
import { soundboardService } from '../core/SoundboardService';
import { escapeHtml } from '../utils/html';
import { openCommunityModal } from './CommunityModal';
import { setButtonLoading } from '../utils/buttonLoading';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
}

function renderItem(item: RecentSoundEntry): string {
  return `<article class="recent-sound-item" data-recent-sound="${item.id}">
    <button type="button" class="recent-sound-preview" data-preview-recent="${item.id}"
      title="${escapeHtml(t('recentSounds.preview'))}" aria-label="${escapeHtml(t('recentSounds.previewNamed', { name: item.soundName }))}">
      <span class="material-symbols-outlined">play_arrow</span>
    </button>
    <div class="recent-sound-copy">
      <strong>${escapeHtml(item.soundName)}</strong>
      <span>${escapeHtml(t('recentSounds.playedBy', { user: item.userName }))}</span>
      <span>${escapeHtml(new Date(item.playedAt).toLocaleString())} · ${formatBytes(item.sizeBytes)}</span>
    </div>
    <button type="button" class="btn btn-secondary recent-sound-download" data-download-recent="${item.id}"
      title="${escapeHtml(t('recentSounds.download'))}" aria-label="${escapeHtml(t('recentSounds.downloadNamed', { name: item.soundName }))}">
      <span class="material-symbols-outlined md-18">download</span>
    </button>
  </article>`;
}

export class RecentSoundsModal {
  public async open(): Promise<void> {
    const session = sessionManager.getActive();
    if (!session || !session.serverStore.serverDetails?.protocol?.features.includes('recent-sounds')) return;
    const sessionKey = session.key;
    const modal = openCommunityModal(t('recentSounds.title'));
    modal.element.querySelector('.community-modal')?.classList.add('recent-sounds-modal');
    modal.content.innerHTML = `<div class="recent-sounds-loading" aria-live="polite">
      <span class="spinner"></span><span>${escapeHtml(t('common.loading'))}</span>
    </div>`;
    let snapshot: RecentSoundsList | null = null;
    const soundCache = new Map<string, Promise<RecentSoundDownload>>();
    const loadSound = (id: string): Promise<RecentSoundDownload> => {
      const cached = soundCache.get(id);
      if (cached) return cached;
      const pending = session.client.sendRequest<unknown>(
        MessageType.RECENT_SOUND_DOWNLOAD, { id }, undefined, LIMITS.RECENT_SOUND_DOWNLOAD_TIMEOUT_MS,
      ).then((value) => recentSoundDownloadSchema.parse(value)).catch((error) => {
        soundCache.delete(id);
        throw error;
      });
      soundCache.set(id, pending);
      return pending;
    };
    let activePreviewId: string | null = null;
    const syncPreview = () => {
      modal.content.querySelectorAll<HTMLElement>('[data-recent-sound]').forEach((row) => {
        const active = row.dataset.recentSound === activePreviewId;
        row.classList.toggle('is-playing', active);
        const icon = row.querySelector<HTMLElement>('[data-preview-recent] .material-symbols-outlined');
        if (icon) icon.textContent = active ? 'stop' : 'play_arrow';
      });
    };
    const render = (result: RecentSoundsList) => {
      snapshot = result;
      if (!result.enabled) {
        modal.content.innerHTML = `<div class="recent-sounds-empty">
          <span class="material-symbols-outlined">history_toggle_off</span>
          <p>${escapeHtml(t('recentSounds.disabled'))}</p>
        </div>`;
        return;
      }
      const overview = `<div class="recent-sounds-overview">
        <span class="material-symbols-outlined">history</span>
        <div>
          <strong>${escapeHtml(t('recentSounds.aboutTitle'))}</strong>
          <p>${escapeHtml(t('recentSounds.about'))}</p>
        </div>
      </div>
      <div class="recent-sounds-section-heading">
        <strong>${escapeHtml(t('recentSounds.history'))}</strong>
        <span>${escapeHtml(t('recentSounds.capacity', {
          count: result.items.length,
          limit: result.limit,
        }))}</span>
      </div>`;
      modal.content.innerHTML = overview + (result.items.length
        ? `<div class="recent-sounds-list">${result.items.map(renderItem).join('')}</div>`
        : `<div class="recent-sounds-empty recent-sounds-empty-compact">
            <span class="material-symbols-outlined">music_off</span>
            <p>${escapeHtml(t('recentSounds.empty'))}</p>
          </div>`);
      modal.content.querySelectorAll<HTMLButtonElement>('[data-download-recent]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.dataset.downloadRecent;
          if (!id || button.disabled) return;
          void this.download(sessionKey, id, button, modal.signal, modal.fail, loadSound);
        }, { signal: modal.signal });
      });
      modal.content.querySelectorAll<HTMLButtonElement>('[data-preview-recent]').forEach((button) => {
        button.addEventListener('click', () => {
          const id = button.dataset.previewRecent;
          if (!id || button.disabled) return;
          if (activePreviewId === id) {
            soundboardService.stopRecentPreview();
            return;
          }
          void this.preview(sessionKey, id, button, modal.signal, modal.fail, loadSound).then((started) => {
            if (!started || modal.signal.aborted) return;
            activePreviewId = id;
            syncPreview();
          });
        }, { signal: modal.signal });
      });
      syncPreview();
    };
    const unbindAdded = appEvents.on(`message.${MessageType.RECENT_SOUND_ADDED}`, (payload: unknown) => {
      const parsed = recentSoundEntrySchema.safeParse(payload);
      if (!parsed.success || !snapshot?.enabled ||
          sessionManager.getActive()?.key !== sessionKey) return;
      render({
        ...snapshot,
        items: [
          parsed.data,
          ...snapshot.items.filter((item) => item.id !== parsed.data.id),
        ].slice(0, snapshot.limit),
      });
    });
    modal.signal.addEventListener('abort', unbindAdded, { once: true });
    const unbindPreviewEnded = appEvents.on('soundboard.playback_ended', (payload: { userId?: string }) => {
      if (payload?.userId !== 'recent-preview') return;
      activePreviewId = null;
      syncPreview();
    });
    modal.signal.addEventListener('abort', () => {
      unbindPreviewEnded();
      soundboardService.stopRecentPreview();
    }, { once: true });

    try {
      const result = recentSoundsListSchema.parse(await session.client.sendRequest<unknown>(
        MessageType.RECENT_SOUNDS_LIST, {},
      ));
      if (modal.signal.aborted || sessionManager.getActive()?.key !== sessionKey) return;
      render(result);
    } catch (error) {
      if (!modal.signal.aborted) modal.fail(error instanceof Error ? error.message : t('recentSounds.loadFailed'));
    }
  }

  private async preview(
    sessionKey: string,
    id: string,
    button: HTMLButtonElement,
    signal: AbortSignal,
    fail: (message: string) => void,
    loadSound: (id: string) => Promise<RecentSoundDownload>,
  ): Promise<boolean> {
    const session = sessionManager.getActive();
    if (!session || session.key !== sessionKey) return false;
    setButtonLoading(button, true);
    try {
      const sound = await loadSound(id);
      if (signal.aborted || sessionManager.getActive()?.key !== sessionKey) return false;
      return await soundboardService.previewRecentSound(sound.soundName, sound.audioBase64, sound.mimeType);
    } catch (error) {
      if (!signal.aborted) fail(error instanceof Error ? error.message : t('recentSounds.previewFailed'));
      return false;
    } finally {
      if (!signal.aborted) setButtonLoading(button, false);
    }
  }

  private async download(
    sessionKey: string,
    id: string,
    button: HTMLButtonElement,
    signal: AbortSignal,
    fail: (message: string) => void,
    loadSound: (id: string) => Promise<RecentSoundDownload>,
  ): Promise<void> {
    const session = sessionManager.getActive();
    if (!session || session.key !== sessionKey) return;
    setButtonLoading(button, true);
    try {
      const sound = await loadSound(id);
      if (signal.aborted || sessionManager.getActive()?.key !== sessionKey) return;
      const result = await window.api.saveRecentSound({
        fileName: sound.soundName,
        mimeType: sound.mimeType,
        base64: sound.audioBase64,
      });
      if (!signal.aborted && !result.success && !result.canceled) {
        fail(result.error || t('recentSounds.downloadFailed'));
      }
    } catch (error) {
      if (!signal.aborted) fail(error instanceof Error ? error.message : t('recentSounds.downloadFailed'));
    } finally {
      if (!signal.aborted) setButtonLoading(button, false);
    }
  }
}

export const recentSoundsModal = new RecentSoundsModal();
