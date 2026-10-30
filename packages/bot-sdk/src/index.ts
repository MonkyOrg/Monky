import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import http from 'http';
import WebSocket from 'ws';
import { BotVoiceConnection } from './voice/BotVoiceConnection';
import { BotScreenClient } from './BotScreenClient';
import {
  liveActionCreateSchema, liveActionSchema, liveActionUpdateSchema, liveActionSubmissionSchema,
  type LiveAction, type LiveActionCreate, type LiveActionUpdate, type LiveActionSubmission,
} from '@monky/shared';
export type { LiveAction, LiveActionCreate, LiveActionUpdate, LiveActionSubmission } from '@monky/shared';
import {
  BotLocalExecutionClient, type LocalExecutionConnection, type LocalExecutionContextLifetime,
} from './localExecution/LocalExecutionClient';
import type { LocalExecutionClient } from './localExecution/contracts';
import { botVoiceAuthSchema, botVoiceJoinOptionsSchema, type BotVoiceJoinOptions } from '@monky/shared';
export type {
  BotCapability, BotPermissions, BotVoiceJoinOptions, LocalCapabilityId, LocalMediaTrack, LocalOperation, LocalPlaylistResult,
  LocalPreviewReference, LocalRequestContext,
  LocalSourceContext, LocalSourceFailure, LocalTaskCancellationCause, LocalTaskEvent, LocalTaskFailureReason,
  LocalTaskSpec, LocalWirePreviewResult, LocalWireTaskResult,
} from '@monky/shared';
export { BotVoiceConnection } from './voice/BotVoiceConnection';
export type { BotVoicePacket, BotVoiceAudioReceiver } from './voice/VoiceAudioReceiver';
export { BotScreenClient } from './BotScreenClient';
import { createBotStorage, type BotStorage } from './BotStorageClient';
export { type BotStorage, type BotStoragePutOptions, type BotStoredObject } from './BotStorageClient';
import { BotRequestError } from './requestError';
export { BotRequestError } from './requestError';
export type { BotStorageList, BotStorageListResult, BotStorageLevel, BotStorageObjectInfo, BotStorageUsage } from '@monky/shared';
export type { BotDeviceStorageStatus, BotScreenStorage, BotScreenStorageEntry, BotScreenStorageUsage } from '@monky/shared';
export * from './managedTools';
export * from './localExecution/contracts';
export { handleReachabilityProbe } from './reachability';
import { createMarketplaceServer, marketplaceBaseUrl } from './marketplace';
import {
  LIMITS,
  MessageType,
  PROTOCOL_VERSION,
  createProtocolOffer,
  legacyProtocolFallback,
  protocolOfferSchema,
  ProtocolErrorCode,
  botManifestSchema,
  botCapabilitiesSchema,
  type BotPermissions,
  botProfileUpdateSchema,
  botChatMessageSchema,
  chatReactionSchema,
  chatReactionEventSchema,
  normalizeBotMessageContent,
  type BotPublishedMessageContent,
  messageReferenceSchema,
  commandDefinitionSchema,
  commandDefinitionsSchema,
  requiredCommandCapabilities,
  commandRequestIdSchema,
  localBotIdentitySchema,
  withoutBotStorageCapabilities,
  clientMessage,
  type ClientMessage,
  type ClientMessageArgs,
} from '@monky/shared';
import { RegistrationStore, type BotRegistration } from './RegistrationStore';
import {
  createServerConnection, isLive, isRecord, readMessage, serverMessage,
  type IncomingMessage, type ServerConnection,
} from './client/connection';
import { immutableCopy } from './client/immutable';
import { SettingsSync } from './client/settingsSync';
import { LiveRequests } from './client/liveRequests';
import { CommandRuntime } from './client/commandRuntime';
import type {
  BotOptions, BotSelectorResponseContext, BotSelectorResponseEvent, CommandDefinition, ServeOptions,
} from './client/types';
export type {
  BotChoice, BotOptions, BotSelectorResponseContext, BotSelectorResponseEvent, CommandAudioPreviewContext,
  CommandAudioPreviewData, CommandAudioPreviewResponse, CommandAutocompleteContext, CommandContext,
  CommandDefinition, ServeOptions,
} from './client/types';
import {
  botSelectorCreateSchema, botSelectorPatchSchema, botSelectorSchema,
  botSelectorFinalizeSchema, botSelectorRespondedSchema,
  type BotSelector, type BotSelectorCreate, type BotSelectorPatch,
} from '@monky/shared';
import type {
  BotScreen,
  BotScreenRef,
  BotScreenCreate,
  BotScreenPatch,
  BotManifest,
  BotProfileUpdatePayload,
  BotServerSettingsSnapshot,
  BotSettingsDefinition,
  LocalRequestContext,
  ChatMessage,
  ChatSendPayload,
  ChatReactionEventPayload,
} from '@monky/shared';

