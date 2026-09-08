import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import http from 'http';
import WebSocket from 'ws';
import {
  LIMITS,
  MessageType,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  botFormSchema,
  botManifestSchema,
  botProfileUpdateSchema,
  botRegistrationSchema,
  botChatMessageSchema,
  chatReactionSchema,
  chatReactionEventSchema,
  messageContentSchema,
  commandDefinitionSchema,
  commandExecutionSchema,
  commandFinishedSchema,
  commandResponseSchema,
  commandSubmitSchema,
  validateBotFormValues,
  validateCommandOptions,
} from '@monky/shared';
import { RegistrationStore, type BotRegistration } from './RegistrationStore';
import {
  botSelectorCreateSchema, botSelectorPatchSchema, botSelectorSchema,
  botSelectorFinalizeSchema,
  type BotSelector, type BotSelectorCreate, type BotSelectorPatch,
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
  ChatMessage,
  ChatReactionEventPayload,
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
  /** Private JSON file for authenticated marketplace registrations; survives close/restart. */
  registrationFile?: string;
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
  /** Ask one private choice; buttons submit immediately, dropdowns require confirmation. */
  choose: (choice: BotChoice) => Promise<string | null>;
  /** Publish durable channel controls, independent of this invocation's lifetime. */
  createSelector: (input: Omit<BotSelectorCreate, 'channelId' | 'invokerId' | 'invocationId'>) => Promise<BotSelector>;
}

