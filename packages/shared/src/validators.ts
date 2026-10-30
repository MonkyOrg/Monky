import { z } from 'zod';
import { ED25519_SPKI_PUBLIC_KEY_DER_HEX_LENGTH, ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX, LIMITS, PROTOCOL_VERSION } from './constants.js';
import { CHANNEL_PERMISSIONS, EVERYONE_ROLE_ID, LEGACY_CHANNEL_PERMISSIONS, channelPermissionTargetKey } from './permissions.js';
import { protocolOfferSchema } from './protocolCompatibility.js';
import { screenShareIdSchema, nativeScreenRenditionSchema } from './screenSharing.js';
export { screenShareIdSchema } from './screenSharing.js';

export const messageReferenceSchema = z.string().min(1).max(128);
export const rtcTransportPurposeSchema = z.enum(['call', 'screen']);
export const sfuCreateWebRtcTransportSchema = z.object({
  channelId: messageReferenceSchema,
  direction: z.enum(['send', 'recv']),
  purpose: rtcTransportPurposeSchema.default('call'),
  screenSessionId: z.string().uuid().optional(),
}).strict().refine(value => value.screenSessionId === undefined || value.purpose === 'screen');
export const screenWatchSignalSchema = z.object({
  fromSessionId: messageReferenceSchema,
  targetSessionId: messageReferenceSchema,
  signalType: z.literal('screen-watch'),
  streamId: screenShareIdSchema,
  subscriptionId: screenShareIdSchema,
  watcherSubscriptionId: screenShareIdSchema,
  subscriptionRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  watching: z.boolean(),
}).strict();
export const screenMetadataSignalSchema = z.object({
  fromSessionId: messageReferenceSchema,
  targetSessionId: messageReferenceSchema,
  signalType: z.enum(['screen-video-meta', 'screen-audio-meta']),
  streamId: screenShareIdSchema,
  subscriptionId: screenShareIdSchema,
}).strict();
export const rtcSignalSchema = z.union([
  screenWatchSignalSchema,
  screenMetadataSignalSchema,
  z.object({
    fromSessionId: messageReferenceSchema,
    targetSessionId: messageReferenceSchema,
    signalType: z.enum(['offer', 'answer', 'candidate', 'user-left']),
    subscriptionId: screenShareIdSchema.optional(),
    sdp: z.object({
      type: z.enum(['offer', 'answer', 'pranswer', 'rollback']),
      sdp: z.string().max(1024 * 1024).optional(),
    }).optional(),
    candidate: z.object({
      candidate: z.string().max(8192).optional(),
      sdpMid: z.string().max(128).nullable().optional(),
      sdpMLineIndex: z.number().int().min(0).max(65535).nullable().optional(),
      usernameFragment: z.string().max(256).nullable().optional(),
    }).optional(),
  }).strict().refine(value => (value.signalType !== 'offer' && value.signalType !== 'answer') || !!value.subscriptionId),
]);
export const sfuConsumerClosedSchema = z.object({
  channelId: messageReferenceSchema,
  consumerId: messageReferenceSchema,
}).strict();
export const sfuProducerClosedSchema = z.object({
  channelId: messageReferenceSchema,
  producerId: messageReferenceSchema,
}).strict();
export const sfuProducerSetPausedSchema = sfuProducerClosedSchema.extend({
  paused: z.boolean(),
  purpose: z.literal('screen'),
});
export const sfuCloseWebRtcTransportSchema = z.object({
  channelId: messageReferenceSchema,
  transportId: messageReferenceSchema,
  purpose: z.literal('screen'),
}).strict();
export const sfuConsumerSetPausedSchema = sfuConsumerClosedSchema.extend({
  paused: z.boolean(),
});
export const sfuMediaAppDataSchema = z.discriminatedUnion('mediaType', [
  z.object({ mediaType: z.literal('mic') }).strict(),
  z.object({ mediaType: z.literal('camera') }).strict(),
  z.object({
    mediaType: z.literal('screen_video'), shareId: screenShareIdSchema,
    nativeScreen: nativeScreenRenditionSchema.optional(),
  }).strict(),
  // Screen audio is a single publisher resource, not one consumer per screen.
  z.object({
    mediaType: z.literal('screen_audio'), shareId: screenShareIdSchema,
    nativeScreen: nativeScreenRenditionSchema.optional(),
  }).strict(),
]);
export type SfuMediaAppData = z.infer<typeof sfuMediaAppDataSchema>;
/** The only header extensions mediasoup serializes; it refuses any other URI. */
const SFU_RTP_HEADER_EXTENSION_URIS = [
  'urn:ietf:params:rtp-hdrext:sdes:mid',
  'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id',
  'urn:ietf:params:rtp-hdrext:sdes:repaired-rtp-stream-id',
  'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
  'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  'https://aomediacodec.github.io/av1-rtp-spec/#dependency-descriptor-rtp-header-extension',
  'urn:3gpp:video-orientation',
  'http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time',
  'urn:ietf:params:rtp-hdrext:toffset',
  'http://www.webrtc.org/experiments/rtp-hdrext/playout-delay',
  'urn:mediasoup:params:rtp-hdrext:packet-id',
] as const;
const sfuRtpHeaderExtensionUriSchema = z.enum(SFU_RTP_HEADER_EXTENSION_URIS);
const sfuRtpParameterValuesSchema = z.record(z.union([z.string().max(1024), z.number().finite()]))
  .refine(value => Object.keys(value).length <= 64);
