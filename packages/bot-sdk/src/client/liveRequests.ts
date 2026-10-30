import {
  LIMITS, MessageType, commandAudioPreviewCancelSchema, commandAudioPreviewExecutionSchema, commandAudioPreviewMimeSchema,
  commandAutocompleteCancelSchema, commandAutocompleteExecutionSchema, commandAutocompletePageSchema,
  commandRequestIdSchema, localWireTaskResultSchema, resolveBotLocale, validateCommandOptions,
  type BotSettingsContext, type CommandAudioPreviewExecutionPayload, type CommandAudioPreviewResult,
  type CommandAutocompleteExecutionPayload, type CommandAutocompleteResultPayload,
  type ClientMessage,
} from '@monky/shared';
import { localExecutionCaller, type LocalExecutionCaller } from '../localExecution/LocalExecutionClient';
import { isLive, isRecord, type IncomingMessage, type ServerConnection } from './connection';
import type { CommandAudioPreviewContext, CommandAutocompleteContext, CommandDefinition } from './types';

/** An autocomplete search or audio preview that the server is waiting on. */
export interface LiveRequest {
  controller: AbortController;
  caller: LocalExecutionCaller;
  timer: ReturnType<typeof setTimeout>;
}

export interface LiveRequestHost {
  command(name: string): CommandDefinition | undefined;
  /** The checked settings context of one interaction; throws when it cannot be trusted. */
  settings(conn: ServerConnection, input: BotSettingsContext | undefined): BotSettingsContext;
  send(conn: ServerConnection, message: ClientMessage): void;
  report(error: unknown, conn: ServerConnection): void;
}

interface LiveRun {
  conn: ServerConnection;
  requestId: string;
  requests: Map<string, LiveRequest>;
  caller: LocalExecutionCaller;
  timeoutMs: number;
  /** Calls the bot's handler. */
  start(signal: AbortSignal): unknown;
  /** Answers with what the handler returned, while the request is still current. */
  answer(response: unknown): void;
  fail(reason: 'handler_failed' | 'timeout'): void;
  /** Frees the handler's slot; runs once the handler settles. */
  release(): void;
}

function cancel(requests: Map<string, LiveRequest>, requestId: string): void {
  const pending = requests.get(requestId);
  if (!pending) return;
  requests.delete(requestId);
  clearTimeout(pending.timer);
  pending.controller.abort();
}

/**
 * Autocomplete searches and audio previews: the server asks, the bot's handler
 * answers once, and the server may cancel at any time. It cancels the previous
 * search on every keystroke, so how cancelled handlers are counted matters.
 */
export class LiveRequests {
  /** Audio preview handlers that have not settled, on every server. */
  private audioPreviewWork = 0;

  constructor(private readonly host: LiveRequestHost) {}

  handle(conn: ServerConnection, msg: IncomingMessage): boolean {
    switch (msg.type) {
      case MessageType.COMMAND_AUTOCOMPLETE: {
        const correlation = commandRequestIdSchema.safeParse(msg.requestId);
        const parsed = commandAutocompleteExecutionSchema.safeParse(msg.payload);
        if (!correlation.success || !parsed.success) {
          this.host.report(new Error('The server sent an invalid autocomplete request.'), conn);
          if (correlation.success && conn.connected) {
            this.host.send(conn, {
              type: MessageType.COMMAND_AUTOCOMPLETE_RESULT, requestId: correlation.data,
              payload: { status: 'failed', reason: 'invalid_response' },
            });
          }
          return true;
        }
        void this.autocomplete(conn, correlation.data, parsed.data).catch((error) => this.host.report(error, conn));
        return true;
      }
      case MessageType.COMMAND_AUTOCOMPLETE_CANCEL: {
        const parsed = commandAutocompleteCancelSchema.safeParse(msg.payload);
        if (parsed.success) cancel(conn.autocompletes, parsed.data.requestId);
        else this.host.report(new Error('The server sent an invalid autocomplete cancellation.'), conn);
        return true;
      }
      case MessageType.COMMAND_AUDIO_PREVIEW: {
        const correlation = commandRequestIdSchema.safeParse(msg.requestId);
        const parsed = commandAudioPreviewExecutionSchema.safeParse(msg.payload);
        if (!correlation.success || !parsed.success) {
          this.host.report(new Error('The server sent an invalid audio preview request.'), conn);
          if (correlation.success && conn.connected) {
            this.host.send(conn, {
              type: MessageType.COMMAND_AUDIO_PREVIEW_RESULT, requestId: correlation.data,
              payload: { status: 'failed', reason: 'invalid_response' },
            });
          }
          return true;
        }
        void this.audioPreview(conn, correlation.data, parsed.data).catch((error) => this.host.report(error, conn));
        return true;
      }
      case MessageType.COMMAND_AUDIO_PREVIEW_CANCEL: {
        const parsed = commandAudioPreviewCancelSchema.safeParse(msg.payload);
        if (parsed.success) cancel(conn.audioPreviews, parsed.data.requestId);
        else this.host.report(new Error('The server sent an invalid audio preview cancellation.'), conn);
        return true;
      }
      default:
        return false;
    }
  }

