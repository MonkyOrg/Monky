import { z } from 'zod';

const id = z.string().min(1).max(256);
const token = z.string().min(1).max(256).regex(/^[A-Za-z0-9+/_:.-]+$/);
export const botVoiceContextRequestSchema = z.object({ invocationId: id }).strict();
export const botVoiceContextResultSchema = z.object({
  invocationId: id, voiceChannelId: id.nullable(),
}).strict();
export type BotVoiceContextRequest = z.infer<typeof botVoiceContextRequestSchema>;
export type BotVoiceContextResult = z.infer<typeof botVoiceContextResultSchema>;
export const botVoiceJoinOptionsSchema = z.object({
  invocationId: id.optional(),
  receiveAudio: z.boolean().optional(),
}).strict();
export type BotVoiceJoinOptions = z.infer<typeof botVoiceJoinOptionsSchema>;
export const botVoiceJoinSchema = botVoiceJoinOptionsSchema.extend({
  channelId: id, isMuted: z.boolean().optional(), isDeafened: z.boolean().optional(),
}).strict();
export const botVoiceChannelSchema = z.object({ channelId: id });
export const botVoiceStateUpdateSchema = z.object({
  isMuted: z.boolean().optional(), isDeafened: z.boolean().optional(), isSpeaking: z.boolean().optional(),
}).strict();
export function isReceivingBotVoice(state: {
  receivesVoice?: boolean; isDeafened?: boolean; serverDeafened?: boolean;
} | null | undefined): boolean {
  return state?.receivesVoice === true && !state.isDeafened && !state.serverDeafened;
}
export const botVoiceAuthSchema = z.object({
  currentUser: z.object({ id, sessionId: id }),
  server: z.object({ voiceMode: z.enum(['p2p', 'sfu']) }),
  iceServers: z.array(z.object({
    urls: z.array(z.string().min(1).max(2048)).max(16),
    username: z.string().max(512).optional(),
    credential: z.string().max(512).optional(),
  })).max(16),
});
export type BotVoiceAuth = z.infer<typeof botVoiceAuthSchema>;

export const botVoiceParticipantSchema = z.object({
  user: z.object({ id, sessionId: id.optional(), isBot: z.boolean().optional() }),
  voiceState: z.object({
    sessionId: id, channelId: id,
    isMuted: z.boolean().optional(), isDeafened: z.boolean().optional(), receivesVoice: z.boolean().optional(),
    botVoicePermissions: z.object({
      publish: z.boolean(), receive: z.boolean(),
      publishRequested: z.boolean(), receiveRequested: z.boolean(),
    }).optional(),
    serverMuted: z.boolean().optional(), serverDeafened: z.boolean().optional(),
  }),
});
export type BotVoiceParticipant = z.infer<typeof botVoiceParticipantSchema>;
export const botVoiceJoinedSchema = z.object({
  channelId: id, sessionId: id,
  user: botVoiceParticipantSchema.shape.user,
  voiceState: botVoiceParticipantSchema.shape.voiceState,
  participants: z.array(botVoiceParticipantSchema).max(1000).optional(),
});
export const botVoiceLeftSchema = z.object({ channelId: id, sessionId: id });
export const botVoiceSignalSchema = z.object({
  fromSessionId: id, targetSessionId: id,
  signalType: z.enum(['offer', 'answer', 'candidate', 'user-left', 'screen-audio-meta', 'screen-video-meta']),
  sdp: z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().min(1).max(128 * 1024) }).optional(),
  candidate: z.object({
    candidate: z.string().max(4096),
    sdpMid: z.string().max(256).nullable().optional(),
    sdpMLineIndex: z.number().int().min(0).max(64).nullable().optional(),
    usernameFragment: z.string().max(256).nullable().optional(),
  }).nullable().optional(),
});
export type BotVoiceSignal = z.infer<typeof botVoiceSignalSchema>;

/** Legacy publishing policy; reception always requires an explicit grant. */
export function isBotPublishSignalAllowed(input: unknown, fromBot: boolean): boolean {
  return isBotVoiceSignalAllowed(input, fromBot, { publish: true, receive: false });
}