const sfuRtcpFeedbackSchema = z.object({
  type: z.string().max(64), parameter: z.string().max(128).optional(),
});
export const sfuConsumeSchema = z.object({
  channelId: messageReferenceSchema,
  transportId: messageReferenceSchema,
  producerId: messageReferenceSchema,
  rtpCapabilities: z.object({
    codecs: z.array(z.object({
      kind: z.enum(['audio', 'video']),
      mimeType: z.string().min(1).max(128),
      preferredPayloadType: z.number().int().min(0).max(127),
      clockRate: z.number().int().positive(),
      channels: z.number().int().min(1).max(64).optional(),
      parameters: sfuRtpParameterValuesSchema.optional(),
      rtcpFeedback: z.array(sfuRtcpFeedbackSchema).max(32).optional(),
    })).max(128).optional(),
    headerExtensions: z.array(z.object({
      kind: z.enum(['audio', 'video']),
      uri: sfuRtpHeaderExtensionUriSchema,
      preferredId: z.number().int().min(1).max(255),
      preferredEncrypt: z.boolean().optional(),
      direction: z.enum(['sendrecv', 'sendonly', 'recvonly', 'inactive']).optional(),
    })).max(64).optional(),
  }),
}).strict();
export const sfuDtlsParametersSchema = z.object({
  role: z.enum(['auto', 'client', 'server']).optional(),
  fingerprints: z.array(z.object({
    algorithm: z.enum(['sha-1', 'sha-224', 'sha-256', 'sha-384', 'sha-512']),
    value: z.string().min(1).max(256),
  })).min(1).max(8),
});
export type SfuDtlsParameters = z.infer<typeof sfuDtlsParametersSchema>;
export const sfuConnectWebRtcTransportSchema = z.object({
  channelId: messageReferenceSchema,
  transportId: messageReferenceSchema,
  dtlsParameters: sfuDtlsParametersSchema,
});
/**
 * What a producer announces, bounded before it reaches mediasoup, which still
 * judges its meaning. Bounds follow the native engine's own (sfu_controller.cc).
 * Unlisted keys pass through: mediasoup may know them, and none is relayed.
 */
