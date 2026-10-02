export function calendarDate(value: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(Number(y), Number(m) - 1, Number(d));
  return Number(y) >= 1 && date.getUTCFullYear() === Number(y)
    && date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d) ? date : null;
}

export function calendarValue(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

export function todayCalendarValue(now = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export function formatCalendarValue(value: string, locale: string): string {
  const date = calendarDate(value);
  if (!date) return '';
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  }).format(date).replaceAll('.', '');
}

export function dateFieldValue(input: HTMLInputElement): string {
  return input.dataset.datePicker !== undefined ? input.dataset.dateValue ?? '' : input.value;
}

export function setDateFieldValue(input: HTMLInputElement, value: string, locale: string): void {
  if (input.dataset.datePicker === undefined) {
    input.value = value;
    return;
  }
  input.dataset.dateValue = value;
  input.value = formatCalendarValue(value, locale);
}

export function shiftCalendarMonth(date: Date, delta: number): Date {
  const result = new Date(date);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + delta + 1);
  result.setUTCDate(0);
  result.setUTCDate(Math.min(date.getUTCDate(), result.getUTCDate()));
  return result;
}

export function quarterHourOptions(): string[] {
  return Array.from({ length: 96 }, (_, index) =>
    `${String(Math.floor(index / 4)).padStart(2, '0')}:${String((index % 4) * 15).padStart(2, '0')}`);
}
