import { createPublicKey, randomBytes, verify } from 'crypto';
import { WebSocket } from 'ws';
import { v4 as uuidv4 } from 'uuid';
import {
  AttachmentStorageInfo,
  AuthConnectPayload,
  CustomStatus,
  LIMITS,
  PROTOCOL_VERSION,
  negotiateProtocol,
  ProtocolErrorCode,
  ServerDetails,
  UserSummary,
  authChallengeResponseSchema,
  authConnectSchema,
  canAccessChannel,
  deriveClientIdFromPublicKey,
  normalizePublicKeyHex,
  type ServerSettingsUpdatedPayload,
} from '@monky/shared';
import type { ServerRecord, UserRecord } from '../../domain/entities';
import { planServerSettingsUpdate, type ServerSettingsPatch, type ServerSettingsProblem } from '../../domain/serverSettings';
import { CapacityEstimator } from '../../domain/services/CapacityEstimator';
import { ICategoryRepository, IChannelRepository, IMentionRepository, IServerRepository, IUserRepository } from '../../domain/repositories';
import { AvatarStorageService, publicImageUrl } from '../../infrastructure/security/AvatarStorageService';
import { PasswordService } from '../../infrastructure/security/PasswordService';
import { Logger } from '../../infrastructure/logger/Logger';
import { AttachmentService } from './AttachmentService';
import { toChannelSummary } from './ChannelService';
import { PermissionService } from './PermissionService';
import { RoleService } from './RoleService';
import { toUserSummary } from './UserService';

/** The settings the login snapshot and a settings change both carry (S-APP-10). */
export type ServerSettingsPayload = Required<Pick<ServerSettingsUpdatedPayload,
  'name' | 'hasPassword' | 'maxUsers' | 'maxMessageLength' | 'allowSoundboard' | 'dmRelayEnabled' |
  'recentSoundCacheEnabled' | 'recentSoundCacheLimit' | 'allowEveryoneMention' | 'allowMessageEdit' |
  'messageDeleteUndoSeconds' | 'showRoleBadgesToEveryone' | 'voiceMode' | 'iconUrl' | 'attachmentStorage' |
  'turnEnabled' | 'afkTimeoutSeconds'>>;

export type ServerSettingsUpdateResult =
  | { success: true; settings: ServerSettingsPayload }
  | { success: false; errorMessage: string };

/** Members see each setting as the stored server holds it, at login and after every change. */
export function serverSettingsPayload(server: ServerRecord, attachmentStorage: AttachmentStorageInfo): ServerSettingsPayload {
  return {
    name: server.name,
    hasPassword: Boolean(server.passwordHash),
    maxUsers: server.maxUsers,
    maxMessageLength: server.maxMessageLength,
    allowSoundboard: server.allowSoundboard,
    dmRelayEnabled: server.dmRelayEnabled,
    recentSoundCacheEnabled: server.recentSoundCacheEnabled,
    recentSoundCacheLimit: server.recentSoundCacheLimit,
    allowEveryoneMention: server.allowEveryoneMention,
    allowMessageEdit: server.allowMessageEdit,
    messageDeleteUndoSeconds: server.messageDeleteUndoSeconds,
    showRoleBadgesToEveryone: server.showRoleBadgesToEveryone,
    voiceMode: server.voiceMode,
    iconUrl: publicImageUrl(server.iconPath),
    attachmentStorage,
    turnEnabled: server.turnEnabled,
    afkTimeoutSeconds: server.afkTimeoutSeconds,
  };
}

export interface AuthResult {
  success: boolean;
  errorCode?: ProtocolErrorCode;
  errorMessage?: string;
  authFailed?: boolean;
  user?: UserSummary;
  serverDetails?: ServerDetails;
  /** Whether this connection should be invisible to other users (#561). */
  appearOffline?: boolean;
  /** The user arrived "be right back" (user-brb); applied only when negotiated. */
  brb?: boolean;
  /** The user arrived with a custom status (custom-status); applied only when negotiated. */
  customStatus?: CustomStatus;
  /** True on the first connection of a member, which registers them on the server. */
  newMember?: boolean;
  /**
   * True when signing in changed who holds which role: a default role given or
   * the first member made owner. Only then do the other connections need the
   * role state again (S-WS-4).
   */
  rolesChanged?: boolean;
}

