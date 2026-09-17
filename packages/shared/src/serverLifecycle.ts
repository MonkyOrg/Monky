import { z } from 'zod';

export const serverShutdownReasonSchema = z.enum(['stopped', 'update']);
export type ServerShutdownReason = z.infer<typeof serverShutdownReasonSchema>;

export const serverShutdownSchema = z.object({
  reasonCode: serverShutdownReasonSchema.optional(),
  reason: z.string().max(1000).optional(),
}).strict();
