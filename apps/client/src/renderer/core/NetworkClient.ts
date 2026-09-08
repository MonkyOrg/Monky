import { v4 as uuidv4 } from 'uuid';
import {
  AuthChallengePayload,
  AuthConnectPayload,
  AuthFailedPayload,
  AuthSuccessPayload,
  MessageType,
  ProtocolMessage,
  PROTOCOL_VERSION,
  RECONNECT_DELAYS_MS,
  ServerErrorPayload,
  ServerShutdownKind,
  ServerShutdownPayload,
} from '@monky/shared';
import { appEvents } from './EventBus';
import { createActiveProxy } from './activeProxy';
import { routeSessionEvent } from './sessionRouting';
import { clientLog } from './ClientLogService';
import { t } from '../i18n';
import { translateProtocolError } from '../i18n/protocolErrors';
import { settingsStore } from '../stores/settingsStore';

export type ConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

export interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
  timer: any;
}

interface ClientIdentity {
  publicKey: string;
  clientId: string;
}

interface PendingAuthRequest {
  requestId: string;
  resolve: (value: AuthSuccessPayload) => void;
  reject: (reason: Error) => void;
  timer: any;
}

type ConnectState = AuthConnectPayload & ClientIdentity;

const DEVICE_ID_STORAGE_KEY = 'monky_device_id';

/**
 * Stable id for this installation. It deliberately lives outside the identity
 * file: copying an identity to another machine must still yield two distinct
 * sessions, which is what lets the same person be online twice (#309).
 */
export function getDeviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
    if (stored) return stored;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(DEVICE_ID_STORAGE_KEY, generated);
    return generated;
  } catch {
    return 'default';
  }
}

