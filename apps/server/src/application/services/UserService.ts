import {
  ProtocolErrorCode,
  UserSummary,
  nicknameSchema,
} from '@monky/shared';
import { IUserRepository } from '../../domain/repositories';
import { AvatarStorageService } from '../../infrastructure/security/AvatarStorageService';
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

    const updatedUser: UserSummary = {
      id: user.id,
      clientId: user.clientId,
      nickname: user.nickname,
      avatarUrl: this.avatarStorage.getPublicUrl(user.avatarPath),
      status: 'ONLINE',
      joinedAt: user.lastSeenAt,
    };

    return {
      success: true,
      updatedUser,
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

    if (user.avatarPath) {
      this.avatarStorage.deleteAvatar(user.avatarPath);
    }

    await this.userRepo.delete(userId);
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
      if (user.avatarPath) {
        this.avatarStorage.deleteAvatar(user.avatarPath);
      }
      await this.userRepo.update(userId, { avatarPath: null });
      user.avatarPath = null;

      const updatedUser: UserSummary = {
        id: user.id,
        clientId: user.clientId,
        nickname: user.nickname,
        avatarUrl: null,
        status: 'ONLINE',
        joinedAt: user.lastSeenAt,
      };

      return {
        success: true,
        updatedUser,
      };
    }

    // Extract base64
    let rawBase64 = avatarBase64OrDataUrl;
    if (avatarBase64OrDataUrl.includes(',')) {
      rawBase64 = avatarBase64OrDataUrl.split(',')[1];
    }

    const buffer = Buffer.from(rawBase64, 'base64');
    const validation = this.avatarStorage.validateAvatarBuffer(buffer);

    if (!validation.isValid || !validation.extension) {
      return {
        success: false,
        errorCode: ProtocolErrorCode.AVATAR_INVALID_TYPE,
        errorMessage: validation.error || 'Formato de imagem inválido. Utilize PNG, JPEG ou WebP.',
      };
    }

    // Delete old avatar if exists
    if (user.avatarPath) {
      this.avatarStorage.deleteAvatar(user.avatarPath);
    }

    // Save new avatar safely
    const newFilename = await this.avatarStorage.saveAvatar(buffer, validation.extension);
    await this.userRepo.update(userId, { avatarPath: newFilename });
    user.avatarPath = newFilename;

    const updatedUser: UserSummary = {
      id: user.id,
      clientId: user.clientId,
      nickname: user.nickname,
      avatarUrl: this.avatarStorage.getPublicUrl(newFilename),
      status: 'ONLINE',
      joinedAt: user.lastSeenAt,
    };

    return {
      success: true,
      updatedUser,
    };
  }
}
