import { randomUUID } from 'crypto';
import {
  LIMITS, MessageType, botFormSchema, botVoiceContextResultSchema, commandExecutionSchema, commandFinishedSchema,
  commandResponseSchema, commandSoundDownloadResultSchema, commandSubmitSchema, deferred, normalizeBotMessageContent,
  resolveBotLocale, soundDownloadRequestSchema, validateBotFormValues, validateCommandOptions,
  type BotForm, type BotFormValues, type BotMessageContent, type BotScreen, type BotScreenCreate, type BotSelector,
  type BotSelectorCreate, type BotSettingsContext, type CommandExecutionPayload, type CommandResponsePayload,
  type Deferred, type LiveAction, type LiveActionCreate, type SoundDownloadResult,
  type ClientMessage,
} from '@monky/shared';
import { localExecutionCaller, type LocalExecutionCaller } from '../localExecution/LocalExecutionClient';
import { isLive, serverMessage, type IncomingMessage, type ServerConnection } from './connection';
import type { CommandContext, CommandDefinition } from './types';

interface PendingPrompt {
  interactionId: string;
  form: BotForm;
  resolve: (values: BotFormValues | null) => void;
  reject: (error: Error) => void;
}

interface PendingSoundDownload {
  requestId: string;
  resolve: (result: SoundDownloadResult | null) => void;
  reject: (error: Error) => void;
}

interface PendingVoiceContext {
  requestId: string;
  reply: Deferred<string | null>;
  timer: ReturnType<typeof setTimeout>;
}

/** One running command and its private conversation with the person who invoked it. */
export interface Invocation {
  controller: AbortController;
  caller: LocalExecutionCaller;
  prompt: PendingPrompt | null;
  download: PendingSoundDownload | null;
  downloadUsed: boolean;
  voiceContext: PendingVoiceContext | null;
}

export interface CommandRuntimeHost {
  command(name: string): CommandDefinition | undefined;
  /** The checked settings context of one interaction; throws when it cannot be trusted. */
  settings(conn: ServerConnection, input: BotSettingsContext | undefined): BotSettingsContext;
  send(conn: ServerConnection, message: ClientMessage): void;
  report(error: unknown, conn: ServerConnection): void;
  createSelector(serverId: string, input: BotSelectorCreate): Promise<BotSelector>;
  createLiveAction(serverId: string, input: LiveActionCreate): Promise<LiveAction>;
  createScreen(serverId: string, input: BotScreenCreate): Promise<BotScreen>;
}

/**
 * Slash-command invocations. A bot may serve many servers and many callers
 * concurrently: each invocation owns its form promise and abort signal, and
 * handlers never share conversation state.
 */
export class CommandRuntime {
  constructor(private readonly host: CommandRuntimeHost) {}

  handle(conn: ServerConnection, msg: IncomingMessage): boolean {
    switch (msg.type) {
      case MessageType.COMMAND_INVOKE: {
        const parsed = commandExecutionSchema.safeParse(msg.payload);
        if (!parsed.success) {
          this.host.report(new Error('The server sent an invalid command invocation.'), conn);
          return true;
        }
        void this.run(conn, parsed.data).catch((error) => this.host.report(error, conn));
        return true;
      }
      case MessageType.COMMAND_SOUND_DOWNLOAD_RESULT: {
        const parsed = commandSoundDownloadResultSchema.safeParse(msg.payload);
        if (!parsed.success) {
          const error = new Error('The server sent an invalid sound download result.');
          if (!this.rejectSoundDownload(conn, msg.requestId, error)) this.host.report(error, conn);
          return true;
        }
        const invocation = conn.invocations.get(parsed.data.invocationId);
        const pending = invocation?.download;
        if (!invocation || !pending || pending.requestId !== msg.requestId) return true;
        invocation.download = null;
        pending.resolve(parsed.data.result);
        return true;
      }
      case MessageType.COMMAND_SUBMITTED: {
        const parsed = commandSubmitSchema.safeParse(msg.payload);
        if (!parsed.success) {
          this.host.report(new Error('The server sent an invalid form submission.'), conn);
          return true;
        }
        const invocation = conn.invocations.get(parsed.data.invocationId);
        const pending = invocation?.prompt;
        if (!invocation || !pending || pending.interactionId !== parsed.data.interactionId) return true;
        const validated = validateBotFormValues(pending.form, parsed.data.values);
        invocation.prompt = null;
        if (validated.success) pending.resolve(validated.values);
        else pending.reject(new Error(`Invalid form field: ${validated.field} (${validated.reason}).`));
        return true;
      }
      case MessageType.COMMAND_FINISHED: {
        const parsed = commandFinishedSchema.safeParse(msg.payload);
        if (!parsed.success) {
          this.host.report(new Error('The server sent an invalid command completion.'), conn);
          return true;
        }
        const invocation = conn.invocations.get(parsed.data.invocationId);
        if (invocation) {
          conn.invocations.delete(parsed.data.invocationId);
          this.end(invocation);
        }
        return true;
      }
      default:
        return false;
    }
  }

