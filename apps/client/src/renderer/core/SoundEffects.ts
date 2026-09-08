import micUnmuteUrl from '../assets/sounds/Desmutando_Mic.wav';
import micMuteUrl from '../assets/sounds/Mutando_Mic.wav';
import deafenUrl from '../assets/sounds/Mutar_Auto-Falante.wav';
import undeafenUrl from '../assets/sounds/Desmutar_Auto-Falante.wav';
import joinVoiceUrl from '../assets/sounds/Entrando_Na_Call.wav';
import leaveVoiceUrl from '../assets/sounds/Saindo_Da_Call.wav';
import { settingsStore } from '../stores/settingsStore';
import { t } from '../i18n';

export type SoundEffectType =
  | 'mic_mute'
  | 'mic_unmute'
  | 'deafen'
  | 'undeafen'
  | 'join_voice'
  | 'leave_voice'
  | 'screen_share_start'
  | 'screen_share_stop'
  | 'chat_message';

const DEFAULT_URLS: Record<string, string> = {
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
export function getSoundLabels(): Record<string, string> {
  return {
    mic_mute: t('sounds.micMute'),
    mic_unmute: t('sounds.micUnmute'),
    deafen: t('sounds.deafen'),
    undeafen: t('sounds.undeafen'),
    join_voice: t('sounds.joinVoice'),
    leave_voice: t('sounds.leaveVoice'),
    screen_share_start: t('sounds.screenShareStart'),
    screen_share_stop: t('sounds.screenShareStop'),
  };
}

export class SoundEffectManager {
  private audioMap: Partial<Record<SoundEffectType, HTMLAudioElement>> = {};
  private toneCtx: AudioContext | null = null;
  // Handle for the repeating reconnection cue (#553): a window.setInterval id
  // while a voice call is reconnecting, or null when it is not.
  private reconnectLoopTimer: number | null = null;

  constructor() {
    this.loadAll();
  }

  public loadAll(): void {
    const customSounds = settingsStore.customSounds || {};
    for (const [key, defaultUrl] of Object.entries(DEFAULT_URLS)) {
      const url = customSounds[key] || defaultUrl;
      this.preload(key as SoundEffectType, url);
    }
  }

  public reloadSound(key: SoundEffectType, url?: string): void {
    const finalUrl = url || DEFAULT_URLS[key];
    if (finalUrl) this.preload(key, finalUrl);
  }

  private preload(key: SoundEffectType, url: string): void {
    try {
      const audio = new Audio(url);
      audio.volume = 0.6;
      this.applySink(audio);
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
    const deviceId = settingsStore.selectedSpeakerId;
    if (deviceId && typeof (audio as any).setSinkId === 'function' && (audio as any).sinkId !== deviceId) {
      return (audio as any).setSinkId(deviceId).catch(() => {
        /* device may be gone; ignore and fall back to default */
      });
    }
    return Promise.resolve();
  }

  /** Reapplies the currently selected speaker to all preloaded sound effects. */
  public setSinkId(deviceId: string): void {
    for (const audio of Object.values(this.audioMap)) {
      if (audio && typeof (audio as any).setSinkId === 'function') {
        (audio as any).setSinkId(deviceId).catch(() => {});
      }
    }
    if (this.toneCtx && typeof (this.toneCtx as any).setSinkId === 'function') {
      (this.toneCtx as any).setSinkId(deviceId).catch(() => {});
    }
  }

  /**
   * Lazily creates the shared tone AudioContext and routes it to the speaker
   * selected in the app.
   */
  private ensureToneCtx(): AudioContext {
    if (!this.toneCtx) {
      const Ctor = window.AudioContext || (window as any).webkitAudioContext;
      this.toneCtx = new Ctor();
      if (settingsStore.selectedSpeakerId && typeof (this.toneCtx as any).setSinkId === 'function') {
        (this.toneCtx as any).setSinkId(settingsStore.selectedSpeakerId).catch(() => {});
      }
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
    const run = () => schedule(ctx, ctx.currentTime);
    if (ctx.state === 'suspended') {
      ctx.resume().then(run).catch(() => {});
    } else {
      run();
    }
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
    this.playReconnectCue();
    this.reconnectLoopTimer = window.setInterval(() => this.playReconnectCue(), 5000);
  }

  /** Stops the recurring reconnection cue, if one is running. */
  public stopReconnectingLoop(): void {
    if (this.reconnectLoopTimer !== null) {
      clearInterval(this.reconnectLoopTimer);
      this.reconnectLoopTimer = null;
    }
  }

  public play(key: SoundEffectType): void {
    if (key === 'screen_share_start') {
      this.playTone(true);
      return;
    }
    if (key === 'screen_share_stop') {
      this.playTone(false);
      return;
    }
    if (key === 'chat_message') {
      this.playChatCue();
      return;
    }
    try {
      const audio = this.audioMap[key];
      if (audio) {
        audio.currentTime = 0;
        // Apply the selected speaker BEFORE playing so the sound doesn't briefly
        // (or entirely) come out of the OS default device (#46).
        this.applySink(audio).finally(() => {
          audio.play().catch((err) => {
            console.debug(`[SoundEffects] Play prevented for ${key}:`, err);
          });
        });
      }
    } catch (e) {
      console.warn(`[SoundEffects] Error playing sound ${key}:`, e);
    }
  }
}

export const soundEffects = new SoundEffectManager();
