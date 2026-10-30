import type { NativeLiveForm, NativeLiveFormResults } from '@monky/shared';
import { t } from '../../i18n';

export type FormResponse = NativeLiveFormResults['responses'][number];
type FormField = NativeLiveForm['form']['fields'][number];

/** Something other than nothing, an empty text or an empty list. */
function isAnswer(value: unknown): boolean {
  return value !== undefined && value !== '' && (!Array.isArray(value) || value.length > 0);
}

/** The responses that answered `field`. */
export function answeredResponses(responses: readonly FormResponse[], field: FormField): FormResponse[] {
  return responses.filter(entry => isAnswer(entry.response.values[field.name]));
}

/** An answer as a person reads it: the label of a choice, on or off, the stars. */
export function answerLabel(form: NativeLiveForm, name: string, value: unknown): string {
  const field = form.form.fields.find(entry => entry.name === name);
  if (!isAnswer(value)) return t('liveForm.noAnswer');
  if (field?.type === 'boolean') return t(value === true ? 'botChat.switchOn' : 'botChat.switchOff');
  if (field?.type === 'select') {
    return field.choices.find(choice => choice.value === value)?.label ?? String(value ?? '');
  }
  if (field?.type === 'multi-select' && Array.isArray(value)) {
    return value.map(entry => field.choices.find(choice => choice.value === entry)?.label ?? String(entry)).join(', ');
  }
  if (field?.type === 'rating' && typeof value === 'number') return t('liveForm.ratingResult', { value });
  return String(value);
}

export interface AnswerShare {
  label: string;
  count: number;
  /** Of the answered responses, with two decimals. */
  share: number;
  percentage: number;
}

/**
 * How the answers to `field` split among its choices; null for free text, which
 * has none. A number question counts each value while it has at most ten.
 */
export function answerShares(responses: readonly FormResponse[], field: FormField): AnswerShare[] | null {
  const answered = answeredResponses(responses, field);
  let categories: Array<{ value: string | number | boolean; label: string }> | null = field.type === 'boolean'
    ? [{ value: true, label: t('botChat.switchOn') }, { value: false, label: t('botChat.switchOff') }]
    : field.type === 'select' || field.type === 'multi-select'
      ? field.choices.map(choice => ({ value: choice.value, label: choice.label }))
      : field.type === 'rating'
        ? Array.from({ length: 5 }, (_, index) => ({ value: index + 1, label: t('liveForm.ratingResult', { value: index + 1 }) }))
        : null;
  if (field.type === 'integer' && answered.length) {
    const values = [...new Set(answered.map(entry => Number(entry.response.values[field.name])))]
      .filter(Number.isFinite).sort((a, b) => a - b);
    if (values.length <= 10) categories = values.map(value => ({ value, label: String(value) }));
  }
  return categories?.map(category => {
    const count = answered.filter(entry => {
      const value = entry.response.values[field.name];
      return Array.isArray(value) ? value.includes(String(category.value)) : value === category.value;
    }).length;
    const share = answered.length ? Number((count * 100 / answered.length).toFixed(2)) : 0;
    return { label: category.label, count, share, percentage: Math.round(share) };
  }) ?? null;
}

/** The responses grouped by identical answer to `field`, in the order the answers first appear. */
export function answerGroups(
  form: NativeLiveForm, responses: readonly FormResponse[], field: FormField,
): Array<{ label: string; responseIndices: number[] }> {
  const groups = new Map<string, { label: string; responseIndices: number[] }>();
  for (const [index, entry] of responses.entries()) {
    const value = entry.response.values[field.name];
    const key = JSON.stringify(Array.isArray(value) ? [...value].sort() : value ?? null);
    const group = groups.get(key);
    if (group) group.responseIndices.push(index);
    else groups.set(key, { label: answerLabel(form, field.name, value), responseIndices: [index] });
  }
  return [...groups.values()];
}

/** A spreadsheet never runs a cell as a formula: one that starts like one is kept as text. */
function csvCell(value: unknown): string {
  let text = String(value ?? '').replace(/\r\n?/g, '\n');
  if (/^[=+\-@\t]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/** The responses as CSV, one row each; an anonymous form leaves out who answered and when. */
export function resultsCsv(form: NativeLiveForm, responses: readonly FormResponse[]): string {
  const fields = form.form.fields;
  const answers = (entry: FormResponse) => fields.map(field => answerLabel(form, field.name, entry.response.values[field.name]));
  const rows = form.form.anonymous ? [
    fields.map(field => field.label),
    ...responses.map(answers),
  ] : [
    [t('liveForm.csvRespondent'), t('liveForm.csvSubmittedAt'), ...fields.map(field => field.label)],
    ...responses.map(entry => [
      entry.user?.nickname ?? '',
      'updatedAt' in entry.response ? new Date(entry.response.updatedAt).toISOString() : '',
      ...answers(entry),
    ]),
  ];
  return `\uFEFF${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}`;
}
