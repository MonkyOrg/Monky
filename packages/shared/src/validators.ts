import { z } from 'zod';
import { LIMITS, PROTOCOL_VERSION } from './constants.js';
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
      parameters: z.record(z.union([z.string().max(1024), z.number().finite()]))
        .refine(value => Object.keys(value).length <= 64).optional(),
      rtcpFeedback: z.array(z.object({
        type: z.string().max(64), parameter: z.string().max(128).optional(),
      })).max(32).optional(),
    })).max(128).optional(),
    headerExtensions: z.array(z.object({
      kind: z.enum(['audio', 'video']),
      uri: z.enum([
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
      ]),
      preferredId: z.number().int().min(1).max(255),
      preferredEncrypt: z.boolean().optional(),
      direction: z.enum(['sendrecv', 'sendonly', 'recvonly', 'inactive']).optional(),
    })).max(64).optional(),
  }),
}).strict();
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
export const chatHistoryRequestSchema = z.object({
  channelId: messageReferenceSchema,
  limit: z.number().int().positive().optional(),
  beforeTimestamp: z.number().finite().nonnegative().optional(),
  aroundMessageId: messageReferenceSchema.optional(),
});

export const nicknameSchema = z
  .string()
  .min(LIMITS.MIN_NICKNAME_LENGTH, `Nickname deve ter pelo menos ${LIMITS.MIN_NICKNAME_LENGTH} caracteres`)
  .max(LIMITS.MAX_NICKNAME_LENGTH, `Nickname não pode exceder ${LIMITS.MAX_NICKNAME_LENGTH} caracteres`)
  .regex(/^[a-zA-Z0-9_\-\.\s]+$/, 'Nickname contém caracteres inválidos')
  .transform((val) => val.trim());

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
  // Bot token for bot authentication (#569). Mutually exclusive with the
  // challenge-response flow: when present the server skips the nonce handshake.
  botToken: z.string().min(1).max(128).optional(),
});

export const authChallengeResponseSchema = z.object({
  signature: z.string().regex(/^[a-fA-F0-9]+$/, 'Assinatura inválida'),
});

export const channelAllowedRoleIdsSchema = z
  .array(z.string().min(1, 'Cargo inválido'))
  .max(100, 'Cargos demais para um canal')
  .transform((ids) => Array.from(new Set(ids)));

export const channelCreateSchema = z.object({
  botCommandsEnabled: z.boolean().optional().default(true),
  name: channelNameSchema,
  type: z.enum(['VOICE', 'TEXT']),
  maxParticipants: z.number().int().min(1).max(50).optional().default(LIMITS.MAX_PARTICIPANTS_PER_CHANNEL_DEFAULT),
  isPrivate: z.boolean().optional().default(false),
  allowedRoleIds: channelAllowedRoleIdsSchema.optional().default([]),
});

// Editing a channel (#384). Only the fields present are changed, so `name` and
// `isPrivate` are optional here even though they are required on creation.
export const channelUpdateSchema = z.object({
  botCommandsEnabled: z.boolean().optional(),
  channelId: z.string().min(1, 'Canal inválido'),
  name: channelNameSchema.optional(),
  maxParticipants: z.number().int().min(1).max(50).optional(),
  isPrivate: z.boolean().optional(),
  allowedRoleIds: channelAllowedRoleIdsSchema.optional(),
});

// Reordenar os canais de um tipo (#471). A lista chega inteira, na ordem
// desejada; o limite acompanha o de canais por servidor e o `min(1)` recusa uma
// reordenação vazia, que só poderia vir de um payload malformado.
export const channelReorderSchema = z.object({
  type: z.enum(['VOICE', 'TEXT']),
  orderedIds: z
    .array(z.string().min(1, 'Canal inválido'))
    .min(1, 'Nenhum canal informado')
    .max(200, 'Canais demais'),
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

export const roleCreateSchema = z.object({
  name: roleNameSchema,
  color: roleColorSchema.default(null),
  permissions: permissionBitsSchema,
  position: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional().default(false),
});

export const roleUpdateSchema = z.object({
  roleId: z.string().min(1, 'Cargo inválido'),
  name: roleNameSchema.optional(),
  color: roleColorSchema,
  permissions: permissionBitsSchema.optional(),
  position: z.number().int().min(0).optional(),
  isDefault: z.boolean().optional(),
});

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
