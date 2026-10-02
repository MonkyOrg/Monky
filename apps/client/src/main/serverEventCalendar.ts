import { eventCalendarExportSchema, type EventCalendarExport } from '@monky/shared';
import { tzlib_get_ical_block } from 'timezones-ical-library';

const text = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\r\n|\r|\n/g, '\\n').replace(/;/g, '\\;').replace(/,/g, '\\,');
const utc = (value: number): string => {
  const formatted = new Date(value).toISOString();
  if (!/^\d{4}-/.test(formatted)) throw new Error('Unsupported calendar date.');
  return formatted.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
};

function localDate(time: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(time).map(part => [part.type, part.value]));
  return `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`;
}

function fold(line: string): string {
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line)) throw new Error('Unsupported calendar control character.');
  const lines: string[] = [];
  let current = '', bytes = 0;
  for (const character of line) {
    const length = Buffer.byteLength(character, 'utf8');
    if (bytes + length > 75) { lines.push(current); current = ' '; bytes = 1; }
    current += character;
    bytes += length;
  }
  lines.push(current);
  return lines.join('\r\n');
}

export function createEventCalendar(input: EventCalendarExport, now = Date.now()): string {
  const { event, serverId, serverName, location, link } = eventCalendarExportSchema.parse(input);
  const recurring = event.repeat !== 'none';
  const startsAt = recurring ? event.anchorStartsAt : event.startedAt ?? event.startsAt;
  const endsAt = event.status === 'ended' && !recurring ? event.endedAt ?? event.endsAt : event.endsAt;
  const duration = endsAt === null ? null : endsAt - (recurring ? event.startsAt : startsAt);
  if (duration !== null && duration <= 0) throw new Error('The event end must follow its start.');
  if (recurring && duration === null) throw new Error('Recurring events require a duration.');
  const zone = new Intl.DateTimeFormat('en', { timeZone: event.timeZone }).resolvedOptions().timeZone;
  const timezone = recurring && zone !== 'UTC' ? tzlib_get_ical_block(zone) : null;
  if (recurring && zone !== 'UTC' && (!Array.isArray(timezone) || timezone.length !== 2 || !timezone[1].startsWith('TZID='))) {
    throw new Error('Unsupported calendar time zone.');
  }
  const date = recurring && zone !== 'UTC' ? localDate(startsAt, zone) : utc(startsAt);
  const start = timezone ? `DTSTART;${timezone[1]}:${date}` : `DTSTART:${date}`;
  const day = Number(localDate(event.anchorStartsAt, zone).slice(6, 8));
  // BYSETPOS selects the earlier of the anchor day and month's last day, matching the server's clamp.
  const monthly = day === 31 ? 'BYMONTHDAY=-1' : day <= 28 ? `BYMONTHDAY=${day}` : `BYMONTHDAY=${day},-1;BYSETPOS=1`;
  const rule = event.repeat === 'monthly' ? `FREQ=MONTHLY;${monthly}`
    : event.repeat === 'weekly' ? 'FREQ=WEEKLY' : 'FREQ=DAILY';
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Monky//Events//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    ...(timezone ? timezone[0].trim().split(/\r?\n/) : []),
    'BEGIN:VEVENT', `UID:${text(`${event.id}@${serverId}.monky`)}`, `DTSTAMP:${utc(now)}`, start,
    ...(duration === null ? [] : [`DURATION:PT${Math.ceil(duration / 1000)}S`]),
    ...(recurring ? [`RRULE:${rule}`] : []),
    `SEQUENCE:${event.revision}`, `SUMMARY:${text(event.title)}`,
    `DESCRIPTION:${text(`${event.description}\n\n${serverName}`)}`, `LOCATION:${text(location)}`, `URL:${link}`,
    `STATUS:${event.status === 'cancelled' ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT', 'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n';
}
