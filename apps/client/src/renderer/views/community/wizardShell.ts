import { t } from '../../i18n';
import { html, type SafeHtml } from '../../utils/html';
import { tabbableControls } from '../../utils/modalShell';
import { slideStepContent } from '../../utils/modalSteps';
import { preserveViewState } from '../../utils/preserveViewState';
import { revealWithin, scrollParentOf, smoothScrollTo } from '../../utils/scroll';
import type { CommunityModal } from '../CommunityModal';

export interface WizardStep {
  /** Its name in the stepper. */
  label: string;
  /** The step's content, a single root element, drawn again each time the step shows. */
  render(): string | SafeHtml;
}

export interface WizardOptions {
  /**
   * Names the wizard's hooks: `data-<name>-stepper`, `data-<name>-viewport`, and
   * `data-<name>-back`, `-cancel`, `-next` and, on the last step, `-submit`.
   */
  name: string;
  /** Accessible name of the stepper. */
  label: string;
  stepperClass?: string;
  /** Class of the area between the stepper and the footer, which holds the step. */
  viewportClass: string;
  steps: readonly WizardStep[];
  /** Attributes naming the repeated items of a step, such as a form's fields; see `preserveViewState`. */
  itemKeys?: readonly string[];
  /** What the last step's button does: publish, save… */
  submitLabel(): string;
  /** Reads the fields of the step on screen into the draft, before it is left. */
  capture?(step: number): void;
  /** Whether the step's button can be pressed now; asked again by `sync` after every edit. */
  ready?(step: number): boolean;
  /** Runs when Next is pressed: false keeps the step, which has already said why. */
  leave?(step: number): boolean;
  /** Sending: every button waits, Cancel included. */
  pending?(): boolean;
  /** Working on something, such as an image upload: Back and Next wait for it. */
  busy?(): boolean;
  /** Runs when the last step's button is pressed. */
  submit(): void;
  /** Runs after a step is drawn, with its content in place. */
  drawn?(step: number): void;
}

export interface Wizard {
  /** Holds the step on screen. */
  readonly viewport: HTMLElement;
  readonly step: number;
  /** Draws the first step, with focus on its first control. */
  start(): void;
  /**
   * Draws the step on screen again. Focus, caret and scroll stay where they were,
   * unless `focus` names the control of the step that takes it.
   */
  redraw(focus?: string): void;
  /** Applies `ready`, `pending` and `busy` to the buttons. */
  sync(): void;
}

/**
 * The frame every community wizard shares (#490). The stepper and the footer stay
 * put while the steps slide between them, forward or back; each new step shows
 * from its top with its title focused, so Tab goes on to its first field. A double
 * click moves one step and never publishes. The wizard keeps its draft and its
 * markup; the frame owns the steps, the buttons and when a step may be left.
 */
