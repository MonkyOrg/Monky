import { z } from 'zod';
import { eventDefinitionSchema, eventSaveSchema, serverEventPublicSchema } from './serverCommunity.js';

const id = z.string().min(1).max(256);
export const AUTOMATION_CAPABILITIES = ['read', 'send_messages', 'create_events', 'control_calls'] as const;
export const automationCapabilitySchema = z.enum(AUTOMATION_CAPABILITIES);
const capabilities = z.array(automationCapabilitySchema).max(4);
const serverIds = z.array(id).max(128);
const session = z.object({ sessionRef: id }).strict();
const channel = session.extend({ channelId: id }).strict();
const message = z.object({ id, userId: id, content: z.string(), createdAt: z.number() }).strict();
const event = serverEventPublicSchema.pick({
  id: true, title: true, description: true, location: true, startsAt: true, endsAt: true,
  timeZone: true, status: true, audience: true,
}).strip();
const call = z.object({ sessionRef: id, channelId: id, isMuted: z.boolean(), health: z.string() }).strict().nullable();
const server = z.object({ sessionRef: id, serverId: id, name: z.string(), nickname: z.string() }).strict();

/** Model-facing descriptions; application UI uses the localized automation catalog. */
export const AUTOMATION_TOOLS = {
  get_state: {
    capability: 'read', description: 'Read the number of authorized connected Monky servers.',
    input: z.object({}).strict(), output: z.object({ connectedServers: z.number().int().nonnegative() }).strict(),
  },
  list_servers: {
    capability: 'read', description: 'List authorized connected servers. Use their sessionRef in subsequent calls; refresh after reconnecting.',
    input: z.object({}).strict(), output: z.object({ servers: z.array(server) }).strict(),
  },
  list_channels: {
    capability: 'read', description: 'List channels visible to the signed-in user on one authorized connection.',
    input: session, output: z.object({ channels: z.array(z.object({ id, name: z.string(), type: z.string() }).strict()) }).strict(),
  },
  list_members: {
    capability: 'read', description: 'List members known to this server connection, without credentials or device identifiers.',
    input: session, output: z.object({ members: z.array(z.object({ id, nickname: z.string(), status: z.string() }).strict()) }).strict(),
  },
  read_messages: {
    capability: 'read', description: 'Read a bounded text history page without opening the channel or marking messages read.',
    input: channel.extend({ limit: z.number().int().min(1).max(50).default(25), beforeTimestamp: z.number().nonnegative().optional() }).strict(),
    output: z.object({ messages: z.array(message).max(50), nextBeforeTimestamp: z.number().nullable() }).strict(),
  },
  send_message: {
    capability: 'send_messages', description: 'Send plain text as the signed-in user. Reuse clientMessageId on retries. An unknown outcome must be reconciled before retrying.',
    input: channel.extend({ content: z.string().trim().min(1), clientMessageId: z.string().uuid() }).strict(),
    output: z.object({ message }).strict(),
  },
  list_events: {
    capability: 'read', description: 'List visible scheduled and active events; excludes ended event history.',
    input: session, output: z.object({ events: z.array(event).max(200) }).strict(),
  },
  create_event: {
    capability: 'create_events', description: 'Create a single event using explicit epoch milliseconds, IANA timeZone, end time and location. Uses the app default audience. Never automatically retry an unknown outcome.',
    input: session.extend({ event: eventDefinitionSchema.omit({ audience: true, repeat: true })
      .extend({ endsAt: eventDefinitionSchema.shape.endsAt.unwrap() }).strict()
      .refine(event => eventSaveSchema.safeParse({ ...event, repeat: 'none' }).success, { message: 'Invalid event.' }) }).strict(),
    output: z.object({ event }).strict(),
  },
  get_call_state: {
    capability: 'read', description: 'Read the call only if its server is authorized; no audio is exposed.',
    input: z.object({}).strict(), output: z.object({ call }).strict(),
  },
  join_call: {
    capability: 'control_calls', description: 'Join a voice channel muted without capturing the microphone. Another active call must be explicitly left first. No audio reaches the assistant.',
    input: channel, output: z.object({ call }).strict(),
  },
  leave_call: {
    capability: 'control_calls', description: 'Leave exactly the specified call and release local media. Does not wait for a remote leave acknowledgement.',
    input: channel, output: z.object({ left: z.boolean() }).strict(),
  },
} as const;

