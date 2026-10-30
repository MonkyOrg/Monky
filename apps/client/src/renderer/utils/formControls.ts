import { html, trustedHtml, type SafeHtml } from './html';

type SwitchName =
  /** The switch's own name, when no visible text names it. */
  | { label: string; labelledBy?: never }
  /** The id of the visible text that names it, such as the title of its row. */
  | { labelledBy: string; label?: never };

export type SwitchOptions = SwitchName & {
  id?: string;
  checked: boolean;
  disabled?: boolean;
  /** Ids of the text that explains what the switch does. */
  describedBy?: string;
  /** Classes of the input, for code that finds the switch by class. */
  className?: string;
  /** Other attributes of the input, such as `data-*` hooks. */
  attributes?: SafeHtml;
  size?: 'small';
  /** For a switch that only appears once its value is known. */
  wrapperId?: string;
  hidden?: boolean;
};

/**
 * The app's one on/off control (#490): a hidden checkbox drawn by
 * `.toggle-switch`, always announced as a switch and always named. A native
 * checkbox never shows up on its own.
 */
export function renderSwitch(options: SwitchOptions): SafeHtml {
  const name = options.label !== undefined
    ? html`aria-label="${options.label}"`
    : html`aria-labelledby="${options.labelledBy}"`;
  return html`<label class="toggle-switch${options.size === 'small' ? ' toggle-switch-sm' : ''}"${
    options.wrapperId ? html` id="${options.wrapperId}"` : null}${options.hidden ? html` hidden` : null}><input type="checkbox" role="switch"${
    options.id ? html` id="${options.id}"` : null}${options.className ? html` class="${options.className}"` : null} ${name}${
    options.describedBy ? html` aria-describedby="${options.describedBy}"` : null}${options.checked ? html` checked` : null}${
    options.disabled ? html` disabled` : null}${options.attributes ? html` ${options.attributes}` : null}><span class="toggle-slider" aria-hidden="true"></span></label>`;
}

export interface ChoiceCard<T extends string> {
  value: T;
  title: string;
  description?: string;
  icon?: string;
}

export interface ChoiceCardsOptions<T extends string> {
  id: string;
  /** What the group chooses, announced with it. */
  label: string;
  /** The attribute that carries each card's value: code and tests find the cards by it. */
  attribute: `data-${string}`;
  choices: readonly ChoiceCard<T>[];
  selected: T;
  disabled?: boolean;
}

/**
 * A choice among a few options shown as cards (#490), never radio buttons:
 * each card is a button with `aria-pressed`, drawn by `.input-mode-card`.
 * `selectChoiceCard` moves the selection.
 */
export function renderChoiceCards<T extends string>(options: ChoiceCardsOptions<T>): SafeHtml {
  const attribute = trustedHtml(options.attribute);
  return html`<div class="input-mode-cards" id="${options.id}" role="group" aria-label="${options.label}">${options.choices.map(choice => html`
    <button type="button" class="input-mode-card" ${attribute}="${choice.value}" aria-pressed="${choice.value === options.selected}"${
      options.disabled ? html` disabled` : null}>
      <span class="input-mode-card-title">${choice.icon ? html`<span class="material-symbols-outlined md-18" aria-hidden="true">${choice.icon}</span>` : null}${choice.title}</span>
      ${choice.description ? html`<span class="input-mode-card-description">${choice.description}</span>` : null}
    </button>`)}
  </div>`;
}

/** Marks the card with `value` as the chosen one in its group. */
export function selectChoiceCard(group: ParentNode, attribute: `data-${string}`, value: string): void {
  group.querySelectorAll<HTMLElement>(`[${attribute}]`).forEach((card) => {
    card.setAttribute('aria-pressed', String(card.getAttribute(attribute) === value));
  });
}
