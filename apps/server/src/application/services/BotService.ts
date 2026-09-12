import { randomBytes, createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  LIMITS,
  ProtocolErrorCode,
  BotInfo,
  UserSummary,
  botIdentitySchema,
  botManifestSchema,
  botProfileUpdateSchema,
  type BotIdentity,
} from '@monky/shared';
import { BotRecord } from '../../domain/entities';
import { IBotRepository, IServerRepository } from '../../domain/repositories';
import { AvatarStorageService } from '../../infrastructure/security/AvatarStorageService';
import { Logger } from '../../infrastructure/logger/Logger';

type BotFailure = {
  success: false;
  errorCode: ProtocolErrorCode;
  errorMessage: string;
  revokedBotId?: string;
};
type BotProfileResult = { success: true; bot: BotInfo } | BotFailure;
type BotCreateResult = { success: true; bot: BotInfo; token: string } | BotFailure;

/**
 * Manages bot lifecycle: creation, token validation, TOFU binding and revocation (#569).
 *
 * Tokens are stored as SHA-256 hex hashes. This avoids the overhead of bcrypt
 * for a 256-bit random token that is already immune to dictionary attacks, while
 * keeping the on-disk token safe from casual disclosure.
 */
export class BotService {
  private mutations: Promise<void> = Promise.resolve();

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

  async create(createdByUserId: string): Promise<BotCreateResult> {
    return this.mutate(() => this.createBot(createdByUserId));
  }

