import fs from 'node:fs/promises';
import path from 'node:path';
import { DM_MAX_FILE_BYTES_LIMIT, type DmAttachmentState, type DmDispatch, type DmRelayItem } from '@monky/shared';
import type { DmLedger } from './dmLedger';
import { DmError, SELF_REPEAT_WINDOW_MS, type DownloadState, type PeerRecord, type StoredAttachment, type StoredMessage } from './dmModel';
import type { DmOutbox } from './dmOutbox';
import { isDmId } from './dmWire';

export const DM_FILE_CHUNK_BYTES = 96 * 1024;
const FILE_WINDOW_CHUNKS = 6;
/**
 * A friend that sent no chunk of any of their files for this long is asked
 * again from where each download stopped: the relay may have dropped a window.
 * Counted per friend, so files that wait their turn behind another one of the
 * same friend are not asked twice.
 */
export const DM_DOWNLOAD_STALL_MS = 5_000;
/** Quiet rounds asked again right away; after them, only the regular outbox rounds ask. */
const MAX_STALL_RETRIES = 3;
/**
 * Request rounds of a download answered only with "not here" (no chunk, no
 * "wait") before it ends as unavailable. Only the device that sent a file
 * keeps it, while each request reaches every device of the friend on every
 * server they share: one device without it says nothing about the others.
 * With the quick retries these rounds are {@link DM_DOWNLOAD_STALL_MS} apart.
 */
const MAX_ABSENT_ROUNDS = 3;
/** Download progress reaches the screen at most this often (or every 1%)... */
const PROGRESS_EVENT_MS = 250;
/** ...and the conversation file at most this often: the part file is what holds the bytes. */
const PROGRESS_SAVE_MS = 5_000;
const FILE_CACHE_TTL_MS = 60_000;
/**
 * A file a friend did not ask for in this long stops counting as being sent,
 * and its memory may go to another file. Longer than the gap between two
 * windows of one download, even with several downloads sharing a connection
 * or a window lost on the way (the friend asks again after
 * {@link DM_DOWNLOAD_STALL_MS}). It also caps how often a file can be
 * decrypted whole again: at most once per this long.
 */
export const DM_FILE_TRANSFER_IDLE_MS = 20_000;
/**
 * Decrypted files being sent at once never take more than this: one of the
 * largest allowed, plus room for small ones. A file that does not fit next to
 * those in transfer waits its turn.
 */
const FILE_CACHE_MAX_BYTES = DM_MAX_FILE_BYTES_LIMIT + 32 * 1024 * 1024;
/** File requests remembered at most, so copies of one request on other servers are answered once. */
const MAX_REMEMBERED_REQUESTS = 512;

/** What this run knows about a download beyond its saved state. */
interface LiveDownload {
  /** Chunks in the part file: checked against the disk once per run, then counted as they are appended. */
  chunks: number;
  savedAt: number;
  shownAt: number;
  shownBytes: number;
  /** A device of the friend said the file is not there since the last request, and none sent a chunk or "wait". */
  absent: boolean;
  /** Requests in a row whose round got only that answer (see {@link MAX_ABSENT_ROUNDS}). */
  absentRounds: number;
}

/**
 * The files of direct messages (#743). The friend who sent a file is asked
 * for it in windows of encrypted chunks, and serves it from memory while the
 * transfer lasts. Only the device that sent a file has it, so a download asks
 * every device of the friend, is asked again within seconds when the friend
 * goes quiet, and only gives up after rounds with nothing but "not here".
 */
export class DmFiles {
  private readonly fileCache = new Map<string, { data: Buffer; expiresAt: number; activeUntil: number }>();
  private fileCacheTimer: NodeJS.Timeout | null = null;
  private readonly liveDownloads = new Map<string, LiveDownload>();
  /** Per friend with downloads: asks again when they go quiet (see {@link DM_DOWNLOAD_STALL_MS}). */
  private readonly stallTimers = new Map<string, { timer: NodeJS.Timeout | null; retries: number }>();
  /** File requests answered lately, by envelope id, oldest first (see {@link repeatedRequest}). */
  private readonly answeredRequests = new Map<string, number>();

  constructor(
    private readonly ledger: DmLedger,
    private readonly outbox: DmOutbox,
    /** Memory for the decrypted files being sent; the default suits the largest file allowed. */
    private readonly fileCacheMaxBytes = FILE_CACHE_MAX_BYTES,
  ) {}

