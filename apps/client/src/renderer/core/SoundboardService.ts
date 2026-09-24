import { MessageType, Permission, SoundboardPlayedPayload, SoundboardStoppedPayload } from '@monky/shared';
import { appEvents } from './EventBus';
import { callClient } from './serverConnection';
import { sessionManager } from './SessionManager';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';
import { SoundboardAudioOutput } from './SoundboardAudioOutput';
import { setAudioOutputSink } from './AudioOutputSink';

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
}

export class SoundboardService {
  private sounds: SoundItem[] = [];
  private loadGeneration = 0;
  private loadStatus: 'loading' | 'ready' | 'error' = 'ready';
  private sinkId: string = settingsStore.selectedSpeakerId;
  private activePlaybacks: Map<string, ManagedSoundPlayback> = new Map();
  private pendingPlaybacks = new Map<string, PendingSoundPlayback>();
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
      this.handleIncomingSound(payload);
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
      if (!p.audio.paused && !p.audio.ended) {
        active.add(p.soundName);
      }
    }
    return active;
  }

  public getActivePlaybacks(includePaused = false): ActiveSoundPlayback[] {
    return Array.from(this.activePlaybacks.values()).filter(
      (p) => (includePaused || !p.audio.paused) && !p.audio.ended
    );
  }

  public getCurrentPlayback(): {
    soundName: string | null;
    isPlaying: boolean;
    currentTime: number;
    duration: number;
    activeCount: number;
  } {
    const active = this.getActivePlaybacks();
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
   * so silence has to be asked for, not assumed.
   */
  public stopAllFromUi(): void {
    const hasLocalPlayback = this.getActivePlaybacks(true).some((p) => this.isLocalPlayback(p.userId))
      || [...this.pendingPlaybacks.keys()].some((userId) => this.isLocalPlayback(userId));
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
      return await this.playAudioForUser(audio, userId, t('soundboard.editorPreview'), soundName, () => URL.revokeObjectURL(url));
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

  public async playSound(filePath: string): Promise<boolean> {
    if (!window.api?.readSoundboardSound) return false;

    // Must be in a voice channel to broadcast sound to the room
    const currentChannelId = voiceStore.currentVoiceChannelId;
    const voiceKey = voiceStore.voiceSessionKey;
    if (!currentChannelId || !voiceKey) {
      console.warn('[SoundboardService] Cannot play sound: not in a voice channel');
      // Local preview if clicked outside call
      return await this.playLocalPreview(filePath);
    }

    // Check permissions on the server hosting the call (not necessarily the one in foreground)
    const voiceSession = sessionManager.get(voiceKey);
    const voiceServerStore = voiceSession?.serverStore ?? serverStore;

    if (voiceServerStore.serverDetails?.allowSoundboard === false) {
      console.warn('[SoundboardService] Soundboard is disabled on the voice server');
      return false;
    }

    if (!voiceServerStore.hasPermission(Permission.USE_SOUNDBOARD)) {
      console.warn('[SoundboardService] Missing USE_SOUNDBOARD permission on voice server');
      return false;
    }

    try {
      const soundData = await window.api.readSoundboardSound(filePath);
      if (!soundData) {
        console.warn('[SoundboardService] Failed to read sound file:', filePath);
        return false;
      }

      // Send to server hosting the call via callClient to broadcast to channel members
      callClient().send(MessageType.SOUNDBOARD_PLAY, {
        channelId: currentChannelId,
        soundName: soundData.soundName,
        audioBase64: soundData.base64,
        mimeType: soundData.mimeType,
      });

      return true;
    } catch (err) {
      console.error('[SoundboardService] Error playing soundboard sound:', err);
      return false;
    }
  }

  private playAudioForUser(
    audio: HTMLAudioElement,
    userId: string,
    userName: string | undefined,
    soundName: string,
    release?: () => void
  ): Promise<boolean> {
    const playback: ManagedSoundPlayback = {
      userId,
      userName,
      soundName,
      audio,
      dispose: () => cleanup(),
    };
    this.activePlaybacks.set(userId, playback);

    let isCleanedUp = false;

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
      if (isCleanedUp) return;
      isCleanedUp = true;
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

    return audio.play().then(() => !isCleanedUp).catch((err) => {
      if (isCleanedUp) return false;
      console.warn('[SoundboardService] Audio play error:', err);
      cleanup();
      return false;
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

  private async playLocalPreview(filePath: string): Promise<boolean> {
    const pending = this.beginPlayback('local', this.sounds.find(sound => sound.filePath === filePath)?.name);
    try {
      const soundData = await window.api.readSoundboardSound(filePath);
      if (!soundData) throw new Error('Could not read the soundboard file');
      if (this.pendingPlaybacks.get('local') !== pending) return false;

      const audio = new Audio(soundData.dataUrl);
      pending.audio = audio;
      this.audioOutput.setVolume(this.getEffectiveVolume());

      await setAudioOutputSink(audio, this.sinkId);
      await this.audioOutput.connect(audio, pending.controller.signal);
      if (this.pendingPlaybacks.get('local') !== pending) return false;

      return await this.playAudioForUser(audio, 'local', t('common.you'), soundData.soundName);
    } catch (err) {
      if (!pending.controller.signal.aborted) console.warn('[SoundboardService] Local preview failed:', err);
      pending.controller.abort();
      return false;
    } finally {
      if (this.pendingPlaybacks.get('local') === pending) this.pendingPlaybacks.delete('local');
    }
  }

  public async handleIncomingSound(payload: SoundboardPlayedPayload): Promise<void> {
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
      if (this.pendingPlaybacks.get(userId) !== pending) return;

      await this.playAudioForUser(audio, userId, payload.userName, payload.soundName);
    } catch (err) {
      if (!pending.controller.signal.aborted) console.warn('[SoundboardService] Failed to play incoming soundboard audio:', err);
      pending.controller.abort();
    } finally {
      if (this.pendingPlaybacks.get(userId) === pending) this.pendingPlaybacks.delete(userId);
    }
  }
}

export const soundboardService = new SoundboardService();