const RESOURCE_RESPONSES = new Set<string>([
  MessageType.COMMUNITY_ACK,
  MessageType.LIVE_ACTION_SNAPSHOT,
  MessageType.LIVE_ACTION_LIST_RESULT,
  MessageType.SERVER_ERROR,
  MessageType.SELECTOR_SNAPSHOT,
  MessageType.SELECTOR_LIST_RESULT,
  MessageType.BOT_SCREEN_SNAPSHOT,
  MessageType.BOT_SCREEN_LIST_RESULT,
  MessageType.BOT_SCREEN_REMOVED,
  MessageType.BOT_STORAGE_SAVED,
  MessageType.BOT_STORAGE_GET_RESULT,
  MessageType.BOT_STORAGE_DELETED,
  MessageType.BOT_STORAGE_LIST_RESULT,
  MessageType.BOT_STORAGE_USAGE_RESULT,
]);

/**
 * A bot may serve many servers and many callers concurrently. Each invocation
 * owns its form promise and abort signal; handlers never share conversation state.
 */
export class BotClient extends EventEmitter {
  private voiceCleanup = new Set<Promise<void>>();
  private localExecutionClients = new Map<string, BotLocalExecutionClient>();
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
  private screens = new BotScreenClient({
    request: (serverId, ...message) => this.requestResource(serverId, message),
    report: (serverId, event) => this.emit('screenAction', { serverId, ...event }),
    removed: (serverId, event) => this.emit('screenRemoved', { serverId, ...event }),
    error: (serverId, error) => this.reportError(error, this.connections.get(serverId)),
  });
  private settingsSync = new SettingsSync({
    permissionsChanged: (permissions, context) => this.emit('permissionsChanged', permissions, context),
    settingsChanged: (snapshot, context) => this.emit('settingsChanged', snapshot, context),
    error: (error, conn) => this.reportError(error, conn),
  });
  private liveRequests = new LiveRequests({
    command: (name) => this.commands.get(name),
    settings: (conn, input) => this.settingsSync.capture(conn, input),
    send: (conn, message) => this.sendToConn(conn, message),
    report: (error, conn) => this.reportError(error, conn),
  });
  private commandRuntime = new CommandRuntime({
    command: (name) => this.commands.get(name),
    settings: (conn, input) => this.settingsSync.capture(conn, input),
    send: (conn, message) => this.sendToConn(conn, message),
    report: (error, conn) => this.reportError(error, conn),
    createSelector: (serverId, input) => this.createSelector(serverId, input),
    createLiveAction: (serverId, input) => this.createLiveAction(serverId, input),
    createScreen: (serverId, input) => this.createScreen(serverId, input),
  });

  createScreen(serverId: string, input: BotScreenCreate): Promise<BotScreen> {
    return this.screens.createScreen(serverId, input);
  }

  updateScreen(serverId: string, ref: BotScreenRef, patch: BotScreenPatch): Promise<BotScreen> {
    return this.screens.updateScreen(serverId, ref, patch);
  }

  closeScreen(serverId: string, ref: BotScreenRef): Promise<void> {
    return this.screens.closeScreen(serverId, ref);
  }

  listScreens(serverId: string, channelId: string): Promise<BotScreen[]> {
    return this.screens.listScreens(serverId, channelId);
  }

  /**
   * Objects this bot keeps on the Monky server, private to the bot. Requires `server_storage`
   * in `requestedCapabilities`, an administrator's approval and a server that supports it.
   */
  storage(serverId: string): BotStorage {
    if (!this.options.requestedCapabilities.includes('server_storage')) {
      throw new Error('Declare server_storage in BotOptions.requestedCapabilities to use bot storage.');
    }
    return createBotStorage({
      request: (message, timeoutMs) => {
        const conn = this.connections.get(serverId);
        if (conn?.connected && !conn.protocolFeatures?.includes('bot-storage')) {
          return Promise.reject(new BotRequestError('This Monky server does not support bot storage yet. Update the server.',
            ProtocolErrorCode.FEATURE_REQUIRES_UPDATE));
        }
        return this.requestResource(serverId, message, timeoutMs);
      },
    });
  }

  localExecution(serverId: string): LocalExecutionClient {
    if (this.closing) throw new Error('This bot client has been closed.');
    this.requireConnection(serverId);
    const existing = this.localExecutionClients.get(serverId);
    if (existing) return existing;
    const botPublicKey = localBotIdentitySchema.shape.botPublicKey.parse(this.options.publicKey);
    const isCurrent = (connection: LocalExecutionConnection): boolean => {
      const conn = this.connections.get(serverId);
      return !this.closing && !!conn && isLive(conn) && conn.ws === connection.ws && conn.botId === connection.botId &&
        conn.voiceAuth?.currentUser.id === connection.botId &&
        conn.voiceAuth.currentUser.sessionId === connection.botSessionId;
    };
    const client = new BotLocalExecutionClient({
      connection: () => {
        if (this.closing) throw new Error('This bot client has been closed.');
        const conn = this.requireConnection(serverId);
        if (!conn.ws || !conn.voiceAuth || conn.botId !== conn.voiceAuth.currentUser.id) {
          throw new Error('Server did not supply valid authenticated local execution metadata.');
        }
        return {
          ws: conn.ws, botId: conn.botId, botSessionId: conn.voiceAuth.currentUser.sessionId, botPublicKey,
        };
      },
      isCurrent,
      features: () => {
        const conn = this.connections.get(serverId);
        return !this.closing && conn?.connected && !conn.disposed ? conn.protocolFeatures : undefined;
      },
      captureContext: (connection, context) => this.captureLocalExecutionContext(serverId, connection, context),
      send: (connection, message) => {
        if (!isCurrent(connection)) throw new Error('Local execution signaling disconnected.');
        this.sendToConn(this.requireConnection(serverId), message);
      },
      reportError: (error) => this.reportError(error, this.connections.get(serverId)),
    });
    this.localExecutionClients.set(serverId, client);
    return client;
  }

