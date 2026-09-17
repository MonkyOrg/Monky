import { z } from 'zod';
import { botPermissionsSchema } from './botPermissions.js';

export const DEVELOPMENT_QA_SCENARIOS = ['connected', 'server-settings', 'voice', 'music', 'home', 'login', 'bot-install', 'tool-consent'] as const;
export type DevelopmentQaScenario = typeof DEVELOPMENT_QA_SCENARIOS[number];

const loopbackManifest = z.string().max(2048).refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port &&
      url.pathname === '/manifest' && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, 'QA bot manifests must belong to a loopback service owned by the launcher.');

export const developmentQaConfigSchema = z.object({
  runId: z.string().uuid(),
  scenario: z.enum(DEVELOPMENT_QA_SCENARIOS),
  smoke: z.boolean(),
  nickname: z.string().min(2).max(32),
  server: z.object({
    host: z.literal('127.0.0.1'),
    port: z.number().int().min(1024).max(65535),
    name: z.string().min(1).max(50),
    password: z.string().min(16).max(128),
  }).strict(),
  bot: z.object({
    kind: z.enum(['sdk-fixture', 'production']),
    manifestUrl: loopbackManifest,
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (['voice', 'music', 'bot-install', 'tool-consent'].includes(value.scenario) && !value.bot) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'This QA scenario requires a bot.' });
  }
  if (value.scenario === 'music' && value.bot?.kind !== 'production') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Music QA requires the explicit production MonkyBot checkout, never an SDK fixture.' });
  }
  if (['home', 'login'].includes(value.scenario) && value.bot) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Home/login QA must not install a bot before the tested login.' });
  }
});
export type DevelopmentQaConfig = z.infer<typeof developmentQaConfigSchema>;

export const developmentQaReportSchema = z.object({
  runId: z.string().uuid(),
  scenario: z.enum(DEVELOPMENT_QA_SCENARIOS),
  phase: z.enum(['connected', 'voice-joined', 'waiting-consent', 'ready', 'failed']),
  connected: z.boolean(),
  serverId: z.string().max(256).optional(),
  userId: z.string().max(256).optional(),
  textChannelId: z.string().max(256).optional(),
  voiceChannelId: z.string().max(256).optional(),
  botId: z.string().max(256).optional(),
  botPermissions: botPermissionsSchema.optional(),
  commandCount: z.number().int().nonnegative().optional(),
  peers: z.number().int().nonnegative().optional(),
  muted: z.boolean().optional(),
  localConsentCount: z.number().int().nonnegative().optional(),
  localToolStatus: z.enum(['absent', 'installing', 'ready', 'invalid', 'removing', 'failed']).optional(),
  error: z.string().max(2000).optional(),
}).strict();
export type DevelopmentQaReport = z.infer<typeof developmentQaReportSchema>;
