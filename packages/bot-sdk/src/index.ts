import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import http from 'http';
import WebSocket from 'ws';
import {
  LIMITS,
  MessageType,
  PROTOCOL_VERSION,
  botFormSchema,
  botManifestSchema,
  botProfileUpdateSchema,
  botRegistrationSchema,
  commandDefinitionSchema,
  commandExecutionSchema,
  commandFinishedSchema,
  commandResponseSchema,
  commandSubmitSchema,
  validateBotFormValues,
  validateCommandOptions,
} from '@monky/shared';
import type {
  BotForm,
  BotFormValues,
  BotManifest,
  BotProfileUpdatePayload,
  CommandExecutionPayload,
  CommandOption,
  CommandResponsePayload,
  CommandValues,
} from '@monky/shared';

export interface BotOptions {
  serverUrl?: string;
  token?: string;
  /** Ed25519 public key in hex (DER/SPKI), used for TOFU binding. */
  publicKey: string;
  autoReconnect?: boolean;
  /** Optional profile to synchronize, including already-added bot accounts. */
  name?: string;
  /** Image bytes encoded as base64 or a data URI, not a remote URL. */
  avatarBase64?: string;
}

export interface CommandDefinition {
  name: string;
  description: string;
  options?: CommandOption[];
  handler: (ctx: CommandContext) => void | Promise<void>;
}

export interface CommandContext {
  invocationId: string;
  commandName: string;
  channelId: string;
  invokerId: string;
  invokerNickname: string;
  serverId: string;
  locale: 'pt-BR' | 'en';
  /** Named, typed values: integer and boolean options are not strings. */
  args: CommandValues;
  /** Aborted on cancellation, timeout, disconnection or completion. */
  signal: AbortSignal;
  /** Private response in the caller's chat. */
  reply: (content: string) => void;
  replyEphemeral: (content: string) => void;
  /** Explicitly publish a result to everyone allowed into the channel. */
  publish: (content: string) => void;
  /** Wait for a private form. Returns null if the interaction ends/cancels. */
  prompt: (form: BotForm) => Promise<BotFormValues | null>;
}

interface PendingPrompt {
  interactionId: string;
  form: BotForm;
  resolve: (values: BotFormValues | null) => void;
  reject: (error: Error) => void;
}

interface Invocation {
  controller: AbortController;
  prompt: PendingPrompt | null;
}

interface ServerConnection {
  serverId: string;
  serverUrl: string;
  token: string;
  ws: WebSocket | null;
  connected: boolean;
  disposed: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  profileRequestId: string | null;
  invocations: Map<string, Invocation>;
}

interface IncomingMessage {
  type: string;
  requestId?: string;
  payload?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMessage(value: unknown): IncomingMessage {
  if (!isRecord(value) || typeof value.type !== 'string' ||
      (value.requestId !== undefined && typeof value.requestId !== 'string')) {
    throw new Error('Invalid Monky protocol message.');
  }
  return { type: value.type, requestId: value.requestId, payload: value.payload };
}

/**
 * A bot may serve many servers and many callers concurrently. Each invocation
 * owns its form promise and abort signal; handlers never share conversation state.
 */
export class BotClient extends EventEmitter {
  private options: BotOptions;
  private profile: BotProfileUpdatePayload = {};
  private commands = new Map<string, CommandDefinition>();
  private connections = new Map<string, ServerConnection>();
  private httpServers = new Set<http.Server>();
  private closing = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: BotOptions) {
    super();
    this.options = { autoReconnect: true, ...options };
    if (options.name !== undefined || options.avatarBase64 !== undefined) {
      this.profile = botProfileUpdateSchema.parse({
        name: options.name,
        avatarBase64: options.avatarBase64,
      });
    }
  }

