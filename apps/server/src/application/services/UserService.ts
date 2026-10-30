import {
  ProtocolErrorCode,
  UserSummary,
  nicknameSchema,
  normalizePublicKeyHex,
} from '@monky/shared';
import { IUserRepository } from '../../domain/repositories';
import type { UserRecord } from '../../domain/entities';
import { AvatarStorageService, publicImageUrl } from '../../infrastructure/security/AvatarStorageService';
import { Logger } from '../../infrastructure/logger/Logger';

export class UserService {
  constructor(
    private userRepo: IUserRepository,
    private avatarStorage: AvatarStorageService,
    private getActiveOnlineUsers: () => Map<string, { user: UserSummary }>
  ) {}

  public async isMember(userId: string): Promise<boolean> {
    return (await this.userRepo.findById(userId)) !== null;
  }

  /** Current nicknames by id; unknown ids are left out. */
  public async nicknames(userIds: readonly string[]): Promise<Map<string, string>> {
    if (userIds.length === 0) return new Map();
    return new Map((await this.userRepo.findByIds([...new Set(userIds)])).map((user) => [user.id, user.nickname]));
  }

  public async changeNickname(
    userId: string,
    newNickname: string
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string; updatedUser?: UserSummary }> {
    const parseResult = nicknameSchema.safeParse(newNickname);
    if (!parseResult.success) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.NICKNAME_INVALID,
        errorMessage: parseResult.error.errors[0]?.message || 'Nickname inválido',
      };
    }

    const trimmed = parseResult.data;
    const onlineMap = this.getActiveOnlineUsers();

    // Check if another active online user has this nickname
    for (const [_, session] of onlineMap.entries()) {
      if (session.user.id !== userId && session.user.nickname.toLowerCase() === trimmed.toLowerCase()) {
        return {
          success: false,
          errorCode: ProtocolErrorCode.NICKNAME_ALREADY_EXISTS,
          errorMessage: 'Nickname indisponível ou já em uso.',
        };
      }
    }

    const user = await this.userRepo.findById(userId);
    if (!user) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.UNAUTHORIZED,
        errorMessage: 'Usuário não encontrado',
      };
    }

    await this.userRepo.update(userId, { nickname: trimmed });
    user.nickname = trimmed;

    return {
      success: true,
      updatedUser: toUserSummary(user, 'ONLINE', user.lastSeenAt),
    };
  }

  public async deleteMember(
    userId: string
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string; nickname?: string }> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.BAD_REQUEST,
        errorMessage: 'Usuário não encontrado.',
      };
    }

    // The record goes first: a member who cannot be removed keeps their picture.
    await this.userRepo.delete(userId);
    if (user.avatarPath) {
      this.avatarStorage.deleteAvatar(user.avatarPath);
    }
    Logger.info('NETWORK', `Member ${user.nickname} (${userId}) removed from the server`);

    return { success: true, nickname: user.nickname };
  }

  public async updateAvatar(
    userId: string,
    avatarBase64OrDataUrl: string | null | undefined
  ): Promise<{ success: boolean; errorCode?: ProtocolErrorCode; errorMessage?: string; updatedUser?: UserSummary }> {
    const user = await this.userRepo.findById(userId);
    if (!user) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.UNAUTHORIZED,
        errorMessage: 'Usuário não encontrado',
      };
    }

    // Handle avatar removal
    if (!avatarBase64OrDataUrl || avatarBase64OrDataUrl.trim() === '') {
      await this.userRepo.update(userId, { avatarPath: null });
      if (user.avatarPath) {
        this.avatarStorage.deleteAvatar(user.avatarPath);
      }
      user.avatarPath = null;
      return { success: true, updatedUser: toUserSummary(user, 'ONLINE', user.lastSeenAt) };
    }

    const image = this.avatarStorage.decodeImage(avatarBase64OrDataUrl);
    if (!image.ok) {
      return { success: false, errorCode: image.code, errorMessage: image.message };
    }

    user.avatarPath = await this.avatarStorage.replaceImage(user.avatarPath, image,
      (filename) => this.userRepo.update(userId, { avatarPath: filename }));
    return { success: true, updatedUser: toUserSummary(user, 'ONLINE', user.lastSeenAt) };
  }
}

/**
 * A stored member as the others see them. Every summary built from a member
 * record comes from here (S-APP-10); `session` names the connection when the
 * summary describes one.
 */
export function toUserSummary(
  user: UserRecord, status: UserSummary['status'], joinedAt: number, session?: { sessionId: string; connectedAt: number },
): UserSummary {
  return {
    id: user.id,
    clientId: user.clientId,
    publicKey: user.publicKey ? normalizePublicKeyHex(user.publicKey) : undefined,
    nickname: user.nickname,
    avatarUrl: publicImageUrl(user.avatarPath),
    status,
    joinedAt,
    ...(session ? { sessionId: session.sessionId, connectedAt: session.connectedAt } : {}),
  };
}
