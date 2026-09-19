import micUnmuteUrl from '../assets/sounds/Desmutando_Mic.wav';
import micMuteUrl from '../assets/sounds/Mutando_Mic.wav';
import deafenUrl from '../assets/sounds/Mutar_Auto-Falante.wav';
import undeafenUrl from '../assets/sounds/Desmutar_Auto-Falante.wav';
import joinVoiceUrl from '../assets/sounds/Entrando_Na_Call.wav';
import leaveVoiceUrl from '../assets/sounds/Saindo_Da_Call.wav';
import { settingsStore } from '../stores/settingsStore';
import { t, type TranslationKey } from '../i18n';
import { setAudioOutputSink } from './AudioOutputSink';

export const SOUND_EFFECT_TYPES = [
  'mic_mute', 'mic_unmute', 'deafen', 'undeafen', 'join_voice', 'leave_voice',
  'screen_share_start', 'screen_share_stop', 'chat_message', 'ptt_press', 'ptt_release', 'reconnecting',
] as const;
export type SoundEffectType = typeof SOUND_EFFECT_TYPES[number];

const SOUND_LABEL_KEYS: Record<SoundEffectType, TranslationKey> = {
  mic_mute: 'sounds.micMute',
  mic_unmute: 'sounds.micUnmute',
  deafen: 'sounds.deafen',
  undeafen: 'sounds.undeafen',
  join_voice: 'sounds.joinVoice',
  leave_voice: 'sounds.leaveVoice',
  screen_share_start: 'sounds.screenShareStart',
  screen_share_stop: 'sounds.screenShareStop',
  chat_message: 'sounds.chatMessage',
  ptt_press: 'sounds.pttPress',
  ptt_release: 'sounds.pttRelease',
  reconnecting: 'sounds.reconnecting',
};

export function isSoundEffectType(value: unknown): value is SoundEffectType {
  return SOUND_EFFECT_TYPES.some(key => key === value);
}

const DEFAULT_URLS: Partial<Record<SoundEffectType, string>> = {
  mic_unmute: micUnmuteUrl,
  mic_mute: micMuteUrl,
  deafen: deafenUrl,
  undeafen: undeafenUrl,
  join_voice: joinVoiceUrl,
  leave_voice: leaveVoiceUrl,
};

/**
 * Rótulos dos efeitos sonoros, resolvidos no idioma ativo a cada chamada (#16)
 * — por isso é uma função, e não um objeto constante.
 */
export function getSoundLabels(): Record<SoundEffectType, string> {
  const labels: Record<SoundEffectType, string> = { ...SOUND_LABEL_KEYS };
  for (const key of SOUND_EFFECT_TYPES) labels[key] = t(SOUND_LABEL_KEYS[key]);
  return labels;
}

export class SoundEffectManager {
  private audioMap: Partial<Record<SoundEffectType, HTMLAudioElement>> = {};
  private toneCtx: AudioContext | null = null;
  private speakerDeviceId: string | null = null;
  private playRequests: Partial<Record<SoundEffectType, number>> = {};
  // Handle for the repeating reconnection cue (#553): a window.setInterval id
  // while a voice call is reconnecting, or null when it is not.
  private reconnectLoopTimer: number | null = null;

  constructor() {
    this.loadAll();
  }

  public loadAll(): void {
    const customSounds = settingsStore.customSounds || {};
    for (const key of SOUND_EFFECT_TYPES) this.reloadSound(key, customSounds[key]);
  }

  public reloadSound(key: SoundEffectType, url?: string): void {
    this.stopCachedSound(key);
    const previous = this.audioMap[key];
    if (previous) previous.src = '';
    delete this.audioMap[key];
    if (url !== undefined && (typeof url !== 'string' || !url.trim())) {
      console.warn(`[SoundEffects] Invalid custom sound for ${key}; restoring the default.`);
      url = undefined;
    }
    const finalUrl = url || DEFAULT_URLS[key];
    if (finalUrl) this.preload(key, finalUrl);
  }

  private stopCachedSound(key: SoundEffectType): void {
    this.playRequests[key] = (this.playRequests[key] ?? 0) + 1;
    const audio = this.audioMap[key];
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
  }