  // ---------------------------------------------------------------------------
  // Sending
  // ---------------------------------------------------------------------------

  /**
   * Answers a file request. The friend sends it on every server this identity
   * shares with them: a device on several of them answers one copy.
   */
  answerRequest(record: PeerRecord, id: string, data: Record<string, unknown>): DmDispatch {
    if (this.repeatedRequest(id)) return {};
    return { reply: this.serveFile(record, data) };
  }

  /**
   * The decrypted file a friend is downloading, kept while they ask for its
   * chunks: one decryption per transfer instead of one per window. Every file
   * is sealed whole on disk, so a file pushed out while its transfer goes on
   * has to be decrypted whole again for its next window; with two downloads
   * taking turns, that meant every window of both.
   *
   * So a file in transfer is never dropped to make room for another (see
   * {@link DM_FILE_TRANSFER_IDLE_MS}), and the memory these files take never
   * passes `fileCacheMaxBytes` (one of the largest files allowed, plus room
   * for small ones): a file that does not fit next to the ones being sent
   * waits its turn ('busy': the friend is told to wait and asks again). Files
   * no longer in transfer give their room up, least recently used first, and
   * leave by timer after {@link FILE_CACHE_TTL_MS}. Returns null when the file
   * is not on this device.
   */
  private servedFile(fileId: string, size: number): Buffer | 'busy' | null {
    const now = this.ledger.now();
    const cached = this.fileCache.get(fileId);
    if (cached) {
      cached.expiresAt = now + FILE_CACHE_TTL_MS;
      cached.activeUntil = now + DM_FILE_TRANSFER_IDLE_MS;
      this.fileCache.delete(fileId);
      this.fileCache.set(fileId, cached);
      return cached.data;
    }
    // Checked first: a device without the file must say so, not that it is busy.
    if (!this.ledger.store.hasAttachment(fileId)) return null;
    let held = 0;
    let inTransfer = 0;
    for (const entry of this.fileCache.values()) {
      held += entry.data.length;
      if (entry.activeUntil > now) inTransfer += entry.data.length;
    }
    if (inTransfer > 0 && inTransfer + size > this.fileCacheMaxBytes) return 'busy';
    for (const [key, entry] of this.fileCache) {
      if (held + size <= this.fileCacheMaxBytes) break;
      if (entry.activeUntil > now) continue;
      this.fileCache.delete(key);
      held -= entry.data.length;
    }
    const data = this.ledger.store.readAttachment(fileId);
    if (!data) return null;
    this.fileCache.set(fileId, { data, expiresAt: now + FILE_CACHE_TTL_MS, activeUntil: now + DM_FILE_TRANSFER_IDLE_MS });
    this.scheduleFileCacheSweep();
    return data;
  }

  private scheduleFileCacheSweep(): void {
    if (this.fileCacheTimer) return;
    this.fileCacheTimer = setTimeout(() => {
      this.fileCacheTimer = null;
      const now = this.ledger.now();
      for (const [key, entry] of this.fileCache) {
        if (entry.expiresAt <= now) this.fileCache.delete(key);
      }
      if (this.fileCache.size > 0) this.scheduleFileCacheSweep();
    }, FILE_CACHE_TTL_MS);
    this.fileCacheTimer.unref?.();
  }

  private dropFileCache(): void {
    if (this.fileCacheTimer) clearTimeout(this.fileCacheTimer);
    this.fileCacheTimer = null;
    this.fileCache.clear();
  }

  /**
   * Whether this file request was already answered: the friend sends each
   * request on every server it shares with this identity (see
   * `DmDispatch.everywhere`), so a device on several of them gets the same
   * sealed request once per server, and serving each copy would send the same
   * window of the file again.
   */
  private repeatedRequest(id: string): boolean {
    const now = this.ledger.now();
    for (const [seen, at] of this.answeredRequests) {
      if (now - at < SELF_REPEAT_WINDOW_MS && this.answeredRequests.size < MAX_REMEMBERED_REQUESTS) break;
      this.answeredRequests.delete(seen);
    }
    if (this.answeredRequests.has(id)) return true;
    this.answeredRequests.set(id, now);
    return false;
  }