  private async createBot(createdByUserId: string, identity?: BotIdentity): Promise<BotCreateResult> {
    const parsed = botIdentitySchema.safeParse(identity ?? { name: 'Bot' });
    if (!parsed.success) {
      return {
        success: false,
        errorCode: parsed.error.issues.some((issue) => issue.path[0] === 'avatarBase64' && issue.code === 'too_big')
          ? ProtocolErrorCode.AVATAR_TOO_LARGE : ProtocolErrorCode.BOT_INVALID_PROFILE,
        errorMessage: 'Nome ou avatar do bot inválido.',
      };
    }

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

    const rawToken = randomBytes(LIMITS.BOT_TOKEN_BYTES).toString('hex');
    const tokenHash = BotService.hashToken(rawToken);
    const id = uuidv4();
    const now = Date.now();

    let avatarPath: string | null = null;
    if (parsed.data.avatarBase64 !== undefined) {
      const avatar = await this.saveProfileAvatar(parsed.data.avatarBase64);
      if (!avatar.success) return avatar;
      avatarPath = avatar.filename;
    }

    const record: BotRecord = {
      id,
      name: parsed.data.name,
      profilePending: identity === undefined,
      tokenHash,
      avatarPath,
      boundPublicKey: null,
      createdByUserId,
      createdAt: now,
    };
    try {
      await this.botRepo.create(record);
    } catch (error) {
      if (avatarPath) this.avatarStorage.deleteAvatar(avatarPath);
      Logger.error('BOT', 'Failed to create bot.', error);
      return { success: false, errorCode: ProtocolErrorCode.INTERNAL_ERROR, errorMessage: 'Não foi possível salvar o bot.' };
    }
    Logger.info('BOT', record.profilePending
      ? `Bot link (${id}) reserved by user ${createdByUserId}; waiting for the bot identity.`
      : `Bot "${record.name}" (${id}) linked by user ${createdByUserId}.`);

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

  async getInfo(botId: string): Promise<BotInfo | null> {
    const record = await this.botRepo.findById(botId);
    return record ? this.toBotInfo(record) : null;
  }

  async updateProfile(botId: string, profile: unknown): Promise<BotProfileResult> {
    const parsed = botProfileUpdateSchema.safeParse(profile);
    if (!parsed.success) {
      return {
        success: false,
        errorCode: parsed.error.issues.some((issue) => issue.path[0] === 'avatarBase64' && issue.code === 'too_big')
          ? ProtocolErrorCode.AVATAR_TOO_LARGE : ProtocolErrorCode.BOT_INVALID_PROFILE,
        errorMessage: 'Perfil do bot inválido.',
      };
    }
    if (parsed.data.botId !== undefined && parsed.data.botId !== botId) {
      return { success: false, errorCode: ProtocolErrorCode.BOT_INVALID_PROFILE, errorMessage: 'Bot inválido.' };
    }

    return this.mutate(async () => {
      const record = await this.botRepo.findById(botId);
      if (!record) {
        return { success: false, errorCode: ProtocolErrorCode.BOT_INVALID_PROFILE, errorMessage: 'Bot não encontrado.' };
      }

      const updates: Partial<BotRecord> = {};
      if (parsed.data.name !== undefined) {
        updates.name = parsed.data.name;
        updates.profilePending = false;
      }
      const avatarBase64 = parsed.data.avatarBase64;
      if (avatarBase64 === null) {
        updates.avatarPath = null;
      } else if (avatarBase64 !== undefined) {
        const avatar = await this.saveProfileAvatar(avatarBase64);
        if (!avatar.success) return avatar;
        updates.avatarPath = avatar.filename;
      }

      try {
        await this.botRepo.update(botId, updates);
      } catch (error) {
        if (updates.avatarPath) this.avatarStorage.deleteAvatar(updates.avatarPath);
        Logger.error('BOT', 'Failed to update bot profile.', error);
        return { success: false, errorCode: ProtocolErrorCode.INTERNAL_ERROR, errorMessage: 'Não foi possível salvar o perfil do bot.' };
      }
      if (updates.avatarPath !== undefined && record.avatarPath) {
        this.avatarStorage.deleteAvatar(record.avatarPath);
      }
      return { success: true, bot: this.toBotInfo({ ...record, ...updates }) };
    });
  }

  async revoke(botId: string): Promise<{ success: true } | BotFailure> {
    return this.mutate(async () => {
      const record = await this.botRepo.findById(botId);
      if (!record) {
        return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Bot não encontrado.' };
      }
      await this.botRepo.delete(botId);
      if (record.avatarPath) this.avatarStorage.deleteAvatar(record.avatarPath);
      Logger.info('BOT', `Bot "${record.name}" (${botId}) revoked.`);
      return { success: true };
    });
  }

  /**
   * Validates a bot token and performs TOFU binding on first connection.
   * Returns the BotRecord if valid, or null.
   */
  async validateToken(rawToken: string, publicKey: string): Promise<BotRecord | null> {
    return this.mutate(async () => {
      const hash = BotService.hashToken(rawToken);
      const record = await this.botRepo.findByTokenHash(hash);
      if (!record) return null;

      if (!record.boundPublicKey) {
        // TOFU: bind the public key on first connection.
        await this.botRepo.update(record.id, { boundPublicKey: publicKey });
        record.boundPublicKey = publicKey;
        Logger.info('BOT', `Bot "${record.name}" TOFU-bound to public key ${publicKey.substring(0, 16)}...`);
      } else if (record.boundPublicKey !== publicKey) {
        Logger.security(`Bot "${record.name}" rejected: public key mismatch (TOFU binding violated).`);
        return null;
      }

      return record;
    });
  }

  /**
   * Installs a bot from a remote manifest URL (#578).
   *
   * 1. Fetches the manifest from the bot's HTTP endpoint.
   * 2. Creates the bot record with the metadata from the manifest.
   * 3. POSTs the generated token to the bot's `registrationUrl`.
   * 4. The bot responds with its public key, which is immediately TOFU-bound.
   */
  async installFromManifest(
    manifestUrl: string,
    createdByUserId: string,
    serverName: string,
    serverWsUrl?: string
  ): Promise<BotProfileResult> {
    // 1. Fetch manifest.
    let rawManifest: unknown;
    try {
      const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) {
        return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: `O bot não respondeu corretamente (HTTP ${res.status}). Verifique se a URL está correta e o bot está em execução.` };
      }
      rawManifest = await res.json();
    } catch {
      return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage: 'Não foi possível conectar ao bot. Verifique se a URL está acessível e a porta está aberta no firewall.' };
    }

    const parsed = botManifestSchema.safeParse(rawManifest);
    if (!parsed.success) {
      return { success: false, errorCode: ProtocolErrorCode.BOT_INVALID_PROFILE, errorMessage: 'O bot respondeu, mas o manifest é inválido. Verifique o nome, a imagem e a URL de registro.' };
    }
    const manifest = parsed.data;

    // Only metadata supplied by the bot can initialize a linked identity.
    const createResult = await this.mutate(() => this.createBot(createdByUserId, {
      name: manifest.name,
      ...(manifest.icon !== undefined ? { avatarBase64: manifest.icon } : {}),
    }));
    if (!createResult.success) return createResult;

    // 3. POST the token to the bot's registration endpoint.
    let publicKey: string | null = null;
    let registrationError = 'O bot não confirmou o registro com uma chave pública válida. Verifique os logs e a versão do bot.';
    try {
      const regRes = await fetch(manifest.registrationUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          token: createResult.token,
          serverId: createResult.bot.id,
          serverName,
          ...(serverWsUrl ? { serverUrl: serverWsUrl } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (regRes.ok) {
        const regBody: unknown = await regRes.json();
        if (
          regBody !== null && typeof regBody === 'object' && 'publicKey' in regBody &&
          typeof regBody.publicKey === 'string' && /^[a-fA-F0-9]{64,128}$/.test(regBody.publicKey)
        ) {
          publicKey = regBody.publicKey;
        }
      } else {
        registrationError = `O bot recusou o registro (HTTP ${regRes.status}). Verifique os logs do bot e se as versões do bot e do servidor são compatíveis.`;
      }
    } catch (error) {
      registrationError = 'Não foi possível concluir o registro no bot. Verifique a conexão, a porta e os logs do bot.';
      Logger.error('BOT', 'Failed to complete bot registration.', error);
    }

    if (!publicKey) {
      return this.rollbackInstallation(createResult.bot.id, registrationError);
    }

    // 4. Bind the confirmed key (or verify the binding established by the SDK).
    if (!await this.validateToken(createResult.token, publicKey)) {
      return this.rollbackInstallation(createResult.bot.id, 'A identidade confirmada pelo bot não corresponde ao registro. Verifique as chaves do bot.');
    }

    // Refresh the bot info (bound status may have changed).
    const refreshed = await this.botRepo.findById(createResult.bot.id);
    const botInfo = refreshed ? this.toBotInfo(refreshed) : createResult.bot;

    Logger.info('BOT', `Bot "${manifest.name}" installed from manifest by user ${createdByUserId}.`);
    return { success: true, bot: botInfo };
  }

  private async rollbackInstallation(botId: string, errorMessage: string): Promise<BotFailure> {
    if (await this.botRepo.findById(botId)) {
      const revoked = await this.revoke(botId);
      if (!revoked.success) return revoked;
    }
    return { success: false, errorCode: ProtocolErrorCode.BAD_REQUEST, errorMessage, revokedBotId: botId };
  }

  public async findById(botId: string): Promise<BotRecord | null> {
    return this.botRepo.findById(botId);
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
      profilePending: record.profilePending,
    };
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const result = this.mutations.then(action);
    this.mutations = result.then(() => undefined, () => undefined);
    return result;
  }

  private async saveProfileAvatar(value: string): Promise<{ success: true; filename: string } | BotFailure> {
    const invalid: BotFailure = {
      success: false,
      errorCode: ProtocolErrorCode.AVATAR_INVALID_TYPE,
      errorMessage: 'Avatar inválido. Utilize uma imagem PNG, JPEG ou WebP em base64.',
    };
    let rawBase64 = value;
    let declaredMime: string | undefined;
    if (value.startsWith('data:')) {
      const match = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(value);
      if (!match) return invalid;
      declaredMime = match[1];
      rawBase64 = match[2];
    }
    if (!rawBase64 || rawBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(rawBase64)) return invalid;
    const buffer = Buffer.from(rawBase64, 'base64');
    if (buffer.length > LIMITS.MAX_AVATAR_SIZE) {
      return { success: false, errorCode: ProtocolErrorCode.AVATAR_TOO_LARGE, errorMessage: 'Avatar excede o limite de tamanho.' };
    }
    if (buffer.toString('base64') !== rawBase64) return invalid;
    const validation = this.avatarStorage.validateAvatarBuffer(buffer);
    if (!validation.isValid || !validation.extension || (declaredMime && declaredMime !== validation.mimeType)) {
      return { ...invalid, errorMessage: validation.error ?? invalid.errorMessage };
    }
    try {
      return { success: true, filename: await this.avatarStorage.saveAvatar(buffer, validation.extension) };
    } catch (error) {
      Logger.error('BOT', 'Failed to save bot avatar.', error);
      return { success: false, errorCode: ProtocolErrorCode.INTERNAL_ERROR, errorMessage: 'Não foi possível salvar o avatar do bot.' };
    }
  }
}
