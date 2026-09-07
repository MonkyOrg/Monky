import { randomBytes, createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { LIMITS, ProtocolErrorCode, BotInfo, UserSummary } from '@monky/shared';
import { BotRecord } from '../../domain/entities';
import { IBotRepository, IServerRepository } from '../../domain/repositories';
import { AvatarStorageService } from '../../infrastructure/security/AvatarStorageService';
import { Logger } from '../../infrastructure/logger/Logger';

/**
 * Manages bot lifecycle: creation, token validation, TOFU binding and revocation (#569).
 *
 * Tokens are stored as SHA-256 hex hashes. This avoids the overhead of bcrypt
 * for a 256-bit random token that is already immune to dictionary attacks, while
 * keeping the on-disk token safe from casual disclosure.
 */
export class BotService {
  constructor(
    private botRepo: IBotRepository,
    private serverRepo: IServerRepository,
    private avatarStorage: AvatarStorageService,
    private getOnlineBotsMap: () => Map<string, UserSummary>
  ) {}

  /** SHA-256 hex hash of the raw token string. */
  static hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  async create(
    name: string,
    createdByUserId: string,
    avatarBase64?: string
  ): Promise<{ success: boolean; bot?: BotInfo; token?: string; errorCode?: ProtocolErrorCode; errorMessage?: string }> {
    const server = await this.serverRepo.getServer();
    const maxBots = server?.maxBots ?? LIMITS.MAX_BOTS_DEFAULT;
    const count = await this.botRepo.count();
    if (count >= maxBots) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: `O servidor atingiu o limite de ${maxBots} bots.`,
      };
    }

    const trimmed = name.trim();
    if (trimmed.length < LIMITS.MIN_NICKNAME_LENGTH || trimmed.length > LIMITS.MAX_NICKNAME_LENGTH) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: `O nome do bot deve ter entre ${LIMITS.MIN_NICKNAME_LENGTH} e ${LIMITS.MAX_NICKNAME_LENGTH} caracteres.`,
      };
    }

    const rawToken = randomBytes(LIMITS.BOT_TOKEN_BYTES).toString('hex');
    const tokenHash = BotService.hashToken(rawToken);
    const id = uuidv4();
    const now = Date.now();

    let avatarPath: string | null = null;
    if (avatarBase64) {
      try {
        let rawBase64 = avatarBase64;
        if (avatarBase64.includes(',')) {
          rawBase64 = avatarBase64.split(',')[1];
        }
        const buffer = Buffer.from(rawBase64, 'base64');
        const validation = this.avatarStorage.validateAvatarBuffer(buffer);
        if (validation.isValid && validation.extension) {
          avatarPath = await this.avatarStorage.saveAvatar(buffer, validation.extension);
        }
      } catch {
        /* non-critical */
      }
    }

    const record: BotRecord = {
      id,
      name: trimmed,
      tokenHash,
      avatarPath,
      boundPublicKey: null,
      createdByUserId,
      createdAt: now,
    };
    await this.botRepo.create(record);
    Logger.info('BOT', `Bot "${trimmed}" (${id}) created by user ${createdByUserId}.`);

    return {
      success: true,
      bot: this.toBotInfo(record),
      token: rawToken,
    };
  }

  async list(): Promise<BotInfo[]> {
    const records = await this.botRepo.listAll();
    return records.map((r) => this.toBotInfo(r));
  }

  async revoke(botId: string): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string }> {
    const record = await this.botRepo.findById(botId);
    if (!record) {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Bot não encontrado.' };
    }
    await this.botRepo.delete(botId);
    Logger.info('BOT', `Bot "${record.name}" (${botId}) revoked.`);
    return { success: true };
  }

  /**
   * Validates a bot token and performs TOFU binding on first connection.
   * Returns the BotRecord if valid, or null.
   */
  async validateToken(rawToken: string, publicKey: string): Promise<BotRecord | null> {
    const hash = BotService.hashToken(rawToken);
    const record = await this.botRepo.findByTokenHash(hash);
    if (!record) return null;

    if (!record.boundPublicKey) {
      // TOFU: bind the public key on first connection.
      await this.botRepo.update(record.id, { boundPublicKey: publicKey });
      record.boundPublicKey = publicKey;
      Logger.info('BOT', `Bot "${record.name}" TOFU-bound to public key ${publicKey.substring(0, 16)}...`);
    } else if (record.boundPublicKey !== publicKey) {
      // Public key mismatch: reject.
      Logger.security(`Bot "${record.name}" rejected: public key mismatch (TOFU binding violated).`);
      return null;
    }

    return record;
  }

  private toBotInfo(record: BotRecord): BotInfo {
    const onlineBots = this.getOnlineBotsMap();
    return {
      id: record.id,
      name: record.name,
      avatarUrl: this.avatarStorage.getPublicUrl(record.avatarPath),
      createdAt: record.createdAt,
      createdByUserId: record.createdByUserId,
      bound: record.boundPublicKey !== null,
      online: onlineBots.has(record.id),
    };
  }
}
