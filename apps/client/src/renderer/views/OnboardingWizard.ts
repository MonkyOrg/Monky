import { t } from '../i18n';
import { replaceModalStep } from '../utils/modalSteps';
import { settingsStore } from '../stores/settingsStore';
import type { TutorialDefinition } from '../tutorials/TutorialDefinition';
import { attachTutorialStep, renderTutorialStep, tutorialStepShots } from '../tutorials/TutorialViewer';
import { radminTutorial } from '../tutorials/vpn/radminTutorial';
import { tailscaleTutorial } from '../tutorials/vpn/tailscaleTutorial';
import { hamachiTutorial } from '../tutorials/vpn/hamachiTutorial';
import { zerotierTutorial } from '../tutorials/vpn/zerotierTutorial';
import { portForwardTutorial } from '../tutorials/portForwardTutorial';
import { lanTutorial } from '../tutorials/lanTutorial';
import { vpsOracleFreeTutorial, vpsGenericTutorial } from '../tutorials/vpsTutorial';
import { preloadOnboardingShots, renderOnboardingShot, type OnboardingShot } from './onboardingShots';

type WizardScreen = 'welcome' | 'choose' | 'host-method' | 'vpn-select' | 'vps-select' | 'tutorial';
/** `guide` is the full getting-started flow; `host-tutorials` is opened from the create-server form. */
export type WizardEntry = 'guide' | 'host-tutorials';
/**
 * Where the modal continues when the wizard hands its card back: the join or
 * create form, back to whatever opened the wizard, or closed.
 */
export type WizardExit = 'join' | 'host' | 'leave' | 'close';

interface WizardSession {
  root: HTMLElement;
  entry: WizardEntry;
  exit: (result: WizardExit) => void;
}

interface OpenTutorial {
  definition: TutorialDefinition;
  step: number;
  from: WizardScreen;
}

const SUGGEST_URL = 'https://github.com/MonkyOrg/Monky/discussions/categories/ideas';
const CONTRIBUTE_URL = 'https://github.com/MonkyOrg/Monky';

const VPN_TUTORIALS: Record<string, TutorialDefinition> = {
  radmin: radminTutorial,
  tailscale: tailscaleTutorial,
  hamachi: hamachiTutorial,
  zerotier: zerotierTutorial,
};
const VPS_TUTORIALS: Record<string, TutorialDefinition> = {
  oracle: vpsOracleFreeTutorial,
  generic: vpsGenericTutorial,
};

/** Pictures of the next screen each screen can open, decoded ahead so it never appears half drawn. */
function nextShots(screen: WizardScreen): OnboardingShot[] {
  const firstSteps = (tutorials: TutorialDefinition[]) =>
    tutorials.flatMap((definition) => tutorialStepShots(definition, 0));
  switch (screen) {
    case 'welcome': return ['add-server-choice'];
    case 'host-method': return firstSteps([lanTutorial, portForwardTutorial]);
    case 'vpn-select': return firstSteps(Object.values(VPN_TUTORIALS));
    case 'vps-select': return firstSteps(Object.values(VPS_TUTORIALS));
    default: return [];
  }
}

/**
 * Getting-started guide and hosting tutorials. It renders inside the card of
 * an already open modal (the add-server modal), replacing the card content
 * step by step, so the user never sees one dialog close and another open.
 */
export class OnboardingWizard {
  private session: WizardSession | null = null;
  private screen: WizardScreen = 'welcome';
  private tutorial: OpenTutorial | null = null;

  /**
   * Shows the first screen in `root`'s card. `direction` 0 fills a modal that
   * is about to enter; otherwise the current card slides to the wizard.
   */
  public start(root: HTMLElement, entry: WizardEntry, exit: (result: WizardExit) => void, direction = 1): HTMLElement {
    this.session = { root, entry, exit };
    this.tutorial = null;
    this.screen = entry === 'guide' ? 'welcome' : 'host-method';
    return this.show(direction);
  }

  /** The owner took the card back or closed the modal. Any end of the guide counts as having seen it. */
  public stop(): void {
    const session = this.session;
    if (!session) return;
    this.session = null;
    this.tutorial = null;
    if (session.entry === 'guide') {
      settingsStore.onboardingCompleted = true;
      settingsStore.save();
    }
  }

  public get active(): boolean {
    return this.session !== null;
  }