export function mountWizard(modal: CommunityModal, options: WizardOptions): Wizard {
  const { name, steps } = options;
  const last = steps.length - 1;
  modal.content.innerHTML = String(html`<nav class="${['community-steps', options.stepperClass].filter(Boolean).join(' ')}"
      aria-label="${options.label}">
      ${steps.map((step, index) => html`<span data-${name}-stepper="${index}">${step.label}</span>`)}
    </nav>
    <div class="${options.viewportClass}" data-${name}-viewport></div>
    <footer class="modal-footer event-wizard-footer">
      <button type="button" class="btn btn-secondary" data-${name}-back hidden>${t('common.back')}</button>
      <span class="event-footer-spacer"></span>
      <button type="button" class="btn btn-secondary" data-${name}-cancel>${t('common.cancel')}</button>
      <button type="button" class="btn btn-primary" data-${name}-next>${t('common.next')}</button>
    </footer>`);
  const stepper = modal.content.querySelector<HTMLElement>('.community-steps')!;
  const viewport = modal.content.querySelector<HTMLElement>(`[data-${name}-viewport]`)!;
  const footer = modal.content.querySelector<HTMLElement>('.event-wizard-footer')!;
  const back = footer.querySelector<HTMLButtonElement>(`[data-${name}-back]`)!;
  const cancel = footer.querySelector<HTMLButtonElement>(`[data-${name}-cancel]`)!;
  const primary = footer.querySelector<HTMLButtonElement>(`[data-${name}-next]`)!;
  const title = (): HTMLElement | null => viewport.firstElementChild?.querySelector<HTMLElement>('h2') ?? null;
  let step = 0;
  let moves = 0;
  let moving = false;

  const sync = (): void => {
    const pending = options.pending?.() ?? false;
    const waiting = pending || moving || (options.busy?.() ?? false);
    const focused = document.activeElement;
    back.disabled = waiting;
    cancel.disabled = pending;
    primary.disabled = waiting || !(options.ready?.(step) ?? true);
    // A button that stops working while focused would drop the focus on the page.
    if (focused instanceof HTMLButtonElement && footer.contains(focused) && focused.disabled) {
      title()?.focus({ preventScroll: true });
    }
  };

  const draw = (direction: number): HTMLElement => {
    const holder = document.createElement('div');
    holder.innerHTML = String(steps[step].render()).trim();
    const content = holder.firstElementChild;
    if (!(content instanceof HTMLElement) || holder.childElementCount !== 1) {
      throw new Error('A wizard step needs exactly one root element');
    }
    const landing = slideStepContent(viewport, content, direction);
    const move = ++moves;
    moving = landing !== null;
    void landing?.then(() => {
      if (move !== moves) return;
      moving = false;
      if (!modal.signal.aborted) sync();
    });
    stepper.style.setProperty('--event-step', String(step));
    stepper.querySelectorAll<HTMLElement>(`[data-${name}-stepper]`).forEach((item, index) => {
      if (index === step) item.setAttribute('aria-current', 'step');
      else item.removeAttribute('aria-current');
    });
    back.hidden = step === 0;
    primary.toggleAttribute(`data-${name}-next`, step < last);
    primary.toggleAttribute(`data-${name}-submit`, step === last);
    primary.textContent = step < last ? t('common.next') : options.submitLabel();
    options.drawn?.(step);
    sync();
    return content;
  };

  const go = (target: number): void => {
    const direction = Math.sign(target - step);
    step = target;
    draw(direction);
    title()?.focus({ preventScroll: true });
    // A dialog that scrolls as a whole shows the new step from the top, stepper included.
    const scroller = scrollParentOf(viewport, modal.card);
    if (scroller && scroller.scrollTop > 0) smoothScrollTo(scroller, { top: 0 });
  };

  footer.addEventListener('click', event => {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || button.disabled) return;
    if (button === cancel) { modal.close(); return; }
    // The footer stays put, so the second click of a double click lands on the button the first
    // one just changed: Next that became Publish, or Back of an earlier step. The system counts it
    // as part of the same gesture (`detail` 2 and up), with or without motion and however long the
    // person's double-click time is. A key (`detail` 0) or a new click (1) always counts.
    if (event.detail > 1) return;
    if (button === back) {
      if (step === 0) return;
      options.capture?.(step);
      go(step - 1);
      return;
    }
    if (button !== primary) return;
    options.capture?.(step);
    if (!(options.ready?.(step) ?? true)) { sync(); return; }
    if (step === last) { options.submit(); return; }
    if (options.leave && !options.leave(step)) return;
    go(step + 1);
  }, { signal: modal.signal });

  return {
    viewport,
    get step() { return step; },
    start() {
      const content = draw(0);
      tabbableControls(content)[0]?.focus({ preventScroll: true });
    },
    redraw(focus) {
      const outer = scrollParentOf(viewport, modal.card);
      const scrolled = outer?.scrollTop;
      if (focus) {
        const target = draw(0).querySelector<HTMLElement>(focus);
        target?.focus({ preventScroll: true });
        if (outer && scrolled !== undefined) outer.scrollTop = scrolled;
        if (target) revealWithin(outer ?? viewport, target);
        return;
      }
      preserveViewState(viewport, () => { draw(0); }, { itemKeys: options.itemKeys, fallback: title });
      // Exact: nothing moved, the step was only drawn again.
      if (outer && scrolled !== undefined) outer.scrollTop = scrolled;
    },
    sync,
  };
}
