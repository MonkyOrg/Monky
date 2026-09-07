import { EventEmitter } from 'events';
import http from 'http';
import WebSocket from 'ws';
import {
  MessageType,
  PROTOCOL_VERSION,
  CommandOption,
  CommandResponsePayload,
  BotManifest,
} from '@monky/shared';

export interface BotOptions {
  /** WebSocket URL of the Monky server, e.g. ws://localhost:3000 */
  serverUrl?: string;
  /** The bot token obtained from the server's Bot Management UI. */
  token?: string;
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
  /** The server ID where the command was invoked. */
  serverId: string;
  /** Parsed argument values keyed by option name. */
  args: Record<string, string>;
  /** Reply to the invoker (public message in the channel). */
  reply: (content: string) => void;
  /** Reply only to the invoker (ephemeral, not visible to others). */
  replyEphemeral: (content: string) => void;
}

/** Represents one WebSocket connection to a Monky server. */
interface ServerConnection {
  serverId: string;
  serverUrl: string;
  token: string;
  ws: WebSocket | null;
  connected: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Multi-server Monky bot client.
 *
 * **Single-server mode** (manual token):
 * ```ts
 * const bot = new MonkyBot({ serverUrl: 'ws://localhost:3000', token: 'TOKEN', publicKey: 'HEX' });
 * bot.command({ name: 'ping', description: 'Pong!', handler: ctx => ctx.reply('🏓') });
 * bot.connect();
 * ```
 *
 * **Multi-server mode** (marketplace):
 * ```ts
 * const bot = new MonkyBot({ publicKey: 'HEX' });
 * bot.command({ name: 'ping', description: 'Pong!', handler: ctx => ctx.reply('🏓') });
 * bot.serve({ name: 'PingBot', port: 7780, publicHost: 'mybot.example.com' });
 * // Each server that installs via the manifest URL gets its own connection.
 * ```
 */
export class MonkyBot extends EventEmitter {
  private options: Required<Pick<BotOptions, 'publicKey' | 'autoReconnect'>> & Omit<BotOptions, 'publicKey' | 'autoReconnect'>;
  private commands = new Map<string, CommandDefinition>();
  private connections = new Map<string, ServerConnection>();

  /** Counter for generating unique connection IDs when serverId is unknown. */
  private connIdCounter = 0;

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

  /**
   * Connect to a single Monky server.
   * Uses `serverUrl` and `token` from constructor options, or pass overrides.
   */
  connect(overrides?: { serverUrl?: string; token?: string; serverId?: string }): void {
    const serverUrl = overrides?.serverUrl || this.options.serverUrl;
    const token = overrides?.token || this.options.token;
    if (!serverUrl || !token) {
      throw new Error('MonkyBot.connect() requires serverUrl and token (via constructor or overrides).');
    }
    const serverId = overrides?.serverId || `conn_${++this.connIdCounter}`;
    this.connectToServer(serverId, serverUrl, token);
  }

  /** Disconnect from a specific server, or all servers if no id given. */
  disconnect(serverId?: string): void {
    if (serverId) {
      const conn = this.connections.get(serverId);
      if (conn) this.teardownConnection(conn);
      this.connections.delete(serverId);
    } else {
      for (const conn of this.connections.values()) {
        this.teardownConnection(conn);
      }
      this.connections.clear();
    }
  }

  /** Number of active server connections. */
  get serverCount(): number {
    return this.connections.size;
  }

  /** List connected server IDs. */
  get serverIds(): string[] {
    return Array.from(this.connections.keys());
  }

  // ── Internal connection management ──────────────────────────────────

  private connectToServer(serverId: string, serverUrl: string, token: string): void {
    // Avoid duplicate connections to the same server.
    if (this.connections.has(serverId)) {
      const existing = this.connections.get(serverId)!;
      if (existing.connected) return;
      // Clean up stale connection before reconnecting.
      this.teardownConnection(existing);
    }

    const conn: ServerConnection = {
      serverId,
      serverUrl,
      token,
      ws: null,
      connected: false,
      reconnectTimer: null,
    };
    this.connections.set(serverId, conn);
    this.openSocket(conn);
  }

  private openSocket(conn: ServerConnection): void {
    const ws = new WebSocket(conn.serverUrl);
    conn.ws = ws;

    ws.on('open', () => {
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

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString('utf8'));
        this.handleMessage(conn, msg);
      } catch { /* ignore malformed */ }
    });

    ws.on('close', () => {
      conn.connected = false;
      this.emit('disconnected', { serverId: conn.serverId });
      if (this.options.autoReconnect && this.connections.has(conn.serverId)) {
        conn.reconnectTimer = setTimeout(() => {
          conn.ws = null;
          this.openSocket(conn);
        }, 5000);
      }
    });