export class NetworkClient {
  /**
   * Identifies which server this client talks to, so events can be routed to
   * the matching state bundle when several servers are connected (#400).
   */
  public sessionKey: string = '';
  private ws: WebSocket | null = null;
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
  private status: ConnectionStatus = 'DISCONNECTED';
  private reconnectAttempt: number = 0;
  private reconnectTimeout: any = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private pendingAuth: PendingAuthRequest | null = null;
  private currentServerUrl: string = '';
  private lastConnectPayload: ConnectState | null = null;
  private manualDisconnect: boolean = false;
  private hasEverConnected: boolean = false;
  private heartbeatInterval: any = null;
  private lastPongAt: number = 0;
  private static readonly HEARTBEAT_INTERVAL_MS = 5000;
  private static readonly HEARTBEAT_TIMEOUT_MS = 12000;

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onBrowserOnline);
    }
  }

  /**
   * Kept as a field so it can be removed again: there is one client per server
   * now (#400), and a listener left on `window` would pin every client the user
   * ever connected to in memory.
   */
  private onBrowserOnline = (): void => {
    this.reconnectNow();
  };

  /** Releases everything the client holds outside itself, for good. */
  public dispose(): void {
    this.disconnect();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onBrowserOnline);
    }
  }

  private reconnectNow(): void {
    if (this.manualDisconnect || !this.lastConnectPayload || !this.hasEverConnected) return;
    if (this.status !== 'RECONNECTING') return;
    this.clearReconnect();
    this.reconnectAttempt = 0;
    void this.doReconnect();
  }

  private async diagnoseConnectionFailure(host: string, port: number): Promise<Error> {
    clientLog.warn('NETWORK', `Diagnosing connection failure to ${host}:${port}`);
    const probe = (window as any).api?.probeServer;
    if (typeof probe !== 'function') {
      return new Error(t('network.genericConnectError'));
    }
    try {
      const result: { reachable: boolean; reason: string } = await probe(host, port);
      switch (result.reason) {
        case 'online':
          return new Error(t('network.notMonkyServer', { host, port }));
        case 'refused':
          return new Error(t('network.portClosed', { host, port }));
        case 'unreachable':
          return new Error(t('network.hostUnreachable', { host, port }));
        case 'timeout':
        default:
          return new Error(t('network.connectionTimeout', { host, port }));
      }
    } catch {
      return new Error(t('network.genericConnectError'));
    }
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  /**
   * Emits on the app bus with this client's server as the origin, so the
   * session manager can point the stores at the right bundle before handlers
   * run (#400).
   */
  private emitScoped(event: string, data?: unknown): void {
    routeSessionEvent(this.sessionKey, event, () => appEvents.emit(event, data));
  }

  public getHttpBaseUrl(): string {
    if (!this.currentServerUrl) return '';
    return this.currentServerUrl.replace(/^ws:\/\//, 'http://').replace(/^wss:\/\//, 'https://');
  }

  public getCurrentServerUrl(): string {
    return this.currentServerUrl;
  }

  public async connect(
    host: string,
    port: number,
    identity: ClientIdentity,
    nickname: string,
    password?: string,
    isReconnect = false
  ): Promise<AuthSuccessPayload> {
    clientLog.info('NETWORK', `Connecting to ${host}:${port}${isReconnect ? ' (reconnect)' : ''}`);
    this.manualDisconnect = false;
    if (!isReconnect) {
      this.reconnectAttempt = 0;
      this.hasEverConnected = false;
    }
    this.clearReconnect();
    this.clearConnectionTimeout();

    const cleanHost = host.trim().replace(/^ws:\/\//, '').replace(/^wss:\/\//, '');
    this.currentServerUrl = `ws://${cleanHost}:${port}`;
    if (!this.sessionKey) this.sessionKey = this.currentServerUrl;
    this.lastConnectPayload = {
      protocolVersion: PROTOCOL_VERSION,
      publicKey: identity.publicKey,
      clientId: identity.clientId,
      nickname,
      password: password || '',
    };

    return new Promise((resolve, reject) => {
      this.setStatus('CONNECTING');

      try {
        this.detachSocket(this.ws);
        this.ws = new WebSocket(this.currentServerUrl);
      } catch (err: any) {
        this.setStatus('DISCONNECTED');
        reject(new Error(t('network.addressError', { url: this.currentServerUrl, error: err.message })));
        return;
      }

      const socket = this.ws;
      const isStale = () => this.ws !== socket;

      this.connectionTimeout = setTimeout(() => {
        if (isStale()) return;
        if (this.status === 'CONNECTING') {
          this.rejectPendingAuth(new Error(t('network.timeout')));
          this.ws?.close();
          this.setStatus('DISCONNECTED');
          if (!isReconnect) {
            void this.diagnoseConnectionFailure(cleanHost, port).then(reject);
          } else {
            reject(new Error(t('network.timeout')));
          }
        }
      }, 12000);

      this.ws.onopen = () => {
        if (isStale()) return;
        this.clearConnectionTimeout();
        const authRequestId = uuidv4();
        this.pendingAuth = {
          requestId: authRequestId,
          timer: setTimeout(() => {
            this.rejectPendingAuth(new Error(t('network.timeout')));
            socket.close();
          }, 15000),
          resolve: (res) => {
            this.clearPendingAuth();
            this.setStatus('CONNECTED');
            this.reconnectAttempt = 0;
            this.hasEverConnected = true;
            this.startHeartbeat();
            this.emitScoped('network.connected', res);
            resolve(res);
          },
          reject: (error) => {
            this.clearPendingAuth();
            socket.close();
            this.setStatus('DISCONNECTED');
            reject(error);
          },
        };

        this.send(
          MessageType.AUTH_CONNECT,
          {
            protocolVersion: PROTOCOL_VERSION,
            publicKey: identity.publicKey,
            nickname,
            password: password || '',
            deviceId: getDeviceId(),
            appearOffline: settingsStore.appearOffline || undefined,
          },
          authRequestId
        );
      };

      this.ws.onmessage = (event) => {
        if (isStale()) return;
        try {
          const message: ProtocolMessage = JSON.parse(event.data.toString());
          this.handleIncomingMessage(message);
        } catch (error) {
          console.error('Failed to parse incoming WebSocket message', error);
        }
      };

      this.ws.onclose = () => {
        if (isStale()) return;
        this.clearConnectionTimeout();
        if (this.status === 'CONNECTING') {
          const authError = this.clearPendingAuth();
          this.setStatus('DISCONNECTED');
          if (authError) {
            reject(authError);
            return;
          }
          if (isReconnect) {
            reject(new Error(t('network.genericConnectError')));
          } else {
            void this.diagnoseConnectionFailure(cleanHost, port).then(reject);
          }
          return;
        }
        this.handleSocketClosed();
      };

      this.ws.onerror = (err) => {
        console.warn('WebSocket error encountered:', err);
      };
    });
  }

  public disconnect(): void {
    clientLog.info('NETWORK', 'Disconnecting from server');
    // Emitting again after the socket already died would run the whole teardown
    // twice — and, with one client per server (#400), would ask the session
    // manager to drop a session while it is already being dropped.
    const wasLive = this.status !== 'DISCONNECTED';
    this.manualDisconnect = true;
    this.clearReconnect();
    this.clearConnectionTimeout();
    this.stopHeartbeat();
    this.clearPendingAuth();
    if (this.ws) {
      if (this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: MessageType.USER_LOGOUT, payload: {} }));
        } catch {}
      }
      // Detach before dropping the reference: a socket closed here fires `onclose`
      // asynchronously, and by then a new connect() may already have cleared
      // `manualDisconnect`, which used to restart the reconnect loop and null out
      // the brand new socket (#312).
      this.detachSocket(this.ws);
    }
    // Detaching skips `handleSocketClosed`, so in-flight requests are rejected
    // here instead of lingering until their own 8s timeout.
    this.rejectPendingRequests();
    this.setStatus('DISCONNECTED');
    if (wasLive) this.emitScoped('network.disconnected');
  }

  private rejectPendingRequests(): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(t('network.connectionClosed')));
    }
    this.pendingRequests.clear();
  }

  /** Drops every handler of a socket and closes it, so it can no longer affect state. */
  private detachSocket(socket: WebSocket | null): void {
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    try {
      socket.close();
    } catch {}
    if (this.ws === socket) this.ws = null;
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  public send(type: MessageType, payload: any, requestId?: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn(`Cannot send message ${type}, socket is not open.`);
      return;
    }

    const message: ProtocolMessage = {
      type,
      requestId: requestId || uuidv4(),
      payload,
    };

    this.ws.send(JSON.stringify(message));
  }

  public sendRequest<T = any>(type: MessageType, payload: any, customRequestId?: string, timeoutMs: number = 8000): Promise<T> {
    const requestId = customRequestId || uuidv4();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          reject(new Error(`Timeout aguardando resposta para ${type}`));
        }
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      this.send(type, payload, requestId);
    });
  }

  private handleIncomingMessage(message: ProtocolMessage): void {
    const { type, requestId, payload } = message;

    if (type === MessageType.PONG) {
      this.lastPongAt = Date.now();
      return;
    }

    if (type === MessageType.SERVER_SHUTDOWN) {
      const shutdown = (payload as ServerShutdownPayload) || {};
      // An older server sends no kind at all, and its only wording is "the host
      // closed the server", so treat the absence as a definitive shutdown.
      const kind: ServerShutdownKind = shutdown.kind === 'update' ? 'update' : 'shutdown';
      this.emitScoped('network.server_shutdown', { reason: shutdown.reason, kind });
      if (kind === 'update') {
        // The server is restarting to apply an update and is coming back on its
        // own. Letting the socket close on its own hands it to the normal
        // reconnect backoff, whereas `disconnect()` sets `manualDisconnect` and
        // would strand the client on the home screen — telling people to wait
        // for a reconnection the app had just disabled (#558).
        clientLog.info('NETWORK', 'Server is restarting for an update; keeping the reconnect loop alive');
        return;
      }
      this.disconnect();
      return;
    }

    if (this.pendingAuth && requestId === this.pendingAuth.requestId) {
      if (type === MessageType.AUTH_CHALLENGE) {
        void this.respondToAuthChallenge(payload as AuthChallengePayload, requestId);
        return;
      }

      if (type === MessageType.AUTH_SUCCESS) {
        clientLog.info('NETWORK', 'Authentication successful');
        this.pendingAuth.resolve(payload as AuthSuccessPayload);
        return;
      }

      if (type === MessageType.AUTH_FAILED) {
        const authFailed = payload as AuthFailedPayload;
        clientLog.error('NETWORK', 'Authentication failed', { message: authFailed.message });
        this.pendingAuth.reject(new Error(authFailed.message || t('network.genericConnectError')));
        return;
      }

      if (type === MessageType.SERVER_ERROR) {
        const errorPayload = payload as ServerErrorPayload;
        this.pendingAuth.reject(
          new Error(
            translateProtocolError(errorPayload.code, errorPayload.message, errorPayload.serverProtocolVersion)
          )
        );
        return;
      }
    }

    if (requestId && this.pendingRequests.has(requestId)) {
      const pending = this.pendingRequests.get(requestId)!;
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);

      if (type === MessageType.SERVER_ERROR) {
        const errorPayload = payload as ServerErrorPayload;
        pending.reject(new Error(translateProtocolError(errorPayload.code, errorPayload.message)));
        return;
      }

      pending.resolve(payload);
    }

    this.emitScoped(`message.${type}`, payload);
  }

  private async respondToAuthChallenge(payload: AuthChallengePayload, requestId?: string): Promise<void> {
    if (!this.pendingAuth || !requestId) return;

    try {
      const signature = await window.api.signChallenge(payload.nonce);
      this.send(MessageType.AUTH_CHALLENGE_RESPONSE, { signature }, requestId);
    } catch (error: any) {
      this.pendingAuth.reject(new Error(error?.message || t('network.genericConnectError')));
    }
  }

  private handleSocketClosed(): void {
    clientLog.warn('NETWORK', 'WebSocket connection closed');
    this.ws = null;
    this.stopHeartbeat();
    this.clearPendingAuth();
    this.rejectPendingRequests();

    if (this.manualDisconnect) {
      this.setStatus('DISCONNECTED');
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect || !this.lastConnectPayload || !this.hasEverConnected) {
      this.setStatus('DISCONNECTED');
      return;
    }

    this.setStatus('RECONNECTING');
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;

    this.emitScoped('network.reconnecting', { attempt: this.reconnectAttempt, delay });

    this.reconnectTimeout = setTimeout(() => {
      void this.doReconnect();
    }, delay);
  }

  private async doReconnect(): Promise<void> {
    if (this.manualDisconnect || !this.lastConnectPayload) return;

    try {
      console.log(`[NetworkClient] Trying to reconnect (attempt ${this.reconnectAttempt})...`);
      clientLog.info('NETWORK', `Reconnection attempt ${this.reconnectAttempt}`);
      const { clientId, publicKey, nickname, password } = this.lastConnectPayload;
      const urlObj = new URL(this.currentServerUrl);
      const host = urlObj.hostname;
      const port = parseInt(urlObj.port, 10);

      await this.connect(host, port, { clientId, publicKey }, nickname, password, true);
    } catch {
      console.warn(`[NetworkClient] Reconnection attempt ${this.reconnectAttempt} failed.`);
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private clearPendingAuth(): Error | null {
    if (!this.pendingAuth) return null;
    clearTimeout(this.pendingAuth.timer);
    this.pendingAuth = null;
    return null;
  }

  private rejectPendingAuth(error: Error): void {
    if (!this.pendingAuth) return;
    const pending = this.pendingAuth;
    clearTimeout(pending.timer);
    this.pendingAuth = null;
    pending.reject(error);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      if (Date.now() - this.lastPongAt > NetworkClient.HEARTBEAT_TIMEOUT_MS) {
        clientLog.error('NETWORK', 'Heartbeat timeout — connection considered dead, forcing reconnect');
        console.warn('[NetworkClient] Heartbeat timeout, connection considered dead. Forcing reconnect.');
        this.stopHeartbeat();
        try {
          this.ws.close();
        } catch {}
        if (this.ws) {
          this.ws.onclose = null;
          this.ws = null;
          this.handleSocketClosed();
        }
        return;
      }

      try {
        this.ws.send(JSON.stringify({ type: MessageType.PING, payload: { timestamp: Date.now() } }));
      } catch {}
    }, NetworkClient.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.emitScoped('network.status', status);
  }
}

export function createNetworkClient(): NetworkClient {
  return new NetworkClient();
}

let activeNetworkClient = createNetworkClient();

export function setActiveNetworkClient(client: NetworkClient): void {
  activeNetworkClient = client;
}

export function getActiveNetworkClient(): NetworkClient {
  return activeNetworkClient;
}

export const networkClient = createActiveProxy<NetworkClient>(() => activeNetworkClient);