export const automationCommandSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('get_state'), args: AUTOMATION_TOOLS.get_state.input }),
  z.object({ tool: z.literal('list_servers'), args: AUTOMATION_TOOLS.list_servers.input }),
  z.object({ tool: z.literal('list_channels'), args: AUTOMATION_TOOLS.list_channels.input }),
  z.object({ tool: z.literal('list_members'), args: AUTOMATION_TOOLS.list_members.input }),
  z.object({ tool: z.literal('read_messages'), args: AUTOMATION_TOOLS.read_messages.input }),
  z.object({ tool: z.literal('send_message'), args: AUTOMATION_TOOLS.send_message.input }),
  z.object({ tool: z.literal('list_events'), args: AUTOMATION_TOOLS.list_events.input }),
  z.object({ tool: z.literal('create_event'), args: AUTOMATION_TOOLS.create_event.input }),
  z.object({ tool: z.literal('get_call_state'), args: AUTOMATION_TOOLS.get_call_state.input }),
  z.object({ tool: z.literal('join_call'), args: AUTOMATION_TOOLS.join_call.input }),
  z.object({ tool: z.literal('leave_call'), args: AUTOMATION_TOOLS.leave_call.input }),
]);
export const automationErrorSchema = z.enum([
  'invalid_input', 'not_authorized', 'not_ready', 'disconnected', 'cancelled', 'unknown_outcome',
  'call_conflict', 'feature_unavailable', 'failed', 'port_unavailable', 'storage_failed',
]);
export type AutomationErrorCode = z.infer<typeof automationErrorSchema>;
export class AutomationError extends Error {
  constructor(readonly code: AutomationErrorCode) { super(code); }
}
export type AutomationCommand = z.infer<typeof automationCommandSchema>;
export type AutomationTool = AutomationCommand['tool'];
export type AutomationCapability = z.infer<typeof automationCapabilitySchema>;
export type AutomationData = z.infer<(typeof AUTOMATION_TOOLS)[AutomationTool]['output']>;
export type AutomationResult = { ok: true; data: AutomationData } | { ok: false; code: AutomationErrorCode };

export const automationConnectionSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(80), serverIds, capabilities,
}).strict();
export type AutomationConnection = z.infer<typeof automationConnectionSchema>;
export const automationGrantSchema = z.object({ serverIds, capabilities }).strict();
export type AutomationGrant = z.infer<typeof automationGrantSchema>;
export const automationRequestSchema = z.object({
  requestId: z.string().uuid(), command: automationCommandSchema, grant: automationGrantSchema,
}).strict();
export type AutomationRequest = z.infer<typeof automationRequestSchema>;
export interface AutomationReply { requestId: string; result: AutomationResult }
export const automationMutationSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('change_port') }).strict(),
  z.object({ action: z.literal('save'), connection: automationConnectionSchema.omit({ id: true }).extend({ id: z.string().uuid().optional() }) }).strict(),
  z.object({ action: z.literal('revoke'), id: z.string().uuid() }).strict(),
  z.object({ action: z.literal('rotate'), id: z.string().uuid() }).strict(),
]);
export type AutomationMutation = z.infer<typeof automationMutationSchema>;
export const automationAuditSchema = z.object({
  connection: z.string(), tool: z.enum(Object.keys(AUTOMATION_TOOLS) as [AutomationTool, ...AutomationTool[]]),
  destination: z.string(), timestamp: z.number(), result: z.enum(['completed', 'rejected', 'unknown']),
}).strict();
export interface AutomationSnapshot {
  enabled: boolean;
  url: string | null;
  error: AutomationErrorCode | null;
  connections: AutomationConnection[];
  audit: z.infer<typeof automationAuditSchema>[];
}
export interface AutomationMutationResult {
  snapshot: AutomationSnapshot;
  credential?: { id: string; token: string };
  error?: AutomationErrorCode;
}
