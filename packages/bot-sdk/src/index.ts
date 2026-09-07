import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  MessageType,
  PROTOCOL_VERSION,
  CommandOption,
  CommandResponsePayload,
} from '@monky/shared';

export interface BotOptions {
  /** WebSocket URL of the Monky server, e.g. ws://localhost:3000 */
  serverUrl: string;
  /** The bot token obtained from the server's Bot Management UI. */
  token: string;
  /** Ed25519 public key in hex (DER/SPKI). Needed for TOFU binding. */
  publicKey: string;
  /** Reconnect automatically on disconnect (default: true). */
  autoReconnect?: boolean;
}

export interface CommandDefinition {
  name: string;
  description: string;
  options?: CommandOption[];
  handler: (ctx: CommandContext) => void | Promise<void>;
}

export interface CommandContext {
  /** The channel where the command was invoked. */
  channelId: string;
  /** The user who invoked the command. */
  invokerId: string;
  invokerNickname: string;
  /** Parsed argument values keyed by option name. */
  args: Record<string, string>;
  /** Reply to the invoker (public message in the channel). */
  reply: (content: string) => void;
  /** Reply only to the invoker (ephemeral, not visible to others). */
  replyEphemeral: (content: string) => void;
}

/**
 * Thin WebSocket client for building Monky bots.
 *
 * ```ts
 * import { MonkyBot } from '@monky/bot-sdk';
 *
 * const bot = new MonkyBot({
 *   serverUrl: 'ws://localhost:3000',
 *   token: 'YOUR_BOT_TOKEN',
 *   publicKey: 'YOUR_ED25519_PUBLIC_KEY_HEX',
 * });
 *
 * bot.command({
 *   name: 'ping',
 *   description: 'Responde com pong!',
 *   handler: (ctx) => ctx.reply('🏓 Pong!'),
 * });
 *
 * bot.connect();
 * ```
 */
export class MonkyBot extends EventEmitter {
  private ws: WebSocket | null = null;
  private options: Required<BotOptions>;
  private commands = new Map<string, CommandDefinition>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;

  constructor(options: BotOptions) {
    super();
    this.options = {
      autoReconnect: true,
      ...options,
    };
  }

  /** Register a slash command. */
  command(def: CommandDefinition): this {
    this.commands.set(def.name.toLowerCase(), def);
    return this;
  }

  /** Connect to the Monky server. */
  connect(): void {
    if (this.ws) return;
    this.ws = new WebSocket(this.options.serverUrl);

    this.ws.on('open', () => {
      this.sendRaw({
        type: MessageType.AUTH_CONNECT,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          publicKey: this.options.publicKey,
          nickname: 'bot',
          password: '',
          botToken: this.options.token,
        },
      });
    });

    this.ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        this.handleMessage(msg);
      } catch { /* ignore */ }
    });

    this.ws.on('close', () => {
      this.connected = false;
      this.emit('disconnected');
      if (this.options.autoReconnect) {
        this.reconnectTimer = setTimeout(() => this.reconnect(), 5000);
      }
    });

    this.ws.on('error', (err) => {
      this.emit('error', err);
    });
  }

  disconnect(): void {
    this.options.autoReconnect = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  private reconnect(): void {
    this.ws = null;
    this.connect();
  }

  private handleMessage(msg: { type: string; payload?: any }): void {
    if (msg.type === MessageType.AUTH_SUCCESS) {
      this.connected = true;
      this.emit('connected');
      this.registerCommands();
      return;
    }

    if (msg.type === MessageType.AUTH_FAILED) {
      this.emit('auth_failed', msg.payload);
      return;
    }

    if (msg.type === MessageType.PING) {
      this.sendRaw({ type: MessageType.PONG, payload: { timestamp: Date.now() } });
      return;
    }

    if (msg.type === MessageType.COMMAND_INVOKE) {
      this.handleCommandInvoke(msg.payload);
      return;
    }

    this.emit('message', msg);
  }

  private registerCommands(): void {
    const cmds = Array.from(this.commands.values()).map((def) => ({
      name: def.name,
      description: def.description,
      options: def.options || [],
    }));

    this.sendRaw({
      type: MessageType.COMMAND_REGISTER,
      payload: { commands: cmds },
    });
  }

  private handleCommandInvoke(payload: any): void {
    const name = (payload.commandName || '').toLowerCase();
    const def = this.commands.get(name);
    if (!def) return;

    const argsMap: Record<string, string> = {};
    for (const arg of payload.args || []) {
      argsMap[arg.name] = arg.value;
    }

    const ctx: CommandContext = {
      channelId: payload.channelId,
      invokerId: payload.invokerId,
      invokerNickname: payload.invokerNickname || '',
      args: argsMap,
      reply: (content: string) => {
        const response: CommandResponsePayload = {
          channelId: payload.channelId,
          userId: payload.invokerId,
          content,
        };
        this.sendRaw({ type: MessageType.COMMAND_RESPONSE, payload: response });
      },
      replyEphemeral: (content: string) => {
        const response: CommandResponsePayload = {
          channelId: payload.channelId,
          userId: payload.invokerId,
          content,
          ephemeral: true,
        };
        this.sendRaw({ type: MessageType.COMMAND_RESPONSE, payload: response });
      },
    };

    try {
      const result = def.handler(ctx);
      if (result && typeof (result as any).catch === 'function') {
        (result as Promise<void>).catch((err) => this.emit('error', err));
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  private sendRaw(msg: object): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}

export { MessageType, PROTOCOL_VERSION } from '@monky/shared';
export type { SlashCommand, CommandOption, CommandResponsePayload } from '@monky/shared';
