import {
  MessageType,
  Permission,
  SoundboardPlayedPayload,
  SoundboardStoppedPayload,
  type SoundboardPlayPayload,
  type SoundboardSoundData,
} from '@monky/shared';
import { appEvents } from './EventBus';
import { callClient } from './serverConnection';
import { sessionManager } from './SessionManager';
import { ProtocolRequestError } from './NetworkClient';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';
import { SoundboardAudioOutput } from './SoundboardAudioOutput';
import { setAudioOutputSink } from './AudioOutputSink';
import { showErrorToast } from '../views/CopyToast';

/**
 * Safety net for a sound sent to the call. The server always answers, with the
 * broadcast itself or an error, and a dropped connection rejects the request at
 * once; this only bounds a server that never replies. It is generous because the
 * reply carries the whole clip back (~4 MB of base64 each way at most).
 */
const PLAY_REQUEST_TIMEOUT_MS = 60_000;

export interface SoundItem {
  name: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  ext: string;
}

export interface ActiveSoundPlayback {
  userId: string;
  userName?: string;
  soundName: string;
  audio: HTMLAudioElement;
}

interface PendingSoundPlayback {
  audio: HTMLAudioElement | null;
  controller: AbortController;
  soundName?: string;
}

interface ManagedSoundPlayback extends ActiveSoundPlayback {
  dispose: () => void;
  showInGlobalPlayer: boolean;
}

/** How one attempt to play a clip ended: audible, broken, or stopped/replaced first. */
export type PlaybackOutcome = 'started' | 'failed' | 'cancelled';

/** A library sound this client asked to play that is not audible yet. */
interface SoundRequest {
  filePath: string;
  controller: AbortController;
  /** SOUNDBOARD_PLAY left: only a stop announced to the channel can still silence it. */
  sent: boolean;
}

export class SoundboardService {
  private sounds: SoundItem[] = [];
  private loadGeneration = 0;
  private loadStatus: 'loading' | 'ready' | 'error' = 'ready';
  private sinkId: string = settingsStore.selectedSpeakerId;
  private activePlaybacks: Map<string, ManagedSoundPlayback> = new Map();
  private pendingPlaybacks = new Map<string, PendingSoundPlayback>();
  private readonly soundRequests = new Set<SoundRequest>();
  /**
   * Local playback of every received clip, by payload. A request's own echo is
   * the very object `sendRequest` resolves with, so `playSound` can follow it
   * to the moment it becomes audible here.
   */
  private readonly incomingPlaybacks = new WeakMap<SoundboardPlayedPayload, Promise<PlaybackOutcome>>();
  private intensity: number | null = null;
  private readonly audioOutput = new SoundboardAudioOutput((value) => {
    this.intensity = value;
    appEvents.emit('soundboard.intensity', value);
  });

  constructor() {
    this.setupListeners();
    this.loadSounds();
  }

  private setupListeners(): void {
    // Listen to network events when another user or server sends a soundboard play
    appEvents.on(`message.${MessageType.SOUNDBOARD_PLAYED}`, (payload: SoundboardPlayedPayload) => {
      const playback = this.handleIncomingSound(payload);
      if (payload && typeof payload === 'object') this.incomingPlaybacks.set(payload, playback);
    });

    // Whoever started the sound stopped it, so the whole channel drops it (#499).
    appEvents.on(`message.${MessageType.SOUNDBOARD_STOPPED}`, (payload: SoundboardStoppedPayload) => {
      if (payload?.userId) this.stopSoundForUser(payload.userId);
    });

    // Update active soundboard playbacks when local user deafens
    appEvents.on('local.deafened', (deafened: boolean) => {
      const vol = deafened ? 0 : this.getEffectiveVolume();
      this.audioOutput.setVolume(vol);
    });

    // Update speaker device and active audio volume when settings change
    appEvents.on('settings.updated', () => {
      if (settingsStore.selectedSpeakerId !== this.sinkId) {
        void this.setSinkId(settingsStore.selectedSpeakerId).catch((error: unknown) => {
          console.warn('[SoundboardService] Could not switch speaker:', error);
        });
      }
      const vol = this.getEffectiveVolume();
      this.audioOutput.setVolume(vol);
      this.audioOutput.updateLimiter();
    });

    // Listen to global shortcuts triggered via Electron
    if (window.api?.onSoundboardShortcutTriggered) {
      window.api.onSoundboardShortcutTriggered((soundName: string) => {
        const sound = this.sounds.find((s) => s.name === soundName);
        if (sound) {
          this.playSound(sound.filePath);
        }
      });
    }
  }