  private serveFile(record: PeerRecord, data: Record<string, unknown>): DmRelayItem[] {
    const fileId = data.fileId;
    const offset = data.offset;
    if (!isDmId(fileId) || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) return [];
    let owned: StoredAttachment | undefined;
    for (const message of this.ledger.conversation(record.publicKey).messages) {
      if (message.author !== this.ledger.me || message.deleted) continue;
      owned = message.attachments.find((file) => file.fileId === fileId);
      if (owned) break;
    }
    const content = owned ? this.servedFile(fileId, owned.size) : null;
    if (content === 'busy') return [this.outbox.envelopeItem(record, 'file-wait', { fileId })];
    if (!content) {
      // Every device of this identity on the server gets the request, and only the one that sent a file ever has
      // it: another device without it just says so, which does not end a download the sender is serving. Only the
      // device that sent the file and lost it knows it is gone for good. Versions before #490 read any
      // "file-missing" as final and ignore "file-absent" and "file-wait".
      return [owned?.state === 'local'
        ? this.outbox.envelopeItem(record, 'file-missing', { fileId, final: true })
        : this.outbox.envelopeItem(record, 'file-absent', { fileId })];
    }
    const count = Math.max(1, Math.min(FILE_WINDOW_CHUNKS, typeof data.count === 'number' ? Math.floor(data.count) : 1));
    const items: DmRelayItem[] = [];
    for (let index = 0; index < count; index += 1) {
      const start = offset + index * DM_FILE_CHUNK_BYTES;
      if (start >= content.length && !(content.length === 0 && start === 0)) break;
      const chunk = content.subarray(start, Math.min(content.length, start + DM_FILE_CHUNK_BYTES));
      items.push(
        this.outbox.envelopeItem(record, 'file-chunk', { fileId, offset: start, data: chunk.toString('base64') }, 'file')
      );
      if (content.length === 0) break;
    }
    // The last window went out: the room is free for the next file. A lost window asked again still finds it here.
    const entry = this.fileCache.get(fileId);
    if (entry && offset + count * DM_FILE_CHUNK_BYTES >= content.length) entry.activeUntil = 0;
    return items;
  }

  // ---------------------------------------------------------------------------
  // Downloading
  // ---------------------------------------------------------------------------

  /** Asks the friend for a file of the message that just arrived from them. */
  startDownload(peer: string, messageId: string, file: StoredAttachment, now: number): DmRelayItem | null {
    const download = this.beginDownload({
      peer,
      messageId,
      fileId: file.fileId,
      size: file.size,
      sha256: file.sha256,
      requestedUntil: 0,
      lastActivityAt: now,
    });
    return this.requestFile(download, false);
  }

  /** A device of the friend just came: it may hold files the others said they do not have, so it gets asked first. */
  peerAppeared(peer: string): void {
    for (const download of Object.values(this.ledger.state.downloads)) {
      const live = download.peer === peer ? this.liveDownloads.get(download.fileId) : undefined;
      if (live) live.absentRounds = 0;
    }
  }

  /**
   * A device of the friend does not have the file. Only the device that sent
   * it can tell it is gone for good (`final`, see {@link serveFile}); any
   * other device of the friend just does not have it.
   */
  receiveAbsent(record: PeerRecord, data: Record<string, unknown>, final: boolean): void {
    const download = this.downloadFrom(record, data);
    if (!download) return;
    if (final) this.finishDownload(download.fileId, 'unavailable');
    else this.live(download).absent = true;
  }

  /** The device that sent it has it and sends it once the files ahead of it are through: keep asking, quickly. */
  receiveWait(record: PeerRecord, data: Record<string, unknown>): void {
    const download = this.downloadFrom(record, data);
    if (!download) return;
    this.fileHeld(this.live(download));
    this.armStall(record.publicKey, true);
  }

  /** The download an answer of `record` is about, if this device is downloading that file from them. */
  private downloadFrom(record: PeerRecord, data: Record<string, unknown>): DownloadState | undefined {
    const fileId = data.fileId;
    const download = isDmId(fileId) ? this.ledger.state.downloads[fileId] : undefined;
    return download && download.peer === record.publicKey ? download : undefined;
  }