  private captureLocalExecutionContext(
    serverId: string, connection: LocalExecutionConnection,
    context: Exclude<LocalRequestContext, { kind: 'source' }>,
  ): LocalExecutionContextLifetime {
    const conn = this.requireConnection(serverId);
    const current = () => {
      switch (context.kind) {
        case 'invocation': return conn.invocations.get(context.invocationId);
        case 'autocomplete': return conn.autocompletes.get(context.requestId);
        case 'audio-preview': return conn.audioPreviews.get(context.requestId);
      }
    };
    const pending = current();
    if (conn.ws !== connection.ws || !pending || pending.controller.signal.aborted ||
        pending.caller.botId !== connection.botId) {
      throw new Error('The local execution context is not a live interaction on this connection.');
    }
    return {
      caller: pending.caller, signal: pending.controller.signal,
      isCurrent: () => this.connections.get(serverId) === conn && conn.ws === connection.ws &&
        current() === pending && !pending.controller.signal.aborted,
    };
  }

  private disposeLocalExecution(conn: ServerConnection): void {
    if (conn.ws) this.localExecutionClients.get(conn.serverId)?.disconnect(conn.ws);
  }

  joinVoice(serverId: string, channelId: string, options: BotVoiceJoinOptions = {}): Promise<BotVoiceConnection> {
    const conn = this.requireConnection(serverId);
    const parsed = botVoiceJoinOptionsSchema.safeParse(options);
    if (!parsed.success) return Promise.reject(new Error('Invalid voice join options.'));
    if (parsed.data.receiveAudio && !this.options.requestedCapabilities.includes('receive_voice')) {
      return Promise.reject(new Error('Declare receive_voice and have it approved before receiving audio.'));
    }
    if (!conn.voiceAuth) return Promise.reject(new Error('Server did not supply valid authenticated voice metadata.'));
    if (!channelId || channelId.length > 256) return Promise.reject(new Error('Invalid voice channel ID.'));
    if (conn.voice) {
      if (conn.voice.isClosed) return Promise.reject(new Error('Voice connection is closing; await leaveVoice before rejoining.'));
      if (conn.voice.channelId !== channelId) return Promise.reject(new Error('Leave the current voice channel before joining another.'));
      if (conn.voice.receivesAudio !== (parsed.data.receiveAudio === true)) {
        return Promise.reject(new Error('Leave the current voice channel before changing its reception opt-in.'));
      }
      return conn.voiceJoin ?? Promise.resolve(conn.voice);
    }
    const voice = new BotVoiceConnection(channelId, conn.voiceAuth, {
      send: (message) => {
        if (!isLive(conn)) throw new Error('Voice signaling disconnected.');
        this.sendToConn(conn, message);
      },
      participants: (humanParticipantCount) => this.emit('voiceParticipantsChanged', {
        serverId: conn.serverId, channelId, humanParticipantCount,
      }),
      disconnected: (reason) => {
        if (conn.voice === voice) {
          conn.voice = undefined;
          conn.voiceJoin = undefined;
        }
        this.emit('voiceDisconnected', { serverId: conn.serverId, channelId, reason });
      },
      error: (error) => this.reportError(error, conn),
    }, (conn.permissions?.granted ?? this.options.requestedCapabilities).includes('publish_voice'));
    conn.voice = voice;
    const joining = voice.join(parsed.data).then(() => voice).finally(() => {
      if (conn.voice === voice) conn.voiceJoin = undefined;
    });
    conn.voiceJoin = joining;
    return joining;
  }

  getVoiceConnection(serverId: string): BotVoiceConnection | undefined {
    return this.connections.get(serverId)?.voice;
  }

  async leaveVoice(serverId: string): Promise<void> {
    await this.connections.get(serverId)?.voice?.close();
  }

  private disposeVoice(conn: ServerConnection, reason: string): void {
    conn.voiceAuth = undefined;
    if (!conn.voice) return;
    const cleanup = conn.voice.disconnect(reason);
    this.voiceCleanup.add(cleanup);
    void cleanup.catch((error: unknown) => this.reportError(error, conn))
      .finally(() => this.voiceCleanup.delete(cleanup));
  }