  public async syncShortcuts(): Promise<void> {
    if (!window.api?.registerSoundboardShortcuts) return;
    try {
      const shortcuts = settingsStore.soundboardShortcuts;
      const list = Object.entries(shortcuts)
        .filter(([_, data]) => data && data.accelerator)
        .map(([soundName, data]) => ({
          soundName,
          accelerator: data.accelerator,
        }));
      const ok = await window.api.registerSoundboardShortcuts(list);
      if (!ok) console.warn('[SoundboardService] Shortcuts unavailable: invalid binding or native input hook failed.');
    } catch (err) {
      console.warn('[SoundboardService] Failed to sync shortcuts:', err);
    }
  }

  public async setSinkId(sinkId: string): Promise<void> {
    this.sinkId = sinkId;
    await this.audioOutput.setSinkId(sinkId);
    for (const playback of this.activePlaybacks.values()) await setAudioOutputSink(playback.audio, sinkId);
    for (const pending of this.pendingPlaybacks.values()) {
      if (pending.audio) await setAudioOutputSink(pending.audio, sinkId);
    }
  }

  public async prepareLimiter(): Promise<void> {
    await this.audioOutput.prepareLimiter();
  }

  public getIntensity(): number | null {
    return this.intensity;
  }

  public async loadSounds(): Promise<SoundItem[]> {
    const generation = ++this.loadGeneration;
    let folder = settingsStore.soundboardFolderPath;
    const isCurrent = () => generation === this.loadGeneration && folder === settingsStore.soundboardFolderPath;
    this.loadStatus = 'loading';
    appEvents.emit('soundboard.sounds_loading');
    try {
      if (!folder) {
        if (!window.api?.getDefaultSoundboardFolder) throw new Error('Default soundboard folder access is unavailable');
        const defaultFolder = await window.api.getDefaultSoundboardFolder();
        if (!isCurrent()) return this.sounds;
        if (defaultFolder === null) {
          this.sounds = [];
          this.loadStatus = 'ready';
          appEvents.emit('soundboard.sounds_loaded', this.sounds);
          return this.sounds;
        }
        settingsStore.soundboardFolderPath = defaultFolder;
        try {
          settingsStore.save();
        } catch (error: unknown) {
          settingsStore.soundboardFolderPath = folder;
          throw error;
        }
        folder = defaultFolder;
      }
      if (!window.api?.listSoundboardSounds) throw new Error('Soundboard folder access is unavailable');
      const sounds = await window.api.listSoundboardSounds(folder);
      if (!isCurrent()) return this.sounds;
      this.sounds = sounds;
      this.loadStatus = 'ready';
      appEvents.emit('soundboard.sounds_loaded', this.sounds);
      this.syncShortcuts();
      return this.sounds;
    } catch (err) {
      if (!isCurrent()) return this.sounds;
      console.warn('[SoundboardService] Error loading sounds from folder:', err);
      this.sounds = [];
      this.loadStatus = 'error';
      appEvents.emit('soundboard.sounds_loaded', this.sounds);
      return [];
    }
  }

  public getSounds(): SoundItem[] {
    return this.sounds;
  }

  public getLoadStatus(): 'loading' | 'ready' | 'error' {
    return this.loadStatus;
  }