  /**
   * Requests for a friend's files, from where each download stopped: every
   * one when forced, otherwise those never asked for and, once the friend went
   * quiet, the rest. A friend still sending one of their files is busy, not
   * stalled, and asking again would only bring the same chunks twice.
   */
  requests(peer: string, now: number, force: boolean): DmRelayItem[] {
    const downloads = Object.values(this.ledger.state.downloads).filter((download) => download.peer === peer);
    const quiet = downloads.every((download) => now - download.lastActivityAt >= DM_DOWNLOAD_STALL_MS);
    const items: DmRelayItem[] = [];
    for (const download of downloads) {
      if (!force && !quiet && download.lastActivityAt > 0) continue;
      if (this.nobodyHas(download)) {
        this.finishDownload(download.fileId, 'unavailable');
        continue;
      }
      const request = this.requestFile(download, true);
      if (request) items.push(request);
    }
    return items;
  }

  /**
   * Checked before asking for a file again: whether the friend's devices only
   * said they do not have it, round after round, with no chunk and no "wait"
   * from any of them ({@link MAX_ABSENT_ROUNDS}). A round without any answer
   * (the friend away) does not count: the file is only late.
   */
  private nobodyHas(download: DownloadState): boolean {
    const live = this.liveDownloads.get(download.fileId);
    if (!live?.absent) return false;
    live.absent = false;
    live.absentRounds += 1;
    return live.absentRounds >= MAX_ABSENT_ROUNDS;
  }

  /** A device of the friend has the file (it sent a chunk or "wait"): "not here" from the others settles nothing. */
  private fileHeld(live: LiveDownload): void {
    live.absent = false;
    live.absentRounds = 0;
  }

  /** A chunk of a file being downloaded: appended to the part file, and the next window asked for. */
  receiveChunk(record: PeerRecord, data: Record<string, unknown>): DmRelayItem[] {
    const download = this.downloadFrom(record, data);
    if (!download) return [];
    const fileId = download.fileId;
    const live = this.live(download);
    // Whatever its offset (another device of this identity may be further along), a chunk shows the file is there.
    this.fileHeld(live);
    const received = Math.min(download.size, live.chunks * DM_FILE_CHUNK_BYTES);
    if (data.offset !== received || typeof data.data !== 'string') return [];
    const chunk = Buffer.from(data.data, 'base64');
    if (chunk.length !== Math.min(DM_FILE_CHUNK_BYTES, download.size - received)) return [];
    try {
      this.ledger.store.appendPart(fileId, live.chunks, chunk);
    } catch (error) {
      this.downloadFailed(fileId, error);
      return [];
    }
    live.chunks += 1;
    download.lastActivityAt = this.ledger.now();
    this.armStall(download.peer, true);
    const total = received + chunk.length;
    if (total >= download.size) {
      this.completeDownload(download);
      return [];
    }
    this.showProgress(download, live, total);
    const next = this.requestFile(download, false);
    return next ? [next] : [];
  }

  private nextFileRequest(download: DownloadState, resume: boolean): DmRelayItem | null {
    const received = this.receivedBytes(download);
    if (received >= download.size) {
      // Every byte is here but was never put together (the app closed, or the disk was full at that moment).
      this.completeDownload(download);
      return null;
    }
    const record = this.ledger.state.peers[download.peer];
    if (!record || record.relation !== 'friend' || !record.cert) return null;
    if (resume) download.requestedUntil = received;
    if (download.requestedUntil > received) return null;
    const count = FILE_WINDOW_CHUNKS;
    download.requestedUntil = Math.min(download.size, received + count * DM_FILE_CHUNK_BYTES);
    // Not saved for each request: after a restart every download is asked for again from its part file.
    download.lastActivityAt = this.ledger.now();
    this.armStall(download.peer, false);
    return this.outbox.envelopeItem(record, 'file-req', { fileId: download.fileId, offset: received, count });
  }

  /** The next file request, never throwing: a part file that cannot be read fails the download visibly. */
  private requestFile(download: DownloadState, resume: boolean): DmRelayItem | null {
    try {
      return this.nextFileRequest(download, resume);
    } catch (error) {
      this.downloadFailed(download.fileId, error);
      return null;
    }
  }