  constructor(options: BotOptions) {
    super();
    this.options = { autoReconnect: true, ...options, requestedCapabilities: botCapabilitiesSchema.parse(options.requestedCapabilities) };
    this.registrationStore = new RegistrationStore(options.registrationFile, options.publicKey);
    if (options.name !== undefined || options.avatarBase64 !== undefined) {
      this.profile = botProfileUpdateSchema.parse({
        name: options.name,
        avatarBase64: options.avatarBase64,
      });
    }
  }

  getPermissions(serverId: string): BotPermissions | undefined {
    const connection = this.connections.get(serverId);
    return connection?.connected && connection.permissions ? immutableCopy(connection.permissions) : undefined;
  }

  command(def: CommandDefinition): this {
    if (requiredCommandCapabilities([def]).some((capability) => !this.options.requestedCapabilities.includes(capability))) {
      throw new Error('Declare the capabilities required by this command in BotOptions.requestedCapabilities.');
    }
    const definition = commandDefinitionSchema.parse({
      name: def.name.toLowerCase(),
      description: def.description,
      options: def.options,
      localizations: def.localizations,
      downloadsSound: def.downloadsSound,
      voiceRequirement: def.voiceRequirement,
      localCapabilities: def.localCapabilities,
    });
    if (typeof def.handler !== 'function') throw new TypeError('A command handler is required.');
    if ((def.autocomplete !== undefined && typeof def.autocomplete !== 'function') ||
        (definition.options?.some((option) => option.autocomplete) && !def.autocomplete)) {
      throw new TypeError('String options with autocomplete require an autocomplete handler.');
    }
    if (def.audioPreview !== undefined && typeof def.audioPreview !== 'function') {
      throw new TypeError('An audio preview provider must be a function.');
    }
    if (!this.commands.has(definition.name) && this.commands.size >= LIMITS.MAX_COMMANDS_PER_BOT) {
      throw new Error(`A bot may register at most ${LIMITS.MAX_COMMANDS_PER_BOT} commands.`);
    }
    commandDefinitionsSchema.parse([
      ...[...this.commands.values()].filter((command) => command.name !== definition.name)
        .map(({ name, description, options, localizations, downloadsSound, voiceRequirement, localCapabilities }) => ({
          name, description, options, localizations, downloadsSound, voiceRequirement, localCapabilities,
        })),
      definition,
    ]);
    this.commands.set(definition.name, {
      ...definition, autocomplete: def.autocomplete, audioPreview: def.audioPreview, handler: def.handler,
    });
    return this;
  }

  /** Declare custom settings before connecting or starting a marketplace listener. */
  settings(definition: BotSettingsDefinition): this {
    if (this.closing) throw new Error('This bot client has been closed.');
    if (this.connections.size || this.httpServers.size || this.startingServers.size) {
      throw new Error('Declare bot settings before connecting or serving; disconnect first to change them.');
    }
    this.settingsSync.declare(definition);
    return this;
  }

  /** The latest shared values, never a caller's personal preferences. */
  getServerSettings(serverId: string): BotServerSettingsSnapshot | undefined {
    const conn = this.connections.get(serverId);
    if (this.closing || !conn || !isLive(conn) || !conn.serverSettings) return undefined;
    return immutableCopy(conn.serverSettings);
  }

  onSettingsChanged(
    listener: (snapshot: BotServerSettingsSnapshot, context: { readonly serverId: string }) => void
  ): () => void {
    const handler = (snapshot: BotServerSettingsSnapshot, context: { serverId: string }) => {
      listener(immutableCopy(snapshot), immutableCopy(context));
    };
    this.on('settingsChanged', handler);
    return () => { this.off('settingsChanged', handler); };
  }

  /** Private responder preferences; these are not part of public selector snapshots. */
  onSelectorResponse(
    listener: (event: BotSelectorResponseEvent, context: BotSelectorResponseContext) => void
  ): () => void {
    const handler = (event: BotSelectorResponseEvent, context: BotSelectorResponseContext) => {
      listener(immutableCopy(event), immutableCopy(context));
    };
    this.on('selectorResponse', handler);
    return () => { this.off('selectorResponse', handler); };
  }

  async createSelector(serverId: string, input: BotSelectorCreate): Promise<BotSelector> {
    const parsed = botSelectorCreateSchema.parse({ ...input, id: input.id ?? randomUUID() });
    return botSelectorSchema.parse(await this.requestResource(serverId, [MessageType.SELECTOR_CREATE, parsed]));
  }

  async createLiveAction(serverId: string, input: LiveActionCreate): Promise<LiveAction> {
    const parsed = liveActionCreateSchema.parse({ ...input, id: input.id ?? randomUUID() });
    return liveActionSchema.parse(await this.requestResource(serverId, [MessageType.LIVE_ACTION_CREATE, parsed]));
  }

  async updateLiveAction(serverId: string, input: LiveActionUpdate): Promise<LiveAction> {
    return liveActionSchema.parse(await this.requestResource(serverId, [MessageType.LIVE_ACTION_UPDATE,
      liveActionUpdateSchema.parse(input)]));
  }