  private go(screen: WizardScreen, direction: number): void {
    this.screen = screen;
    if (screen !== 'tutorial') this.tutorial = null;
    this.show(direction);
  }

  private leave(result: WizardExit): void {
    this.session?.exit(result);
  }

  private openTutorial(definition: TutorialDefinition): void {
    this.tutorial = { definition, step: 0, from: this.screen };
    this.go('tutorial', 1);
  }

  private show(direction: number): HTMLElement {
    const session = this.session!;
    const holder = document.createElement('div');
    holder.innerHTML = this.markup(session.entry);
    const content = replaceModalStep(session.root, holder.firstElementChild as HTMLElement, direction);
    const card = session.root.querySelector<HTMLElement>(':scope > .modal-card');
    card?.setAttribute('aria-labelledby', this.tutorial ? 'tutorial-step-title' : 'onboarding-title');
    this.attachEvents(content);
    if (direction !== 0) content.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    preloadOnboardingShots(this.tutorial
      ? tutorialStepShots(this.tutorial.definition, this.tutorial.step + 1)
      : nextShots(this.screen));
    return content;
  }

  /* ─── screens ───────────────────────────────────────────────────────── */

  private markup(entry: WizardEntry): string {
    if (this.tutorial) return renderTutorialStep(this.tutorial.definition, this.tutorial.step);
    switch (this.screen) {
      case 'welcome': return this.renderWelcome();
      case 'choose': return this.renderChoose();
      case 'host-method': return this.renderHostMethod(entry === 'guide');
      case 'vpn-select': return this.renderVpnSelect();
      default: return this.renderVpsSelect();
    }
  }

  private card(body: string): string {
    return `<section class="modal-card onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">${body}</section>`;
  }

  private heading(icon: string, title: string, subtitle: string, start = true): string {
    return `
      <div class="onboarding-heading${start ? ' onboarding-heading--start' : ''}">
        <span class="material-symbols-outlined" aria-hidden="true">${icon}</span>
        <h2 id="onboarding-title">${title}</h2>
        <p>${subtitle}</p>
      </div>
    `;
  }

  private renderStepDots(active: number): string {
    if (this.session?.entry !== 'guide') return '';
    return `<div class="onboarding-step-dots" aria-hidden="true">
      ${[0, 1, 2].map((index) => `<div class="onboarding-step-dot ${index < active ? 'completed' : index === active ? 'active' : ''}"></div>`).join('')}
    </div>`;
  }

  private backButton(id: string): string {
    return `
      <button type="button" class="btn btn-secondary" id="${id}">
        <span class="material-symbols-outlined md-16" aria-hidden="true">arrow_back</span>
        ${t('common.back')}
      </button>
    `;
  }

  private optionCard(id: string, icon: string, title: string, description: string, trailing: string, extra = ''): string {
    return `
      <button type="button" class="onboarding-option-card${extra}" id="${id}">
        <span class="material-symbols-outlined onboarding-option-icon" aria-hidden="true">${icon}</span>
        <span class="onboarding-option-text">
          <span class="onboarding-option-title">${title}</span>
          ${description ? `<span class="onboarding-option-desc">${description}</span>` : ''}
        </span>
        ${trailing}
      </button>
    `;
  }

  private arrow(): string {
    return '<span class="material-symbols-outlined onboarding-option-arrow" aria-hidden="true">chevron_right</span>';
  }

  /* ── Step 1: Welcome — where things are on Home ── */

  private renderWelcome(): string {
    return this.card(`
      ${this.heading('explore', t('onboarding.welcomeTitle'), t('onboarding.welcomeSubtitle'), false)}
      ${this.renderStepDots(0)}
      ${renderOnboardingShot('home', t('onboarding.homeShotAlt'))}
      <ul class="onboarding-pointers">
        <li>
          <span class="onboarding-pointer-icon onboarding-pointer-icon--add material-symbols-outlined" aria-hidden="true">add</span>
          <div>
            <strong>${t('onboarding.pointerAddTitle')}</strong>
            <span>${t('onboarding.pointerAddDesc')}</span>
          </div>
        </li>
        <li>
          <span class="onboarding-pointer-icon material-symbols-outlined" aria-hidden="true">group</span>
          <div>
            <strong>${t('onboarding.pointerFriendsTitle')}</strong>
            <span>${t('onboarding.pointerFriendsDesc')}</span>
          </div>
        </li>
      </ul>
      <div class="onboarding-footer">
        <button type="button" class="btn btn-secondary" id="onboarding-skip">${t('onboarding.skip')}</button>
        <button type="button" class="btn btn-primary" id="onboarding-next">
          ${t('common.next')}
          <span class="material-symbols-outlined md-16" aria-hidden="true">arrow_forward</span>
        </button>
      </div>
    `);
  }