  /** The connection's socket is gone: abort every request it was waiting on. */
  clear(conn: ServerConnection): void {
    for (const requestId of conn.autocompletes.keys()) cancel(conn.autocompletes, requestId);
    for (const requestId of conn.audioPreviews.keys()) cancel(conn.audioPreviews, requestId);
  }

  private async autocomplete(
    conn: ServerConnection, requestId: string, payload: CommandAutocompleteExecutionPayload
  ): Promise<void> {
    if (!conn.connected || conn.disposed || conn.autocompletes.has(requestId)) return;
    const def = this.host.command(payload.commandName);
    const option = def?.options?.find((item) => item.name === payload.optionName);
    const values = validateCommandOptions(def?.options ?? [], payload.options, { partial: true });
    const sendResult = (result: CommandAutocompleteResultPayload) => {
      this.host.send(conn, { type: MessageType.COMMAND_AUTOCOMPLETE_RESULT, requestId, payload: result });
    };
    let settings: BotSettingsContext;
    try {
      settings = this.host.settings(conn, payload.settings);
    } catch (error) {
      this.host.report(error, conn);
      sendResult({ status: 'failed', reason: 'invalid_response' });
      return;
    }
    const provider = def?.autocomplete;
    if (!def || !provider || !option?.autocomplete || option.type !== 'string' || !values.success ||
        Object.prototype.hasOwnProperty.call(payload.options, payload.optionName)) {
      sendResult({ status: 'failed', reason: 'invalid_response' });
      return;
    }
    if (conn.autocompleteWork >= LIMITS.MAX_BOT_AUTOCOMPLETE_REQUESTS) {
      sendResult({ status: 'failed', reason: 'handler_failed' });
      return;
    }
    conn.autocompleteWork++;
    await this.run({
      conn, requestId, requests: conn.autocompletes, caller: localExecutionCaller(payload),
      timeoutMs: LIMITS.BOT_AUTOCOMPLETE_TIMEOUT_MS,
      start: (signal) => {
        const ctx: CommandAutocompleteContext = {
          requestId, commandName: payload.commandName, botId: payload.botId, channelId: payload.channelId,
          invokerId: payload.invokerId, invokerSessionId: payload.invokerSessionId,
          invokerNickname: payload.invokerNickname, invokerVoiceChannelId: payload.invokerVoiceChannelId,
          query: payload.query, optionName: payload.optionName, args: values.values,
          page: payload.page ?? 0, ...(payload.cursor !== undefined ? { cursor: payload.cursor } : {}),
          locale: resolveBotLocale(payload.locale), serverId: conn.serverId, signal, settings,
        };
        Object.defineProperty(ctx, 'settings', { writable: false, configurable: false });
        return provider.call(def, ctx);
      },
      answer: (response) => {
        const parsed = commandAutocompletePageSchema.safeParse(Array.isArray(response) ? { choices: response } : response);
        const supported = parsed.success && (def.audioPreview ||
          !parsed.data.choices.some((choice) => choice.audio && 'resourceId' in choice.audio));
        sendResult(parsed.success && supported
          ? { status: 'ok', ...parsed.data }
          : { status: 'failed', reason: 'invalid_response' });
      },
      fail: (reason) => sendResult({ status: 'failed', reason }),
      release: () => { conn.autocompleteWork--; },
    });
  }