  async closeLiveAction(serverId: string, id: string): Promise<void> {
    await this.requestResource(serverId, [MessageType.LIVE_ACTION_CLOSE, { id }]);
  }

  async listLiveActions(serverId: string): Promise<LiveAction[]> {
    const result = await this.requestResource(serverId, [MessageType.LIVE_ACTION_LIST, {}]);
    if (!isRecord(result) || !Array.isArray(result.liveActions)) throw new Error('Invalid live action list.');
    return result.liveActions.map((entry) => liveActionSchema.parse(entry));
  }

  onLiveActionSubmission(listener: (event: LiveActionSubmission, context: { serverId: string }) => void): () => void {
    const handler = (event: LiveActionSubmission, context: { serverId: string }) =>
      listener(immutableCopy(event), immutableCopy(context));
    this.on('liveActionSubmission', handler);
    return () => { this.off('liveActionSubmission', handler); };
  }

  async listSelectors(serverId: string): Promise<BotSelector[]> {
    const result = await this.requestResource(serverId, [MessageType.SELECTOR_LIST, {}]);
    if (!isRecord(result) || !Array.isArray(result.selectors)) throw new Error('Invalid selector list.');
    return result.selectors.map((entry) => botSelectorSchema.parse(entry));
  }

  async updateSelector(serverId: string, id: string, patch: BotSelectorPatch): Promise<BotSelector> {
    return botSelectorSchema.parse(await this.requestResource(serverId, [MessageType.SELECTOR_UPDATE,
      { id, patch: botSelectorPatchSchema.parse(patch) }]));
  }

  async closeSelector(serverId: string, id: string): Promise<BotSelector> {
    return botSelectorSchema.parse(await this.requestResource(serverId, [MessageType.SELECTOR_CLOSE, { id }]));
  }

  async finalizeSelector(serverId: string, id: string, content: BotPublishedMessageContent): Promise<BotSelector> {
    return botSelectorSchema.parse(await this.requestResource(serverId, [MessageType.SELECTOR_FINALIZE,
      botSelectorFinalizeSchema.parse({ id, ...normalizeBotMessageContent(content) })]));
  }

  private requestResource(serverId: string, message: ClientMessageArgs, timeoutMs = 8000): Promise<unknown> {
    const conn = this.connections.get(serverId);
    if (!conn?.connected) return Promise.reject(new Error('The bot is not connected to this server.'));
    if (this.pendingResources() >= 100) return Promise.reject(new Error('Too many pending bot resource requests.'));
    return conn.resources.request(timeoutMs, 'Bot resource acknowledgement timed out.',
      (requestId) => this.sendToConn(conn, clientMessage(...message, requestId)));
  }

  /** One budget for every server: a bot cannot pile up resource requests by spreading them. */
  private pendingResources(): number {
    let pending = 0;
    for (const conn of this.connections.values()) pending += conn.resources.size;
    return pending;
  }

