import { LIMITS, type ServerDetails, type ServerUpdateSettingsPayload } from '@monky/shared';

type ValidationError =
  | 'serverSettings.nameInvalid'
  | 'serverSettings.passwordInvalid'
  | 'serverSettings.memberLimitInvalid'
  | 'serverSettings.memberLimitBelowCurrent'
  | 'serverSettings.storageLimitInvalid'
  | 'serverSettings.limitError'
  | 'serverSettings.turnBlockedBySfu'
  | 'serverSettings.turnUnknownSupport'
  | 'serverSettings.turnUnsupportedPlatform'
  | 'serverSettings.turnNotInstalled';

export function serverSettingsValidationError(
  patch: ServerUpdateSettingsPayload,
  persisted: ServerDetails,
  registeredMembers?: number,
): ValidationError | null {
  if (patch.name !== undefined && (patch.name.trim().length < 2 || patch.name.trim().length > 50)) {
    return 'serverSettings.nameInvalid';
  }
  if (typeof patch.password === 'string' && !patch.password.trim()) return 'serverSettings.passwordInvalid';
  if (patch.maxUsers !== undefined) {
    if (!Number.isSafeInteger(patch.maxUsers) || patch.maxUsers < 0) return 'serverSettings.memberLimitInvalid';
    const members = registeredMembers ?? new Set([...(persisted.knownMembers ?? []), ...persisted.members].map((member) => member.id)).size;
    if (patch.maxUsers > 0 && patch.maxUsers < members) return 'serverSettings.memberLimitBelowCurrent';
  }
  if (patch.maxAttachmentFileBytes !== undefined || patch.maxAttachmentStorageBytes !== undefined) {
    const file = patch.maxAttachmentFileBytes ?? persisted.attachmentStorage?.maxFileBytes ?? LIMITS.MAX_ATTACHMENT_FILE_SIZE_DEFAULT;
    const total = patch.maxAttachmentStorageBytes ?? persisted.attachmentStorage?.maxTotalBytes ?? LIMITS.MAX_ATTACHMENT_STORAGE_TOTAL_DEFAULT;
    if (!Number.isSafeInteger(file) || !Number.isSafeInteger(total) || file < 1 || total < 1) {
      return 'serverSettings.storageLimitInvalid';
    }
    if (file > total) return 'serverSettings.limitError';
  }
  if (patch.turnEnabled === true) {
    if (persisted.voiceMode === 'sfu') return 'serverSettings.turnBlockedBySfu';
    const availability = persisted.turnAvailability;
    if (!availability) return 'serverSettings.turnUnknownSupport';
    if (!availability.supported) {
      if (availability.reason !== 'not-installed') return 'serverSettings.turnUnsupportedPlatform';
      if (!availability.autoInstallable) return 'serverSettings.turnNotInstalled';
    }
  }
  return null;
}