  private preload(key: SoundEffectType, url: string): void {
    try {
      const audio = new Audio(url);
      audio.volume = 0.6;
      void this.applySink(audio).catch((error: unknown) => console.warn('[SoundEffects] Could not preload the selected output:', error));
      this.audioMap[key] = audio;
    } catch (e) {
      console.warn(`[SoundEffects] Error preloading sound ${key}:`, e);
    }
  }

  /**
   * Routes an audio element to the speaker device selected in the app so that
   * sound effects respect the user's choice instead of the OS default.
   */
  private applySink(audio: HTMLAudioElement): Promise<void> {
    const deviceId = this.speakerDeviceId ?? settingsStore.selectedSpeakerId;
    return setAudioOutputSink(audio, deviceId);
  }

  /** Reapplies the currently selected speaker to all preloaded sound effects. */
  public async setSinkId(deviceId: string): Promise<void> {
    this.speakerDeviceId = deviceId;
    for (const audio of Object.values(this.audioMap)) {
      if (audio) {
        if (typeof audio.setSinkId !== 'function') throw new Error('Output selection unavailable');
        await setAudioOutputSink(audio, deviceId);
      }
    }
    if (this.toneCtx && 'setSinkId' in this.toneCtx && typeof this.toneCtx.setSinkId === 'function') {
      await setAudioOutputSink(this.toneCtx, deviceId);
    }
  }

  /**
   * Lazily creates the shared tone AudioContext and routes it to the speaker
   * selected in the app.
   */
  private ensureToneCtx(): AudioContext {
    if (!this.toneCtx) {
      this.toneCtx = new AudioContext({ sinkId: { type: 'none' } });
    }
    return this.toneCtx!;
  }

  /**
   * Runs `schedule` with the tone context guaranteed to be running. Chromium can
   * park an AudioContext in the "suspended" state — e.g. while Monky sits in the
   * background behind the window being shared or a fullscreen game. A suspended
   * context advances no clock, so scheduling oscillators at `currentTime` would
   * place them in the past and silently drop the cue (this is why the
   * screen-share stop sound went missing when the shared window was closed).
   * `resume()` is async, so we must await it and only then read the clock (#560).
   */
  private withRunningToneCtx(schedule: (ctx: AudioContext, now: number) => void): void {
    const ctx = this.ensureToneCtx();
    void setAudioOutputSink(ctx, this.speakerDeviceId ?? settingsStore.selectedSpeakerId)
      .then(async () => {
        if (ctx.state === 'suspended') await ctx.resume();
        if (ctx.state !== 'closed') schedule(ctx, ctx.currentTime);
      })
      .catch((error: unknown) => console.warn('[SoundEffects] Could not play the tone on the selected output:', error));
  }

