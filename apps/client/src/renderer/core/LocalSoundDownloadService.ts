import {
  LIMITS, MessageType, soundDownloadResultSchema, commandSoundDownloadReceivedSchema, soundDownloadFileNameSchema,
  type CommandInvokedPayload, type CommandSoundDownloadReceivedPayload,
  type CommandSoundDownloadCancelPayload, type SlashCommand,
  type SoundDownloadResult, type SoundboardDownloadProgress,
} from '@monky/shared';
import type { ElectronApi } from '../../preload/preload';
import type { ChatStore, BotInvocation } from '../stores/chatStore';
import type { ServerStore } from '../stores/serverStore';
import type { NetworkClient } from './NetworkClient';
import type { SoundDownloadApproval, SoundDownloadConfirmationDetails } from '../utils/soundDownloadConfirmation';

type DownloadApi = Pick<ElectronApi, 'authorizeSoundDownload' | 'downloadSound' | 'cancelSoundDownload' | 'onSoundDownloadProgress'>;
interface AuthorizedInvocation {
  client: NetworkClient;
  store: ChatStore;
  connectionId: string;
  invocation: BotInvocation;
  invokerId: string;
  confirmation: Omit<SoundDownloadConfirmationDetails, 'request'>;
  controller: AbortController;
  token?: string;
  permitFailure?: SoundDownloadResult;
  request?: CommandSoundDownloadReceivedPayload;
  started: boolean;
  transferring: boolean;
  closed: boolean;
  timer: ReturnType<typeof setTimeout>;
  unbindFinish: () => void;
}

/** Only the gesture/ACK path creates entries. Incoming bot events never authorize I/O. */
export class LocalSoundDownloadService {
  private authorized = new Map<string, AuthorizedInvocation>();
  private unbindProgress: (() => void) | null = null;

  constructor(
    private api: () => DownloadApi | undefined = () => typeof window === 'undefined' ? undefined : window.api,
    private reloadSounds: () => Promise<unknown> = async () => (await import('./SoundboardService')).soundboardService.loadSounds(),
    private confirmDownload: (details: SoundDownloadConfirmationDetails, signal: AbortSignal) => Promise<SoundDownloadApproval | null> =
      async (details, signal) => (await import('../utils/soundDownloadConfirmation')).confirmSoundDownload(details, signal)
  ) {}

  private key(connectionId: string, invocationId: string): string { return `${connectionId}:${invocationId}`; }
  private current(entry: AuthorizedInvocation): boolean {
    return !entry.closed && this.authorized.get(this.key(entry.connectionId, entry.invocation.invocationId)) === entry &&
      entry.client.getConnectionId() === entry.connectionId && entry.client.getStatus() === 'CONNECTED' &&
      entry.store.getInvocation(entry.invocation.invocationId) === entry.invocation &&
      entry.invocation.status === 'active' && !entry.invocation.cancelPending;
  }

  public authorize(
    client: NetworkClient, store: ChatStore, server: ServerStore, command: SlashCommand,
    ack: CommandInvokedPayload, connectionId: string, configuredFolder: string, userGesture: boolean
  ): void {
    const api = this.api();
    const invocation = store.getInvocation(ack.invocationId);
    if (!userGesture || !command.downloadsSound || !api?.authorizeSoundDownload || !api.onSoundDownloadProgress ||
        !invocation || invocation.status !== 'active' || !server.currentUser ||
        ack.botId !== command.botId || ack.commandName !== command.name ||
        invocation.botId !== command.botId || invocation.channelId !== ack.channelId ||
        client.getConnectionId() !== connectionId || client.getStatus() !== 'CONNECTED') return;
    const key = this.key(connectionId, ack.invocationId);
    if (this.authorized.has(key)) return;
    const expiresAt = invocation.expiresAt;
    const entry: AuthorizedInvocation = {
      client, store, connectionId, invocation, invokerId: server.currentUser.id, started: false, transferring: false, closed: false,
      controller: new AbortController(),
      confirmation: {
        serverUrl: client.getCurrentServerUrl(), serverId: server.serverDetails?.id ?? '',
        serverName: server.serverDetails?.name ?? '', invokerId: server.currentUser.id,
        botId: command.botId, botName: command.botName, folder: configuredFolder,
      },
      timer: setTimeout(() => this.end(entry, { status: 'failed', reason: 'timeout' }), Math.max(1, expiresAt - Date.now())),
      unbindFinish: () => {},
    };
    entry.unbindFinish = store.onInvocationFinished((finished) => {
      if (finished === invocation) this.end(entry, { status: 'cancelled' });
    });
    this.authorized.set(key, entry);
    this.unbindProgress ??= api.onSoundDownloadProgress((progress) => this.progress(progress));
    void api.authorizeSoundDownload({ connectionId, invocationId: ack.invocationId, configuredFolder, expiresAt }).then((permit) => {
      if (!this.current(entry)) {
        void api.cancelSoundDownload({ connectionId, invocationId: ack.invocationId }).catch((error: unknown) => {
          console.warn('[Soundboard] Could not revoke a stale authorization:', error);
        });
        return;
      }
      if (permit.status === 'authorized') entry.token = permit.token;
      else entry.permitFailure = { status: 'failed', reason: permit.reason };
      this.start(entry);
    }, () => {
      if (this.current(entry)) {
        entry.permitFailure = { status: 'failed', reason: 'write_failed' };
        this.start(entry);
      }
    });
  }

