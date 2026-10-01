import assert from 'node:assert/strict';
import test from 'node:test';
import ICAL from 'ical.js';
import { rrulestr } from 'rrule';
import {
  createServerInviteLink, eventOccurrenceStart, eventTimeInZone, type EventCalendarExport,
} from '@monky/shared';
import { createEventCalendar } from '../src/main/serverEventCalendar';

function fixture(repeat: EventCalendarExport['event']['repeat'] = 'none', timeZone = 'UTC', start = '2026-01-31T10:00'): EventCalendarExport {
  const startsAt = eventTimeInZone(start, timeZone);
  return {
    serverId: 'server-123', serverName: 'Server', location: 'Voice',
    link: createServerInviteLink({ v: 1, host: 'localhost', port: 3000, eventId: 'event-123' }),
    event: { id: 'event-123', creatorUserId: 'user', title: 'Event', description: '', location: { kind: 'voice', channelId: 'voice' },
      startsAt, endsAt: startsAt + 3600000, anchorStartsAt: startsAt, timeZone, repeat, imageUrl: null, imageUrls: [],
      status: 'scheduled', revision: 0, occurrence: 0, createdAt: startsAt - 1000, startedAt: null, endedAt: null,
      interested: false, interestedCount: 0, audience: { visibility: 'public' } },
  };
}

function parse(contents: string) {
  ICAL.TimezoneService.reset();
  const calendar = new ICAL.Component(ICAL.parse(contents));
  for (const component of calendar.getAllSubcomponents('vtimezone')) ICAL.TimezoneService.register(component);
  return new ICAL.Event(calendar.getFirstSubcomponent('vevent')!);
}

test('calendar exports round-trip UTF-8 text, escapes, CRLF folding and stable identity', () => {
  const input = fixture();
  input.event.title = 'Café 🐵; reunião, ' + '🎉'.repeat(30);
  input.event.description = 'Backslash\\; comma,\r\nBEGIN:VEVENT\nEND:VEVENT';
  const output = createEventCalendar(input, input.event.createdAt);
  for (const line of output.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75);
  assert.ok(!output.replace(/\r\n/g, '').includes('\n'));
  const event = parse(output);
  assert.equal(event.summary, input.event.title);
  assert.equal(event.description, input.event.description.replace(/\r\n/g, '\n') + '\n\nServer');
  assert.equal(event.startDate.toUnixTime() * 1000, input.event.startsAt);
  assert.equal(event.endDate.toUnixTime() * 1000, input.event.endsAt);
  assert.equal(new ICAL.Component(ICAL.parse(output)).getAllSubcomponents('vevent').length, 1);
  assert.equal(parse(createEventCalendar({ ...input, event: { ...input.event, occurrence: 100 } })).uid, event.uid);
  assert.equal(parse(createEventCalendar({ ...input, event: { ...input.event, endsAt: null } })).component.hasProperty('duration'), false);
  assert.equal(parse(createEventCalendar({ ...input, event: { ...input.event, status: 'cancelled' } })).component.getFirstPropertyValue('status'), 'CANCELLED');
});

test('full recurring series matches server daily, weekly, monthly clamps and DST over multiple years', t => {
  // rrule represents floating dates relative to the process zone; use UTC for its independent expansion.
  const previousZone = process.env.TZ;
  process.env.TZ = 'UTC';
  t.after(() => { if (previousZone === undefined) delete process.env.TZ; else process.env.TZ = previousZone; });
  for (const [repeat, zone, start, count, compareEmbeddedZone = true] of [
    ['daily', 'America/New_York', '2026-03-07T10:00', 800],
    ['daily', 'America/New_York', '2026-03-07T02:30', 4, false],
    ['daily', 'America/New_York', '2026-10-31T01:30', 4, false],
    ['weekly', 'Europe/Berlin', '2026-03-21T10:00', 120],
    ['monthly', 'UTC', '2026-01-31T10:00', 36],
    ['monthly', 'America/Sao_Paulo', '2026-01-30T10:00', 36],
    ['daily', 'Asia/Calcutta', '2026-01-01T10:00', 20],
    ['monthly', 'UTC', '2026-01-28T10:00', 36],
    ['monthly', 'UTC', '2026-01-29T10:00', 36],
  ] as const) {
    const input = fixture(repeat, zone, start);
    input.event.occurrence = 4;
    input.event.startsAt = eventOccurrenceStart(input.event, 4);
    input.event.endsAt = input.event.startsAt + 3600000;
    const calendar = parse(createEventCalendar(input));
    const startProperty = calendar.component.getFirstProperty('dtstart')!;
    const recurrence = calendar.component.getFirstProperty('rrule')!;
    const dates = rrulestr(`${startProperty.toICALString()}\n${recurrence.toICALString()}`).all((_date, index) => index < count);
    const iterator = calendar.iterator();
    assert.equal(calendar.component.getFirstProperty('rrule')?.getFirstValue()?.toString().includes('COUNT='), false);
    for (let index = 0; index < count; index++) {
      assert.equal(dates[index].getTime(), eventOccurrenceStart(input.event, index), `${repeat}, ${zone}, occurrence ${index}`);
      // ical.js lacks BYSETPOS support and resolves DST gaps/folds differently; rrule checks those cases.
      if (compareEmbeddedZone && !recurrence.toICALString().includes('BYSETPOS')) {
        assert.equal(iterator.next()!.toUnixTime() * 1000, dates[index].getTime(), `Embedded VTIMEZONE: ${zone}, ${index}`);
      }
    }
  }
});

test('calendar export rejects mismatched links, credentials, invalid times and control injection', () => {
  const input = fixture();
  assert.throws(() => createEventCalendar({ ...input, link: 'https://example.com' }));
  assert.throws(() => createEventCalendar({ ...input, link: createServerInviteLink({
    v: 1, host: 'localhost', port: 3000, eventId: 'event-123', password: 'not-exportable',
  }) }));
  assert.throws(() => createEventCalendar({ ...input, event: { ...input.event, endsAt: input.event.startsAt } }));
  assert.throws(() => createEventCalendar({ ...input, event: { ...input.event, title: 'Null\0control' } }));
});