  /** Replies to `getVoiceChannel()`, a result or a SERVER_ERROR carrying its request ID. */
  handleVoiceContext(conn: ServerConnection, msg: IncomingMessage): boolean {
    if (!msg.requestId || (msg.type !== MessageType.BOT_VOICE_CONTEXT_RESULT && msg.type !== MessageType.SERVER_ERROR)) return false;
    for (const [invocationId, invocation] of conn.invocations) {
      const pending = invocation.voiceContext;
      if (pending?.requestId !== msg.requestId) continue;
      clearTimeout(pending.timer);
      invocation.voiceContext = null;
      if (msg.type === MessageType.SERVER_ERROR) {
        pending.reply.reject(new Error(serverMessage(msg.payload, 'The server rejected the voice context request.')));
      } else {
        const parsed = botVoiceContextResultSchema.safeParse(msg.payload);
        if (!parsed.success || parsed.data.invocationId !== invocationId) {
          pending.reply.reject(new Error('Invalid voice context response.'));
        } else pending.reply.resolve(parsed.data.voiceChannelId);
      }
      return true;
    }
    return false;
  }

  rejectSoundDownload(conn: ServerConnection, requestId: string | undefined, error: Error): boolean {
    if (!requestId) return false;
    for (const invocation of conn.invocations.values()) {
      if (invocation.download?.requestId !== requestId) continue;
      const pending = invocation.download;
      invocation.download = null;
      pending.reject(error);
      return true;
    }
    return false;
  }

  rejectPrompt(conn: ServerConnection, requestId: string | undefined, error: Error): boolean {
    for (const invocation of conn.invocations.values()) {
      const pending = invocation.prompt;
      if (pending && pending.interactionId === requestId) {
        pending.reject(error);
        invocation.prompt = null;
        return true;
      }
    }
    return false;
  }

  /** The socket is gone: end every invocation it started. */
  clear(conn: ServerConnection): void {
    for (const invocation of conn.invocations.values()) {
      this.end(invocation);
    }
    conn.invocations.clear();
  }

  /** Aborts the handler's signal and settles its pending conversation: forms and downloads resolve null. */
  private end(invocation: Invocation): void {
    invocation.controller.abort();
    invocation.prompt?.resolve(null);
    invocation.prompt = null;
    invocation.download?.resolve(null);
    invocation.download = null;
    if (invocation.voiceContext) {
      clearTimeout(invocation.voiceContext.timer);
      invocation.voiceContext.reply.reject(new Error('The bot interaction ended before voice context was refreshed.'));
      invocation.voiceContext = null;
    }
  }

  private requestVoiceContext(conn: ServerConnection, invocationId: string, invocation: Invocation): Promise<string | null> {
    if (invocation.controller.signal.aborted || conn.invocations.get(invocationId) !== invocation) {
      return Promise.reject(new Error('This bot interaction has already ended.'));
    }
    if (invocation.voiceContext) return invocation.voiceContext.reply.promise;
    const requestId = randomUUID();
    const reply = deferred<string | null>();
    const timer = setTimeout(() => {
      if (invocation.voiceContext?.requestId !== requestId) return;
      invocation.voiceContext = null;
      reply.reject(new Error('Voice context request timed out after 8 seconds.'));
    }, 8000);
    invocation.voiceContext = { requestId, reply, timer };
    try {
      if (!isLive(conn)) throw new Error('Voice context signaling disconnected.');
      this.host.send(conn, { type: MessageType.BOT_VOICE_CONTEXT, requestId, payload: { invocationId } });
    } catch (error) {
      clearTimeout(timer);
      invocation.voiceContext = null;
      reply.reject(error instanceof Error ? error : new Error(String(error)));
    }
    return reply.promise;
  }

