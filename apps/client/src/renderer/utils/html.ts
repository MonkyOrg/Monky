/**
 * Escapes a string for safe interpolation into HTML, preventing XSS when
 * rendering user-provided content (nicknames, messages, server names, etc.).
 */
export function escapeHtml(str: string | null | undefined): string {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Markup that may go into the page as it is: built by `html`, or vouched for
 * with `trustedHtml`. It turns into its markup wherever a string is expected,
 * so it also fits the plain template strings that have not moved to `html`.
 */
export class SafeHtml {
  constructor(private readonly markup: string) {}

  toString(): string {
    return this.markup;
  }
}

/** What `html` interpolates. Objects are left out, so nothing renders as "[object Object]". */
export type HtmlValue = SafeHtml | string | number | boolean | null | undefined | readonly HtmlValue[];

/**
 * Lets `html` insert markup that is already safe: static markup, or the output
 * of a helper that escapes on its own. Never pass text that came from a server,
 * another person or the keyboard.
 */
export function trustedHtml(markup: string): SafeHtml {
  return new SafeHtml(markup);
}

function isHtmlList(value: HtmlValue): value is readonly HtmlValue[] {
  return Array.isArray(value);
}

function renderHtmlValue(value: HtmlValue): string {
  if (value instanceof SafeHtml) return value.toString();
  if (isHtmlList(value)) return value.map(renderHtmlValue).join('');
  if (value === null || value === undefined) return '';
  return escapeHtml(String(value));
}

/**
 * Template tag that escapes every interpolated value unless it is SafeHtml
 * (#490), so a server-provided id, address or name lands as text even inside
 * an attribute: forgetting `escapeHtml` stops being possible.
 *
 * - Nested `html` templates, and arrays of them, go in as markup. Pass a mapped
 *   array as it is: `.join('')` would turn the markup back into text.
 * - `null` and `undefined` render nothing; numbers and booleans render as text.
 * - `t()` returns text, so it is escaped as well.
 */
export function html(strings: TemplateStringsArray, ...values: readonly HtmlValue[]): SafeHtml {
  let markup = strings[0];
  values.forEach((value, index) => {
    markup += renderHtmlValue(value) + strings[index + 1];
  });
  return new SafeHtml(markup);
}