export const sfuRtpParametersSchema = z.object({
  mid: z.string().max(256).optional(),
  codecs: z.array(z.object({
    mimeType: z.string().min(1).max(128),
    payloadType: z.number().int().min(0).max(127),
    clockRate: z.number().int().positive(),
    channels: z.number().int().min(1).max(64).optional(),
    parameters: sfuRtpParameterValuesSchema.optional(),
    rtcpFeedback: z.array(sfuRtcpFeedbackSchema).max(32).optional(),
  }).passthrough()).max(32),
  headerExtensions: z.array(z.object({
    uri: sfuRtpHeaderExtensionUriSchema,
    id: z.number().int().min(1).max(255),
    encrypt: z.boolean().optional(),
    parameters: sfuRtpParameterValuesSchema.optional(),
  }).passthrough()).max(32).optional(),
  encodings: z.array(z.object({
    ssrc: z.number().int().min(0).max(0xffffffff).optional(),
    rid: z.string().max(64).optional(),
    codecPayloadType: z.number().int().min(0).max(127).optional(),
    rtx: z.object({ ssrc: z.number().int().min(0).max(0xffffffff) }).optional(),
    dtx: z.boolean().optional(),
    scalabilityMode: z.string().max(32).optional(),
    maxBitrate: z.number().nonnegative().optional(),
  }).passthrough()).max(16).optional(),
  rtcp: z.object({
    cname: z.string().max(256).optional(),
    reducedSize: z.boolean().optional(),
  }).passthrough().optional(),
  msid: z.string().max(256).optional(),
}).passthrough();
export type SfuRtpParameters = z.infer<typeof sfuRtpParametersSchema>;
export const sfuProduceSchema = z.object({
  channelId: messageReferenceSchema,
  transportId: messageReferenceSchema,
  kind: z.enum(['audio', 'video']),
  rtpParameters: sfuRtpParametersSchema,
  // Checked against the transport and the announced screens by the handler.
  appData: z.unknown().optional(),
});
export const adminVoiceRestrictionsGetSchema = z.object({
  targetUserId: messageReferenceSchema,
});
export const adminMuteUserSchema = adminVoiceRestrictionsGetSchema.extend({
  muted: z.boolean(),
});
export const adminDeafenUserSchema = adminVoiceRestrictionsGetSchema.extend({
  deafened: z.boolean(),
});
export const voiceRestrictionsUpdatedSchema = z.object({
  userId: messageReferenceSchema,
  serverMuted: z.boolean(),
  serverDeafened: z.boolean(),
  permissionMuted: z.boolean().optional(),
});

export const voiceModeTransitionSchema = z.object({
  id: messageReferenceSchema,
  from: z.literal('sfu'),
  to: z.literal('p2p'),
});
export const voiceReconnectSchema = z.object({
  channelId: messageReferenceSchema,
  transitionId: messageReferenceSchema,
  isMuted: z.boolean().optional(),
  isDeafened: z.boolean().optional(),
});
export const voiceAfkSchema = z.object({
  channelId: messageReferenceSchema,
}).strict();
/*
 * Voice payloads of human clients (S-VOICE-2). Not strict: an unknown key is
 * dropped instead of refusing a newer client, so nothing a client invents
 * lands in the voice state that is replayed to everyone in the room.
 */
export const voiceJoinSchema = z.object({
  channelId: messageReferenceSchema,
  isMuted: z.boolean().optional(),
  isDeafened: z.boolean().optional(),
});
export const voiceStateUpdateSchema = z.object({
  isMuted: z.boolean().optional(),
  isDeafened: z.boolean().optional(),
  isSpeaking: z.boolean().optional(),
  isCameraOn: z.boolean().optional(),
  isScreenSharing: z.boolean().optional(),
  isSharingScreenAudio: z.boolean().optional(),
  // The server keeps only well-formed ids, up to its own share limit.
  screenShareIds: z.array(z.string().max(64)).max(64).optional(),
  // Checked by the server against the share ids announced with it.
  nativeScreenShares: z.unknown().optional(),
});
export const adminKickVoiceSchema = z.object({
  targetSessionId: messageReferenceSchema,
});
export const adminMoveUserSchema = z.object({
  targetSessionId: messageReferenceSchema,
  channelId: messageReferenceSchema,
});
/** One printable line: a diagnostic only ever ends up in the server log (S-VOICE-8). */
const diagnosticTextSchema = (max: number) => z.string().max(max).regex(/^[\x20-\x7E]*$/);
export const rtcCandidateInfoSchema = z.object({
  type: diagnosticTextSchema(16),
  address: diagnosticTextSchema(64).optional(),
  port: z.number().int().min(0).max(65535).optional(),
  protocol: diagnosticTextSchema(8).optional(),
});
export const rtcDiagnosticsReportSchema = z.object({
  targetSessionId: diagnosticTextSchema(128).min(1),
  reason: diagnosticTextSchema(128),
  iceGatheringState: diagnosticTextSchema(32),
  signalingState: diagnosticTextSchema(32),
  iceRestartAttempts: z.number().int().min(0).max(10_000),
  hardReconnectAttempts: z.number().int().min(0).max(10_000),
  localCandidate: rtcCandidateInfoSchema.nullish(),
  remoteCandidate: rtcCandidateInfoSchema.nullish(),
});
export const chatHistoryRequestSchema = z.object({
  channelId: messageReferenceSchema,
  limit: z.number().int().positive().optional(),
  beforeTimestamp: z.number().finite().nonnegative().optional(),
  aroundMessageId: messageReferenceSchema.optional(),
});