  /** Post persistent channel text and resolve with its server-assigned ID. */
  async sendMessage(
    serverId: string, channelId: string, content: BotPublishedMessageContent,
    options: Pick<ChatSendPayload, 'replyToMessageId'> = {}
  ): Promise<ChatMessage> {
    const conn = this.requireConnection(serverId);
    if (!channelId || channelId.length > 128) throw new Error('Invalid channel ID.');
    const message = normalizeBotMessageContent(content);
    const replyToMessageId = messageReferenceSchema.optional().parse(options.replyToMessageId);
    if (conn.pendingMessages.size >= 100) throw new Error('Too many unacknowledged messages.');
    return conn.pendingMessages.request(30_000, 'The server did not acknowledge the channel message.',
      (requestId) => this.sendToConn(conn, {
        type: MessageType.CHAT_SEND, requestId, payload: { channelId, ...message, replyToMessageId },
      }));
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
    if (!conn || !isLive(conn)) {
      throw new Error('The bot is not connected to this Monky server.');
    }
    return conn;
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
      const mediaCleanup = await Promise.allSettled([
        ...this.voiceCleanup, ...[...this.localExecutionClients.values()].map((client) => client.dispose()),
      ]);
      this.localExecutionClients.clear();
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
      const failure = mediaCleanup.find((result) => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
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

    const conn = createServerConnection(serverId, serverUrl, token);
    this.connections.set(serverId, conn);
    this.openSocket(conn);
    return conn;
  }

  private openSocket(conn: ServerConnection): void {
    if (conn.disposed || this.connections.get(conn.serverId) !== conn) return;
    conn.botId = null;
    conn.serverSettings = undefined;
    conn.permissions = undefined;
    conn.retriedProtocol = false;
    const ws = new WebSocket(conn.serverUrl);
    conn.ws = ws;
    const isCurrent = () => conn.ws === ws && !conn.disposed;

    ws.on('open', () => {
      if (isCurrent()) this.sendAuthConnect(conn, PROTOCOL_VERSION);
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
      this.disposeLocalExecution(conn);
      this.disposeVoice(conn, 'disconnected');
      this.endSession(conn, 'The connection closed before the bot registration completed.');
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
    this.disposeLocalExecution(conn);
    this.disposeVoice(conn, 'disconnected');
    conn.disposed = true;
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    const ws = conn.ws;
    this.endSession(conn, 'The bot registration was interrupted.');
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  }

  /**
   * The socket is gone: forget what its authentication established, abort the
   * handlers it started and fail whatever still waits for its replies.
   */
  private endSession(conn: ServerConnection, registrationError: string): void {
    conn.ws = null;
    conn.connected = false;
    conn.botId = null;
    conn.serverSettings = undefined;
    conn.permissions = undefined;
    conn.profileRequestId = null;
    this.rejectRegistration(conn, new Error(registrationError));
    this.liveRequests.clear(conn);
    conn.resources.rejectAll('The bot disconnected before the resource acknowledgement.');
    this.commandRuntime.clear(conn);
    conn.pendingMessages.rejectAll('The connection closed before the channel message was acknowledged.');
  }

  /**
   * Order matters: local execution, voice context and resource requests claim the
   * SERVER_ERRORs that carry their request IDs before the generic handling below.
   */
  private handleMessage(conn: ServerConnection, msg: IncomingMessage): void {
    if (conn.ws && this.localExecutionClients.get(conn.serverId)?.handle(conn.ws, msg)) return;
    if (this.commandRuntime.handleVoiceContext(conn, msg)) return;
    if (conn.voice?.handle(msg)) return;
    if (msg.type === MessageType.SERVER_SETTINGS_UPDATED && conn.voiceAuth && isRecord(msg.payload) &&
        (msg.payload.voiceMode === 'p2p' || msg.payload.voiceMode === 'sfu')) {
      conn.voiceAuth = { ...conn.voiceAuth, server: { voiceMode: msg.payload.voiceMode } };
    }
    if (this.settleResource(conn, msg)) return;
    if (this.screens.handle(conn.serverId, msg.type, msg.payload)) return;
    if (this.settingsSync.handle(conn, msg) || this.liveRequests.handle(conn, msg) ||
        this.commandRuntime.handle(conn, msg)) return;
    switch (msg.type) {
      case MessageType.AUTH_SUCCESS:
        this.authenticated(conn, msg.payload);
        return;
      case MessageType.AUTH_FAILED:
        this.failAuthentication(conn, msg.payload);
        return;
      case MessageType.SERVER_ERROR:
        this.serverError(conn, msg);
        return;
      case MessageType.BOT_PROFILE_UPDATED:
        if (conn.profileRequestId && msg.requestId === conn.profileRequestId) {
          conn.profileRequestId = null;
        }
        return;
      case MessageType.BOT_REVOKED:
        this.revoked(conn, msg);
        return;
      case MessageType.PING:
        this.sendToConn(conn, { type: MessageType.PONG, payload: { timestamp: Date.now() } });
        return;
      case MessageType.CHAT_MESSAGE: {
        if (msg.requestId && conn.pendingMessages.has(msg.requestId)) {
          const parsed = botChatMessageSchema.safeParse(msg.payload);
          if (parsed.success) conn.pendingMessages.settle(msg.requestId, parsed.data);
          else conn.pendingMessages.fail(msg.requestId, new Error('The server sent an invalid channel message acknowledgement.'));
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
      case MessageType.SELECTOR_RESPONDED: {
        const parsed = botSelectorRespondedSchema.safeParse(msg.payload);
        if (!parsed.success) {
          this.reportError(new Error('The server sent an invalid selector response.'), conn);
          return;
        }
        try {
          const { settings, ...event } = parsed.data;
          const context = this.settingsSync.capture(conn, settings);
          this.emit('selectorResponse', immutableCopy(event),
            immutableCopy({ serverId: conn.serverId, settings: context }));
        } catch (error) {
          this.reportError(error, conn);
        }
        return;
      }
      case MessageType.SELECTOR_SNAPSHOT: {
        const parsed = botSelectorSchema.safeParse(msg.payload);
        if (parsed.success) this.emit('selectorUpdate', { serverId: conn.serverId, selector: parsed.data });
        else this.reportError(new Error('Invalid selector snapshot.'), conn);
        return;
      }
      case MessageType.LIVE_ACTION_SUBMITTED: {
        const parsed = liveActionSubmissionSchema.safeParse(msg.payload);
        if (parsed.success) this.emit('liveActionSubmission', immutableCopy(parsed.data), { serverId: conn.serverId });
        else this.reportError(new Error('Invalid live action submission.'), conn);
        return;
      }
      default:
        this.emit('message', msg, { serverId: conn.serverId });
    }
  }

  /** Replies to selector, live action, miniapp and storage requests, refusals included. */
  private settleResource(conn: ServerConnection, msg: IncomingMessage): boolean {
    if (!msg.requestId || !RESOURCE_RESPONSES.has(msg.type) || !conn.resources.has(msg.requestId)) return false;
    if (msg.type === MessageType.SERVER_ERROR) {
      const code = isRecord(msg.payload) && typeof msg.payload.code === 'string' ? msg.payload.code : undefined;
      conn.resources.fail(msg.requestId, new BotRequestError(serverMessage(msg.payload, 'Bot resource request failed.'), code));
    } else conn.resources.settle(msg.requestId, msg.payload);
    return true;
  }

  private authenticated(conn: ServerConnection, payload: unknown): void {
    if (conn.connected) this.disposeLocalExecution(conn);
    const voiceAuth = botVoiceAuthSchema.safeParse(payload);
    conn.voiceAuth = voiceAuth.success ? voiceAuth.data : undefined;
    const agreement = protocolOfferSchema.safeParse(isRecord(payload) && isRecord(payload.server)
      ? payload.server.protocol : undefined);
    conn.protocolFeatures = agreement.success ? agreement.data.features : [];
    const currentUser = isRecord(payload) ? payload.currentUser : undefined;
    if (currentUser !== undefined) {
      const botId = commandRequestIdSchema.safeParse(isRecord(currentUser) ? currentUser.id : undefined);
      if (!botId.success) {
        this.reportError(new Error('The server sent an invalid authenticated bot identity.'), conn);
        return;
      }
      conn.botId = botId.data;
    }
    conn.connected = true;
    if (conn.pendingRegistration) {
      void this.registrationStore.save(conn.pendingRegistration.registration).then(() => {
        if (this.closing || !isLive(conn)) {
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
  }

  /**
   * A SERVER_ERROR nobody claimed earlier: before authentication it may ask for the legacy
   * protocol or end the attempt; after it, it rejects the request it answers.
   */
  private serverError(conn: ServerConnection, msg: IncomingMessage): void {
    const fallback = isRecord(msg.payload) && msg.payload.code === ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED
      ? legacyProtocolFallback(msg.payload.serverProtocolVersion, 'bot') : null;
    if (!conn.connected && !conn.retriedProtocol && fallback !== null) {
      conn.retriedProtocol = true;
      this.sendAuthConnect(conn, fallback);
      return;
    }
    const error = new Error(serverMessage(msg.payload, 'The Monky server rejected the bot request.'));
    if (this.commandRuntime.rejectSoundDownload(conn, msg.requestId, error)) return;
    if (msg.requestId && conn.pendingMessages.fail(msg.requestId, error)) return;
    if (this.commandRuntime.rejectPrompt(conn, msg.requestId, error)) return;
    if (!conn.connected) {
      this.failAuthentication(conn, msg.payload);
      return;
    }
    if (conn.profileRequestId && msg.requestId === conn.profileRequestId) {
      conn.profileRequestId = null;
    }
    this.reportError(error, conn);
  }

  /** The server removed this bot: drop the saved link to that server and disconnect from it. */
  private revoked(conn: ServerConnection, msg: IncomingMessage): void {
    const botId = commandRequestIdSchema.safeParse(isRecord(msg.payload) ? msg.payload.botId : undefined);
    if (!botId.success) {
      this.reportError(new Error('Invalid bot revocation notification.'), conn);
      return;
    }
    if (botId.data === conn.botId && this.connections.get(conn.serverId) === conn) {
      const removed = this.registrationStore.remove({
        serverId: conn.serverId, serverUrl: conn.serverUrl, token: conn.token,
      });
      this.disconnect(conn.serverId);
      void removed.catch(error => this.reportError(error, conn));
    }
    this.emit('message', msg, { serverId: conn.serverId });
  }

  /** The first attempt and the legacy protocol retry present the same identity and token. */
  private sendAuthConnect(conn: ServerConnection, protocolVersion: number): void {
    this.sendToConn(conn, {
      type: MessageType.AUTH_CONNECT,
      payload: {
        protocolVersion,
        protocolOffer: createProtocolOffer('bot'),
        publicKey: this.options.publicKey,
        nickname: this.profile.name ?? 'bot',
        password: '',
        botToken: conn.token,
      },
    });
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
    const error = new Error(serverMessage(payload, 'Bot authentication failed. Check the token and the bot identity keys.'));
    const pending = conn.pendingRegistration !== null;
    this.emit('auth_failed', payload, { serverId: conn.serverId });
    this.rejectRegistration(conn, error);
    if (pending) return;
    if (this.connections.get(conn.serverId) === conn && isRecord(payload) &&
        payload.code === ProtocolErrorCode.UNAUTHORIZED) {
      const removed = this.registrationStore.remove({
        serverId: conn.serverId, serverUrl: conn.serverUrl, token: conn.token,
      });
      void removed.catch(error => this.reportError(error, conn));
    }
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
    await this.registrationStore.flush();
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
        // A server without bot-storage rejects the whole declaration if it lists those names.
        requestedCapabilities: conn.protocolFeatures?.includes('bot-storage')
          ? this.options.requestedCapabilities : withoutBotStorageCapabilities(this.options.requestedCapabilities),
        commands: [...this.commands.values()].map(({ name, description, options, localizations, downloadsSound, voiceRequirement, localCapabilities }) => ({
          name, description, options: options ?? [], localizations, downloadsSound, voiceRequirement, localCapabilities,
        })),
        settings: this.settingsSync.definition,
      },
    });
  }

  private sendToConn(conn: ServerConnection, msg: ClientMessage): void {
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
    const publicBase = opts.publicUrl === undefined ? undefined : marketplaceBaseUrl(opts.publicUrl);
    this.profile = botProfileUpdateSchema.parse({
      ...this.profile,
      name: opts.name,
      avatarBase64: opts.icon ?? this.profile.avatarBase64,
    });
    let listeningPort = port;
    const getManifest = (serverFeatures?: string): BotManifest => botManifestSchema.parse({
      requestedCapabilities: serverFeatures?.split(',').map((feature) => feature.trim()).includes('bot-storage')
        ? this.options.requestedCapabilities : withoutBotStorageCapabilities(this.options.requestedCapabilities),
      name: opts.name,
      description: opts.description,
      icon: opts.icon ?? this.profile.avatarBase64 ?? undefined,
      commands: [...this.commands.values()].map(({ name, description }) => ({ name, description })),
      registrationUrl: publicBase ? `${publicBase}/register` : `http://${urlHost}:${listeningPort}/register`,
    });
    getManifest();

    const server = createMarketplaceServer({
      publicKey: this.options.publicKey,
      isClosing: () => this.closing,
      manifest: getManifest,
      register: async (registration) => {
        if (!registration.serverUrl) return;
        const url = new URL(registration.serverUrl);
        if (url.hash) throw new Error('The server URL must not contain a fragment.');
        await this.registerServer({ ...registration, serverUrl: registration.serverUrl });
      },
      // The token is the installation's secret; listeners only learn which server it was.
      registered: ({ serverId, serverName, serverUrl }) => this.emit('registered', {
        serverId, serverName, ...(serverUrl ? { serverUrl } : {}),
      }),
      report: (error) => this.reportError(error),
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

export { BOT_CAPABILITIES, BOT_STORAGE_LIMITS, LIMITS, MessageType, PROTOCOL_VERSION, ProtocolErrorCode } from '@monky/shared';
export {
  botSettingsDefinitionSchema, botSettingsContextSchema, botServerSettingsSnapshotSchema,
  botSettingsSnapshotSchema, botSettingsValuesSchema, botSelectorRespondedSchema, resolveBotSettingsValues,
  BOT_LOCALES, botLocaleSchema, normalizeBotLocale, resolveBotLocale, localizeCommand, getCommandPresentation,
} from '@monky/shared';
export { runBotCli } from './cli';
export {
  validateBotName,
  validateBotToken,
  validateServerUrl as validateBotServerUrl,
  validatePublicHost as validateBotPublicHost,
  validateServePort as validateBotServePort,
} from './cli/config';
export { buildBotPackage, type BuildBotOptions, type BuiltBotPackage } from './tooling/build';
export { askCliChoice, askCliText, askCliValue, CliPromptCancelled, type CliChoice, type CliPromptIO } from './cli/prompts';
export type {
  BotPackageDefinition, GitHubReleaseSource, BotUpdateSource, HttpsUpdateSource, FileUpdateSource,
} from './tooling/config';
export type {
  BotRequirements, BotPortRequirement, BotSettingRequirement, BotLocalizedText,
  BotPortProtocol, BotPortExposure, BotPortActivation,
} from './tooling/requirements';
export type {
  BotSelector, BotSelectorCreate, BotSelectorPatch, BotSelectorPublic, BotSelectorRespondedPayload,
  BotScreen, BotScreenRef, BotScreenCreate, BotScreenPatch, BotScreenActionEvent, BotScreenJson, BotScreenRemoved,
  BotScreenBridge, BotScreenViewer, BotScreenBeforeCloseEvent, BotScreenBeforeCloseReason, BotScreenCloseEvent, BotScreenCloseReason,
} from '@monky/shared';
export type {
  BotForm, BotFormField, BotFormValues, BotManifest, BotLocale, CommandLocalization, CommandLocalizations,
  CommandPresentation, BotFieldLocalization,
  BotSettingsDefinition, BotSettingsContext, BotServerSettingsSnapshot, BotSettingsSnapshot, BotSettingsSummary,
  BotInputResult,
  ChatMessage, ChatReactionEventPayload, MessageReaction, BotMessageContent, BotPublishedMessageContent,
  BotLocalizedMessage, BotMessageLocalizations, BotCarouselPresentation, BotCarouselFormat, BotCarouselFit,
  BotCarouselSize, BotCarouselInput, BotCarouselComponent, BotMessageComponentInput, BotMessageComponent,
  SlashCommand, CommandOption, CommandValue, CommandValues, CommandVoiceRequirement, CommandResponsePayload,
  CommandAutocompleteChoice, CommandAutocompletePage, CommandAudioPreviewMimeType, SoundDownloadRequest, SoundDownloadResult, SoundDownloadFailureReason,
  AudioPreviewSource, SelectionChoice,
} from '@monky/shared';