  public getPlayingSoundNames(): Set<string> {
    const active = new Set<string>();
    for (const p of this.activePlaybacks.values()) {
      if (p.showInGlobalPlayer && !p.audio.paused && !p.audio.ended) {
        active.add(p.soundName);
      }
    }
    return active;
  }

  /** Library files this client asked to play that are not audible yet (`soundboard.loading_changed`). */
  public getLoadingSoundPaths(): Set<string> {
    return new Set([...this.soundRequests].map((request) => request.filePath));
  }

  public getActivePlaybacks(includePaused = false): ActiveSoundPlayback[] {
    return Array.from(this.activePlaybacks.values()).filter(
      (p) => (includePaused || !p.audio.paused) && !p.audio.ended
    );
  }

  /** Whether a sound we sent is playing in the call (a preview out of it is not): the tray megaphone. */
  public isPlayingOwnSound(): boolean {
    return this.getActivePlaybacks().some((p) => p.userId !== 'local' && this.isLocalPlayback(p.userId));
  }

  public getGlobalPlayerPlaybacks(includePaused = false): ActiveSoundPlayback[] {
    return Array.from(this.activePlaybacks.values()).filter(
      (p) => p.showInGlobalPlayer && (includePaused || !p.audio.paused) && !p.audio.ended
    );
  }

  public getCurrentPlayback(): {
    soundName: string | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    activeCount: number;
  } {
    const active = this.getGlobalPlayerPlaybacks();
    const latest = active[active.length - 1];
    return {
      soundName: latest ? latest.soundName : null,
      isPlaying: active.length > 0,
      currentTime: latest?.audio.currentTime || 0,
      duration: latest?.audio.duration || 0,
      activeCount: active.length,
    };
  }

  public stopSoundForUser(userId: string): void {
    const pending = this.pendingPlaybacks.get(userId);
    this.pendingPlaybacks.delete(userId);
    pending?.controller.abort();
    if (pending?.audio) {
      pending.audio.pause();
      pending.audio.src = '';
    }
    const existing = this.activePlaybacks.get(userId);
    existing?.dispose();
  }

  /**
   * Stop requested from the UI. The audio travels once and is then played by
   * each listener on their own, so stopping your own sound has to be announced
   * to the channel — otherwise only the sender falls silent while everyone else
   * hears the rest of the file (#499). Stopping somebody else's sound stays
   * local: it is a personal "I don't want to hear this", not a moderation tool.
   */
  public stopSoundFromUi(userId: string): void {
    if (this.isLocalPlayback(userId)) this.broadcastStop();
    this.stopSoundForUser(userId);
  }

  /**
   * Stops every sound at once (#517). Our own playback is announced to the
   * channel for the same reason a single stop is: the audio already travelled,
   * so silence has to be asked for, not assumed. A sound still on its way
   * counts too: the server relays it before this stop, and the stop then
   * silences it everywhere.
   */
  public stopAllFromUi(): void {
    const hasLocalPlayback = this.getActivePlaybacks(true).some((p) => this.isLocalPlayback(p.userId))
      || [...this.pendingPlaybacks.keys()].some((userId) => this.isLocalPlayback(userId))
      || [...this.soundRequests].some((request) => request.sent);
    if (hasLocalPlayback) this.broadcastStop();
    this.stopSound();
  }

  /** Whether a playback entry belongs to this client (call user or preview). */
  private isLocalPlayback(userId: string): boolean {
    if (userId === 'local') return true;
    const voiceKey = voiceStore.voiceSessionKey;
    const voiceServerStore = (voiceKey ? sessionManager.get(voiceKey)?.serverStore : null) ?? serverStore;
    return !!voiceServerStore.currentUser && voiceServerStore.currentUser.id === userId;
  }

  private broadcastStop(): void {
    const channelId = voiceStore.currentVoiceChannelId;
    if (!channelId || !voiceStore.voiceSessionKey) return;
    try {
      callClient().send(MessageType.SOUNDBOARD_STOP, { channelId });
    } catch (err) {
      console.warn('[SoundboardService] Failed to broadcast soundboard stop:', err);
    }
  }