  private live(download: DownloadState): LiveDownload {
    let live = this.liveDownloads.get(download.fileId);
    if (!live) {
      // Checked once per download and run: a crash or a full disk during an append can leave a torn last record.
      // From then on the count follows the appends, instead of reading the whole part file for every chunk.
      live = {
        chunks: this.ledger.store.repairPart(download.fileId), savedAt: 0, shownAt: 0, shownBytes: 0, absent: false, absentRounds: 0,
      };
      this.liveDownloads.set(download.fileId, live);
    }
    return live;
  }

  private receivedBytes(download: DownloadState): number {
    return Math.min(download.size, this.live(download).chunks * DM_FILE_CHUNK_BYTES);
  }

  /** A download that starts from nothing: no part file, nothing to check on disk. */
  private beginDownload(download: DownloadState): DownloadState {
    this.ledger.store.resetPart(download.fileId);
    this.liveDownloads.set(download.fileId, { chunks: 0, savedAt: 0, shownAt: 0, shownBytes: 0, absent: false, absentRounds: 0 });
    this.ledger.state.downloads[download.fileId] = download;
    return download;
  }

  /** Forgets a download that ended or whose message is gone, with the quiet timer of a friend left without any. */
  private forgetDownload(fileId: string): DownloadState | undefined {
    const download = this.ledger.state.downloads[fileId];
    delete this.ledger.state.downloads[fileId];
    this.liveDownloads.delete(fileId);
    if (download && !Object.values(this.ledger.state.downloads).some((other) => other.peer === download.peer)) {
      const stall = this.stallTimers.get(download.peer);
      if (stall?.timer) clearTimeout(stall.timer);
      this.stallTimers.delete(download.peer);
    }
    return download;
  }

  /**
   * Re-arms the quiet timer of a friend whose files are on their way (see
   * {@link DM_DOWNLOAD_STALL_MS}). A chunk or a "wait" from them starts the
   * quick retries over; once those are used up, only the regular outbox
   * rounds ask again.
   */
  private armStall(peer: string, progressed: boolean): void {
    const current = this.stallTimers.get(peer);
    if (current?.timer) clearTimeout(current.timer);
    const retries = progressed ? 0 : current?.retries ?? 0;
    const timer = retries < MAX_STALL_RETRIES ? setTimeout(() => this.onStall(peer), DM_DOWNLOAD_STALL_MS) : null;
    timer?.unref?.();
    this.stallTimers.set(peer, { timer, retries });
  }

  /** Every request, chunk or "wait" re-arms the timer, so firing means the friend went quiet: ask for each file again. */
  private onStall(peer: string): void {
    const stall = this.stallTimers.get(peer);
    if (!stall) return;
    stall.timer = null;
    stall.retries += 1;
    const record = this.ledger.state.peers[peer];
    if (!record || record.blocked || record.relation !== 'friend' || !record.cert) return;
    const items = this.requests(peer, this.ledger.now(), true);
    if (items.length > 0) this.ledger.emit({ type: 'dispatch', dispatch: { everywhere: { [peer]: items } } });
  }

  private attachmentRef(peer: string, messageId: string, fileId: string): { message: StoredMessage; file: StoredAttachment } | null {
    const message = this.ledger.findMessage(peer, messageId);
    const file = message?.attachments.find((entry) => entry.fileId === fileId);
    return message && file ? { message, file } : null;
  }

  /**
   * The progress of a download under way reaches the screen a few times per
   * second through a light event, and the conversation file now and then: a
   * whole conversation rewritten, re-encrypted and redrawn for every 96 KiB
   * chunk made large files slow down everything else.
   */
  private showProgress(download: DownloadState, live: LiveDownload, total: number): void {
    const ref = this.attachmentRef(download.peer, download.messageId, download.fileId);
    if (!ref) return;
    ref.file.receivedBytes = total;
    const now = this.ledger.now();
    if (ref.file.state !== 'downloading') {
      ref.file.state = 'downloading';
      live.savedAt = now;
      live.shownAt = now;
      live.shownBytes = total;
      this.ledger.saveConversation(download.peer);
      this.ledger.emitMessages(download.peer, [ref.message]);
      return;
    }
    if (now - live.savedAt >= PROGRESS_SAVE_MS) {
      live.savedAt = now;
      this.ledger.saveConversation(download.peer);
    }
    if (now - live.shownAt >= PROGRESS_EVENT_MS || total - live.shownBytes >= download.size / 100) {
      live.shownAt = now;
      live.shownBytes = total;
      this.ledger.emit({
        type: 'attachment-progress',
        peer: download.peer,
        messageId: download.messageId,
        fileId: download.fileId,
        receivedBytes: total,
      });
    }
  }