export interface BotChoice {
  title: string;
  description?: string;
  choices: Array<{ label: string; value: string }>;
  presentation?: 'dropdown' | 'buttons';
  submitLabel?: string;
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

interface PendingRegistration {
  registration: BotRegistration;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ServerConnection {
  pendingMessages: Map<string, { resolve: (message: ChatMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>;
  serverId: string;
  serverUrl: string;
  token: string;
  ws: WebSocket | null;
  connected: boolean;
  disposed: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  profileRequestId: string | null;
  invocations: Map<string, Invocation>;
  pendingRegistration: PendingRegistration | null;
  registrationPromise: Promise<void> | null;
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
  private selectorRequests = new Map<string, {
    conn: ServerConnection;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private options: BotOptions;
  private profile: BotProfileUpdatePayload = {};
  private commands = new Map<string, CommandDefinition>();
  private connections = new Map<string, ServerConnection>();
  private httpServers = new Set<http.Server>();
  private startingServers = new Set<Promise<http.Server>>();
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private registrationStore: RegistrationStore;
  private registrationsRestored = false;

  constructor(options: BotOptions) {
    super();
    this.options = { autoReconnect: true, ...options };
    this.registrationStore = new RegistrationStore(options.registrationFile, options.publicKey);
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

  async createSelector(serverId: string, input: BotSelectorCreate): Promise<BotSelector> {
    const parsed = botSelectorCreateSchema.parse({ ...input, id: input.id ?? randomUUID() });
    return botSelectorSchema.parse(await this.requestSelector(serverId, MessageType.SELECTOR_CREATE, parsed));
  }

  async listSelectors(serverId: string): Promise<BotSelector[]> {
    const result = await this.requestSelector(serverId, MessageType.SELECTOR_LIST, {});
    if (!isRecord(result) || !Array.isArray(result.selectors)) throw new Error('Invalid selector list.');
    return result.selectors.map((entry) => botSelectorSchema.parse(entry));
  }

  async updateSelector(serverId: string, id: string, patch: BotSelectorPatch): Promise<BotSelector> {
    return botSelectorSchema.parse(await this.requestSelector(serverId, MessageType.SELECTOR_UPDATE,
      { id, patch: botSelectorPatchSchema.parse(patch) }));
  }

  async closeSelector(serverId: string, id: string): Promise<BotSelector> {
    return botSelectorSchema.parse(await this.requestSelector(serverId, MessageType.SELECTOR_CLOSE, { id }));
  }

  async finalizeSelector(serverId: string, id: string, content: string): Promise<BotSelector> {
    return botSelectorSchema.parse(await this.requestSelector(serverId, MessageType.SELECTOR_FINALIZE,
      botSelectorFinalizeSchema.parse({ id, content })));
  }

  private requestSelector(serverId: string, type: MessageType, payload: unknown): Promise<unknown> {
    const conn = this.connections.get(serverId);
    if (!conn?.connected) return Promise.reject(new Error('The bot is not connected to this server.'));
    if (this.selectorRequests.size >= 100) return Promise.reject(new Error('Too many selector requests.'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.selectorRequests.delete(requestId);
        reject(new Error('Selector acknowledgement timed out. Retry with the same selector id.'));
      }, 8000);
      this.selectorRequests.set(requestId, { conn, resolve, reject, timer });
      try {
        this.sendToConn(conn, { type, requestId, payload });
      } catch (error) {
        clearTimeout(timer);
        this.selectorRequests.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Post persistent channel text and resolve with its server-assigned ID. */
  async sendMessage(serverId: string, channelId: string, content: string): Promise<ChatMessage> {
    const conn = this.requireConnection(serverId);
    if (!channelId || channelId.length > 128) throw new Error('Invalid channel ID.');
    const validatedContent = messageContentSchema.parse(content);
    if (conn.pendingMessages.size >= 100) throw new Error('Too many unacknowledged messages.');
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pendingMessages.delete(requestId);
        reject(new Error('The server did not acknowledge the channel message.'));
      }, 30_000);
      conn.pendingMessages.set(requestId, { resolve, reject, timer });
      try {
        this.sendToConn(conn, { type: MessageType.CHAT_SEND, requestId, payload: { channelId, content: validatedContent } });
      } catch (error) {
        clearTimeout(timer);
        conn.pendingMessages.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  addReaction(serverId: string, channelId: string, messageId: string, emoji: string): void {
    this.sendReaction(serverId, channelId, messageId, emoji, true);
  }

  removeReaction(serverId: string, channelId: string, messageId: string, emoji: string): void {
    this.sendReaction(serverId, channelId, messageId, emoji, false);
  }

  private sendReaction(serverId: string, channelId: string, messageId: string, emoji: string, add: boolean): void {
    const payload = chatReactionSchema.parse({ channelId, messageId, emoji });
    this.sendToConn(this.requireConnection(serverId), {
      type: add ? MessageType.CHAT_REACTION_ADD : MessageType.CHAT_REACTION_REMOVE, payload,
    });
  }

  /** Channel events outlive slash-command invocations; unsubscribe on bot teardown. */
  onReactionAdded(listener: (event: ChatReactionEventPayload, context: { serverId: string }) => void): () => void {
    this.on('reactionAdded', listener);
    return () => { this.off('reactionAdded', listener); };
  }

  onReactionRemoved(listener: (event: ChatReactionEventPayload, context: { serverId: string }) => void): () => void {
    this.on('reactionRemoved', listener);
    return () => { this.off('reactionRemoved', listener); };
  }

  private requireConnection(serverId: string): ServerConnection {
    const conn = this.connections.get(serverId);
    if (!conn || !conn.connected || conn.disposed || conn.ws?.readyState !== WebSocket.OPEN) {
      throw new Error('The bot is not connected to this Monky server.');
    }
    return conn;
  }

  private rejectPendingMessages(conn: ServerConnection): void {
    for (const pending of conn.pendingMessages.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('The connection closed before the channel message was acknowledged.'));
    }
    conn.pendingMessages.clear();
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
    if (url.hash) throw new Error('serverUrl must not contain a URL fragment.');
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
      await Promise.allSettled([...this.startingServers]);
      await Promise.all([...this.httpServers].map((server) => new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => server.closeAllConnections(), LIMITS.SHUTDOWN_GRACE_MS);
        server.close((error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      })));
      await this.registrationStore.flush();
    }).finally(() => {
      this.disconnect();
      this.emit('closed');
    });
    return this.closePromise;
  }

  get serverCount(): number {
    return [...this.connections.values()].filter((conn) => conn.connected).length;
  }

  get serverIds(): string[] {
    return [...this.connections.values()].filter((conn) => conn.connected).map((conn) => conn.serverId);
  }

  /** Known authenticated marketplace registrations, including disconnected servers. */
  get registeredServerCount(): number {
    return this.registrationStore.size;
  }

  private connectToServer(serverId: string, serverUrl: string, token: string): ServerConnection {
    if (this.closing) throw new Error('This bot client has been closed.');
    const existing = this.connections.get(serverId);
    if (existing && existing.token === token && existing.serverUrl === serverUrl && !existing.disposed &&
        (existing.ws?.readyState === WebSocket.OPEN || existing.ws?.readyState === WebSocket.CONNECTING)) return existing;
    if (existing) this.teardownConnection(existing);

    const conn: ServerConnection = {
      serverId, serverUrl, token,
      ws: null,
      connected: false,
      disposed: false,
      reconnectTimer: null,
      profileRequestId: null,
      invocations: new Map(),
      pendingMessages: new Map(),
      pendingRegistration: null,
      registrationPromise: null,
    };
    this.connections.set(serverId, conn);
    this.openSocket(conn);
    return conn;
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
      this.rejectRegistration(conn, new Error('The connection closed before the bot registration completed.'));
      this.clearInvocations(conn);
      this.rejectPendingMessages(conn);
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
    this.rejectRegistration(conn, new Error('The bot registration was interrupted.'));
    this.clearInvocations(conn);
    this.rejectPendingMessages(conn);
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  }

  private clearInvocations(conn: ServerConnection): void {
    for (const [id, request] of this.selectorRequests) {
      if (request.conn !== conn) continue;
      clearTimeout(request.timer);
      this.selectorRequests.delete(id);
      request.reject(new Error('The bot disconnected before the selector acknowledgement.'));
    }
    for (const invocation of conn.invocations.values()) {
      invocation.controller.abort();
      invocation.prompt?.resolve(null);
      invocation.prompt = null;
    }
    conn.invocations.clear();
  }

  private handleMessage(conn: ServerConnection, msg: IncomingMessage): void {
    const selectorRequest = msg.requestId ? this.selectorRequests.get(msg.requestId) : undefined;
    if (selectorRequest?.conn === conn && msg.requestId &&
        (msg.type === MessageType.SERVER_ERROR || msg.type === MessageType.SELECTOR_SNAPSHOT || msg.type === MessageType.SELECTOR_LIST_RESULT)) {
      clearTimeout(selectorRequest.timer);
      this.selectorRequests.delete(msg.requestId);
      if (msg.type === MessageType.SERVER_ERROR) {
        const payload = isRecord(msg.payload) ? msg.payload : {};
        selectorRequest.reject(new Error(typeof payload.message === 'string' ? payload.message : 'Selector request failed.'));
      } else selectorRequest.resolve(msg.payload);
      return;
    }
    switch (msg.type) {
      case MessageType.SELECTOR_SNAPSHOT: {
        const parsed = botSelectorSchema.safeParse(msg.payload);
        if (parsed.success) this.emit('selectorUpdate', { serverId: conn.serverId, selector: parsed.data });
        else this.reportError(new Error('Invalid selector snapshot.'), conn);
        return;
      }
      case MessageType.AUTH_SUCCESS:
        conn.connected = true;
        if (conn.pendingRegistration) {
          void this.registrationStore.save(conn.pendingRegistration.registration).then(() => {
            if (conn.disposed || this.closing || conn.ws?.readyState !== WebSocket.OPEN) {
              this.rejectRegistration(conn, new Error('The bot registration was interrupted.'));
              return;
            }
            this.completeAuthentication(conn);
            const pending = conn.pendingRegistration;
            if (pending) {
              clearTimeout(pending.timer);
              conn.pendingRegistration = null;
              conn.registrationPromise = null;
              pending.resolve();
            }
          }).catch((error: unknown) => {
            this.rejectRegistration(conn, error instanceof Error ? error : new Error(String(error)));
          });
        } else {
          this.completeAuthentication(conn);
        }
        return;
      case MessageType.BOT_PROFILE_UPDATED:
        if (conn.profileRequestId && msg.requestId === conn.profileRequestId) {
          conn.profileRequestId = null;
        }
        return;
      case MessageType.AUTH_FAILED:
        this.failAuthentication(conn, msg.payload);
        return;
      case MessageType.SERVER_ERROR: {
        const error = new Error(isRecord(msg.payload) && typeof msg.payload.message === 'string'
          ? msg.payload.message : 'The Monky server rejected the bot request.');
        const pendingMessage = msg.requestId ? conn.pendingMessages.get(msg.requestId) : undefined;
        if (pendingMessage && msg.requestId) {
          clearTimeout(pendingMessage.timer);
          conn.pendingMessages.delete(msg.requestId);
          pendingMessage.reject(error);
          return;
        }
        for (const invocation of conn.invocations.values()) {
          const pending = invocation.prompt;
          if (pending && pending.interactionId === msg.requestId) {
            pending.reject(error);
            invocation.prompt = null;
            return;
          }
        }
        if (!conn.connected) {
          this.failAuthentication(conn, msg.payload);
          return;
        }
        if (conn.profileRequestId && msg.requestId === conn.profileRequestId) {
          conn.profileRequestId = null;
        }
        this.reportError(error, conn);
        return;
      }
      case MessageType.CHAT_MESSAGE: {
        const pending = msg.requestId ? conn.pendingMessages.get(msg.requestId) : undefined;
        if (pending && msg.requestId) {
          clearTimeout(pending.timer);
          conn.pendingMessages.delete(msg.requestId);
          const parsed = botChatMessageSchema.safeParse(msg.payload);
          if (parsed.success) pending.resolve(parsed.data);
          else pending.reject(new Error('The server sent an invalid channel message acknowledgement.'));
        }
        this.emit('message', msg, { serverId: conn.serverId });
        return;
      }
      case MessageType.CHAT_REACTION_ADDED:
      case MessageType.CHAT_REACTION_REMOVED: {
        const parsed = chatReactionEventSchema.safeParse(msg.payload);
        if (!parsed.success) {
          this.reportError(new Error('The server sent an invalid reaction event.'), conn);
          return;
        }
        this.emit(msg.type === MessageType.CHAT_REACTION_ADDED ? 'reactionAdded' : 'reactionRemoved',
          parsed.data, { serverId: conn.serverId });
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

  private completeAuthentication(conn: ServerConnection): void {
    if (this.profile.name !== undefined || this.profile.avatarBase64 !== undefined) {
      conn.profileRequestId = randomUUID();
      this.sendToConn(conn, {
        type: MessageType.BOT_UPDATE_PROFILE,
        requestId: conn.profileRequestId,
        payload: this.profile,
      });
    }
    // Profile changes are cosmetic: a rejected avatar must not hide every command.
    this.registerCommandsOn(conn);
    this.emit('connected', { serverId: conn.serverId });
  }

  private failAuthentication(conn: ServerConnection, payload: unknown): void {
    const error = new Error(isRecord(payload) && typeof payload.message === 'string'
      ? payload.message : 'Bot authentication failed. Check the token and the bot identity keys.');
    const pending = conn.pendingRegistration !== null;
    this.emit('auth_failed', payload, { serverId: conn.serverId });
    this.rejectRegistration(conn, error);
    if (pending) return;
    if (this.options.autoReconnect && isRecord(payload) &&
        payload.code === ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED) {
      conn.ws?.close();
    } else {
      this.disconnect(conn.serverId);
    }
    this.reportError(error, conn);
  }

  private rejectRegistration(conn: ServerConnection, error: Error): void {
    const pending = conn.pendingRegistration;
    if (!pending) return;
    clearTimeout(pending.timer);
    conn.pendingRegistration = null;
    conn.registrationPromise = null;
    pending.reject(error);
  }

  private async registerServer(registration: BotRegistration): Promise<void> {
    const known = this.registrationStore.get(registration.serverId) ?? this.connections.get(registration.serverId);
    if (known && (known.serverUrl !== registration.serverUrl || known.token !== registration.token)) {
      throw new Error('This serverId is already registered with different credentials or a different URL.');
    }
    const conn = this.connectToServer(registration.serverId, registration.serverUrl, registration.token);
    if (conn.registrationPromise) return conn.registrationPromise;
    if (conn.connected) {
      await this.registrationStore.save(registration);
      return;
    }
    const authenticated = new Promise<void>((resolve, reject) => {
      conn.pendingRegistration = {
        registration, resolve, reject,
        timer: setTimeout(() => {
          this.rejectRegistration(conn, new Error('The bot could not authenticate to the Monky server in time.'));
        }, 8000),
      };
    });
    conn.registrationPromise = authenticated;
    try {
      await authenticated;
    } catch (error) {
      if (this.connections.get(conn.serverId) === conn) {
        this.disconnect(conn.serverId);
      }
      throw error;
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
      createSelector: (input) => {
        requireActive();
        return this.createSelector(conn.serverId, {
          ...input, channelId: payload.channelId, invokerId: payload.invokerId, invocationId: payload.invocationId,
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
        req.setEncoding('utf8');
        req.on('data', (chunk: string) => {
          if (tooLarge) return;
          body += chunk;
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
          const register = async (): Promise<void> => {
            if (data.serverUrl) {
              const url = new URL(data.serverUrl);
              if (url.hash) throw new Error('The server URL must not contain a fragment.');
              await this.registerServer({ ...data, serverId, serverUrl: data.serverUrl });
            }
            if (this.closing) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'The bot is shutting down.' }));
              return;
            }
            this.emit('registered', { ...data, serverId });
            if (this.closing) {
              res.writeHead(503, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'The bot is shutting down.' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ publicKey: this.options.publicKey }));
          };
          void register().catch((error: unknown) => {
            if (!this.closing) this.reportError(error);
            if (!res.destroyed && !res.writableEnded) {
              res.writeHead(this.closing ? 503 : 502, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'The bot could not complete registration. Check the bot logs and server compatibility.' }));
            }
          });
        });
        return;
      }
      res.writeHead(404);
      res.end('Not Found');
    });

    const starting = this.registrationStore.load().then((registrations) => new Promise<http.Server>((resolve, reject) => {
      if (this.closing) {
        reject(new Error('This bot client has been closed.'));
        return;
      }
      const onStartupError = (error: Error) => reject(error);
      server.once('error', onStartupError);
      server.listen(port, host, () => {
        server.off('error', onStartupError);
        server.on('error', (error) => this.reportError(error));
        const address = server.address();
        if (address && typeof address === 'object') listeningPort = address.port;
        this.httpServers.add(server);
        server.once('close', () => this.httpServers.delete(server));
        if (!this.registrationsRestored && !this.closing) {
          this.registrationsRestored = true;
          for (const registration of registrations) {
            this.connectToServer(registration.serverId, registration.serverUrl, registration.token);
          }
        }
        this.emit('serving', { port: listeningPort, host, manifest: getManifest() });
        resolve(server);
      });
    }));
    this.startingServers.add(starting);
    void starting.then(
      () => this.startingServers.delete(starting),
      () => this.startingServers.delete(starting)
    );
    return starting;
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

export { MessageType, PROTOCOL_VERSION, ProtocolErrorCode } from '@monky/shared';
export type { BotSelector, BotSelectorCreate, BotSelectorPatch, BotSelectorPublic } from '@monky/shared';
export type {
  BotForm, BotFormField, BotFormValues, BotManifest,
  ChatMessage, ChatReactionEventPayload, MessageReaction,
  SlashCommand, CommandOption, CommandValue, CommandValues, CommandResponsePayload,
} from '@monky/shared';
