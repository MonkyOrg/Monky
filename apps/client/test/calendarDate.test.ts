import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calendarDate, calendarValue, quarterHourOptions, shiftCalendarMonth } from '../src/renderer/utils/calendarDate';

test('calendar values preserve date components independently of the local timezone', () => {
  for (const value of ['2024-02-29', '2026-12-31', '2027-01-01', '0001-01-01', '0099-12-31', '9999-12-31']) {
    const parsed = calendarDate(value);
    assert.ok(parsed);
    assert.equal(calendarValue(parsed), value);
  }
  for (const value of ['', '2025-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '0000-01-01', '2026-1-01', 'not-a-date']) {
    assert.equal(calendarDate(value), null, value);
  }
});

test('calendar month navigation clamps the day without crossing the requested month', () => {
  assert.equal(calendarValue(shiftCalendarMonth(calendarDate('2024-01-31')!, 1)), '2024-02-29');
  assert.equal(calendarValue(shiftCalendarMonth(calendarDate('2025-01-31')!, 1)), '2025-02-28');
  assert.equal(calendarValue(shiftCalendarMonth(calendarDate('2026-03-31')!, -1)), '2026-02-28');
  assert.equal(calendarValue(shiftCalendarMonth(calendarDate('2026-12-31')!, 1)), '2027-01-31');
});

test('time suggestions cover a day without imposing a constraint on typed minutes', () => {
  const options = quarterHourOptions();
  assert.equal(options.length, 96);
  assert.equal(new Set(options).size, 96);
  assert.equal(options[0], '00:00');
  assert.equal(options.at(-1), '23:45');
  assert.equal(options.includes('17:07'), false);
  assert.equal(options[68], '17:00');
  assert.equal(options[69], '17:15');
});
