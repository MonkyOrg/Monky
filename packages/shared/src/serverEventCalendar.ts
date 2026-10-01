import { z } from 'zod';
import { serverEventPublicSchema } from './serverCommunity.js';
import { parseServerInviteLink } from './serverInvites.js';

export const eventCalendarExportSchema = z.object({
  event: serverEventPublicSchema,
  serverId: z.string().min(1).max(128),
  serverName: z.string().min(1).max(100),
  location: z.string().max(500),
  link: z.string().max(16384),
}).strict().superRefine((value, context) => {
  const parsed = parseServerInviteLink(value.link);
  if (!parsed.ok || parsed.invite.eventId !== value.event.id || parsed.invite.password !== undefined) {
    context.addIssue({ code: 'custom', path: ['link'], message: 'A password-free link to this event is required.' });
  }
});
export type EventCalendarExport = z.infer<typeof eventCalendarExportSchema>;
export type EventCalendarSaveResult = { status: 'saved' | 'cancelled' } | { status: 'failed'; error: string };
export const EVENT_CALENDAR_IPC = 'community:save-event-calendar' as const;