export type NicknameIssue = 'too_short' | 'too_long' | 'invalid_characters';

// Any language, accent or emoji is welcome in a nickname (#567). Refused are the
// characters that render as nothing or rearrange the text around them — control,
// format and default-ignorable characters (zero-width spaces, bidirectional
// overrides, Hangul fillers), the blank Braille pattern, surrogate halves,
// private-use and unassigned code points, line separators — because they make
// a name invisible or let two different names look identical. `<` and `>` stay
// out as defence in depth.
const FORBIDDEN_NICKNAME_CHARACTER = /[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}<>]/u;
// The zero-width joiner and the emoji variation selectors are invisible as well,
// but they are what draws 👨‍👩‍👧 and ❤️ as emoji; only in that role do they pass.
const EMOJI_JOINER = /(?<=\p{Extended_Pictographic}[\p{Emoji_Modifier}\uFE0F]?)\u200D(?=\p{Extended_Pictographic})/gu;
const EMOJI_VARIATION = /(?<=\p{Emoji})[\uFE0E\uFE0F]/gu;

const NICKNAME_ISSUE_MESSAGES: Record<NicknameIssue, string> = {
  too_short: `Nickname deve ter pelo menos ${LIMITS.MIN_NICKNAME_LENGTH} caracteres`,
  too_long: `Nickname não pode exceder ${LIMITS.MAX_NICKNAME_LENGTH} caracteres`,
  // Not the old "caracteres inválidos": clients recognise an outdated server by that text.
  invalid_characters: 'Nickname contém caracteres invisíveis, de controle ou < >',
};

/** Stored form of a nickname: trimmed and in NFC, so a precomposed and a decomposed "João" are one name. */
export function normalizeNickname(nickname: string): string {
  return nickname.trim().normalize('NFC');
}

/** Why a server would refuse this nickname, or `null` when it is accepted. */
export function getNicknameIssue(nickname: string): NicknameIssue | null {
  const normalized = normalizeNickname(nickname);
  if (normalized.length < LIMITS.MIN_NICKNAME_LENGTH) return 'too_short';
  if (normalized.length > LIMITS.MAX_NICKNAME_LENGTH) return 'too_long';
  const visible = normalized.replace(EMOJI_JOINER, '').replace(EMOJI_VARIATION, '');
  return FORBIDDEN_NICKNAME_CHARACTER.test(visible) ? 'invalid_characters' : null;
}

export const nicknameSchema = z
  .string()
  .transform(normalizeNickname)
  .superRefine((nickname, context) => {
    const issue = getNicknameIssue(nickname);
    if (issue) context.addIssue({ code: z.ZodIssueCode.custom, message: NICKNAME_ISSUE_MESSAGES[issue] });
  });

export function createMessageContentSchema(limit: number = LIMITS.MAX_MESSAGE_LENGTH, allowEmpty = false) {
  return z.string().transform(value => value.trim())
    .refine(value => allowEmpty || value.length > 0, 'Mensagem não pode ser vazia')
    .refine(value => limit === 0 || value.length <= limit, `Mensagem não pode exceder ${limit} caracteres`)
    .refine(value => value.length <= LIMITS.WS_MAX_PAYLOAD_BYTES, 'Mensagem excede o limite de transporte');
}
export const messageContentSchema = createMessageContentSchema();

// Optional caption for an attachment message (#11). Unlike messageContentSchema
// it allows an empty string, because an attachments-only message carries no text.
export const attachmentCaptionSchema = createMessageContentSchema(LIMITS.MAX_MESSAGE_LENGTH, true);

export const channelNameSchema = z
  .string()
  .min(LIMITS.MIN_CHANNEL_NAME_LENGTH, `Nome do canal deve ter pelo menos ${LIMITS.MIN_CHANNEL_NAME_LENGTH} caracteres`)
  .max(LIMITS.MAX_CHANNEL_NAME_LENGTH, `Nome do canal não pode exceder ${LIMITS.MAX_CHANNEL_NAME_LENGTH} caracteres`)
  .transform((val) => val.trim());

export const portSchema = z
  .number()
  .int()
  .min(LIMITS.MIN_PORT, `Porta deve ser maior ou igual a ${LIMITS.MIN_PORT}`)
  .max(LIMITS.MAX_PORT, `Porta deve ser menor ou igual a ${LIMITS.MAX_PORT}`);