  private async audioPreview(
    conn: ServerConnection, requestId: string, payload: CommandAudioPreviewExecutionPayload
  ): Promise<void> {
    if (!conn.connected || conn.disposed || conn.audioPreviews.has(requestId)) return;
    const sendResult = (result: CommandAudioPreviewResult) => {
      this.host.send(conn, { type: MessageType.COMMAND_AUDIO_PREVIEW_RESULT, requestId, payload: result });
    };
    const def = this.host.command(payload.commandName);
    const option = def?.options?.find((item) => item.name === payload.optionName);
    const provider = def?.audioPreview;
    if (!def || !provider || !option?.autocomplete || option.type !== 'string') {
      sendResult({ status: 'failed', reason: 'invalid_response' });
      return;
    }
    if (this.audioPreviewWork >= LIMITS.MAX_BOT_AUDIO_PREVIEW_HANDLERS) {
      sendResult({ status: 'failed', reason: 'busy' });
      return;
    }
    let settings: BotSettingsContext;
    try {
      settings = this.host.settings(conn, payload.settings);
    } catch (error) {
      this.host.report(error, conn);
      sendResult({ status: 'failed', reason: 'invalid_response' });
      return;
    }
    this.audioPreviewWork++;
    await this.run({
      conn, requestId, requests: conn.audioPreviews, caller: localExecutionCaller(payload),
      timeoutMs: LIMITS.BOT_AUDIO_PREVIEW_TIMEOUT_MS,
      start: (signal) => {
        const ctx: CommandAudioPreviewContext = {
          requestId, commandName: payload.commandName, botId: payload.botId, channelId: payload.channelId,
          invokerId: payload.invokerId, invokerSessionId: payload.invokerSessionId,
          invokerNickname: payload.invokerNickname, invokerVoiceChannelId: payload.invokerVoiceChannelId,
          resourceId: payload.resourceId, optionName: payload.optionName, serverId: conn.serverId,
          locale: resolveBotLocale(payload.locale), settings, signal,
        };
        Object.defineProperty(ctx, 'settings', { writable: false, configurable: false });
        return provider.call(def, ctx);
      },
      answer: (data) => {
        const local = localWireTaskResultSchema.safeParse(data);
        if (local.success && local.data.operation === 'youtube.preview') {
          const { operation: _operation, ...reference } = local.data;
          sendResult({ status: 'local', ...reference });
        } else if (!isRecord(data) || !(data.bytes instanceof Uint8Array) || data.bytes.byteLength === 0 ||
            Object.keys(data).some((key) => key !== 'bytes' && key !== 'mimeType')) {
          sendResult({ status: 'failed', reason: 'invalid_response' });
        } else if (data.bytes.byteLength > LIMITS.MAX_BOT_AUDIO_PREVIEW_BYTES) {
          sendResult({ status: 'failed', reason: 'too_large' });
        } else {
          const mime = commandAudioPreviewMimeSchema.safeParse(data.mimeType);
          sendResult(mime.success ? {
            status: 'ok', audioBase64: Buffer.from(data.bytes).toString('base64'), mimeType: mime.data,
          } : { status: 'failed', reason: 'unsupported_audio' });
        }
      },
      fail: (reason) => sendResult({ status: 'failed', reason }),
      release: () => { this.audioPreviewWork--; },
    });
  }

  /**
   * One handler run. A cancellation or timeout aborts the signal and stops any
   * answer, but a handler that ignores its signal keeps running, so `release`
   * waits for it to settle: the limits count those handlers too, and typing
   * cannot pile up background work.
   */
  private async run(request: LiveRun): Promise<void> {
    const { conn, requestId, requests } = request;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      if (requests.get(requestId) !== pending) return;
      cancel(requests, requestId);
      if (isLive(conn)) {
        try {
          request.fail('timeout');
        } catch (error) {
          this.host.report(error, conn);
        }
      }
    }, request.timeoutMs);
    timer.unref();
    const pending: LiveRequest = { controller, timer, caller: request.caller };
    requests.set(requestId, pending);
    const isCurrent = () => requests.get(requestId) === pending && isLive(conn);
    try {
      const response = await request.start(controller.signal);
      if (!isCurrent()) return;
      request.answer(response);
    } catch (error) {
      if (!isCurrent()) return;
      this.host.report(error, conn);
      request.fail('handler_failed');
    } finally {
      request.release();
      if (requests.get(requestId) === pending) cancel(requests, requestId);
    }
  }
}