  /* ── Step 2: Create or join, as offered by the rail "+" ── */

  private renderChoose(): string {
    return this.card(`
      ${this.heading('add_circle', t('onboarding.chooseTitle'), t('onboarding.chooseSubtitle'))}
      ${this.renderStepDots(1)}
      ${renderOnboardingShot('add-server-choice', t('onboarding.choiceShotAlt'))}
      <div class="onboarding-options">
        ${this.optionCard('onboarding-join', 'login', t('onboarding.joinTitle'), t('onboarding.joinDesc'), this.arrow())}
        ${this.optionCard('onboarding-host', 'dns', t('onboarding.hostTitle'), t('onboarding.hostDesc'), this.arrow())}
      </div>
      <div class="onboarding-footer">
        ${this.backButton('onboarding-choose-back')}
        <button type="button" class="btn btn-secondary" id="onboarding-skip-choose">${t('onboarding.skip')}</button>
      </div>
    `);
  }

  /* ── Step 3: Host method ── */

  private renderHostMethod(guide: boolean): string {
    const badge = (level: 'easy' | 'medium' | 'advanced', label: string) =>
      `<span class="onboarding-badge ${level}">${label}</span>`;
    return this.card(`
      ${this.heading('dns', t('onboarding.hostMethodTitle'), t('onboarding.hostMethodSubtitle'))}
      ${this.renderStepDots(2)}
      <div class="onboarding-options">
        ${this.optionCard('onboarding-lan', 'home', t('onboarding.lanTitle'), t('onboarding.lanDesc'), badge('easy', t('onboarding.badgeEasy')))}
        ${this.optionCard('onboarding-vpn', 'vpn_lock', t('onboarding.vpnTitle'), t('onboarding.vpnDesc'), badge('easy', t('onboarding.badgeEasy')))}
        ${this.optionCard('onboarding-port', 'router', t('onboarding.portTitle'), t('onboarding.portDesc'), badge('medium', t('onboarding.badgeMedium')))}
        ${this.optionCard('onboarding-vps', 'cloud', t('onboarding.vpsTitle'), t('onboarding.vpsDesc'), badge('advanced', t('onboarding.badgeAdvanced')))}
        ${guide ? this.optionCard('onboarding-create-now', 'add_circle', t('onboarding.createNowTitle'), t('onboarding.createNowDesc'), this.arrow(), ' onboarding-option-card--primary') : ''}
      </div>
      <div class="onboarding-footer">
        ${this.backButton('onboarding-back')}
        ${guide ? `<button type="button" class="btn btn-secondary" id="onboarding-skip2">${t('onboarding.skip')}</button>` : ''}
      </div>
    `);
  }

  /* ── VPN and VPS selection ── */

  private renderTutorialList(
    icon: string, title: string, subtitle: string,
    items: { attribute: string; id: string; name: string }[], idSuffix: string,
  ): string {
    const follow = `<span class="onboarding-option-cta">${t('onboarding.followTutorial')}
      <span class="material-symbols-outlined md-16" aria-hidden="true">arrow_forward</span></span>`;
    return this.card(`
      ${this.heading(icon, title, subtitle)}
      <div class="onboarding-options">
        ${items.map((item) => `
          <button type="button" class="onboarding-option-card" ${item.attribute}="${item.id}">
            <span class="material-symbols-outlined onboarding-option-icon" aria-hidden="true">${icon}</span>
            <span class="onboarding-option-text"><span class="onboarding-option-title">${item.name}</span></span>
            ${follow}
          </button>
        `).join('')}
      </div>
      <div class="onboarding-contribute">
        <strong>
          <span class="material-symbols-outlined md-16" aria-hidden="true">lightbulb</span>
          ${t('onboarding.contributeTitle')}
        </strong>
        <span>${t('onboarding.contributeDesc')}</span>
        <div class="onboarding-contribute-actions">
          <button type="button" class="btn btn-secondary" id="onboarding-suggest${idSuffix}">
            <span class="material-symbols-outlined md-16" aria-hidden="true">lightbulb</span>
            ${t('onboarding.suggestBtn')}
          </button>
          <button type="button" class="btn btn-secondary" id="onboarding-contribute${idSuffix}">
            <span class="material-symbols-outlined md-16" aria-hidden="true">code</span>
            ${t('onboarding.contributeBtn')}
          </button>
        </div>
      </div>
      <div class="onboarding-footer">
        ${this.backButton(`onboarding-${idSuffix ? 'vps' : 'vpn'}-back`)}
      </div>
    `);
  }

