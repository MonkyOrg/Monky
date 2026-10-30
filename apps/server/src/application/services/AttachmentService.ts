import { v4 as uuidv4 } from 'uuid';
import { AttachmentMeta, AttachmentStorageInfo, LIMITS, ProtocolErrorCode } from '@monky/shared';
import { AttachmentRecord } from '../../domain/entities';
import { IAttachmentRepository, IServerRepository } from '../../domain/repositories';
import { AttachmentStorageService } from '../../infrastructure/security/AttachmentStorageService';
import { RateLimiter } from '../../infrastructure/security/RateLimiter';
import { Logger } from '../../infrastructure/logger/Logger';

interface UploadToken {
  userId: string;
  channelId: string;
  expiresAt: number;
}

export interface FinalizeUploadInput {
  tempPath: string;
  sizeBytes: number;
  userId: string;
  channelId: string;
  originalName: string;
}

export interface FinalizeUploadResult {
  success: boolean;
  meta?: AttachmentMeta;
  errorCode?: ProtocolErrorCode;
  errorMessage?: string;
}

// Pending uploads (never attached to a message) are pruned after this long.
const PENDING_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Owns the chat-attachment lifecycle (#11): issuing single-use upload tokens,
 * finalizing streamed uploads (classify → enforce limits → FIFO-evict → persist),
 * linking uploads to their message, reporting storage usage, removing the files
 * of deleted messages and channels, and reconciling orphaned files. The binary
 * never lives in the DB — only metadata does.
 */
export class AttachmentService {
  private tokens: Map<string, UploadToken> = new Map();

  constructor(
    private attachmentRepo: IAttachmentRepository,
    private serverRepo: IServerRepository,
    private storage: AttachmentStorageService,
    private rateLimiter: RateLimiter
  ) {}

  private async resolveLimits(): Promise<{ maxFileBytes: number; maxTotalBytes: number }> {
    const server = await this.serverRepo.getServer();
    return {
      maxFileBytes: server?.maxAttachmentFileBytes ?? LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT,
      maxTotalBytes: server?.maxAttachmentStorageBytes ?? LIMITS.MAX_ATTACHMENT_STORAGE_TOTAL_DEFAULT,
    };
  }

  /** Per-file byte limit, needed by the HTTP route to abort oversized streams. */
  public async getMaxFileBytes(): Promise<number> {
    return (await this.resolveLimits()).maxFileBytes;
  }

  /** Current storage usage + limits, for the server settings UI. */
  public async getStorageInfo(): Promise<AttachmentStorageInfo> {
    const { maxFileBytes, maxTotalBytes } = await this.resolveLimits();
    const usedBytes = await this.attachmentRepo.sumActiveBytes();
    return { usedBytes, maxTotalBytes, maxFileBytes };
  }

  // --- Upload tokens -------------------------------------------------------

  /** Issues a short-lived token authorizing an HTTP upload, or null if rate-limited. */
  public issueUploadToken(userId: string, channelId: string): { token: string; expiresAt: number } | null {
    if (!this.rateLimiter.checkLimit(userId)) return null;
    const token = uuidv4();
    const expiresAt = Date.now() + LIMITS.UPLOAD_TOKEN_TTL_MS;
    this.tokens.set(token, { userId, channelId, expiresAt });
    this.sweepTokens();
    return { token, expiresAt };
  }

  /**
   * Spends a token and returns its binding, or null if invalid/expired. Each
   * token authorizes one upload: the client asks for one per file, and a
   * reusable token allowed unlimited uploads until it expired (S-WS-11).
   */
  public consumeUploadToken(token: string | undefined | null): { userId: string; channelId: string } | null {
    if (!token) return null;
    const entry = this.tokens.get(token);
    if (!entry) return null;
    this.tokens.delete(token);
    if (entry.expiresAt < Date.now()) return null;
    return { userId: entry.userId, channelId: entry.channelId };
  }

  private sweepTokens(): void {
    const now = Date.now();
    for (const [token, entry] of this.tokens) {
      if (entry.expiresAt < now) this.tokens.delete(token);
    }
  }

  /** Invalidates every outstanding upload token issued to a user (e.g. on kick). */
  public revokeTokensForUser(userId: string): void {
    for (const [token, entry] of this.tokens) {
      if (entry.userId === userId) this.tokens.delete(token);
    }
  }

  // --- Upload finalize + eviction -----------------------------------------

  public async finalizeUpload(input: FinalizeUploadInput): Promise<FinalizeUploadResult> {
    const { maxFileBytes, maxTotalBytes } = await this.resolveLimits();

    if (input.sizeBytes <= 0) {
      this.storage.discardTemp(input.tempPath);
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Arquivo vazio' };
    }
    if (input.sizeBytes > maxFileBytes) {
      this.storage.discardTemp(input.tempPath);
      return {
        success: false,
        errorCode: ProtocolErrorCode.ATTACHMENT_TOO_LARGE,
        errorMessage: `Arquivo excede o limite de ${(maxFileBytes / (1024 * 1024)).toFixed(0)}MB`,
      };
    }
    if (input.sizeBytes > maxTotalBytes) {
      this.storage.discardTemp(input.tempPath);
      return {
        success: false,
        errorCode: ProtocolErrorCode.STORAGE_FULL,
        errorMessage: 'Arquivo maior que o armazenamento total do servidor',
      };
    }

    const classification = this.storage.classifyFile(input.tempPath, input.originalName);

    // Make room FIFO before storing the new file.
    if (!(await this.evictToFit(input.sizeBytes, maxTotalBytes))) {
      this.storage.discardTemp(input.tempPath);
      return { success: false, errorCode: ProtocolErrorCode.STORAGE_FULL,
        errorMessage: 'Armazenamento reservado para mensagens que ainda podem ser restauradas. Tente novamente após o prazo.' };
    }

    let filename: string;
    try {
      filename = this.storage.finalizeFromTemp(input.tempPath, classification.extension);
    } catch (err) {
      this.storage.discardTemp(input.tempPath);
      Logger.warn('ATTACHMENT', `Failed to store upload: ${(err as Error).message}`);
      return { success: false, errorCode: ProtocolErrorCode.INTERNAL_ERROR, errorMessage: 'Falha ao salvar arquivo' };
    }

    const record: AttachmentRecord = {
      id: uuidv4(),
      messageId: null,
      channelId: input.channelId,
      userId: input.userId,
      kind: classification.kind,
      filename,
      originalName: input.originalName.slice(0, 255) || filename,
      mimeType: classification.mimeType,
      sizeBytes: input.sizeBytes,
      width: null,
      height: null,
      durationMs: null,
      evicted: false,
      createdAt: Date.now(),
    };
    await this.attachmentRepo.create(record);

    return { success: true, meta: this.toMeta(record) };
  }

  /**
   * Evicts oldest attachments (deleting their disk file, tombstoning the row) until
   * the incoming file fits under the low-watermark, reducing per-upload churn. The
   * hard limit is always satisfied; the watermark is best-effort.
   */
  private async evictToFit(incomingBytes: number, maxTotalBytes: number): Promise<boolean> {
    let used = await this.attachmentRepo.sumActiveBytes();
    if (used + incomingBytes <= maxTotalBytes) return true;

    const target = Math.max(0, Math.floor(maxTotalBytes * LIMITS.ATTACHMENT_EVICTION_LOW_WATERMARK) - incomingBytes);

    while (used > target) {
      const batch = await this.attachmentRepo.listOldestActive(100);
      if (batch.length === 0) break;
      for (const att of batch) {
        this.storage.delete(att.filename);
        await this.attachmentRepo.markEvicted(att.id);
        used -= att.sizeBytes;
        Logger.info('ATTACHMENT', `Evicted attachment ${att.id} (${att.sizeBytes} bytes) to reclaim space`);
        if (used <= target) break;
      }
    }
    return used + incomingBytes <= maxTotalBytes;
  }

  // --- Linking + reads -----------------------------------------------------

  /**
   * Links previously-uploaded attachments to a freshly created message, keeping the
   * client's order and dropping any that are not owned/pending/valid.
   */
  public async linkToMessage(
    attachmentIds: string[],
    messageId: string,
    userId: string,
    channelId: string
  ): Promise<AttachmentMeta[]> {
    if (!attachmentIds || attachmentIds.length === 0) return [];
    const capped = attachmentIds.slice(0, LIMITS.MAX_ATTACHMENTS_PER_MESSAGE);
    const records = await this.attachmentRepo.findByIds(capped);
    const byId = new Map(records.map((r) => [r.id, r]));

    const valid: AttachmentRecord[] = [];
    for (const id of capped) {
      const r = byId.get(id);
      if (!r) continue;
      if (r.userId !== userId || r.channelId !== channelId) continue;
      if (r.messageId != null || r.evicted) continue;
      valid.push(r);
    }
    if (valid.length === 0) return [];

    await this.attachmentRepo.linkToMessage(valid.map((r) => r.id), messageId);
    return valid.map((r) => this.toMeta({ ...r, messageId }));
  }

  /**
   * Pending uploads of `userId` for `channelId`, in the requested order, or
   * null when any of them is unknown, foreign, already linked or evicted.
   */
  public async getPending(attachmentIds: string[], userId: string, channelId: string): Promise<AttachmentMeta[] | null> {
    const byId = new Map((await this.attachmentRepo.findByIds(attachmentIds)).map((r) => [r.id, r]));
    const pending: AttachmentMeta[] = [];
    for (const id of attachmentIds) {
      const r = byId.get(id);
      if (!r || r.userId !== userId || r.channelId !== channelId || r.messageId != null || r.evicted) return null;
      pending.push(this.toMeta(r));
    }
    return pending;
  }

  /** Attachments grouped by message id, for history hydration. */
  public async getForMessages(messageIds: string[]): Promise<Map<string, AttachmentMeta[]>> {
    const map = new Map<string, AttachmentMeta[]>();
    if (messageIds.length === 0) return map;
    const records = await this.attachmentRepo.listByMessageIds(messageIds);
    for (const r of records) {
      if (!r.messageId) continue;
      const list = map.get(r.messageId) ?? [];
      list.push(this.toMeta(r));
      map.set(r.messageId, list);
    }
    return map;
  }

  public toMeta(r: AttachmentRecord): AttachmentMeta {
    return {
      id: r.id,
      messageId: r.messageId ?? '',
      kind: r.kind,
      url: r.evicted ? null : this.storage.getPublicUrl(r.filename),
      originalName: r.originalName,
      mimeType: r.mimeType,
      sizeBytes: r.sizeBytes,
      width: r.width ?? null,
      height: r.height ?? null,
      durationMs: r.durationMs ?? null,
      evicted: Boolean(r.evicted),
      createdAt: r.createdAt,
    };
  }

  // --- Removal -------------------------------------------------------------

  /**
   * Removes the files of messages whose deletion can no longer be undone.
   * Within the undo window nothing changes, so a restored message gets its
   * files back; past it, a file left on disk stayed reachable by its URL and
   * kept counting against the storage budget (S-APP-6).
   */
  public async purgeForMessages(messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    await this.remove(await this.attachmentRepo.listByMessageIds(messageIds));
  }

  /**
   * Lists what a channel about to be deleted holds — the topics of a forum
   * included — and returns the step that removes it once the deletion went
   * through. Listed first because a database cascade may take the rows along
   * with the channel. The step never throws: the channel is gone by then, and
   * the next reconciliation collects whatever it could not remove (S-APP-6).
   */
  public async prepareChannelDeletion(channelId: string): Promise<() => Promise<void>> {
    const records = await this.attachmentRepo.listByChannelWithTopics(channelId);
    return async () => {
      try {
        await this.remove(records);
      } catch (error) {
        Logger.error('ATTACHMENT', 'Could not remove the files of a deleted channel; the next start removes them.', error);
      }
    };
  }

  /** Rows first: a file that a failure leaves behind is then collected by the next reconciliation. */
  private async remove(records: AttachmentRecord[]): Promise<void> {
    for (const record of records) {
      await this.attachmentRepo.deleteById(record.id);
      this.storage.delete(record.filename);
    }
  }

  // --- Reconciliation ------------------------------------------------------

  /**
   * Startup housekeeping: hard-delete stale pending uploads (never sent), the
   * attachments nothing can show anymore — from deletions made before their
   * files were removed explicitly — and on-disk files no longer referenced by
   * any live row.
   */
  public async reconcile(): Promise<void> {
    try {
      const stale = await this.attachmentRepo.listPendingBefore(Date.now() - PENDING_TTL_MS);
      await this.remove(stale);
      const unreachable = await this.attachmentRepo.listUnreachable(Date.now());
      await this.remove(unreachable);

      // The disk is listed first: an upload stores its file and its row in one
      // synchronous step, so a file that lands afterwards is never taken for an orphan.
      const onDisk = this.storage.listDiskFilenames();
      const active = new Set(await this.attachmentRepo.listActiveFilenames());
      for (const file of onDisk) {
        if (!active.has(file)) this.storage.delete(file);
      }
      if (stale.length > 0) {
        Logger.info('ATTACHMENT', `Reconciliation removed ${stale.length} stale pending upload(s)`);
      }
      if (unreachable.length > 0) {
        Logger.info('ATTACHMENT', `Reconciliation removed ${unreachable.length} attachment(s) of deleted messages or channels`);
      }
    } catch (err) {
      Logger.warn('ATTACHMENT', `Reconciliation failed: ${(err as Error).message}`);
    }
  }
}