/** A bot link negotiates one microphone, never screen media, video or data. */
export function isBotVoiceSignalAllowed(
  input: unknown, fromBot: boolean, permissions: { publish: boolean; receive: boolean },
): boolean {
  const parsed = botVoiceSignalSchema.safeParse(input);
  if (!parsed.success) return false;
  const signal = parsed.data;
  if (signal.signalType === 'candidate') return signal.candidate !== undefined;
  if (signal.signalType === 'user-left') return true;
  if ((signal.signalType !== 'offer' && signal.signalType !== 'answer') ||
      !signal.sdp || signal.sdp.type !== signal.signalType) return false;
  const sections: Array<{ kind: string; port: string; bundleOnly: boolean; directions: string[] }> = [];
  const sessionDirections: string[] = [];
  for (const rawLine of signal.sdp.sdp.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (line.startsWith('m=')) {
      const [kind, port] = line.slice(2).trim().split(/\s+/);
      if (!kind || !port || !/^\d+$/.test(port)) return false;
      sections.push({ kind, port, bundleOnly: false, directions: [] });
    } else if (line === 'a=bundle-only') {
      const section = sections.at(-1);
      if (!section) return false;
      section.bundleOnly = true;
    } else if (/^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) {
      (sections.at(-1)?.directions ?? sessionDirections).push(line.slice(2));
    }
  }
  if (!sections.length || sessionDirections.length > 1) return false;
  let audio = 0;
  return sections.every((section) => {
    if (section.directions.length > 1) return false;
    if (section.port === '0' && !section.bundleOnly) return true;
    const direction = section.directions[0] ?? sessionDirections[0] ?? 'sendrecv';
    if (direction === 'inactive') return true;
    if (section.kind !== 'audio' || ++audio !== 1) return false;
    const sends = direction === 'sendonly' || direction === 'sendrecv';
    const receives = direction === 'recvonly' || direction === 'sendrecv';
    return (!sends || (fromBot ? permissions.publish : permissions.receive)) &&
      (!receives || (fromBot ? permissions.receive : permissions.publish));
  });
}

export const botVoiceTransportSchema = z.object({
  transportOptions: z.object({
    id,
    iceParameters: z.object({ usernameFragment: token, password: token, iceLite: z.boolean().optional() }),
    iceCandidates: z.array(z.object({
      foundation: token, priority: z.number().int().nonnegative(),
      ip: z.string().ip(), protocol: z.enum(['udp', 'tcp']),
      port: z.number().int().min(1).max(65535), type: z.literal('host'),
      tcpType: z.enum(['active', 'passive', 'so']).optional(),
    })).min(1).max(32),
    dtlsParameters: z.object({
      fingerprints: z.array(z.object({
        algorithm: z.enum(['sha-256', 'sha-384', 'sha-512', 'sha-224', 'sha-1']),
        value: z.string().regex(/^[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){19,63}$/),
      })).min(1).max(8),
    }),
  }),
});
export type BotVoiceTransportOptions = z.infer<typeof botVoiceTransportSchema>['transportOptions'];

export const botVoiceProducerSchema = z.object({
  channelId: id, producerId: id, producerSessionId: id, kind: z.literal('audio'),
  appData: z.object({ mediaType: z.literal('mic') }),
});
export type BotVoiceProducer = z.infer<typeof botVoiceProducerSchema>;
export const botVoiceProducersSchema = z.object({
  channelId: id, producers: z.array(botVoiceProducerSchema).max(1000),
  participants: z.array(botVoiceParticipantSchema).max(1000),
});
export const botVoiceConsumerSchema = z.object({
  channelId: id, id, producerId: id, producerSessionId: id, kind: z.literal('audio'),
  appData: z.object({ mediaType: z.literal('mic') }),
  rtpParameters: z.object({
    codecs: z.array(z.object({
      mimeType: z.string().refine((value) => value.toLowerCase() === 'audio/opus'),
      payloadType: z.number().int().min(0).max(127),
      clockRate: z.literal(48000), channels: z.literal(2),
    })).length(1),
    encodings: z.array(z.object({ ssrc: z.number().int().min(1).max(0xffffffff) })).length(1),
  }),
});
export type BotVoiceConsumer = z.infer<typeof botVoiceConsumerSchema>;