  command(def: CommandDefinition): this {
    const definition = commandDefinitionSchema.parse({
      name: def.name.toLowerCase(),
      description: def.description,
      options: def.options,
    });
    if (typeof def.handler !== 'function') throw new TypeError('A command handler is required.');
    if (!this.commands.has(definition.name) && this.commands.size >= LIMITS.MAX_COMMANDS_PER_BOT) {
      throw new Error(`A bot may register at most ${LIMITS.MAX_COMMANDS_PER_BOT} commands.`);
    }
    this.commands.set(definition.name, { ...definition, handler: def.handler });
    return this;
  }

  connect(overrides?: { serverUrl?: string; token?: string; serverId?: string }): void {
    if (this.closing) throw new Error('This bot client has been closed.');
    const serverUrl = overrides?.serverUrl || this.options.serverUrl;
    const token = overrides?.token || this.options.token;
    if (!serverUrl || !token) {
      throw new Error('BotClient.connect() requires serverUrl and token.');
    }
    const url = new URL(serverUrl);
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('serverUrl must use ws:// or wss://.');
    const existing = [...this.connections.values()].find((conn) =>
      conn.serverUrl === serverUrl && conn.token === token
    );
    this.connectToServer(overrides?.serverId || existing?.serverId || randomUUID(), serverUrl, token);
  }

  disconnect(serverId?: string): void {
    if (serverId !== undefined) {
      const conn = this.connections.get(serverId);
      this.connections.delete(serverId);
      if (conn) this.teardownConnection(conn);
      return;
    }
    const connections = [...this.connections.values()];
    this.connections.clear();
    for (const conn of connections) this.teardownConnection(conn);
  }