/** One line of visible text: no line breaks or control characters. */
const statusLine = (max: number) => z.string().trim().max(max)
  .refine((value) => !/\p{Cc}/u.test(value), 'Status com caracteres inválidos')
  .transform((value) => value || undefined);

/**
 * A single emoji grapheme as the picker yields it: pictographs plus their
 * modifiers, joiners, variation selectors and keycap or flag parts. Anything
 * else (letters, markup) is rejected, since it renders beside every name.
 */
const statusEmojiSchema = z.string().max(32)
  .regex(/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\p{Emoji_Presentation}|\u200d|\ufe0f|\u20e3)+$/u, 'Emoji inválido')
  // Emoji_Component also covers plain digits, # and *: require an actual pictograph, flag or keycap.
  .refine((value) => /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value), 'Emoji inválido')
  .refine((value) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].length === 1,
    'Use apenas um emoji');

export const customStatusSchema = z.object({
  text: statusLine(LIMITS.MAX_CUSTOM_STATUS_TEXT_LENGTH).optional(),
  emoji: statusEmojiSchema.optional(),
  tag: statusLine(LIMITS.MAX_CUSTOM_STATUS_TAG_LENGTH).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Cor inválida').transform((value) => value.toLowerCase()),
  showEmoji: z.boolean(),
  showTag: z.boolean(),
}).strict().transform(({ text, emoji, tag, ...status }) => ({
  ...status, ...(text ? { text } : {}), ...(emoji ? { emoji } : {}), ...(tag ? { tag } : {}),
}));

export const authConnectSchema = z.object({
  protocolVersion: z.number().int().positive(),
  protocolOffer: protocolOfferSchema.optional(),
  publicKey: z
    .string()
    .min(64, 'Chave pública inválida')
    .max(128, 'Chave pública inválida')
    .regex(/^[a-fA-F0-9]+$/, 'Chave pública deve estar em hexadecimal'),
  nickname: nicknameSchema,
  password: z.string().optional().default(''),
  // Per-installation id used to distinguish devices of the same person (#309).
  // Optional so the field can be absent; the server falls back to a random one.
  deviceId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,64}$/, 'Identificador de dispositivo inválido')
    .optional(),
  // Appear-offline visibility flag (#561). Optional for backward compatibility.
  appearOffline: z.boolean().optional(),
  // "Be right back" status (user-brb); applied only when the feature is negotiated.
  brb: z.boolean().optional(),
  // Custom status (custom-status); applied only when negotiated, and never with brb.
  customStatus: customStatusSchema.optional(),
  // Bot token for bot authentication (#569). Mutually exclusive with the
  // challenge-response flow: when present the server skips the nonce handshake.
  botToken: z.string().min(1).max(128).optional(),
});

export const authChallengeResponseSchema = z.object({
  signature: z.string().regex(/^[a-fA-F0-9]+$/, 'Assinatura inválida'),
});

export const ed25519SpkiPublicKeyHexSchema = z.string()
  .length(ED25519_SPKI_PUBLIC_KEY_DER_HEX_LENGTH, 'Chave pública inválida')
  .regex(/^[a-fA-F0-9]+$/, 'Chave pública deve estar em hexadecimal')
  .transform(value => value.toLowerCase())
  .refine(value => value.startsWith(ED25519_SPKI_PUBLIC_KEY_DER_PREFIX_HEX), 'Chave pública Ed25519 inválida');

export const dmRelayKindSchema = z.enum(['friend', 'envelope', 'file', 'signal']);
const dmRelayBaseItemSchema = z.object({
  to: ed25519SpkiPublicKeyHexSchema,
});
export const dmRelayItemSchema = z.discriminatedUnion('kind', [
  dmRelayBaseItemSchema.extend({
    kind: z.literal('friend'),
    data: z.string().max(LIMITS.DM_RELAY_DATA_MAX_LENGTH, 'Payload de DM muito grande'),
  }).strict(),
  dmRelayBaseItemSchema.extend({
    kind: z.literal('envelope'),
    data: z.string().max(LIMITS.DM_RELAY_DATA_MAX_LENGTH, 'Payload de DM muito grande'),
  }).strict(),
  dmRelayBaseItemSchema.extend({
    kind: z.literal('file'),
    data: z.string().max(LIMITS.DM_RELAY_FILE_DATA_MAX_LENGTH, 'Arquivo de DM muito grande'),
  }).strict(),
  dmRelayBaseItemSchema.extend({
    kind: z.literal('signal'),
    data: z.string().max(LIMITS.DM_RELAY_DATA_MAX_LENGTH, 'Payload de DM muito grande'),
  }).strict(),
]);
export const dmRelaySendSchema = z.object({
  relayId: z.string().min(1, 'Relay inválido').max(128, 'Relay inválido'),
  items: z.array(dmRelayItemSchema).min(1, 'Envie ao menos um item')
    .max(LIMITS.DM_RELAY_MAX_ITEMS, 'Itens demais no relay'),
}).strict().superRefine((value, ctx) => {
  const total = value.items.reduce((sum, item) => sum + item.data.length, 0);
  if (total > LIMITS.DM_RELAY_TOTAL_DATA_MAX_LENGTH) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Payload de DM muito grande',
      path: ['items'],
    });
  }
});