    ws.on('error', (err) => {
      this.emit('error', err, { serverId: conn.serverId });
    });
  }

  private teardownConnection(conn: ServerConnection): void {
    if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
    conn.reconnectTimer = null;
    try { conn.ws?.close(); } catch { /* ignore */ }
    conn.ws = null;
    conn.connected = false;
  }

  // ── Message handling ────────────────────────────────────────────────

  private handleMessage(conn: ServerConnection, msg: { type: string; payload?: any }): void {
    if (msg.type === MessageType.AUTH_SUCCESS) {
      conn.connected = true;
      this.emit('connected', { serverId: conn.serverId });
      this.registerCommandsOn(conn);
      return;
    }

    if (msg.type === MessageType.AUTH_FAILED) {
      this.emit('auth_failed', msg.payload, { serverId: conn.serverId });
      return;
    }

    if (msg.type === MessageType.PING) {
      this.sendToConn(conn, { type: MessageType.PONG, payload: { timestamp: Date.now() } });
      return;
    }

    if (msg.type === MessageType.COMMAND_INVOKE) {
      this.handleCommandInvoke(conn, msg.payload);
      return;
    }

    this.emit('message', msg, { serverId: conn.serverId });
  }

  private registerCommandsOn(conn: ServerConnection): void {
    const cmds = Array.from(this.commands.values()).map((def) => ({
      name: def.name,
      description: def.description,
      options: def.options || [],
    }));

    this.sendToConn(conn, {
      type: MessageType.COMMAND_REGISTER,
      payload: { commands: cmds },
    });
  }

  private handleCommandInvoke(conn: ServerConnection, payload: any): void {
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
      serverId: conn.serverId,
      args: argsMap,
      reply: (content: string) => {
        const response: CommandResponsePayload = {
          channelId: payload.channelId,
          userId: payload.invokerId,
          content,
        };
        this.sendToConn(conn, { type: MessageType.COMMAND_RESPONSE, payload: response });
      },
      replyEphemeral: (content: string) => {
        const response: CommandResponsePayload = {
          channelId: payload.channelId,
          userId: payload.invokerId,
          content,
          ephemeral: true,
        };
        this.sendToConn(conn, { type: MessageType.COMMAND_RESPONSE, payload: response });
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

  private sendToConn(conn: ServerConnection, msg: object): void {
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(JSON.stringify(msg));
    }
  }

  // ── Bot Marketplace: serve manifest + registration endpoint (#578) ──

  /**
   * Starts an HTTP server exposing:
   * - `GET /manifest`  → returns the bot's `BotManifest` JSON
   * - `POST /register` → receives `{ token, serverId, serverName, serverUrl }`,
   *   opens a new WebSocket connection for that server, responds with `{ publicKey }`.
   *
   * Each server that installs the bot gets its own independent connection.
   * The bot registers all its commands on every connected server automatically.
   */
  serve(opts: ServeOptions): Promise<http.Server> {
    const port = opts.port ?? 7780;
    const host = opts.host ?? '0.0.0.0';

    const manifest: BotManifest = {
      name: opts.name,
      description: opts.description,
      icon: opts.icon,
      registrationUrl: `http://${opts.publicHost ?? host}:${port}/register`,
    };

    const server = http.createServer((req, res) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && req.url === '/manifest') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(manifest));
        return;
      }

      if (req.method === 'POST' && req.url === '/register') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (!data.token || !data.serverName) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Missing token or serverName' }));
              return;
            }

            const serverId = data.serverId || `srv_${++this.connIdCounter}`;
            const serverUrl = data.serverUrl;

            this.emit('registered', {
              token: data.token,
              serverId,
              serverName: data.serverName,
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ publicKey: this.options.publicKey }));

            // Auto-connect to the new server if we have a WebSocket URL.
            if (serverUrl) {
              setTimeout(() => this.connectToServer(serverId, serverUrl, data.token), 100);
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    return new Promise((resolve, reject) => {
      server.listen(port, host, () => {
        this.emit('serving', { port, host, manifest });
        resolve(server);
      });
      server.on('error', reject);
    });
  }
}

export interface ServeOptions {
  /** Bot display name in the manifest. */
  name: string;
  /** Bot description. */
  description?: string;
  /** Bot icon URL or base64. */
  icon?: string;
  /** HTTP port to listen on (default: 7780). */
  port?: number;
  /** Bind address (default: '0.0.0.0'). */
  host?: string;
  /**
   * Public hostname/IP that the Monky server can reach to POST the registration.
   * Defaults to `host`. If your bot is behind NAT, set this to the external IP.
   */
  publicHost?: string;
}

export { MessageType, PROTOCOL_VERSION } from '@monky/shared';
export type { SlashCommand, CommandOption, CommandResponsePayload, BotManifest } from '@monky/shared';
