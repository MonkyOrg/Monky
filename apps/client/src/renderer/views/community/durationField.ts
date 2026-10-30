import { t } from '../../i18n';
import { html, type SafeHtml } from '../../utils/html';

export type DurationUnit = 'minutes' | 'hours' | 'days';

const UNITS: readonly DurationUnit[] = ['minutes', 'hours', 'days'];
const MINUTES: Readonly<Record<DurationUnit, number>> = { minutes: 1, hours: 60, days: 1440 };
/** Each unit reaches the same longest duration: 30 days. */
const LONGEST: Readonly<Record<DurationUnit, number>> = { minutes: 43_200, hours: 720, days: 30 };

export function isDurationUnit(value: string | undefined): value is DurationUnit {
  return UNITS.some(unit => unit === value);
}

/** How many minutes `value` of `unit` lasts. */
export function durationMinutes(value: string, unit: DurationUnit): number {
  return Number(value) * MINUTES[unit];
}

/** The largest value the duration field accepts in `unit`. */
export function longestDuration(unit: DurationUnit): number {
  return LONGEST[unit];
}

interface NumberControl {
  /** Data attribute naming the input, such as `poll-duration` for `data-poll-duration`. */
  hook: string;
  value: string;
  min: number;
  max: number;
  label: string;
  placeholder?: string;
  disabled?: boolean;
}

/** A themed number field with − and + buttons, which `stepNumberControl` handles. */
export function renderNumberControl(control: NumberControl): SafeHtml {
  return html`<div class="native-poll-number-control">
    <input data-${control.hook} class="native-poll-number-input" type="number" inputmode="numeric"
      min="${control.min}" max="${control.max}" value="${control.value}" aria-label="${control.label}"
      placeholder="${control.placeholder ?? ''}" ${control.disabled ? 'disabled' : ''}>
    <button type="button" data-number-step="-1" aria-label="${t('poll.decrement', { field: control.label })}">
      <span class="material-symbols-outlined md-16">remove</span></button>
    <button type="button" data-number-step="1" aria-label="${t('poll.increment', { field: control.label })}">
      <span class="material-symbols-outlined md-16">add</span></button>
  </div>`;
}

/** The unit of a duration field: minutes, hours or days. */
export function renderDurationUnit(hook: string, unit: DurationUnit): SafeHtml {
  return html`<label>${t('poll.durationUnit')}<select class="input-field" data-${hook}>
    ${UNITS.map(value => html`<option value="${value}" ${unit === value ? 'selected' : ''}>${t(`poll.${value}`)}</option>`)}
  </select></label>`;
}

/**
 * Steps the field of a − or + button within its bounds; false when `target` is
 * not one. An empty optional field stays empty on −, and + starts it at its minimum.
 */
export function stepNumberControl(target: Element | null): boolean {
  const button = target?.closest<HTMLButtonElement>('[data-number-step]');
  const input = button?.closest('.native-poll-number-control')?.querySelector<HTMLInputElement>('input');
  if (!button || !input) return false;
  const delta = Number(button.dataset.numberStep);
  const current = input.valueAsNumber;
  if (!Number.isFinite(current) && delta < 0) return true;
  const next = Number.isFinite(current) ? current + delta : Number(input.min);
  input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), next)));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus({ preventScroll: true });
  return true;
}