export const channelAllowedRoleIdsSchema = z
  .array(z.string().min(1, 'Cargo inválido'))
  .max(100, 'Cargos demais para um canal')
  .transform((ids) => Array.from(new Set(ids)));

const channelPermissionBitsSchema = z.number().int().min(0).max(CHANNEL_PERMISSIONS | LEGACY_CHANNEL_PERMISSIONS)
  .refine(bits => (bits & ~(CHANNEL_PERMISSIONS | LEGACY_CHANNEL_PERMISSIONS)) === 0, 'Permissão não aplicável ao canal')
  .transform(bits => (bits & CHANNEL_PERMISSIONS) >>> 0);
const channelPermissionBits = {
  allow: channelPermissionBitsSchema,
  deny: channelPermissionBitsSchema,
};
export const channelPermissionOverwritesSchema = z.array(z.union([
  z.object({
    roleId: z.string().min(1).max(128).refine(id => id !== EVERYONE_ROLE_ID).nullable(),
    ...channelPermissionBits,
  }).strict(),
  z.object({ userId: z.string().min(1).max(128), ...channelPermissionBits }).strict(),
]).refine(value => (value.allow & value.deny) === 0, 'Permissão conflitante'))
  .max(101)
  .refine(entries => new Set(entries.map(channelPermissionTargetKey)).size === entries.length, 'Alvo duplicado');

// 0 means no limit; servers before `voice-user-limit` also rejected 0.
export const voiceUserLimitSchema = z.number().int()
  .min(LIMITS.VOICE_USER_LIMIT_NONE, 'Limite de pessoas inválido')
  .max(LIMITS.VOICE_USER_LIMIT_MAX, `O limite de pessoas não pode passar de ${LIMITS.VOICE_USER_LIMIT_MAX}`);

export const channelCreateSchema = z.object({
  permissionOverwrites: channelPermissionOverwritesSchema.optional(),
  categoryId: z.string().min(1).nullable().optional().default(null),
  inheritCategoryPermissions: z.boolean().optional().default(true),
  botCommandsEnabled: z.boolean().optional().default(true),
  name: channelNameSchema,
  type: z.enum(['VOICE', 'TEXT', 'FORUM']),
  maxParticipants: voiceUserLimitSchema.optional().default(LIMITS.VOICE_USER_LIMIT_NONE),
  isPrivate: z.boolean().optional().default(false),
  allowedRoleIds: channelAllowedRoleIdsSchema.optional().default([]),
});

// Editing a channel (#384). Only the fields present are changed, so `name` and
// `isPrivate` are optional here even though they are required on creation.
export const channelUpdateSchema = z.object({
  permissionOverwrites: channelPermissionOverwritesSchema.optional(),
  categoryId: z.string().min(1).nullable().optional(),
  inheritCategoryPermissions: z.boolean().optional(),
  botCommandsEnabled: z.boolean().optional(),
  channelId: z.string().min(1, 'Canal inválido'),
  name: channelNameSchema.optional(),
  maxParticipants: voiceUserLimitSchema.optional(),
  isPrivate: z.boolean().optional(),
  allowedRoleIds: channelAllowedRoleIdsSchema.optional(),
});

// A category takes precedence over legacy type-scoped ordering. With
// `channel-tree-order`, a null category lists the whole root: loose channels
// and categories together.
export const channelReorderSchema = z.object({
  type: z.enum(['VOICE', 'TEXT', 'FORUM']).optional(),
  categoryId: z.string().min(1).nullable().optional(),
  orderedIds: z
    .array(z.string().min(1, 'Canal inválido'))
    .min(1, 'Nenhum canal informado')
    .max(500, 'Canais demais'),
}).refine((value) => value.type !== undefined || value.categoryId !== undefined, 'Informe uma categoria ou tipo');