interface PendingAuthChallenge {
  publicKey: string;
  clientId: string;
  nickname: string;
  password: string;
  nonce: string;
  /** Which installation is connecting, so two devices of the same person coexist (#309). */
  deviceId: string;
  /** The user wants to appear offline to everyone else (#561). */
  appearOffline: boolean;
  brb: boolean;
  customStatus?: CustomStatus;
}

/** The words clients have always received for a refused settings change. */
function describeSettingsProblem(problem: ServerSettingsProblem): string {
  switch (problem.code) {
    case 'afk-timeout':
      return 'Escolha 1, 5, 15, 30 ou 60 minutos de inatividade para o canal AFK.';
    case 'delete-undo-seconds':
      return 'O prazo para desfazer deve ser um inteiro entre 1 e 86400 segundos.';
    case 'max-message-length':
      return 'O limite de caracteres deve ser um inteiro positivo ou zero (sem limite).';
    case 'attachment-limits':
      return 'Os limites de armazenamento devem ser positivos.';
    case 'attachment-file-over-total':
      return 'O limite por arquivo não pode exceder o total do servidor.';
    case 'max-users':
      return 'O limite de membros deve ser um número positivo.';
    case 'members-over-limit':
      return `O servidor já tem ${problem.memberCount} membros. Remova membros antes de definir um limite menor.`;
    case 'recent-sound-cache-limit':
      return `O cache de áudios deve manter entre ${LIMITS.RECENT_SOUND_CACHE_MIN_LIMIT} e ${LIMITS.RECENT_SOUND_CACHE_MAX_LIMIT} itens.`;
    case 'turn-in-sfu':
      return 'O relay TURN não pode ser ativado no modo SFU: o próprio SFU já faz o papel de relay.';
  }
}

export class AuthService {
  private pendingChallenges = new Map<WebSocket, PendingAuthChallenge>();
  private attempts = new WeakMap<WebSocket, symbol>();
  private challengeTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();

  constructor(
    private serverRepo: IServerRepository,
    private userRepo: IUserRepository,
    private channelRepo: IChannelRepository,
    private mentionRepo: IMentionRepository,
    private avatarStorage: AvatarStorageService,
    private getActiveOnlineUsers: () => Map<string, { user: UserSummary }>,
    private attachmentService: AttachmentService,
    private permissionService: PermissionService,
    private roleService: RoleService,
    private categoryRepo?: ICategoryRepository
  ) {}

