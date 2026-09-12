import { MessageType, Permission, SoundboardPlayedPayload, SoundboardStoppedPayload } from '@monky/shared';
import { appEvents } from './EventBus';
import { callClient } from './serverConnection';
import { sessionManager } from './SessionManager';
import { settingsStore } from '../stores/settingsStore';
import { voiceStore } from '../stores/voiceStore';
import { serverStore } from '../stores/serverStore';
import { t } from '../i18n';
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
}

export class SoundboardService {
  private sounds: SoundItem[] = [];
  private loadGeneration = 0;
  private sinkId: string = settingsStore.selectedSpeakerId;
  private activePlaybacks: Map<string, ActiveSoundPlayback> = new Map();
  private pendingPlaybacks = new Map<string, PendingSoundPlayback>();

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
      for (const playback of this.activePlaybacks.values()) {
        playback.audio.volume = vol;
      }
    });

    // Update speaker device and active audio volume when settings change
    appEvents.on('settings.updated', () => {
      if (settingsStore.selectedSpeakerId !== this.sinkId) {
        void this.setSinkId(settingsStore.selectedSpeakerId).catch((error: unknown) => {
          console.warn('[SoundboardService] Could not switch speaker:', error);
        });
      }
      const vol = this.getEffectiveVolume();
      for (const playback of this.activePlaybacks.values()) {
        playback.audio.volume = vol;
      }
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
    for (const playback of this.activePlaybacks.values()) {
      if (typeof playback.audio.setSinkId !== 'function') throw new Error('Output selection unavailable');
      await setAudioOutputSink(playback.audio, sinkId);
    }
    for (const pending of this.pendingPlaybacks.values()) {
      if (pending.audio) await setAudioOutputSink(pending.audio, sinkId);
    }
  }

  public async loadSounds(): Promise<SoundItem[]> {
    const generation = ++this.loadGeneration;
    const folder = settingsStore.soundboardFolderPath;
    const isCurrent = () => generation === this.loadGeneration && folder === settingsStore.soundboardFolderPath;
    if (!folder || !window.api?.listSoundboardSounds) {
      this.sounds = [];
      appEvents.emit('soundboard.sounds_loaded', this.sounds);
      return [];
    }

    try {
      const sounds = await window.api.listSoundboardSounds(folder);
      if (!isCurrent()) return this.sounds;
      this.sounds = sounds;
      appEvents.emit('soundboard.sounds_loaded', this.sounds);
      this.syncShortcuts();
      return this.sounds;
    } catch (err) {
      if (!isCurrent()) return this.sounds;
      console.warn('[SoundboardService] Error loading sounds from folder:', err);
      this.sounds = [];
      appEvents.emit('soundboard.sounds_loaded', this.sounds);
      return [];
    }
  }

  public getSounds(): SoundItem[] {
    return this.sounds;
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

  public getActivePlaybacks(): ActiveSoundPlayback[] {
    return Array.from(this.activePlaybacks.values()).filter(
      (p) => !p.audio.paused && !p.audio.ended
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
    if (pending?.audio) {
      pending.audio.pause();
      pending.audio.src = '';
    }
    const existing = this.activePlaybacks.get(userId);
    if (existing) {
      this.activePlaybacks.delete(userId);
      try {
        existing.audio.pause();
        existing.audio.currentTime = 0;
        existing.audio.src = '';
      } catch (err) {
        console.warn('[SoundboardService] Error stopping user audio:', err);
      }
      appEvents.emit('soundboard.playback_ended', { userId, soundName: existing.soundName });
    }
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
    const hasLocalPlayback = this.getActivePlaybacks().some((p) => this.isLocalPlayback(p.userId))
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
    for (const pendingUserId of [...this.pendingPlaybacks.keys()]) this.stopSoundForUser(pendingUserId);
    for (const [uid, playback] of Array.from(this.activePlaybacks.entries())) {
      this.activePlaybacks.delete(uid);
      try {
        playback.audio.pause();
        playback.audio.currentTime = 0;
        playback.audio.src = '';
      } catch (err) {
        console.warn('[SoundboardService] Error stopping audio:', err);
      }
      appEvents.emit('soundboard.playback_ended', { userId: uid, soundName: playback.soundName });
    }
    this.activePlaybacks.clear();
    appEvents.emit('soundboard.playback_ended', {});
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
    soundName: string
  ): void {
    const playback: ActiveSoundPlayback = {
      userId,
      userName,
      soundName,
      audio,
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
    };

    const onTimeUpdate = () => {
      if (audio.paused || audio.ended || !this.activePlaybacks.has(userId)) return;
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

    const removeListeners = () => {
      audio.removeEventListener('play', onPlay);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };

    const cleanup = () => {
      if (isCleanedUp) return;
      isCleanedUp = true;
      removeListeners();

      if (this.activePlaybacks.get(userId)?.audio === audio) {
        this.activePlaybacks.delete(userId);
        appEvents.emit('soundboard.playback_ended', { userId, soundName });
      }
    };

    const onEnded = () => cleanup();
    const onError = (e: Event) => {
      console.warn('[SoundboardService] Audio error:', e);
      cleanup();
    };

    audio.addEventListener('play', onPlay);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);

    audio.play().catch((err) => {
      console.warn('[SoundboardService] Audio play error:', err);
      cleanup();
    });
  }

  private getEffectiveVolume(): number {
    if (voiceStore.getEffectiveDeafened() || settingsStore.soundboardMuted || settingsStore.soundboardVolume <= 0) {
      return 0;
    }
    return Math.max(0, Math.min(1, settingsStore.soundboardVolume / 100));
  }

  private beginPlayback(userId: string): PendingSoundPlayback {
    this.stopSoundForUser(userId);
    const pending: PendingSoundPlayback = { audio: null };
    this.pendingPlaybacks.set(userId, pending);
    return pending;
  }

  private async playLocalPreview(filePath: string): Promise<boolean> {
    const pending = this.beginPlayback('local');
    try {
      const soundData = await window.api.readSoundboardSound(filePath);
      if (!soundData) throw new Error('Could not read the soundboard file');
      if (this.pendingPlaybacks.get('local') !== pending) return false;

      const audio = new Audio(soundData.dataUrl);
      pending.audio = audio;
      audio.volume = this.getEffectiveVolume();

      await setAudioOutputSink(audio, this.sinkId);
      if (this.pendingPlaybacks.get('local') !== pending) return false;

      this.playAudioForUser(audio, 'local', t('common.you'), soundData.soundName);
      return true;
    } catch (err) {
      console.warn('[SoundboardService] Local preview failed:', err);
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
    const pending = this.beginPlayback(userId);

    try {
      const dataUrl = payload.audioBase64.startsWith('data:')
        ? payload.audioBase64
        : `data:${payload.mimeType || 'audio/mp3'};base64,${payload.audioBase64}`;

      const audio = new Audio(dataUrl);
      pending.audio = audio;
      audio.volume = this.getEffectiveVolume();

      await setAudioOutputSink(audio, this.sinkId);
      if (this.pendingPlaybacks.get(userId) !== pending) return;

      this.playAudioForUser(audio, userId, payload.userName, payload.soundName);
    } catch (err) {
      console.warn('[SoundboardService] Failed to play incoming soundboard audio:', err);
    } finally {
      if (this.pendingPlaybacks.get(userId) === pending) this.pendingPlaybacks.delete(userId);
    }
  }
}

export const soundboardService = new SoundboardService();