  /**
   * Synthesizes a short two-note cue for screen-share start/stop using the Web
   * Audio API, so no extra binary assets are needed. A rising interval signals
   * "start" and a falling interval signals "stop".
   */
  private playTone(rising: boolean): void {
    try {
      this.withRunningToneCtx((ctx, now) => {
        const freqs = rising ? [523.25, 783.99] : [783.99, 523.25];
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.25, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.34);
        gain.connect(ctx.destination);

        freqs.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now + i * 0.13);
          osc.connect(gain);
          osc.start(now + i * 0.13);
          osc.stop(now + i * 0.13 + 0.16);
        });
      });
    } catch (e) {
      console.debug('[SoundEffects] Tone synthesis failed:', e);
    }
  }

  /**
   * Synthesizes a soft, quick two-note "pop" used to signal an incoming chat
   * message (#152). Kept lighter and shorter than the screen-share cue so the
   * two are easy to tell apart.
   */
  private playChatCue(): void {
    try {
      this.withRunningToneCtx((ctx, now) => {
        const freqs = [659.25, 987.77]; // E5 -> B5, a light ascending blip
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.18, now + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
        gain.connect(ctx.destination);

        freqs.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now + i * 0.07);
          osc.connect(gain);
          osc.start(now + i * 0.07);
          osc.stop(now + i * 0.07 + 0.1);
        });
      });
    } catch (e) {
      console.debug('[SoundEffects] Chat cue synthesis failed:', e);
    }
  }

  /**
   * Synthesizes a subtle, pleasant PTT key press/release cue.
   */
  public playPttTone(activate: boolean): void {
    if (!settingsStore.pttSoundCue) return;
    this.play(activate ? 'ptt_press' : 'ptt_release');
  }

  private playPttCue(activate: boolean): void {
    try {
      this.withRunningToneCtx((ctx, now) => {
        const freq = activate ? 620 : 440;
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.12, now + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
        gain.connect(ctx.destination);

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.08);
      });
    } catch (e) {
      console.debug('[SoundEffects] PTT tone synthesis failed:', e);
    }
  }

  /**
   * Soft descending two-note cue (A4 -> F4) played while a voice call is
   * reconnecting (#553). The gentle falling minor third reads as "trouble" and
   * is intentionally distinct from the chat and screen-share cues.
   */
  private playReconnectCue(): void {
    try {
      this.withRunningToneCtx((ctx, now) => {
        const freqs = [440, 349.23]; // A4 -> F4, a gentle falling minor third
        const gain = ctx.createGain();
        gain.gain.setValueAtTime(0.0001, now);
        gain.gain.exponentialRampToValueAtTime(0.16, now + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.4);
        gain.connect(ctx.destination);

        freqs.forEach((freq, i) => {
          const osc = ctx.createOscillator();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now + i * 0.16);
          osc.connect(gain);
          osc.start(now + i * 0.16);
          osc.stop(now + i * 0.16 + 0.2);
        });
      });
    } catch (e) {
      console.debug('[SoundEffects] Reconnect cue synthesis failed:', e);
    }
  }

  /**
   * Starts a recurring reconnection cue that keeps playing for the whole
   * duration of a voice reconnection (#553). Idempotent: calling it again while
   * already looping is a no-op, so repeated 'sfu.reconnecting' events don't
   * stack timers.
   */
  public startReconnectingLoop(): void {
    if (this.reconnectLoopTimer !== null) return;
    this.play('reconnecting');
    this.reconnectLoopTimer = window.setInterval(() => {
      const current = this.audioMap.reconnecting;
      if (!current || current.paused || current.ended) this.play('reconnecting');
    }, 5000);
  }

  /** Stops the recurring reconnection cue, if one is running. */
  public stopReconnectingLoop(): void {
    if (this.reconnectLoopTimer !== null) {
      clearInterval(this.reconnectLoopTimer);
      this.reconnectLoopTimer = null;
      this.stopCachedSound('reconnecting');
    }
  }

  public play(key: SoundEffectType): void {
    try {
      const audio = this.audioMap[key];
      if (audio) {
        const request = (this.playRequests[key] ?? 0) + 1;
        this.playRequests[key] = request;
        audio.currentTime = 0;
        // Apply the selected speaker BEFORE playing so the sound doesn't briefly
        // (or entirely) come out of the OS default device (#46).
        void this.applySink(audio)
          .then(() => {
            if (this.audioMap[key] === audio && this.playRequests[key] === request) return audio.play();
          })
          .catch((error: unknown) => {
            if (this.audioMap[key] === audio && this.playRequests[key] === request) {
              console.warn(`[SoundEffects] Could not play ${key} on the selected output:`, error);
            }
          });
        return;
      }
      switch (key) {
        case 'screen_share_start': this.playTone(true); return;
        case 'screen_share_stop': this.playTone(false); return;
        case 'chat_message': this.playChatCue(); return;
        case 'ptt_press': this.playPttCue(true); return;
        case 'ptt_release': this.playPttCue(false); return;
        case 'reconnecting': this.playReconnectCue(); return;
        case 'mic_mute':
        case 'mic_unmute':
        case 'deafen':
        case 'undeafen':
        case 'join_voice':
        case 'leave_voice':
          console.warn(`[SoundEffects] Default audio is unavailable for ${key}.`);
          return;
        default: {
          const unknownSound: never = key;
          throw new Error(`Unknown sound effect: ${unknownSound}`);
        }
      }
    } catch (e) {
      console.warn(`[SoundEffects] Error playing sound ${key}:`, e);
    }
  }
}

export const soundEffects = new SoundEffectManager();