  private renderVpnSelect(): string {
    return this.renderTutorialList('vpn_lock', t('onboarding.vpnSelectTitle'), t('onboarding.vpnSelectSubtitle'), [
      { attribute: 'data-vpn', id: 'radmin', name: 'Radmin VPN' },
      { attribute: 'data-vpn', id: 'tailscale', name: 'Tailscale' },
      { attribute: 'data-vpn', id: 'hamachi', name: 'Hamachi' },
      { attribute: 'data-vpn', id: 'zerotier', name: 'ZeroTier' },
    ], '');
  }

  private renderVpsSelect(): string {
    return this.renderTutorialList('cloud', t('onboarding.vpsSelectTitle'), t('onboarding.vpsSelectSubtitle'), [
      { attribute: 'data-vps', id: 'oracle', name: 'Oracle Cloud (Free Tier)' },
      { attribute: 'data-vps', id: 'generic', name: t('onboarding.vpsGenericProvider') },
    ], '-vps');
  }

  /* ─── events ────────────────────────────────────────────────────────── */

  private attachEvents(content: HTMLElement): void {
    const on = (selector: string, handler: () => void) =>
      content.querySelector(selector)?.addEventListener('click', handler);

    const tutorial = this.tutorial;
    if (tutorial) {
      attachTutorialStep(content, tutorial.definition, {
        previous: () => {
          if (tutorial.step === 0) {
            this.go(tutorial.from, -1);
            return;
          }
          tutorial.step--;
          this.show(-1);
        },
        next: () => {
          if (tutorial.step >= tutorial.definition.steps.length - 1) return;
          tutorial.step++;
          this.show(1);
        },
        // From the create form, finishing a tutorial returns to it; in the guide it opens the form.
        finish: () => this.leave(this.session?.entry === 'guide' ? 'host' : 'leave'),
        close: () => this.leave('close'),
      });
      return;
    }

    on('#onboarding-next', () => this.go('choose', 1));
    on('#onboarding-skip', () => this.leave('leave'));

    on('#onboarding-join', () => this.leave('join'));
    on('#onboarding-host', () => this.go('host-method', 1));
    on('#onboarding-choose-back', () => this.go('welcome', -1));
    on('#onboarding-skip-choose', () => this.leave('leave'));

    on('#onboarding-lan', () => this.openTutorial(lanTutorial));
    on('#onboarding-vpn', () => this.go('vpn-select', 1));
    on('#onboarding-port', () => this.openTutorial(portForwardTutorial));
    on('#onboarding-vps', () => this.go('vps-select', 1));
    on('#onboarding-create-now', () => this.leave('host'));
    // From the create-server form, Back returns to that form instead of the guide start.
    on('#onboarding-back', () => {
      if (this.session?.entry === 'host-tutorials') this.leave('leave');
      else this.go('choose', -1);
    });
    on('#onboarding-skip2', () => this.leave('leave'));

    content.querySelectorAll<HTMLElement>('[data-vpn], [data-vps]').forEach((element) => {
      const definition = VPN_TUTORIALS[element.dataset.vpn ?? ''] ?? VPS_TUTORIALS[element.dataset.vps ?? ''];
      element.addEventListener('click', () => { if (definition) this.openTutorial(definition); });
    });
    on('#onboarding-vpn-back', () => this.go('host-method', -1));
    on('#onboarding-vps-back', () => this.go('host-method', -1));
    for (const suffix of ['', '-vps']) {
      on(`#onboarding-suggest${suffix}`, () => window.api?.openExternal?.(SUGGEST_URL));
      on(`#onboarding-contribute${suffix}`, () => window.api?.openExternal?.(CONTRIBUTE_URL));
    }
  }
}

export const onboardingWizard = new OnboardingWizard();