  public stopSound(userId?: string): void {
    if (userId) {
      this.stopSoundForUser(userId);
      return;
    }
    this.cancelSoundRequests();
    for (const id of new Set([...this.pendingPlaybacks.keys(), ...this.activePlaybacks.keys()])) this.stopSoundForUser(id);
    appEvents.emit('soundboard.playback_ended', {});
  }

  public stopLocalFile(soundName: string): void {
    for (const [userId, pending] of this.pendingPlaybacks) {
      if (this.isLocalPlayback(userId) && pending.soundName === soundName) this.stopSoundFromUi(userId);
    }
    for (const playback of this.getActivePlaybacks(true)) {
      if (this.isLocalPlayback(playback.userId) && playback.soundName === soundName) this.stopSoundFromUi(playback.userId);
    }
  }

  public stopEditorPreview(): void {
    this.stopSoundForUser('editor-preview');
  }

  public stopRecentPreview(): void {
    this.stopSoundForUser('recent-preview');
  }

  /** Plays a cached server sound locally without broadcasting or recording it again. */
  public async previewRecentSound(soundName: string, audioBase64: string, mimeType: string): Promise<boolean> {
    const userId = 'recent-preview';
    const pending = this.beginPlayback(userId, soundName);
    try {
      const audio = new Audio(`data:${mimeType};base64,${audioBase64}`);
      pending.audio = audio;
      this.audioOutput.setVolume(this.getEffectiveVolume());
      await setAudioOutputSink(audio, this.sinkId);
      await this.audioOutput.connect(audio, pending.controller.signal);
      if (this.pendingPlaybacks.get(userId) !== pending) return false;
      return await this.playAudioForUser(audio, userId, t('common.you'), soundName, undefined, false) === 'started';
    } catch (err) {
      if (!pending.controller.signal.aborted) console.warn('[SoundboardService] Recent sound preview failed:', err);
      pending.controller.abort();
      return false;
    } finally {
      if (this.pendingPlaybacks.get(userId) === pending) this.pendingPlaybacks.delete(userId);
    }
  }

