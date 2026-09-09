import {
  type ServerSettingsUpdatedPayload,
  type VoiceUserLeftPayload,
  voiceModeTransitionSchema,
} from '@monky/shared';

export interface VoiceReconnectCall {
  sessionKey: string;
  sessionId: string;
  channelId: string;
}

interface ReconnectAttempt {
  call: VoiceReconnectCall;
  transitionId: string;
  teardown: Promise<void>;
  ready: boolean;
  started: boolean;
  timer: ReturnType<typeof setTimeout>;
}

export interface VoiceModeReconnectOptions {
  currentCall: () => VoiceReconnectCall | null;
  canReconnect: (call: VoiceReconnectCall) => boolean;
  teardown: () => Promise<void>;
  rejoin: (call: VoiceReconnectCall, transitionId: string, isCurrent: () => boolean) => Promise<void>;
  notify: (call: VoiceReconnectCall) => void;
  failed: (call: VoiceReconnectCall, error: Error) => void;
  cancelled: (call: VoiceReconnectCall) => void;
  timeoutMessage: () => string;
}

/** A departure authorizes one rejoin, not an enduring instruction to join a room. */
export class VoiceModeReconnect {
  private attempt: ReconnectAttempt | null = null;
  private seen: string[] = [];

  constructor(private readonly options: VoiceModeReconnectOptions) {}

  public departed(sessionKey: string, payload: VoiceUserLeftPayload): 'reconnect' | 'ignore' | false {
    const transition = voiceModeTransitionSchema.safeParse(payload.reconnect);
    if (!transition.success) return false;
    const identity = `${sessionKey}\n${payload.sessionId}\n${transition.data.id}`;
    if (this.seen.includes(identity)) return 'ignore';
    this.seen.push(identity);
    if (this.seen.length > 64) this.seen.shift();

    const call = this.options.currentCall();
    if (!call || call.sessionKey !== sessionKey || call.sessionId !== payload.sessionId
      || call.channelId !== payload.channelId) return 'ignore';
    if (!this.options.canReconnect(call)) {
      this.options.cancelled(call);
      return 'reconnect';
    }
    if (this.attempt) {
      this.cancel();
      return 'reconnect';
    }
    this.options.notify(call);
    const attempt: ReconnectAttempt = {
      call, transitionId: transition.data.id, ready: false, started: false,
      teardown: Promise.resolve(),
      timer: setTimeout(() => {
        if (this.attempt === attempt) this.fail(attempt, new Error(this.options.timeoutMessage()));
      }, 15000),
    };
    this.attempt = attempt;
    try {
      attempt.teardown = this.options.teardown();
      // Observe immediately: settings may still be awaiting a server-side I/O.
      void attempt.teardown.catch((error: unknown) => this.fail(attempt, error));
    } catch (error) {
      this.fail(attempt, error);
    }
    return 'reconnect';
  }

  public settingsUpdated(sessionKey: string, payload: ServerSettingsUpdatedPayload): void {
    const attempt = this.attempt;
    if (!attempt || attempt.call.sessionKey !== sessionKey) return;
    if (payload.voiceMode !== 'p2p') {
      this.cancel();
      return;
    }
    if (payload.voiceTransition?.id !== attempt.transitionId) return;
    attempt.ready = true;
    void this.reconnect(attempt);
  }

  /** Called on explicit leave/join, kick, lost permissions or socket replacement. */
  public cancel(): void {
    const attempt = this.attempt;
    if (!attempt) return;
    this.attempt = null;
    clearTimeout(attempt.timer);
    this.options.cancelled(attempt.call);
  }

  public validate(): void {
    if (this.attempt && !this.isCurrent(this.attempt)) this.cancel();
  }

  private isCurrent(attempt: ReconnectAttempt): boolean {
    const current = this.options.currentCall();
    return this.attempt === attempt && !!current
      && current.sessionKey === attempt.call.sessionKey
      && current.sessionId === attempt.call.sessionId
      && current.channelId === attempt.call.channelId
      && this.options.canReconnect(attempt.call);
  }

  private async reconnect(attempt: ReconnectAttempt): Promise<void> {
    if (!attempt.ready || attempt.started) return;
    attempt.started = true;
    try {
      await attempt.teardown;
      if (!this.isCurrent(attempt)) { this.validate(); return; }
      await this.options.rejoin(attempt.call, attempt.transitionId, () => this.isCurrent(attempt));
      if (!this.isCurrent(attempt)) { this.validate(); return; }
      clearTimeout(attempt.timer);
      this.attempt = null;
    } catch (error) {
      this.fail(attempt, error);
    }
  }

  private fail(attempt: ReconnectAttempt, reason: unknown): void {
    if (this.attempt !== attempt) return;
    this.attempt = null;
    clearTimeout(attempt.timer);
    this.options.failed(attempt.call, reason instanceof Error ? reason : new Error(String(reason)));
  }
}