  /** Close both WebSocket connections and marketplace listeners. */
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = Promise.resolve().then(async () => {
      this.disconnect();
      await Promise.all([...this.httpServers].map((server) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => server.closeAllConnections(), LIMITS.SHUTDOWN_GRACE_MS);
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      })));
    }).finally(() => this.disconnect());
    return this.closePromise;
  }

  get serverCount(): number {
    return [...this.connections.values()].filter((conn) => conn.connected).length;
  }

  get serverIds(): string[] {
    return [...this.connections.values()].filter((conn) => conn.connected).map((conn) => conn.serverId);
  }

  private connectToServer(serverId: string, serverUrl: string, token: string): void {
    if (this.closing) throw new Error('This bot client has been closed.');
    const existing = this.connections.get(serverId);
    if (existing && existing.token === token && existing.serverUrl === serverUrl && !existing.disposed &&
        (existing.ws?.readyState === WebSocket.OPEN || existing.ws?.readyState === WebSocket.CONNECTING)) return;
    if (existing) this.teardownConnection(existing);

    const conn: ServerConnection = {
      serverId, serverUrl, token,
      ws: null,
      connected: false,
      disposed: false,
      reconnectTimer: null,
      profileRequestId: null,
      invocations: new Map(),
    };
    this.connections.set(serverId, conn);
    this.openSocket(conn);
  }

  private openSocket(conn: ServerConnection): void {
    if (conn.disposed || this.connections.get(conn.serverId) !== conn) return;
    const ws = new WebSocket(conn.serverUrl);
    conn.ws = ws;
    const isCurrent = () => conn.ws === ws && !conn.disposed;

    ws.on('open', () => {
      if (!isCurrent()) return;
      this.sendToConn(conn, {
        type: MessageType.AUTH_CONNECT,
        payload: {
          protocolVersion: PROTOCOL_VERSION,
          publicKey: this.options.publicKey,
          nickname: 'bot',
          password: '',
          botToken: conn.token,
        },
      });
    });
    ws.on('message', (data) => {
      if (!isCurrent() || ws.readyState !== WebSocket.OPEN) return;
      let message: IncomingMessage;
      try {
        message = readMessage(JSON.parse(data.toString()));
      } catch (error) {
        this.reportError(error, conn);
        return;
      }
      this.handleMessage(conn, message);
    });
    ws.on('close', () => {
      if (!isCurrent()) return;
      conn.ws = null;
      conn.connected = false;
      conn.profileRequestId = null;
      this.clearInvocations(conn);
      this.emit('disconnected', { serverId: conn.serverId });
      if (this.options.autoReconnect && !conn.disposed && this.connections.get(conn.serverId) === conn) {
        conn.reconnectTimer = setTimeout(() => {
          conn.reconnectTimer = null;
          this.openSocket(conn);
        }, 5000);
      }
    });
    ws.on('error', (error) => {
      if (isCurrent()) this.reportError(error, conn);
    });
  }

  private teardownConnection(conn: ServerConnection): void {
    conn.disposed = true;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    const ws = conn.ws;
    conn.ws = null;
    conn.connected = false;
    conn.profileRequestId = null;
    this.clearInvocations(conn);
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  }

  private clearInvocations(conn: ServerConnection): void {
    for (const invocation of conn.invocations.values()) {
      invocation.controller.abort();
      invocation.prompt?.resolve(null);
      invocation.prompt = null;
    }
    conn.invocations.clear();
  }

  private handleMessage(conn: ServerConnection, msg: IncomingMessage): void {
    switch (msg.type) {
      case MessageType.AUTH_SUCCESS:
        conn.connected = true;
        if (this.profile.name !== undefined || this.profile.avatarBase64 !== undefined) {
          conn.profileRequestId = randomUUID();
          this.sendToConn(conn, {
            type: MessageType.BOT_UPDATE_PROFILE,
            requestId: conn.profileRequestId,
            payload: this.profile,
          });
        } else {
          this.registerCommandsOn(conn);
        }
        this.emit('connected', { serverId: conn.serverId });
        return;
      case MessageType.BOT_PROFILE_UPDATED:
        if (conn.profileRequestId && msg.requestId === conn.profileRequestId) {
          conn.profileRequestId = null;
          this.registerCommandsOn(conn);
        }
        return;
      case MessageType.AUTH_FAILED:
        this.emit('auth_failed', msg.payload, { serverId: conn.serverId });
        this.disconnect(conn.serverId);
        return;
      case MessageType.SERVER_ERROR: {
        const error = new Error(isRecord(msg.payload) && typeof msg.payload.message === 'string'
          ? msg.payload.message : 'The Monky server rejected the bot request.');
        for (const invocation of conn.invocations.values()) {
          const pending = invocation.prompt;
          if (pending && pending.interactionId === msg.requestId) {
            pending.reject(error);
            invocation.prompt = null;
            return;
          }
        }
        if (!conn.connected || (conn.profileRequestId && msg.requestId === conn.profileRequestId)) {
          this.emit('auth_failed', msg.payload, { serverId: conn.serverId });
          this.disconnect(conn.serverId);
        }
        this.reportError(error, conn);
        return;
      }
      case MessageType.PING:
        this.sendToConn(conn, { type: MessageType.PONG, payload: { timestamp: Date.now() } });
        return;
      case MessageType.COMMAND_INVOKE: {
        const parsed = commandExecutionSchema.safeParse(msg.payload);
        if (!parsed.success) {
          this.reportError(new Error('The server sent an invalid command invocation.'), conn);
          return;
        }
        void this.runCommand(conn, parsed.data).catch((error) => this.reportError(error, conn));
        return;
      }
      case MessageType.COMMAND_SUBMITTED: {
        const parsed = commandSubmitSchema.safeParse(msg.payload);
        if (!parsed.success) {
          this.reportError(new Error('The server sent an invalid form submission.'), conn);
          return;
        }
        const invocation = conn.invocations.get(parsed.data.invocationId);
        const pending = invocation?.prompt;
        if (!invocation || !pending || pending.interactionId !== parsed.data.interactionId) return;
        const validated = validateBotFormValues(pending.form, parsed.data.values);
        invocation.prompt = null;
        if (validated.success) pending.resolve(validated.values);
        else pending.reject(new Error(`Invalid form field: ${validated.field} (${validated.reason}).`));
        return;
      }
      case MessageType.COMMAND_FINISHED: {
        const parsed = commandFinishedSchema.safeParse(msg.payload);
        if (!parsed.success) {
          this.reportError(new Error('The server sent an invalid command completion.'), conn);
          return;
        }
        const invocation = conn.invocations.get(parsed.data.invocationId);
        if (invocation) {
          conn.invocations.delete(parsed.data.invocationId);
          invocation.controller.abort();
          invocation.prompt?.resolve(null);
          invocation.prompt = null;
        }
        return;
      }
      default:
        this.emit('message', msg, { serverId: conn.serverId });
    }
  }

  private registerCommandsOn(conn: ServerConnection): void {
    this.sendToConn(conn, {
      type: MessageType.COMMAND_REGISTER,
      payload: {
        commands: [...this.commands.values()].map(({ name, description, options }) => ({
          name, description, options: options ?? [],
        })),
      },
    });
  }

  private async runCommand(conn: ServerConnection, payload: CommandExecutionPayload): Promise<void> {
    const def = this.commands.get(payload.commandName);
    if (conn.invocations.has(payload.invocationId)) return;
    if (!def || conn.invocations.size >= LIMITS.MAX_BOT_INVOCATIONS) {
      this.sendToConn(conn, {
        type: MessageType.COMMAND_FINISH,
        payload: { invocationId: payload.invocationId, failed: true },
      });
      this.reportError(new Error(!def ? 'Unknown bot command.' : 'Too many active bot commands.'), conn);
      return;
    }
    const validated = validateCommandOptions(def.options ?? [], payload.options);
    if (!validated.success) {
      this.sendToConn(conn, {
        type: MessageType.COMMAND_FINISH,
        payload: { invocationId: payload.invocationId, failed: true },
      });
      this.reportError(new Error(`Invalid command option: ${validated.field} (${validated.reason}).`), conn);
      return;
    }
    const invocation: Invocation = { controller: new AbortController(), prompt: null };
    conn.invocations.set(payload.invocationId, invocation);
    const requireActive = () => {
      if (invocation.controller.signal.aborted || conn.invocations.get(payload.invocationId) !== invocation) {
        throw new Error('This bot interaction has already ended.');
      }
    };
    const reply = (content: string, ephemeral: boolean) => {
      requireActive();
      const response: CommandResponsePayload = commandResponseSchema.parse({
        invocationId: payload.invocationId, content, ephemeral,
      });
      this.sendToConn(conn, { type: MessageType.COMMAND_RESPONSE, payload: response });
    };
    const ctx: CommandContext = {
      invocationId: payload.invocationId,
      commandName: payload.commandName,
      channelId: payload.channelId,
      invokerId: payload.invokerId,
      invokerNickname: payload.invokerNickname,
      serverId: conn.serverId,
      locale: payload.locale ?? 'pt-BR',
      args: validated.values,
      signal: invocation.controller.signal,
      reply: (content) => reply(content, true),
      replyEphemeral: (content) => reply(content, true),
      publish: (content) => reply(content, false),
      prompt: (form) => {
        requireActive();
        if (invocation.prompt) throw new Error('Await the current prompt before opening another one.');
        const parsedForm = botFormSchema.parse(form);
        const interactionId = randomUUID();
        return new Promise((resolve, reject) => {
          invocation.prompt = { interactionId, form: parsedForm, resolve, reject };
          try {
            this.sendToConn(conn, {
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
    let failed = false;
    try {
      await def.handler(ctx);
    } catch (error) {
      failed = true;
      if (!invocation.controller.signal.aborted) this.reportError(error, conn);
    } finally {
      if (conn.invocations.get(payload.invocationId) === invocation) {
        conn.invocations.delete(payload.invocationId);
        invocation.controller.abort();
        invocation.prompt?.resolve(null);
        invocation.prompt = null;
        if (conn.connected && conn.ws?.readyState === WebSocket.OPEN && !conn.disposed) {
          this.sendToConn(conn, {
            type: MessageType.COMMAND_FINISH,
            payload: { invocationId: payload.invocationId, failed },
          });
        }
      }
    }
  }

  private sendToConn(conn: ServerConnection, msg: object): void {
    if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN || conn.disposed) {
      throw new Error('The bot is not connected to this Monky server.');
    }
    conn.ws.send(JSON.stringify(msg));
  }

  private reportError(error: unknown, conn?: ServerConnection): void {
    const normalized = error instanceof Error ? error : new Error(String(error));
    if (this.listenerCount('error') > 0) {
      this.emit('error', normalized, conn ? { serverId: conn.serverId } : undefined);
    } else {
      console.error('[BotClient]', normalized);
    }
  }

  /** Expose a manifest and create a separate connection for each registration. */
  serve(opts: ServeOptions): Promise<http.Server> {
    if (this.closing) throw new Error('This bot client has been closed.');
    const port = opts.port ?? 7780;
    const host = opts.host ?? '0.0.0.0';
    const publicHost = opts.publicHost ?? host;
    const urlHost = publicHost.includes(':') && !publicHost.startsWith('[') ? `[${publicHost}]` : publicHost;
    this.profile = botProfileUpdateSchema.parse({
      ...this.profile,
      name: opts.name,
      avatarBase64: opts.icon ?? this.profile.avatarBase64,
    });
    let listeningPort = port;
    const getManifest = (): BotManifest => botManifestSchema.parse({
      name: opts.name,
      description: opts.description,
      icon: opts.icon ?? this.profile.avatarBase64 ?? undefined,
      commands: [...this.commands.values()].map(({ name, description }) => ({ name, description })),
      registrationUrl: `http://${urlHost}:${listeningPort}/register`,
    });
    getManifest();

    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      if (this.closing) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'The bot is shutting down.' }));
        return;
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/manifest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getManifest()));
        return;
      }
      if (req.method === 'POST' && req.url === '/register') {
        let body = '';
        let tooLarge = false;
        req.on('data', (chunk: Buffer) => {
          if (tooLarge) return;
          body += chunk.toString('utf8');
          if (Buffer.byteLength(body) > 16 * 1024) {
            tooLarge = true;
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Registration is too large.' }));
          }
        });
        req.on('error', (error) => {
          if (!this.closing) this.reportError(error);
        });
        req.on('end', () => {
          if (tooLarge) return;
          if (this.closing) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'The bot is shutting down.' }));
            return;
          }
          let raw: unknown;
          try {
            raw = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON.' }));
            return;
          }
          const parsed = botRegistrationSchema.safeParse(raw);
          if (!parsed.success) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid registration settings.' }));
            return;
          }
          const data = parsed.data;
          const serverId = data.serverId ?? randomUUID();
          this.emit('registered', { token: data.token, serverId, serverName: data.serverName });
          if (this.closing) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'The bot is shutting down.' }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ publicKey: this.options.publicKey }));
          if (data.serverUrl) this.connectToServer(serverId, data.serverUrl, data.token);
        });
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });

    return new Promise((resolve, reject) => {
      const onStartupError = (error: Error) => reject(error);
      server.once('error', onStartupError);
      server.listen(port, host, () => {
        server.off('error', onStartupError);
        server.on('error', (error) => this.reportError(error));
        const address = server.address();
        if (address && typeof address === 'object') listeningPort = address.port;
        this.httpServers.add(server);
        server.once('close', () => this.httpServers.delete(server));
        this.emit('serving', { port: listeningPort, host, manifest: getManifest() });
        resolve(server);
      });
    });
  }
}

export interface ServeOptions {
  name: string;
  description?: string;
  /** Base64 image or data URI. Remote image URLs are not supported. */
  icon?: string;
  port?: number;
  host?: string;
  /** Public hostname/IP, without a scheme or port. */
  publicHost?: string;
}

export { MessageType, PROTOCOL_VERSION } from '@monky/shared';
export type {
  BotForm, BotFormField, BotFormValues, BotManifest,
  SlashCommand, CommandOption, CommandValue, CommandValues, CommandResponsePayload,
} from '@monky/shared';
