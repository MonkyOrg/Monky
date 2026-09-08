import { z } from 'zod';

export const botCommandContextSchema = z.object({
  invocationId: z.string().min(1).max(128),
  commandName: z.string().min(1).max(128),
  invokerId: z.string().min(1).max(128),
  invokerNickname: z.string().min(1).max(128),
  invokerAvatarUrl: z.string().nullable().optional(),
}).strict();