  /** Explicit local-only preview through the same volume, sink and limiter graph. */
  public async previewEditedSound(bytes: Uint8Array, soundName: string, startTime = 0): Promise<boolean> {
    const userId = 'editor-preview';
    const pending = this.beginPlayback(userId);
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }));
    try {
      const audio = new Audio(url);
      audio.currentTime = startTime;
      pending.audio = audio;
      this.audioOutput.setVolume(this.getEffectiveVolume());
      await setAudioOutputSink(audio, this.sinkId);
      await this.audioOutput.connect(audio, pending.controller.signal);
      if (this.pendingPlaybacks.get(userId) !== pending) return false;
      return await this.playAudioForUser(audio, userId, t('soundboard.editorPreview'), soundName, () => URL.revokeObjectURL(url)) === 'started';
    } catch (error: unknown) {
      if (!pending.controller.signal.aborted) console.warn('[SoundboardService] Edited audio playback failed:', error);
      pending.controller.abort();
      pending.audio?.pause();
      if (pending.audio) pending.audio.src = '';
      URL.revokeObjectURL(url);
      return false;
    } finally {
      if (this.pendingPlaybacks.get(userId) === pending) this.pendingPlaybacks.delete(userId);
      else URL.revokeObjectURL(url);
    }
  }

  public async selectFolder(): Promise<string | null> {
    if (!window.api?.selectSoundboardFolder) throw new Error(t('botChat.downloadDesktopOnly'));
    const folder = await window.api.selectSoundboardFolder();
    if (folder) {
      const previousFolder = settingsStore.soundboardFolderPath;
      settingsStore.soundboardFolderPath = folder;
      try {
        settingsStore.save();
      } catch (error) {
        settingsStore.soundboardFolderPath = previousFolder;
        throw error;
      }
      await this.loadSounds();
    }
    return folder;
  }

  public async confirmConfiguredFolder(): Promise<boolean> {
    if (!window.api?.confirmSoundboardFolder) throw new Error(t('botChat.downloadDesktopOnly'));
    const folder = settingsStore.soundboardFolderPath;
    if (!folder) return false;
    const confirmed = await window.api.confirmSoundboardFolder(folder);
    return confirmed && folder === settingsStore.soundboardFolderPath;
  }

  /**
   * Plays a library sound: to the call when in one, otherwise as a local
   * preview. Resolves `true` once the sound is audible here, `false` when it
   * was refused, failed or was stopped first. Until then the file is listed by
   * `getLoadingSoundPaths()`: in a call the whole clip first makes a round trip
   * through the server, which can take seconds.
   */
  public async playSound(filePath: string): Promise<boolean> {
    if (!window.api?.readSoundboardSound) return false;

    // Must be in a voice channel to broadcast sound to the room
    const channelId = voiceStore.currentVoiceChannelId;
    const voiceKey = voiceStore.voiceSessionKey;
    const call = channelId && voiceKey ? { channelId, voiceKey } : null;
    if (!call) console.warn('[SoundboardService] Not in a voice channel: playing a local preview');
    else if (!this.canPlayInCall(call.voiceKey, call.channelId)) return false;

    const request = this.beginSoundRequest(filePath);
    let outcome: PlaybackOutcome = 'failed';
    let failure: unknown = null;
    try {
      outcome = call ? await this.sendSoundToCall(request, call.channelId) : await this.playLibraryPreview(request);
    } catch (error: unknown) {
      failure = error;
    } finally {
      this.endSoundRequest(request);
    }
    if (outcome === 'failed' && !request.controller.signal.aborted) this.reportPlayFailure(filePath, failure);
    return outcome === 'started';
  }

  /** The checks the server repeats, made first so a refused sound never shows as loading. */
  private canPlayInCall(voiceKey: string, channelId: string): boolean {
    // Check permissions on the server hosting the call (not necessarily the one in foreground)
    const voiceServerStore = sessionManager.get(voiceKey)?.serverStore ?? serverStore;

    if (voiceStore.permissionMuted) {
      console.warn('[SoundboardService] Cannot play sound: missing SPEAK permission in this channel');
      return false;
    }

    if (voiceServerStore.serverDetails?.allowSoundboard === false) {
      console.warn('[SoundboardService] Soundboard is disabled on the voice server');
      return false;
    }

    if (!voiceServerStore.hasPermission(Permission.USE_SOUNDBOARD, channelId)) {
      console.warn('[SoundboardService] Missing USE_SOUNDBOARD permission on voice server');
      return false;
    }
    return true;
  }

  private async sendSoundToCall(request: SoundRequest, channelId: string): Promise<PlaybackOutcome> {
    const soundData = await window.api.readSoundboardSound(request.filePath);
    if (request.controller.signal.aborted) return 'cancelled';
    if (!soundData) throw new Error(`Failed to read sound file: ${request.filePath}`);

    // Send to server hosting the call via callClient to broadcast to channel
    // members. Its reply is that broadcast, our own copy included, which is
    // then played here like everyone else's — or an error.
    request.sent = true;
    const payload: SoundboardPlayPayload = {
      channelId,
      soundName: soundData.soundName,
      audioBase64: soundData.base64,
      mimeType: soundData.mimeType,
    };
    const echo = await callClient().sendRequest<SoundboardPlayedPayload>(
      MessageType.SOUNDBOARD_PLAY, payload, undefined, PLAY_REQUEST_TIMEOUT_MS,
    );
    return await (this.incomingPlaybacks.get(echo) ?? 'failed');
  }

  private async playLibraryPreview(request: SoundRequest): Promise<PlaybackOutcome> {
    const soundData = await window.api.readSoundboardSound(request.filePath);
    if (request.controller.signal.aborted) return 'cancelled';
    if (!soundData) throw new Error(`Failed to read sound file: ${request.filePath}`);
    const outcome = await this.playLocalPreview(request.filePath, soundData);
    if (outcome === 'started') this.recordLocalPreview(soundData);
    return outcome;
  }

  private beginSoundRequest(filePath: string): SoundRequest {
    const request: SoundRequest = { filePath, controller: new AbortController(), sent: false };
    this.soundRequests.add(request);
    appEvents.emit('soundboard.loading_changed');
    return request;
  }

  private endSoundRequest(request: SoundRequest): void {
    if (this.soundRequests.delete(request)) appEvents.emit('soundboard.loading_changed');
  }

  /** Clears the loading state at once; a sound already sent is silenced by the stop announced to the channel. */
  private cancelSoundRequests(): void {
    if (!this.soundRequests.size) return;
    for (const request of this.soundRequests) request.controller.abort();
    this.soundRequests.clear();
    appEvents.emit('soundboard.loading_changed');
  }

  /** The click already showed the sound loading, so ending in silence has to be explained. */
  private reportPlayFailure(filePath: string, error: unknown): void {
    if (error) console.warn('[SoundboardService] Could not play soundboard sound:', error);
    const name = this.sounds.find((sound) => sound.filePath === filePath)?.name
      ?? filePath.split(/[\\/]/).pop() ?? filePath;
    showErrorToast(error instanceof ProtocolRequestError
      ? t('soundboard.playFailedReason', { name, reason: error.message })
      : t('soundboard.playFailed', { name }));
  }

  private playAudioForUser(
    audio: HTMLAudioElement,
    userId: string,
    userName: string | undefined,
    soundName: string,
    release?: () => void,
    showInGlobalPlayer = true,
  ): Promise<PlaybackOutcome> {
    const playback: ManagedSoundPlayback = {
      userId,
      userName,
      soundName,
      audio,
      dispose: () => cleanup(),
      showInGlobalPlayer,
    };
    this.activePlaybacks.set(userId, playback);

    let stopReason: 'ended' | 'failed' | 'stopped' | null = null;

    const onPlay = () => {
      appEvents.emit('soundboard.playback_started', {
        userId,
        userName,
        soundName,
        duration: audio.duration || 0,
      });
      onTimeUpdate();
    };

    const onTimeUpdate = () => {
      if (audio.ended || !this.activePlaybacks.has(userId)) return;
      const duration = audio.duration || 0;
      const currentTime = audio.currentTime || 0;
      const percent = duration > 0 ? (currentTime / duration) * 100 : 0;
      appEvents.emit('soundboard.playback_progress', {
        userId,
        userName,
        soundName,
        currentTime,
        duration,
        percent: Math.min(100, Math.max(0, percent)),
      });
    };
    const onPause = () => {
      onTimeUpdate();
      appEvents.emit('soundboard.playback_changed', { userId });
    };

    const removeListeners = () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('loadedmetadata', onTimeUpdate);
      audio.removeEventListener('durationchange', onTimeUpdate);
      audio.removeEventListener('seeked', onTimeUpdate);
    };

    const cleanup = (drain = false, failed = false) => {
      if (stopReason) return;
      stopReason = failed ? 'failed' : drain ? 'ended' : 'stopped';
      removeListeners();
      audio.pause();
      audio.src = '';
      this.audioOutput.disconnect(audio, drain);
      release?.();

      if (this.activePlaybacks.get(userId)?.audio === audio) {
        this.activePlaybacks.delete(userId);
        appEvents.emit('soundboard.playback_ended', { userId, soundName, ended: drain, failed });
      }
    };

    const onEnded = () => cleanup(true);
    const onError = (e: Event) => {
      console.warn('[SoundboardService] Audio error:', e);
      cleanup(false, true);
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('loadedmetadata', onTimeUpdate);
    audio.addEventListener('durationchange', onTimeUpdate);
    audio.addEventListener('seeked', onTimeUpdate);

    // A clip that already ended did sound; one stopped or replaced first did not.
    const outcome = (): PlaybackOutcome =>
      stopReason === 'failed' ? 'failed' : stopReason === 'stopped' ? 'cancelled' : 'started';
    return audio.play().then(outcome, (err: unknown) => {
      if (stopReason) return outcome();
      console.warn('[SoundboardService] Audio play error:', err);
      cleanup();
      return 'failed';
    });
  }

  private getEffectiveVolume(): number {
    if (voiceStore.getEffectiveDeafened() || settingsStore.soundboardMuted || settingsStore.soundboardVolume <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(1, settingsStore.soundboardVolume / 100));
  }

  private beginPlayback(userId: string, soundName?: string): PendingSoundPlayback {
    this.stopSoundForUser(userId);
    const pending: PendingSoundPlayback = { audio: null, controller: new AbortController(), soundName };
    this.pendingPlaybacks.set(userId, pending);
    return pending;
  }

  private recordLocalPreview(soundData: SoundboardSoundData): void {
    const session = sessionManager.getActive();
    const details = session?.serverStore.serverDetails;
    if (!session || details?.allowSoundboard === false || !details?.recentSoundCacheEnabled ||
        !details.protocol?.features.includes('recent-sounds') ||
        !session.serverStore.hasPermission(Permission.USE_SOUNDBOARD)) return;
    session.client.send(MessageType.RECENT_SOUND_RECORD, {
      soundName: soundData.soundName,
      audioBase64: soundData.base64,
      mimeType: soundData.mimeType,
    });
  }

  private async playLocalPreview(filePath: string, soundData: SoundboardSoundData): Promise<PlaybackOutcome> {
    const pending = this.beginPlayback('local', this.sounds.find(sound => sound.filePath === filePath)?.name);
    try {
      const audio = new Audio(soundData.dataUrl);
      pending.audio = audio;
      this.audioOutput.setVolume(this.getEffectiveVolume());

      await setAudioOutputSink(audio, this.sinkId);
      await this.audioOutput.connect(audio, pending.controller.signal);
      if (this.pendingPlaybacks.get('local') !== pending) return 'cancelled';

      return await this.playAudioForUser(audio, 'local', t('common.you'), soundData.soundName);
    } catch (err) {
      if (pending.controller.signal.aborted) return 'cancelled';
      console.warn('[SoundboardService] Local preview failed:', err);
      pending.controller.abort();
      return 'failed';
    } finally {
      if (this.pendingPlaybacks.get('local') === pending) this.pendingPlaybacks.delete('local');
    }
  }

  public async handleIncomingSound(payload: SoundboardPlayedPayload): Promise<PlaybackOutcome> {
    appEvents.emit('soundboard.played', payload);

    const userId = payload.userId || 'unknown';

    // Per #156: If the SAME user triggers another sound, interrupt and replace their own previous sound.
    // Different users play their sounds concurrently at the same time.
    const pending = this.beginPlayback(userId, payload.soundName);

    try {
      const dataUrl = payload.audioBase64.startsWith('data:')
        ? payload.audioBase64
        : `data:${payload.mimeType || 'audio/mp3'};base64,${payload.audioBase64}`;

      const audio = new Audio(dataUrl);
      pending.audio = audio;
      this.audioOutput.setVolume(this.getEffectiveVolume());

      await setAudioOutputSink(audio, this.sinkId);
      await this.audioOutput.connect(audio, pending.controller.signal);
      if (this.pendingPlaybacks.get(userId) !== pending) return 'cancelled';

      return await this.playAudioForUser(audio, userId, payload.userName, payload.soundName);
    } catch (err) {
      if (pending.controller.signal.aborted) return 'cancelled';
      console.warn('[SoundboardService] Failed to play incoming soundboard audio:', err);
      pending.controller.abort();
      return 'failed';
    } finally {
      if (this.pendingPlaybacks.get(userId) === pending) this.pendingPlaybacks.delete(userId);
    }
  }
}

export const soundboardService = new SoundboardService();
