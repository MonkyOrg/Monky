import { randomBytes, createHash } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import {
  LIMITS,
  ProtocolErrorCode,
  BotInfo,
  PROTOCOL_VERSION,
  UserSummary,
  botIdentitySchema,
  botManifestSchema,
  botProfileUpdateSchema,
  botCapabilitiesSchema,
  unreviewedBotPermissions,
  type BotCapability,
  type BotInstallPreview,
  type BotManifest,
  type BotIdentity,
  type BotCompatibilitySummary,
} from '@monky/shared';
import { BotRecord } from '../../domain/entities';
import { IBotRepository, IServerRepository } from '../../domain/repositories';
import { AvatarStorageService } from '../../infrastructure/security/AvatarStorageService';
import { Logger } from '../../infrastructure/logger/Logger';
import { BotPermissionService } from './BotPermissionService';

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
  private previews = new Map<string, BotInstallPreview & { owner: string; url: string; digest: string }>();

  constructor(
    private botRepo: IBotRepository,
    private serverRepo: IServerRepository,
    private avatarStorage: AvatarStorageService,
    private getOnlineBotsMap: () => Map<string, UserSummary>,
    readonly permissions?: BotPermissionService,
  ) {}

  /** SHA-256 hex hash of the raw token string. */
  static hashToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  async create(createdByUserId: string, isAuthorized = () => true): Promise<BotCreateResult> {
    return this.mutate(() => this.createBot(createdByUserId, undefined, isAuthorized));
  }

  private async createBot(createdByUserId: string, identity?: BotIdentity, isAuthorized = () => true): Promise<BotCreateResult> {
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
    if (!isAuthorized()) return this.permissionChanged();
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
    if (!isAuthorized()) {
      if (avatarPath) this.avatarStorage.deleteAvatar(avatarPath);
      return this.permissionChanged();
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

  async getCompatibility(): Promise<BotCompatibilitySummary> {
    const bots = await this.botRepo.listAll();
    return {
      protocolVersion: PROTOCOL_VERSION,
      incompatibleBots: bots.filter((bot) =>
        bot.lastProtocolVersion != null && !negotiateProtocol(bot.lastProtocolVersion, undefined, 'bot')).length,
      uncheckedBots: bots.filter((bot) =>
        bot.boundPublicKey !== null && bot.lastProtocolVersion == null).length,
    };
  }

  async recordCompatibleConnection(botId: string, protocolVersion: number = PROTOCOL_VERSION): Promise<boolean> {
    return this.mutate(async () => {
      const record = await this.botRepo.findById(botId);
      if (!record) return false;
      if (record.lastProtocolVersion !== protocolVersion) {
        await this.botRepo.update(botId, { lastProtocolVersion: protocolVersion });
      }
      return true;
    });
  }

  async recordRejectedProtocol(rawToken: string, publicKey: string, protocolVersion: unknown): Promise<boolean> {
    if (typeof protocolVersion !== 'number' || !Number.isSafeInteger(protocolVersion) ||
        protocolVersion <= 0 || protocolVersion === PROTOCOL_VERSION) return false;
    return this.mutate(async () => {
      const record = await this.botRepo.findByTokenHash(BotService.hashToken(rawToken));
      // Never claim an unbound link or let an obsolete duplicate override a live, compatible bot.
      if (!record || !record.boundPublicKey || record.boundPublicKey !== publicKey ||
          this.getOnlineBotsMap().has(record.id)) return false;
      if (record.lastProtocolVersion !== protocolVersion) {
        await this.botRepo.update(record.id, { lastProtocolVersion: protocolVersion });
      }
      return true;
    });
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

  private async fetchManifest(manifestUrl: string): Promise<{ success: true; manifest: BotManifest } | BotFailure> {
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
      return {
        success: false,
        errorCode: parsed.error.issues.some((issue) => issue.path[0] === 'requestedCapabilities')
          ? ProtocolErrorCode.BOT_CAPABILITIES_INVALID : ProtocolErrorCode.BOT_INVALID_PROFILE,
        errorMessage: 'Manifest inválido. Atualize o SDK e declare apenas as capacidades suportadas; recepção de voz não está disponível.',
      };
    }
    return { success: true, manifest: parsed.data };
  }

  private validateRegistrationAddress(serverWsUrl: string | undefined, botUrls: string[]): BotFailure | null {
    const invalid: BotFailure = {
      success: false, errorCode: ProtocolErrorCode.BAD_REQUEST,
      errorMessage: 'Não foi possível determinar o endereço do servidor para o bot. Reconecte usando a URL completa do servidor.',
    };
    if (!serverWsUrl) return invalid;
    try {
      const server = new URL(serverWsUrl);
      if (!['ws:', 'wss:'].includes(server.protocol) || server.username || server.password || server.hash ||
          ['0.0.0.0', '[::]'].includes(server.hostname) || server.port === '0') return invalid;
      const isLoopback = (url: URL): boolean => {
        const host = url.hostname.toLowerCase().replace(/\.$/, '');
        return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' ||
          /^127\.\d+\.\d+\.\d+$/.test(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host);
      };
      if (isLoopback(server) && botUrls.some(url => !isLoopback(new URL(url)))) {
        return {
          success: false, errorCode: ProtocolErrorCode.BAD_REQUEST,
          errorMessage: 'Um bot remoto não pode usar localhost para acessar este servidor. Reconecte pelo IP ou domínio acessível ao bot e tente novamente.',
        };
      }
      return null;
    } catch {
      return invalid;
    }
  }

  async previewInstallation(
    manifestUrl: string, owner: string, serverWsUrl?: string,
  ): Promise<{ success: true; preview: BotInstallPreview } | BotFailure> {
    const now = Date.now();
    for (const [id, preview] of this.previews) if (preview.expiresAt <= now) this.previews.delete(id);
    if (this.previews.size >= 256 || [...this.previews.values()].filter((preview) => preview.owner === owner).length >= 8) {
      return { success: false, errorCode: ProtocolErrorCode.RATE_LIMITED, errorMessage: 'Aguarde a expiração das revisões anteriores antes de tentar novamente.' };
    }
    const result = await this.fetchManifest(manifestUrl);
    if (!result.success) return result;
    const invalidAddress = this.validateRegistrationAddress(serverWsUrl, [manifestUrl, result.manifest.registrationUrl]);
    if (invalidAddress) return invalidAddress;
    const preview: BotInstallPreview = { previewId: uuidv4(), manifest: result.manifest, expiresAt: Date.now() + 5 * 60_000 };
    this.previews.set(preview.previewId, {
      ...preview, owner, url: manifestUrl, digest: this.manifestDigest(result.manifest),
    });
    return { success: true, preview };
  }

  async installFromPreview(
    previewId: string, grants: BotCapability[], owner: string, createdByUserId: string,
    serverName: string, serverWsUrl?: string, isAuthorized = () => true,
  ): Promise<BotProfileResult> {
    const preview = this.previews.get(previewId);
    if (!preview || preview.owner !== owner || preview.expiresAt <= Date.now()) {
      return { success: false, errorCode: ProtocolErrorCode.BOT_MANIFEST_CHANGED, errorMessage: 'Esta revisão expirou ou pertence a outra sessão. Revise o bot novamente.' };
    }
    this.previews.delete(previewId);
    const approved = botCapabilitiesSchema.safeParse(grants);
    if (!approved.success || approved.data.some((capability) => !preview.manifest.requestedCapabilities.includes(capability))) {
      return { success: false, errorCode: ProtocolErrorCode.BOT_PERMISSIONS_REQUIRED, errorMessage: 'Só é possível aprovar capacidades solicitadas pelo bot.' };
    }
    const permissionService = this.permissions;
    if (!permissionService) return { success: false, errorCode: ProtocolErrorCode.INTERNAL_ERROR, errorMessage: 'O armazenamento de permissões está indisponível.' };
    const refreshedManifest = await this.fetchManifest(preview.url);
    if (!refreshedManifest.success) return refreshedManifest;
    if (preview.expiresAt <= Date.now() || this.manifestDigest(refreshedManifest.manifest) !== preview.digest) {
      return { success: false, errorCode: ProtocolErrorCode.BOT_MANIFEST_CHANGED, errorMessage: 'O manifest mudou. Revise a identidade e as capacidades novamente antes de instalar.' };
    }
    if (!isAuthorized()) return this.permissionChanged();
    const manifest = preview.manifest;
    const invalidAddress = this.validateRegistrationAddress(serverWsUrl, [preview.url, manifest.registrationUrl]);
    if (invalidAddress) return invalidAddress;

    // Only metadata supplied by the bot can initialize a linked identity.
    const createResult = await this.mutate(async () => {
      const created = await this.createBot(createdByUserId, {
        name: manifest.name,
        ...(manifest.icon !== undefined ? { avatarBase64: manifest.icon } : {}),
      }, isAuthorized);
      if (!created.success) return created;
      try {
        const { permissions } = permissionService.declare(created.bot.id, manifest.requestedCapabilities);
        // Registration may authenticate before its HTTP response. Keep that
        // provisional connection powerless until the reviewed install finishes.
        return { ...created, permissionRevision: permissions.revision };
      } catch (error) {
        const record = await this.botRepo.findById(created.bot.id);
        await this.botRepo.delete(created.bot.id);
        if (record?.avatarPath) this.avatarStorage.deleteAvatar(record.avatarPath);
        Logger.error('BOT', 'Failed to persist bot permission declaration.', error);
        return { success: false, errorCode: ProtocolErrorCode.INTERNAL_ERROR, errorMessage: 'Não foi possível salvar as permissões do bot.' } satisfies BotFailure;
      }
    });
    if (!createResult.success) return createResult;
    if (!isAuthorized()) return this.rollbackInstallation(createResult.bot.id, this.permissionChanged().errorMessage, ProtocolErrorCode.PERMISSION_DENIED);

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
    if (!isAuthorized()) return this.rollbackInstallation(createResult.bot.id, this.permissionChanged().errorMessage, ProtocolErrorCode.PERMISSION_DENIED);

    // 4. Bind the confirmed key (or verify the binding established by the SDK).
    if (!await this.validateToken(createResult.token, publicKey)) {
      return this.rollbackInstallation(createResult.bot.id, 'A identidade confirmada pelo bot não corresponde ao registro. Verifique as chaves do bot.');
    }

    // Refresh the bot info (bound status may have changed).
    const refreshed = await this.botRepo.findById(createResult.bot.id);
    if (!refreshed || !isAuthorized()) return this.rollbackInstallation(
      createResult.bot.id, this.permissionChanged().errorMessage, ProtocolErrorCode.PERMISSION_DENIED,
    );
    const current = permissionService.get(refreshed.id);
    if (current?.revision !== createResult.permissionRevision) {
      return this.rollbackInstallation(refreshed.id, 'As capacidades do bot mudaram durante o registro. Revise o bot novamente.',
        ProtocolErrorCode.BOT_MANIFEST_CHANGED);
    }
    try {
      permissionService.approve(createdByUserId, {
        botId: refreshed.id, expectedRevision: createResult.permissionRevision, granted: approved.data,
      });
    } catch (error) {
      Logger.error('BOT', 'Failed to approve the reviewed bot installation.', error);
      return this.rollbackInstallation(refreshed.id, 'Não foi possível concluir a revisão das permissões do bot.');
    }
    const botInfo = this.toBotInfo(refreshed);

    Logger.info('BOT', `Bot "${manifest.name}" installed from manifest by user ${createdByUserId}.`);
    return { success: true, bot: botInfo };
  }

  private manifestDigest(manifest: BotManifest): string {
    return createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  }

  private permissionChanged(): BotFailure {
    return { success: false, errorCode: ProtocolErrorCode.PERMISSION_DENIED, errorMessage: 'A sessão ou a permissão de administrar bots mudou. Tente novamente.' };
  }

  private async rollbackInstallation(
    botId: string, errorMessage: string, errorCode: ProtocolErrorCode = ProtocolErrorCode.BAD_REQUEST,
  ): Promise<BotFailure> {
    if (await this.botRepo.findById(botId)) {
      const revoked = await this.revoke(botId);
      if (!revoked.success) return revoked;
    }
    return { success: false, errorCode, errorMessage, revokedBotId: botId };
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
      lastProtocolVersion: record.lastProtocolVersion ?? null,
      requiredProtocolVersion: PROTOCOL_VERSION,
      minimumProtocolVersion: MIN_BOT_PROTOCOL,
      protocolCompatible: record.lastProtocolVersion != null
        ? onlineBots.has(record.id) || !!negotiateProtocol(record.lastProtocolVersion, undefined, 'bot') : undefined,
      permissions: this.permissions?.get(record.id) ?? unreviewedBotPermissions(),
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
import { negotiateProtocol, MIN_BOT_PROTOCOL } from '@monky/shared';