  private async run(conn: ServerConnection, payload: CommandExecutionPayload): Promise<void> {
    const def = this.host.command(payload.commandName);
    if (conn.invocations.has(payload.invocationId)) return;
    let settings: BotSettingsContext;
    try {
      if (conn.botId !== null && payload.botId !== conn.botId) {
        throw new Error('The command invocation belongs to another bot.');
      }
      settings = this.host.settings(conn, payload.settings);
    } catch (error) {
      this.host.send(conn, {
        type: MessageType.COMMAND_FINISH, payload: { invocationId: payload.invocationId, failed: true },
      });
      this.host.report(error, conn);
      return;
    }
    if (!def || conn.commandWork >= LIMITS.MAX_BOT_INVOCATIONS) {
      this.host.send(conn, {
        type: MessageType.COMMAND_FINISH,
        payload: { invocationId: payload.invocationId, failed: true },
      });
      this.host.report(new Error(!def ? 'Unknown bot command.' : 'Too many active bot commands.'), conn);
      return;
    }
    const validated = validateCommandOptions(def.options ?? [], payload.options);
    if (!validated.success) {
      this.host.send(conn, {
        type: MessageType.COMMAND_FINISH,
        payload: { invocationId: payload.invocationId, failed: true },
      });
      this.host.report(new Error(`Invalid command option: ${validated.field} (${validated.reason}).`), conn);
      return;
    }
    const invocation: Invocation = {
      controller: new AbortController(), prompt: null, download: null, downloadUsed: false, voiceContext: null,
      caller: localExecutionCaller(payload),
    };
    conn.invocations.set(payload.invocationId, invocation);
    const requireActive = () => {
      if (invocation.controller.signal.aborted || conn.invocations.get(payload.invocationId) !== invocation) {
        throw new Error('This bot interaction has already ended.');
      }
    };
    const reply = (content: BotMessageContent, ephemeral: boolean) => {
      requireActive();
      const message = normalizeBotMessageContent(content);
      if (!ephemeral && message.components) {
        throw new Error('Carousel components are supported in private replies and Live Actions, not persistent publications.');
      }
      const response: CommandResponsePayload = commandResponseSchema.parse({
        invocationId: payload.invocationId, ...message, ephemeral,
      });
      this.host.send(conn, { type: MessageType.COMMAND_RESPONSE, payload: response });
    };
    const ctx: CommandContext = {
      invocationId: payload.invocationId,
      botId: payload.botId,
      commandName: payload.commandName,
      channelId: payload.channelId,
      invokerId: payload.invokerId,
      invokerNickname: payload.invokerNickname,
      invokerSessionId: payload.invokerSessionId,
      invokerVoiceChannelId: payload.invokerVoiceChannelId,
      getVoiceChannel: () => this.requestVoiceContext(conn, payload.invocationId, invocation),
      serverId: conn.serverId,
      locale: resolveBotLocale(payload.locale),
      settings,
      args: validated.values,
      signal: invocation.controller.signal,
      reply: (content) => reply(content, true),
      replyEphemeral: (content) => reply(content, true),
      publish: (content) => reply(content, false),
      downloadSound: (request) => {
        requireActive();
        if (!def.downloadsSound || payload.allowSoundDownload !== true) {
          throw new Error('This command is not authorized to download a local sound.');
        }
        if (invocation.downloadUsed) throw new Error('Only one sound download may be requested per invocation.');
        const input = soundDownloadRequestSchema.parse(request);
        const requestId = randomUUID();
        invocation.downloadUsed = true;
        return new Promise((resolve, reject) => {
          invocation.download = { requestId, resolve, reject };
          try {
            this.host.send(conn, {
              type: MessageType.COMMAND_SOUND_DOWNLOAD,
              requestId,
              payload: { invocationId: payload.invocationId, ...input },
            });
          } catch (error) {
            invocation.download = null;
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
      createSelector: (input) => {
        requireActive();
        return this.host.createSelector(conn.serverId, {
          ...input, channelId: payload.channelId, invokerId: payload.invokerId, invocationId: payload.invocationId,
        });
      },
      createLiveAction: (input) => {
        requireActive();
        return this.host.createLiveAction(conn.serverId, {
          ...input, channelId: payload.channelId, invocationId: payload.invocationId,
        });
      },
      createScreen: async (input) => {
        requireActive();
        const channelId = await ctx.getVoiceChannel();
        requireActive();
        if (!channelId) throw new Error('The caller must join a voice channel before creating a miniapp.');
        return this.host.createScreen(conn.serverId, {
          ...input, channelId, invocationId: payload.invocationId,
        });
      },
      choose: async (choice) => {
        const values = await ctx.prompt({
          title: choice.title,
          description: choice.description,
          submitLabel: choice.submitLabel,
          fields: [{
            name: 'choice', label: choice.title, type: 'select', required: true,
            choices: choice.choices, presentation: choice.presentation ?? 'dropdown',
          }],
        });
        if (values === null) return null;
        if (typeof values.choice !== 'string') throw new Error('Invalid choice response.');
        return values.choice;
      },
      prompt: (form) => {
        requireActive();
        if (invocation.prompt) throw new Error('Await the current prompt before opening another one.');
        const parsedForm = botFormSchema.parse(form);
        const interactionId = randomUUID();
        return new Promise((resolve, reject) => {
          invocation.prompt = { interactionId, form: parsedForm, resolve, reject };
          try {
            this.host.send(conn, {
              type: MessageType.COMMAND_PROMPT,
              requestId: interactionId,
              payload: { invocationId: payload.invocationId, interactionId, form: parsedForm },
            });
          } catch (error) {
            invocation.prompt = null;
            reject(error);
          }
        });
      },
    };
    Object.defineProperty(ctx, 'settings', { writable: false, configurable: false });
    let failed = false;
    conn.commandWork++;
    try {
      await def.handler(ctx);
    } catch (error) {
      failed = true;
      if (!invocation.controller.signal.aborted) this.host.report(error, conn);
    } finally {
      conn.commandWork--;
      if (conn.invocations.get(payload.invocationId) === invocation) {
        conn.invocations.delete(payload.invocationId);
        this.end(invocation);
        if (isLive(conn)) {
          this.host.send(conn, {
            type: MessageType.COMMAND_FINISH,
            payload: { invocationId: payload.invocationId, failed },
          });
        }
      }
    }
  }
}
