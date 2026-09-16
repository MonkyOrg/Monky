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
} from '@monky/shared';
import { appEvents } from './EventBus';
import { createActiveProxy } from './activeProxy';
import { routeSessionEvent } from './sessionRouting';
import { clientLog } from './ClientLogService';
import { t } from '../i18n';
import { translateProtocolError } from '../i18n/protocolErrors';
import { settingsStore } from '../stores/settingsStore';

export type ConnectionStatus = 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED' | 'RECONNECTING';

export class RequestTimeoutError extends Error {
  constructor(public readonly messageType: MessageType) {
    super(`Timeout aguardando resposta para ${messageType}`);
    this.name = 'RequestTimeoutError';
  }
}

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
  timer: ReturnType<typeof setTimeout>;
}

type ConnectState = AuthConnectPayload & ClientIdentity;

const DEVICE_ID_STORAGE_KEY = 'monky_device_id';
const LOCAL_EXECUTION_EVENTS = new Set<MessageType>([
  MessageType.BOT_LOCAL_TASK_OFFER, MessageType.BOT_LOCAL_TASK_CONTROL,
  MessageType.BOT_LOCAL_TASK_EVENT, MessageType.BOT_LOCAL_MEDIA_SIGNAL,
]);

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
  private connectionId: string = uuidv4();
  private ws: WebSocket | null = null;
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
  private status: ConnectionStatus = 'DISCONNECTED';
  private eventListeners = new Set<(event: string, data: unknown, requestId?: string) => void>();
  private iceServers: RTCIceServer[] = [];
  private reconnectAttempt: number = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private retiredRequests = new Set<string>();
  private pendingAuth: PendingAuthRequest | null = null;
  private pendingConnect: { reject: (reason: Error) => void } | null = null;
  private currentServerUrl: string = '';
  private lastConnectPayload: ConnectState | null = null;
  private manualDisconnect: boolean = false;
  private hasEverConnected: boolean = false;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
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
    this.emitScoped('network.disposed');
    this.eventListeners.clear();
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

  public getConnectionId(): string { return this.connectionId; }

  public getIceServers(): RTCIceServer[] {
    return this.iceServers.map((server) => ({ ...server, urls: Array.isArray(server.urls) ? [...server.urls] : server.urls }));
  }

  public onEvent(listener: (event: string, data: unknown, requestId?: string) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  public cancelRequest(requestId: string): boolean {
    this.retireRequest(requestId);
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(requestId);
    pending.reject(new DOMException('Request cancelled', 'AbortError'));
    return true;
  }

  private retireRequest(requestId: string): void {
    this.retiredRequests.add(requestId);
    if (this.retiredRequests.size > 256) {
      const first = this.retiredRequests.values().next().value;
      if (first !== undefined) this.retiredRequests.delete(first);
    }
  }

  /**
   * Emits on the app bus with this client's server as the origin, so the
   * session manager can point the stores at the right bundle before handlers
   * run (#400).
   */
  private emitScoped(event: string, data?: unknown, requestId?: string): void {
    if (event === 'network.status') this.notifyEventListeners(event, data, requestId);
    routeSessionEvent(this.sessionKey, event, () => appEvents.emit(event, data));
    if (event !== 'network.status') this.notifyEventListeners(event, data, requestId);
  }

  private notifyEventListeners(event: string, data: unknown, requestId?: string): void {
    for (const listener of [...this.eventListeners]) {
      if (this.eventListeners.has(listener)) listener(event, data, requestId);
    }
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
    const connectionId = this.connectionId = uuidv4();
    this.cancelPendingConnect(new DOMException('Connection was replaced', 'AbortError'));
    this.clearReconnect();
    this.stopHeartbeat();
    this.detachSocket(this.ws);
    this.rejectPendingRequests();
    this.manualDisconnect = false;
    if (!isReconnect) {
      this.reconnectAttempt = 0;
      this.hasEverConnected = false;
    }

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
      const attempt = { reject };
      this.pendingConnect = attempt;
      let attemptSocket: WebSocket | null = null;
      const isStale = () => this.connectionId !== connectionId || this.manualDisconnect
        || (attemptSocket !== null && this.ws !== attemptSocket);
      const fail = (error: Error, diagnose = false) => {
        if (isStale() || this.pendingConnect !== attempt) return;
        this.clearConnectionTimeout();
        this.clearPendingAuth();
        this.detachSocket(this.ws);
        this.setStatus(isReconnect ? 'RECONNECTING' : 'DISCONNECTED');
        const finish = (reason: Error) => {
          if (this.pendingConnect === attempt) this.pendingConnect = null;
          reject(reason);
        };
        if (diagnose) void this.diagnoseConnectionFailure(cleanHost, port).then(finish);
        else finish(error);
      };

      // Dialling and authenticating are still part of recovery. A transient
      // failure must not leave a retained server session marked DISCONNECTED.
      this.setStatus(isReconnect ? 'RECONNECTING' : 'CONNECTING');
      if (isStale()) return;

      try {
        this.ws = new WebSocket(this.currentServerUrl);
      } catch (error) {
        fail(new Error(t('network.addressError', {
          url: this.currentServerUrl, error: error instanceof Error ? error.message : String(error),
        })));
        return;
      }

      const socket = attemptSocket = this.ws;
      this.connectionTimeout = setTimeout(() => {
        fail(new Error(t('network.timeout')), !isReconnect);
      }, 12000);

      socket.onopen = () => {
        if (isStale()) return;
        this.clearConnectionTimeout();
        const authRequestId = uuidv4();
        const auth: PendingAuthRequest = {
          requestId: authRequestId,
          timer: setTimeout(() => {
            fail(new Error(t('network.timeout')));
          }, 15000),
          resolve: (res) => {
            if (isStale() || this.pendingAuth !== auth) return;
            this.clearPendingAuth();
            this.iceServers = (res.iceServers ?? []).map((server) => ({ ...server }));
            this.reconnectAttempt = 0;
            this.hasEverConnected = true;
            this.setStatus('CONNECTED');
            if (isStale()) return;
            this.startHeartbeat();
            this.emitScoped('network.connected', res);
            if (isStale()) return;
            this.pendingConnect = null;
            resolve(res);
          },
          reject: (error) => fail(error),
        };
        this.pendingAuth = auth;

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

      socket.onmessage = (event) => {
        if (isStale()) return;
        try {
          const message: ProtocolMessage = JSON.parse(event.data.toString());
          this.handleIncomingMessage(message);
        } catch (error) {
          console.error('Failed to parse incoming WebSocket message', error);
        }
      };

      socket.onclose = () => {
        if (isStale()) return;
        if (this.pendingConnect === attempt) {
          fail(new Error(t('network.genericConnectError')), !isReconnect);
          return;
        }
        this.handleSocketClosed();
      };

      socket.onerror = (err) => {
        console.warn('WebSocket error encountered:', err);
      };
    });
  }

  public disconnect(): void {
    clientLog.info('NETWORK', 'Disconnecting from server');
    // Emitting again after the socket already died would run the whole teardown
    // twice — and, with one client per server (#400), would ask the session
    // manager to drop a session while it is already being dropped.
    const wasLive = !this.manualDisconnect
      && (this.status !== 'DISCONNECTED' || this.lastConnectPayload !== null);
    this.connectionId = uuidv4();
    this.manualDisconnect = true;
    this.clearReconnect();
    this.stopHeartbeat();
    this.cancelPendingConnect(new DOMException('Connection was cancelled', 'AbortError'));
    this.lastConnectPayload = null;
    this.hasEverConnected = false;
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
    if (this.getStatus() !== 'CONNECTED' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      clientLog.warn('NETWORK', `Cannot request ${type}: server is not connected`);
      return Promise.reject(new Error(t('network.connectionClosed')));
    }
    const requestId = customRequestId || uuidv4();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          if (type === MessageType.COMMAND_AUTOCOMPLETE || type === MessageType.COMMAND_AUDIO_PREVIEW) this.retireRequest(requestId);
          reject(new RequestTimeoutError(type));
        }
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      try {
        this.send(type, payload, requestId);
      } catch (error) {
        clearTimeout(timer);
        this.pendingRequests.delete(requestId);
        reject(error);
      }
    });
  }

  private handleIncomingMessage(message: ProtocolMessage): void {
    const { type, requestId, payload } = message;
    const localEvent = LOCAL_EXECUTION_EVENTS.has(type);
    if (requestId && this.retiredRequests.has(requestId) && !localEvent) return;

    if (type === MessageType.PONG) {
      this.lastPongAt = Date.now();
      return;
    }

    if (type === MessageType.SERVER_SHUTDOWN) {
      const reason = (payload as { reason?: string })?.reason;
      this.emitScoped('network.server_shutdown', { reason });
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

    if (requestId && this.pendingRequests.has(requestId) && !localEvent) {
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

    this.emitScoped(`message.${type}`, payload, requestId);
  }

  private async respondToAuthChallenge(payload: AuthChallengePayload, requestId?: string): Promise<void> {
    const auth = this.pendingAuth;
    const connectionId = this.connectionId;
    if (!auth || !requestId || auth.requestId !== requestId) return;
    const isCurrent = () => this.pendingAuth === auth && this.connectionId === connectionId;

    try {
      const signature = await window.api.signChallenge(payload.nonce);
      if (!isCurrent()) return;
      this.send(MessageType.AUTH_CHALLENGE_RESPONSE, { signature }, requestId);
    } catch (error) {
      if (isCurrent()) auth.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleSocketClosed(): void {
    clientLog.warn('NETWORK', 'WebSocket connection closed');
    this.detachSocket(this.ws);
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

    this.clearReconnect();
    const connectionId = this.connectionId;
    this.setStatus('RECONNECTING');
    if (this.manualDisconnect || this.connectionId !== connectionId) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;

    this.emitScoped('network.reconnecting', { attempt: this.reconnectAttempt, delay });
    if (this.manualDisconnect || this.connectionId !== connectionId) return;

    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null;
      void this.doReconnect();
    }, delay);
  }

  private async doReconnect(): Promise<void> {
    if (this.manualDisconnect || !this.lastConnectPayload) return;

    let connectionId = this.connectionId;
    try {
      console.log(`[NetworkClient] Trying to reconnect (attempt ${this.reconnectAttempt})...`);
      clientLog.info('NETWORK', `Reconnection attempt ${this.reconnectAttempt}`);
      const { clientId, publicKey, nickname, password } = this.lastConnectPayload;
      const urlObj = new URL(this.currentServerUrl);
      const host = urlObj.hostname;
      const port = parseInt(urlObj.port, 10);

      const connected = this.connect(host, port, { clientId, publicKey }, nickname, password, true);
      connectionId = this.connectionId;
      await connected;
    } catch (error) {
      // A leave, an online event or a manual connection can supersede this
      // attempt while its handshake is pending. Only its owner may retry.
      if (this.manualDisconnect || this.connectionId !== connectionId) return;
      clientLog.warn('NETWORK', `Reconnection attempt ${this.reconnectAttempt} failed`, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
    }
  }

  private clearReconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private clearPendingAuth(): void {
    if (!this.pendingAuth) return;
    clearTimeout(this.pendingAuth.timer);
    this.pendingAuth = null;
  }

  private cancelPendingConnect(error: Error): void {
    this.clearConnectionTimeout();
    this.clearPendingAuth();
    const pending = this.pendingConnect;
    this.pendingConnect = null;
    pending?.reject(error);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now();
    this.heartbeatInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      if (Date.now() - this.lastPongAt > NetworkClient.HEARTBEAT_TIMEOUT_MS) {
        clientLog.error('NETWORK', 'Heartbeat timeout — connection considered dead, forcing reconnect');
        console.warn('[NetworkClient] Heartbeat timeout, connection considered dead. Forcing reconnect.');
        this.handleSocketClosed();
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
    if (this.status === status) return;
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