export const categoryCreateSchema = z.object({
  permissionOverwrites: channelPermissionOverwritesSchema.optional(),
  name: channelNameSchema,
  isPrivate: z.boolean().optional().default(false),
  allowedRoleIds: channelAllowedRoleIdsSchema.optional().default([]),
});
export const categoryUpdateSchema = categoryCreateSchema.partial().extend({
  categoryId: z.string().min(1),
});
export const categoryDeleteSchema = z.object({ categoryId: z.string().min(1) });
export const categoryReorderSchema = z.object({
  orderedIds: z.array(z.string().min(1)).min(1).max(200),
});

export const roleNameSchema = z
  .string()
  .min(1, 'Nome do cargo é obrigatório')
  .max(32, 'Nome do cargo não pode exceder 32 caracteres')
  .transform((val) => val.trim());

export const roleColorSchema = z
  .string()
  .regex(/^#([0-9a-fA-F]{6})$/, 'Cor do cargo inválida')
  .nullable()
  .optional();

export const permissionBitsSchema = z
  .number()
  .int()
  .min(0, 'Permissões inválidas')
  .max(0xFFFFFFFF, 'Permissões inválidas');

const roleRuleConflict = (role: { permissions?: number; deny?: number }) =>
  role.permissions === undefined || role.deny === undefined || (role.permissions & role.deny) === 0;
const roleRuleConflictMessage = 'Uma permissão não pode ser permitida e negada ao mesmo tempo';

/** `permissions` are granted bits, or a full mask from a client before 36.1; `deny` comes only from 36.1 clients. */
export const roleCreateSchema = z.object({
  name: roleNameSchema,
  color: roleColorSchema.default(null),
  permissions: permissionBitsSchema,
  deny: permissionBitsSchema.optional(),
  position: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional().default(false),
}).refine(roleRuleConflict, roleRuleConflictMessage);

export const roleUpdateSchema = z.object({
  roleId: z.string().min(1, 'Cargo inválido'),
  name: roleNameSchema.optional(),
  color: roleColorSchema,
  permissions: permissionBitsSchema.optional(),
  deny: permissionBitsSchema.optional(),
  position: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional(),
}).refine(roleRuleConflict, roleRuleConflictMessage);

export const roleAssignmentSchema = z.object({
  userId: z.string().min(1, 'Usuário inválido'),
  roleId: z.string().min(1, 'Cargo inválido'),
});

export const voiceModeSchema = z.enum(['p2p', 'sfu']);

export function isValidNickname(nickname: string): boolean {
  return nicknameSchema.safeParse(nickname).success;
}

export function isValidMessageContent(content: string): boolean {
  return messageContentSchema.safeParse(content).success;
}

/**
 * Game presence and lobby invites (#675).
 */
/**
 * The icon is checked by shape, not merely by length: base64 of a JPEG always
 * begins with `/9j/` (the FF D8 FF magic), so anything else never reaches an
 * `<img src>`. Deliberately not a data URI — the prefix is added by the client
 * that renders it, the same way the `steam://` URL is rebuilt rather than
 * accepted ready-made.
 */
const activityIconSchema = z.string()
  .max(LIMITS.MAX_ACTIVITY_ICON_LENGTH)
  .regex(/^\/9j\/[A-Za-z0-9+/]*={0,2}$/, 'Ícone de atividade inválido');

export const userActivitySchema = z.object({
  source: z.literal('steam'),
  appId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  name: z.string().min(1).max(LIMITS.MAX_ACTIVITY_NAME_LENGTH),
  // Stamped by the player's own clock, so the reader clamps the elapsed time
  // instead of trusting it: a skewed clock must not show a negative counter.
  startedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  iconBase64: activityIconSchema.optional(),
}).strict();

export const userUpdateActivitySchema = z.object({
  activity: userActivitySchema.nullable(),
}).strict();

export const userUpdateBrbSchema = z.object({
  brb: z.boolean(),
}).strict();

export const userUpdateCustomStatusSchema = z.object({
  customStatus: customStatusSchema.nullable(),
}).strict();

export const gameShareRequestSchema = z.object({
  targetUserId: messageReferenceSchema,
}).strict();

export const gameShareResponseSchema = z.object({
  shareRequestId: z.string().uuid(),
  accepted: z.boolean(),
}).strict();