  public receive(client: NetworkClient, payload: CommandSoundDownloadReceivedPayload): void {
    const parsed = commandSoundDownloadReceivedSchema.safeParse(payload);
    if (!parsed.success) return;
    payload = parsed.data;
    const entry = this.authorized.get(this.key(client.getConnectionId(), payload.invocationId));
    if (!entry || entry.client !== client || !this.current(entry) || entry.request ||
        payload.botId !== entry.invocation.botId || payload.channelId !== entry.invocation.channelId ||
        payload.commandName !== entry.invocation.commandName || payload.invokerId !== entry.invokerId ||
        typeof payload.downloadId !== 'string' || !payload.downloadId || payload.downloadId.length > 128 ||
        typeof payload.title !== 'string' || typeof payload.fileName !== 'string' || typeof payload.url !== 'string' ||
        !Number.isFinite(payload.expiresAt)) return;
    entry.request = payload;
    entry.store.updateSoundDownload(payload.invocationId, {
      downloadId: payload.downloadId, title: payload.title, fileName: payload.fileName, receivedBytes: 0, phase: 'confirming',
    });
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.end(entry, { status: 'failed', reason: 'timeout' }),
      Math.max(1, Math.min(payload.expiresAt, entry.invocation.expiresAt, Date.now() + LIMITS.BOT_SOUND_DOWNLOAD_TIMEOUT_MS) - Date.now()));
    this.start(entry);
  }

  private start(entry: AuthorizedInvocation): void {
    if (!this.current(entry) || entry.started || !entry.request || (!entry.token && !entry.permitFailure)) return;
    entry.started = true;
    if (entry.permitFailure) { this.end(entry, entry.permitFailure); return; }
    const api = this.api();
    if (!api?.downloadSound || !entry.token) { this.end(entry, { status: 'failed', reason: 'invalid_request' }); return; }
    const request = entry.request;
    void Promise.resolve().then(() => this.current(entry)
      ? this.confirmDownload({ ...entry.confirmation, request }, entry.controller.signal) : null).then((approval) => {
      if (!this.current(entry)) return;
      if (!approval) { this.end(entry, { status: 'cancelled' }); return; }
      const extension = request.fileName.slice(request.fileName.lastIndexOf('.')).toLowerCase();
      if (!soundDownloadFileNameSchema.safeParse(approval.fileName).success || !approval.fileName.toLowerCase().endsWith(extension)) {
        this.end(entry, { status: 'failed', reason: 'invalid_file_name' });
        return;
      }
      this.transfer(entry, approval.fileName);
    }, (error: unknown) => {
      console.warn('[Soundboard] Could not confirm the local download:', error);
      if (this.current(entry)) this.end(entry, { status: 'failed', reason: 'write_failed' });
    });
  }

  private transfer(entry: AuthorizedInvocation, fileName: string): void {
    const api = this.api();
    const request = entry.request;
    if (!this.current(entry) || entry.transferring || !request || !entry.token || !api?.downloadSound) return;
    entry.transferring = true;
    const state = entry.invocation.soundDownload;
    if (state) entry.store.updateSoundDownload(request.invocationId, { ...state, fileName, phase: 'downloading' });
    void api.downloadSound({
      connectionId: entry.connectionId, invocationId: request.invocationId, downloadId: request.downloadId,
      token: entry.token, url: request.url, fileName, title: request.title, expiresAt: request.expiresAt,
    }).then((result) => {
      const parsed = soundDownloadResultSchema.safeParse(result);
      if (parsed.success) entry.store.completeSoundDownload(entry.invocation, request.downloadId, parsed.data);
      if (parsed.success && parsed.data.status === 'downloaded') {
        void this.reloadSounds().catch((error: unknown) => console.warn('[Soundboard] Could not reload the sound library:', error));
      }
      if (!this.current(entry)) return;
      this.end(entry, parsed.success ? parsed.data : { status: 'failed', reason: 'invalid_request' });
    }, () => { if (this.current(entry)) this.end(entry, { status: 'failed', reason: 'write_failed' }); });
  }

  private progress(progress: SoundboardDownloadProgress): void {
    const entry = this.authorized.get(this.key(progress.connectionId, progress.invocationId));
    const state = entry?.invocation.soundDownload;
    if (!entry || !this.current(entry) || !entry.transferring || !state || state.result ||
        state.downloadId !== progress.downloadId || !Number.isSafeInteger(progress.receivedBytes) ||
        progress.receivedBytes < state.receivedBytes || progress.receivedBytes > LIMITS.MAX_SOUNDBOARD_FILE_SIZE ||
        (progress.totalBytes !== undefined && (!Number.isSafeInteger(progress.totalBytes) ||
          progress.totalBytes < progress.receivedBytes || progress.totalBytes > LIMITS.MAX_SOUNDBOARD_FILE_SIZE))) return;
    entry.store.updateSoundDownload(progress.invocationId, {
      ...state, receivedBytes: progress.receivedBytes, totalBytes: progress.totalBytes,
    });
  }

  private end(entry: AuthorizedInvocation, result: SoundDownloadResult): void {
    if (entry.closed) return;
    const respond = this.current(entry) && !!entry.request;
    entry.closed = true;
    entry.controller.abort();
    clearTimeout(entry.timer);
    entry.unbindFinish();
    this.authorized.delete(this.key(entry.connectionId, entry.invocation.invocationId));
    const state = entry.invocation.soundDownload;
    if (state && !state.result) entry.store.updateSoundDownload(entry.invocation.invocationId, {
      ...state, result, resultOrigin: 'client',
    });
    const api = this.api();
    if (api?.cancelSoundDownload) {
      void api.cancelSoundDownload({ connectionId: entry.connectionId, invocationId: entry.invocation.invocationId })
        .catch((error: unknown) => console.warn('[Soundboard] Could not cancel local I/O:', error));
    }
    if (respond && entry.request) {
      try {
        entry.client.send(MessageType.COMMAND_SOUND_DOWNLOAD_RESULT, {
          invocationId: entry.invocation.invocationId, downloadId: entry.request.downloadId, result,
        });
      } catch (error) { console.warn('[Soundboard] Could not report the local result:', error); }
    }
    if (this.authorized.size === 0) { this.unbindProgress?.(); this.unbindProgress = null; }
  }

  public cancelInvocation(client: NetworkClient, invocationId: string): void {
    const entry = this.authorized.get(this.key(client.getConnectionId(), invocationId));
    if (entry?.client === client) this.end(entry, { status: 'cancelled' });
  }

  public cancelRequest(client: NetworkClient, payload: CommandSoundDownloadCancelPayload): void {
    const entry = this.authorized.get(this.key(client.getConnectionId(), payload.invocationId));
    if (entry?.client === client && entry.request?.downloadId === payload.downloadId) {
      this.end(entry, Date.now() >= entry.request.expiresAt
        ? { status: 'failed', reason: 'timeout' } : { status: 'cancelled' });
    }
  }

  public disconnect(client: NetworkClient): void {
    for (const entry of this.authorized.values()) if (entry.client === client) this.end(entry, { status: 'cancelled' });
  }
}

export const localSoundDownloads = new LocalSoundDownloadService();