  /** All bytes arrived: keep the file if they match, or fail visibly so the user can try again. */
  private completeDownload(download: DownloadState): void {
    const fileId = download.fileId;
    let matches: boolean;
    try {
      matches = this.ledger.store.completePart(fileId, download.size, download.sha256);
    } catch (error) {
      this.downloadFailed(fileId, error);
      return;
    }
    this.finishDownload(fileId, matches ? 'ready' : 'failed');
  }

  /** A full disk or an unreadable part file: "failed" offers "try again", which starts over. */
  private downloadFailed(fileId: string, error: unknown): void {
    console.error('[DM] Attachment download failed; it can be tried again.', error);
    this.finishDownload(fileId, 'failed');
  }

  private finishDownload(fileId: string, state: DmAttachmentState): void {
    const download = this.forgetDownload(fileId);
    if (!download) return;
    this.ledger.store.resetPart(fileId);
    const ref = this.attachmentRef(download.peer, download.messageId, fileId);
    if (ref) {
      ref.file.state = state;
      ref.file.receivedBytes = state === 'ready' ? ref.file.size : 0;
      this.ledger.saveConversation(download.peer);
      this.ledger.emitMessages(download.peer, [ref.message]);
    }
    this.ledger.saveState();
  }

  // ---------------------------------------------------------------------------
  // Files on this device
  // ---------------------------------------------------------------------------

  /**
   * Starts a download that failed, or whose file was unavailable or too large,
   * over. Returns whether there is something to ask the friend for now.
   */
  retry(peer: string, messageId: string, fileId: string): boolean {
    const ref = this.attachmentRef(peer, messageId, fileId);
    if (!ref || ref.message.author === this.ledger.me) throw new DmError('not-found', 'Arquivo não encontrado.');
    if (ref.file.state !== 'failed' && ref.file.state !== 'unavailable' && ref.file.state !== 'too-large') return false;
    if (ref.file.size > this.ledger.state.settings.maxFileBytes) {
      ref.file.state = 'too-large';
      this.ledger.emitMessages(peer, [ref.message]);
      return false;
    }
    this.beginDownload({
      peer,
      messageId,
      fileId,
      size: ref.file.size,
      sha256: ref.file.sha256,
      requestedUntil: 0,
      lastActivityAt: 0,
    });
    ref.file.state = 'pending';
    ref.file.receivedBytes = 0;
    this.ledger.changed(peer);
    this.ledger.emitMessages(peer, [ref.message]);
    return true;
  }

  readAttachment(peerKey: string, messageId: string, fileId: string): { name: string; mime: string; data: Buffer } {
    const peer = this.ledger.requirePeerKey(peerKey);
    const ref = this.attachmentRef(peer, messageId, fileId);
    if (!ref || (ref.file.state !== 'ready' && ref.file.state !== 'local')) {
      throw new DmError('not-found', 'Arquivo não disponível.');
    }
    const data = this.ledger.store.readAttachment(fileId);
    if (!data) throw new DmError('not-found', 'Arquivo não disponível.');
    return { name: ref.file.name, mime: ref.file.mime, data };
  }

  /** Decrypts a ready/local attachment into `destination` (absolute path), creating or overwriting it. */
  async writeAttachmentTo(peerKey: string, messageId: string, fileId: string, destination: string): Promise<void> {
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || destination.includes('\0')) {
      throw new Error('Invalid destination for the DM attachment: an absolute file path is required.');
    }
    const file = this.readAttachment(peerKey, messageId, fileId);
    await fs.writeFile(destination, file.data);
  }

  /** The message of this file is gone: so are the file, its memory and its download. */
  forget(fileId: string): void {
    this.ledger.store.deleteAttachment(fileId);
    this.fileCache.delete(fileId);
    this.forgetDownload(fileId);
  }

  /** Stops the timers and drops what is held in memory; used right before the store is deleted. */
  discard(): void {
    this.dropFileCache();
    this.liveDownloads.clear();
    for (const { timer } of this.stallTimers.values()) {
      if (timer) clearTimeout(timer);
    }
    this.stallTimers.clear();
  }
}