  public async createChallenge(
    ws: WebSocket,
    payload: AuthConnectPayload
  ): Promise<{
    success: boolean;
    nonce?: string;
    errorCode?: ProtocolErrorCode;
    errorMessage?: string;
    serverProtocolVersion?: number;
  }> {
    // Checked before the schema so a version mismatch reports itself as such.
    // The schema would flatten it into a generic BAD_REQUEST, and the client
    // then showed "invalid request" for what is really "one of you is outdated"
    // (#355).
    if (!negotiateProtocol(payload?.protocolVersion, payload?.protocolOffer, 'client')) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.PROTOCOL_VERSION_UNSUPPORTED,
        errorMessage: `Versão de protocolo incompatível. Este servidor usa a versão ${PROTOCOL_VERSION}.`,
        serverProtocolVersion: PROTOCOL_VERSION,
      };
    }

    const parseResult = authConnectSchema.safeParse(payload);
    if (!parseResult.success) {
      const firstError = parseResult.error.errors[0]?.message || 'Dados de conexão inválidos';
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: firstError,
      };
    }

    const publicKey = normalizePublicKeyHex(parseResult.data.publicKey);
    try {
      this.getNodePublicKey(publicKey);
    } catch {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: 'Chave pública inválida',
      };
    }

    this.clearChallenge(ws);
    const attempt = Symbol();
    this.attempts.set(ws, attempt);
    const isCurrent = () => this.attempts.get(ws) === attempt && ws.readyState === WebSocket.OPEN;
    const cancelled = { success: false, errorCode: ProtocolErrorCode.UNAUTHORIZED, errorMessage: 'Conexão encerrada.' };
    const server = await this.serverRepo.getServer();
    if (!isCurrent()) return cancelled;
    if (!server) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.INTERNAL_ERROR,
        errorMessage: 'Servidor não inicializado',
      };
    }

    if (server.passwordHash && server.passwordHash.length > 0) {
      const isValid = await PasswordService.verifyPassword(parseResult.data.password || '', server.passwordHash);
      if (!isCurrent()) return cancelled;
      if (!isValid) {
        Logger.security(`Failed authentication attempt for nickname: ${parseResult.data.nickname}`);
        return {
          success: false,
          errorCode: ProtocolErrorCode.AUTH_INVALID_PASSWORD,
          errorMessage: 'Senha do servidor incorreta.',
        };
      }
    }

    const nonce = randomBytes(32).toString('hex');
    this.pendingChallenges.set(ws, {
      publicKey,
      clientId: deriveClientIdFromPublicKey(publicKey),
      nickname: parseResult.data.nickname.trim(),
      password: parseResult.data.password || '',
      nonce,
      // Clients that predate #309 send nothing; give them a random id so each of
      // their connections is still a distinct session.
      deviceId: parseResult.data.deviceId || randomBytes(16).toString('hex'),
      appearOffline: parseResult.data.appearOffline === true,
      brb: parseResult.data.brb === true,
      customStatus: parseResult.data.customStatus,
    });
    const timer = setTimeout(() => this.clearChallenge(ws), 30_000);
    timer.unref();
    this.challengeTimers.set(ws, timer);

    return {
      success: true,
      nonce,
    };
  }

  public async verifyChallengeResponse(ws: WebSocket, signature: string): Promise<AuthResult> {
    const pending = this.pendingChallenges.get(ws);
    if (!pending) {
      return {
        success: false,
        authFailed: true,
        errorCode: ProtocolErrorCode.UNAUTHORIZED,
        errorMessage: 'Desafio de autenticação não encontrado ou expirado.',
      };
    }

    const parseResult = authChallengeResponseSchema.safeParse({ signature });
    if (!parseResult.success) {
      this.clearChallenge(ws);
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: parseResult.error.errors[0]?.message || 'Assinatura inválida',
      };
    }

    const normalizedSignature = parseResult.data.signature.toLowerCase();

    let isValidSignature = false;
    try {
      isValidSignature = verify(
        null,
        Buffer.from(pending.nonce, 'hex'),
        this.getNodePublicKey(pending.publicKey),
        Buffer.from(normalizedSignature, 'hex')
      );
    } catch {
      isValidSignature = false;
    }

    if (!isValidSignature) {
      this.clearChallenge(ws);
      return {
        success: false,
        authFailed: true,
        errorCode: ProtocolErrorCode.UNAUTHORIZED,
        errorMessage: 'Falha ao validar a assinatura do desafio.',
      };
    }

    this.clearChallenge(ws);
    return await this.finishAuthentication(pending);
  }

  public clearChallenge(ws: WebSocket): void {
    this.attempts.delete(ws);
    const timer = this.challengeTimers.get(ws);
    if (timer) clearTimeout(timer);
    this.challengeTimers.delete(ws);
    this.pendingChallenges.delete(ws);
  }

  private async finishAuthentication(pending: PendingAuthChallenge): Promise<AuthResult> {
    const server = await this.serverRepo.getServer();
    if (!server) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.INTERNAL_ERROR,
        errorMessage: 'Servidor não inicializado',
      };
    }

    const onlineMap = this.getActiveOnlineUsers();
    let otherDevicesOfIdentity = 0;
    for (const session of onlineMap.values()) {
      if (session.user.clientId !== pending.clientId) continue;
      // A reconnect from the same device replaces its own session instead of
      // adding one, so it must not count towards the device cap.
      if (session.user.sessionId !== `${session.user.id}:${pending.deviceId}`) {
        otherDevicesOfIdentity++;
      }
    }

    // Resolved before the capacity check because capacity counts registered
    // members (#403): we must know whether this person already has a record.
    let userRecord = await this.userRepo.findByPublicKey(pending.publicKey);
    if (!userRecord) {
      const byClientId = await this.userRepo.findByClientId(pending.clientId);
      if (byClientId?.publicKey && normalizePublicKeyHex(byClientId.publicKey) !== pending.publicKey) {
        return {
          success: false,
          authFailed: true,
          errorCode: ProtocolErrorCode.UNAUTHORIZED,
          errorMessage: 'Esta identidade não corresponde ao membro registrado neste servidor.',
        };
      }
      userRecord = byClientId;
    }

    // Only a brand-new member consumes a slot — an existing member must never be
    // locked out of their own server once it fills up. A cap of
    // MAX_USERS_UNLIMITED means the owner opted out of any limit (#403).
    if (!userRecord && server.maxUsers > LIMITS.MAX_USERS_UNLIMITED) {
      const memberCount = await this.userRepo.count();
      if (memberCount >= server.maxUsers) {
        return {
          success: false,
          errorCode: ProtocolErrorCode.SERVER_FULL,
          errorMessage: `O servidor atingiu o limite de ${server.maxUsers} membros. Peça a um administrador para remover um membro ou aumentar o limite.`,
        };
      }
    }
    // Capacity no longer bounds concurrent connections, so without this an
    // identity could still open unlimited sessions from new devices (#309).
    if (otherDevicesOfIdentity >= LIMITS.MAX_SESSIONS_PER_USER) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.SERVER_FULL,
        errorMessage: `Você já está conectado em ${LIMITS.MAX_SESSIONS_PER_USER} dispositivos. Desconecte um deles para entrar deste.`,
      };
    }

    const trimmedNick = pending.nickname.trim();
    for (const session of onlineMap.values()) {
      if (
        session.user.nickname.toLowerCase() === trimmedNick.toLowerCase() &&
        session.user.clientId !== pending.clientId
      ) {
        return {
          success: false,
          errorCode: ProtocolErrorCode.NICKNAME_ALREADY_EXISTS,
          errorMessage: 'Este nickname já está sendo utilizado por outro usuário no momento.',
        };
      }
    }

    const now = Date.now();
    const newMember = !userRecord;
    if (!userRecord) {
      userRecord = {
        id: uuidv4(),
        clientId: pending.clientId,
        publicKey: pending.publicKey,
        nickname: trimmedNick,
        avatarPath: null,
        createdAt: now,
        lastSeenAt: now,
      };
      await this.userRepo.create(userRecord);
    } else {
      const updates: Partial<UserRecord> = {
        nickname: trimmedNick,
        lastSeenAt: now,
      };
      if (!userRecord.publicKey) updates.publicKey = pending.publicKey;
      await this.userRepo.update(userRecord.id, updates);
      userRecord.nickname = trimmedNick;
      userRecord.publicKey = userRecord.publicKey ?? pending.publicKey;
      userRecord.lastSeenAt = now;
    }

    let rolesChanged = await this.roleService.ensureDefaultRolesAssigned(userRecord.id);

    if (!server.ownerUserId) {
      await this.serverRepo.updateServer({ ownerUserId: userRecord.id });
      await this.roleService.assignAdminRole(userRecord.id);
      server.ownerUserId = userRecord.id;
      rolesChanged = true;
    }

    const userSummary = toUserSummary(userRecord, 'ONLINE', now, {
      sessionId: `${userRecord.id}:${pending.deviceId}`,
      connectedAt: now,
    });

    // Mark the user summary with the invisible flag so the WebSocket layer
    // knows to suppress broadcasts and mask presence (#561).
    userSummary.invisible = pending.appearOffline;

    const channels = await this.channelRepo.listByServerId(server.id);
    // One entry per live connection, so the other devices of this person are
    // visible to the newcomer (#309). Invisible users are excluded from the
    // online list so they appear offline to everyone else (#561). The
    // connecting user's own session is always included regardless.
    const members: UserSummary[] = Array.from(onlineMap.values())
      .filter((s) => !s.user.invisible || s.user.id === userSummary.id)
      .map((s) => s.user);
    if (!members.some((m) => m.sessionId === userSummary.sessionId)) {
      members.push(userSummary);
    }

    const allUsers = await this.userRepo.listAll();
    // The known-members list describes people, so collapse a user's sessions to
    // a single (online) record. Invisible users appear as DISCONNECTED (#561).
    const onlineByUserId = new Map<string, UserSummary>();
    for (const session of onlineMap.values()) {
      if (!session.user.invisible && !onlineByUserId.has(session.user.id)) {
        onlineByUserId.set(session.user.id, session.user);
      }
    }
    // The connecting user always sees themselves as online in knownMembers.
    if (!onlineByUserId.has(userSummary.id)) {
      onlineByUserId.set(userSummary.id, userSummary);
    }
    const knownMembers: UserSummary[] = allUsers.map((user) => {
      const online = onlineByUserId.get(user.id);
      return online ?? toUserSummary(user, 'DISCONNECTED', user.lastSeenAt);
    });
    if (!knownMembers.some((m) => m.id === userSummary.id)) {
      knownMembers.push(userSummary);
    }

    const mentionedChannelIds = await this.mentionRepo.listChannelIdsForUser(userRecord.id);
    const roleState = await this.roleService.getRoleState();
    const myPermissions = await this.permissionService.getUserPermissions(userRecord.id);
    // Private channels are filtered out here rather than on the client, so a
    // channel the member cannot access never reaches them — not even its name (#384).
    const myRoleIds = roleState.userRoles.find((ur) => ur.userId === userRecord.id)?.roleIds ?? [];
    const visibleChannels = channels.filter((c) => canAccessChannel(c, myPermissions, myRoleIds, false, userRecord.id));
    const categories = (await this.categoryRepo?.listByServerId(server.id) ?? []).filter((category) =>
      canAccessChannel(category, myPermissions, myRoleIds, false, userRecord.id) || visibleChannels.some((channel) => channel.categoryId === category.id));

    const serverDetails: ServerDetails = {
      ...await this.settingsFor(server),
      everyonePermissions: roleState.everyonePermissions,
      id: server.id,
      createdAt: server.createdAt,
      afkChannelId: server.afkChannelId && channels.some((channel) => channel.id === server.afkChannelId && channel.type === 'VOICE')
        ? server.afkChannelId : null,
      hostSpecs: CapacityEstimator.getHostSpecs(),
      maxBots: server.maxBots,
      channels: visibleChannels.map(toChannelSummary),
      categories,
      members,
      knownMembers,
      mentionedChannelIds,
      voiceStates: {},
      roles: roleState.roles,
      userRoles: roleState.userRoles,
      ownerId: server.ownerUserId,
      myPermissions,
    };

    return {
      success: true,
      user: userSummary,
      serverDetails,
      appearOffline: pending.appearOffline,
      brb: pending.brb,
      customStatus: pending.customStatus,
      newMember,
      rolesChanged,
    };
  }

  /**
   * The settings the login snapshot and a settings change both carry, read
   * from the stored server in one place so the two never disagree (S-APP-10).
   */
  private async settingsFor(server: ServerRecord): Promise<ServerSettingsPayload> {
    return serverSettingsPayload(server, await this.attachmentService.getStorageInfo());
  }

  private getNodePublicKey(publicKeyHex: string) {
    return createPublicKey({
      key: Buffer.from(publicKeyHex, 'hex'),
      format: 'der',
      type: 'spki',
    });
  }

  public async updateServerSettings(payload: ServerSettingsPatch & {
    password?: string | null;
    iconBase64?: string | null;
  }): Promise<ServerSettingsUpdateResult> {
    const server = await this.serverRepo.getServer();
    if (!server) {
      return { success: false, errorMessage: 'Servidor não encontrado' };
    }

    const plan = planServerSettingsUpdate(server, payload, await this.userRepo.count());
    if (!plan.ok) {
      return { success: false, errorMessage: describeSettingsProblem(plan.problem) };
    }
    const updates = plan.updates;

    if (payload.password !== undefined) {
      if (payload.password === null || payload.password === '') {
        updates.passwordHash = '';
      } else {
        updates.passwordHash = PasswordService.hashPassword(payload.password);
      }
    }

    // Mint the shared secret the first time the relay is switched on, and
    // keep it afterwards: rotating it would invalidate every credential
    // already handed out, dropping the calls currently being relayed.
    if (updates.turnEnabled && !server.turnSecret) {
      updates.turnSecret = randomBytes(32).toString('hex');
    }

    // The new icon is recorded with the rest of the change, and the old file
    // only goes once that write succeeded (S-APP-9).
    const removeIcon = payload.iconBase64 !== undefined && (!payload.iconBase64 || payload.iconBase64.trim() === '');
    if (payload.iconBase64 && !removeIcon) {
      const icon = this.avatarStorage.decodeImage(payload.iconBase64);
      if (!icon.ok) return { success: false, errorMessage: icon.message };
      await this.avatarStorage.replaceImage(server.iconPath, icon,
        (iconPath) => this.serverRepo.updateServer({ ...updates, iconPath }));
    } else {
      if (removeIcon) updates.iconPath = null;
      await this.serverRepo.updateServer(updates);
      if (removeIcon && server.iconPath) this.avatarStorage.deleteAvatar(server.iconPath);
    }
    const updatedServer = await this.serverRepo.getServer() ?? server;
    return { success: true, settings: await this.settingsFor(updatedServer) };
  }
}
