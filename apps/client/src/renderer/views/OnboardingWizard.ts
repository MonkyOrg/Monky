import { t } from '../i18n';
import { enterModal, exitModal } from '../utils/modalSurface';
import { replaceModalStep } from '../utils/modalSteps';
import { settingsStore } from '../stores/settingsStore';
import { enableBackdropClose } from '../utils/modal';
import { tutorialViewer } from '../tutorials/TutorialViewer';
import { radminTutorial } from '../tutorials/vpn/radminTutorial';
import { tailscaleTutorial } from '../tutorials/vpn/tailscaleTutorial';
import { hamachiTutorial } from '../tutorials/vpn/hamachiTutorial';
import { zerotierTutorial } from '../tutorials/vpn/zerotierTutorial';
import { portForwardTutorial } from '../tutorials/portForwardTutorial';
import { lanTutorial } from '../tutorials/lanTutorial';
import { vpsOracleFreeTutorial, vpsGenericTutorial } from '../tutorials/vpsTutorial';

type WizardScreen = 'welcome' | 'host-method' | 'vpn-select' | 'vps-select';

const SUGGEST_URL = 'https://github.com/MonkyOrg/Monky/discussions/categories/ideas';
const CONTRIBUTE_URL = 'https://github.com/MonkyOrg/Monky';

/**
 * Multi-step onboarding wizard that guides new users through connecting to or
 * creating a Monky server.  Renders as a modal overlay; all tutorials run
 * in-app via `TutorialViewer`.
 */
export class OnboardingWizard {
  private modalEl: HTMLElement | null = null;
  private screen: WizardScreen = 'welcome';
  private renderedScreen: WizardScreen = 'welcome';
  private onFinish: ((action: 'join' | 'host' | null) => void) | null = null;

  /**
   * Opens the wizard.
   * @param onFinish Called when the wizard closes.  Receives `'join'` or
   *   `'host'` if the user chose a path, or `null` if they skipped/closed.
   */
  public open(onFinish?: (action: 'join' | 'host' | null) => void): void {
    this.close(null, true);
    this.screen = 'welcome';
    this.onFinish = onFinish ?? null;
    this.render();
  }

  public close(action: 'join' | 'host' | null = null, silent = false): void {
    if (this.modalEl) {
      exitModal(this.modalEl);
      this.modalEl = null;
    }
    if (!silent && this.onFinish) {
      this.onFinish(action);
      this.onFinish = null;
    }
  }

  public get isOpen(): boolean {
    return this.modalEl !== null;
  }

  /* ─── screens ───────────────────────────────────────────────────────── */

  private render(): void {
    const opening = !this.modalEl;
    if (!this.modalEl) {
      this.modalEl = document.createElement('div');
      this.modalEl.className = 'modal-backdrop';
      document.body.appendChild(this.modalEl);
      enableBackdropClose(this.modalEl, () => this.close());
    }

    const next = document.createElement('div');
    switch (this.screen) {
      case 'welcome':
        this.renderWelcome(next);
        break;
      case 'host-method':
        this.renderHostMethod(next);
        break;
      case 'vpn-select':
        this.renderVpnSelect(next);
        break;
      case 'vps-select':
        this.renderVpsSelect(next);
        break;
    }

    const order: WizardScreen[] = ['welcome', 'host-method', 'vpn-select', 'vps-select'];
    const content = replaceModalStep(this.modalEl!, next.firstElementChild as HTMLElement,
      order.indexOf(this.screen) - order.indexOf(this.renderedScreen));
    this.renderedScreen = this.screen;
    this.attachEvents(content);
    if (opening) enterModal(this.modalEl!);
    else content.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  /* ── Step 1: Welcome ── */

  private renderWelcome(target: HTMLElement): void {
    target.innerHTML = `
      <div class="modal-card onboarding-card" style="max-width: 480px;">
        <div style="text-align: center; margin-bottom: 4px;">
          <span class="material-symbols-outlined" style="font-size: 40px; color: var(--accent-primary);">explore</span>
        </div>
        <h2 style="text-align: center; font-size: 20px; font-weight: 800; color: var(--text-primary); margin: 0 0 4px 0;">
          ${t('onboarding.welcomeTitle')}
        </h2>
        <p style="text-align: center; font-size: 13px; color: var(--text-secondary); margin: 0 0 20px 0; line-height: 1.5;">
          ${t('onboarding.welcomeSubtitle')}
        </p>

        <!-- Step indicator -->
        <div style="display: flex; align-items: center; justify-content: center; gap: 6px; margin-bottom: 16px;">
          <div class="onboarding-step-dot active"></div>
          <div class="onboarding-step-dot"></div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 10px;">
          <button class="onboarding-option-card" id="onboarding-join">
            <span class="material-symbols-outlined onboarding-option-icon">login</span>
            <div class="onboarding-option-text">
              <span class="onboarding-option-title">${t('onboarding.joinTitle')}</span>
              <span class="onboarding-option-desc">${t('onboarding.joinDesc')}</span>
            </div>
            <span class="material-symbols-outlined onboarding-option-arrow">chevron_right</span>
          </button>

          <button class="onboarding-option-card" id="onboarding-host">
            <span class="material-symbols-outlined onboarding-option-icon">dns</span>
            <div class="onboarding-option-text">
              <span class="onboarding-option-title">${t('onboarding.hostTitle')}</span>
              <span class="onboarding-option-desc">${t('onboarding.hostDesc')}</span>
            </div>
            <span class="material-symbols-outlined onboarding-option-arrow">chevron_right</span>
          </button>
        </div>

        <div style="text-align: center; margin-top: 16px;">
          <button class="btn btn-secondary" id="onboarding-skip" style="font-size: 12px; padding: 6px 16px;">
            ${t('onboarding.skip')}
          </button>
        </div>
      </div>
    `;
  }

  /* ── Step 2: Host method ── */

  private renderHostMethod(target: HTMLElement): void {
    target.innerHTML = `
      <div class="modal-card onboarding-card" style="max-width: 520px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <span class="material-symbols-outlined" style="color: var(--accent-primary);">dns</span>
          <h2 style="font-size: 17px; font-weight: 800; color: var(--text-primary); margin: 0;">
            ${t('onboarding.hostMethodTitle')}
          </h2>
        </div>
        <p style="font-size: 13px; color: var(--text-secondary); margin: 0 0 14px 0; line-height: 1.5;">
          ${t('onboarding.hostMethodSubtitle')}
        </p>

        <!-- Step indicator -->
        <div style="display: flex; align-items: center; justify-content: center; gap: 6px; margin-bottom: 14px;">
          <div class="onboarding-step-dot completed"></div>
          <div class="onboarding-step-dot active"></div>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px;">
          <button class="onboarding-option-card" id="onboarding-lan">
            <span class="material-symbols-outlined onboarding-option-icon">home</span>
            <div class="onboarding-option-text">
              <span class="onboarding-option-title">${t('onboarding.lanTitle')}</span>
              <span class="onboarding-option-desc">${t('onboarding.lanDesc')}</span>
            </div>
            <span class="onboarding-badge easy">${t('onboarding.badgeEasy')}</span>
          </button>

          <button class="onboarding-option-card" id="onboarding-vpn">
            <span class="material-symbols-outlined onboarding-option-icon">vpn_lock</span>
            <div class="onboarding-option-text">
              <span class="onboarding-option-title">${t('onboarding.vpnTitle')}</span>
              <span class="onboarding-option-desc">${t('onboarding.vpnDesc')}</span>
            </div>
            <span class="onboarding-badge easy">${t('onboarding.badgeEasy')}</span>
          </button>

          <button class="onboarding-option-card" id="onboarding-port">
            <span class="material-symbols-outlined onboarding-option-icon">router</span>
            <div class="onboarding-option-text">
              <span class="onboarding-option-title">${t('onboarding.portTitle')}</span>
              <span class="onboarding-option-desc">${t('onboarding.portDesc')}</span>
            </div>
            <span class="onboarding-badge medium">${t('onboarding.badgeMedium')}</span>
          </button>

          <button class="onboarding-option-card" id="onboarding-vps">
            <span class="material-symbols-outlined onboarding-option-icon">cloud</span>
            <div class="onboarding-option-text">
              <span class="onboarding-option-title">${t('onboarding.vpsTitle')}</span>
              <span class="onboarding-option-desc">${t('onboarding.vpsDesc')}</span>
            </div>
            <span class="onboarding-badge advanced">${t('onboarding.badgeAdvanced')}</span>
          </button>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px;">
          <button class="btn btn-secondary" id="onboarding-back" style="font-size: 12px; padding: 6px 14px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">arrow_back</span>
            ${t('common.back')}
          </button>
          <button class="btn btn-secondary" id="onboarding-skip2" style="font-size: 12px; padding: 6px 14px;">
            ${t('onboarding.skip')}
          </button>
        </div>
      </div>
    `;
  }

  /* ── VPN selection ── */

  private renderVpnSelect(target: HTMLElement): void {
    const vpns = [
      { id: 'radmin', name: 'Radmin VPN', icon: 'vpn_lock' },
      { id: 'tailscale', name: 'Tailscale', icon: 'vpn_lock' },
      { id: 'hamachi', name: 'Hamachi', icon: 'vpn_lock' },
      { id: 'zerotier', name: 'ZeroTier', icon: 'vpn_lock' },
    ];

    target.innerHTML = `
      <div class="modal-card onboarding-card" style="max-width: 480px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <span class="material-symbols-outlined" style="color: var(--accent-primary);">vpn_lock</span>
          <h2 style="font-size: 17px; font-weight: 800; color: var(--text-primary); margin: 0;">
            ${t('onboarding.vpnSelectTitle')}
          </h2>
        </div>
        <p style="font-size: 13px; color: var(--text-secondary); margin: 0 0 14px 0; line-height: 1.5;">
          ${t('onboarding.vpnSelectSubtitle')}
        </p>

        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${vpns.map((vpn) => `
            <button class="onboarding-option-card onboarding-tutorial-trigger" data-vpn="${vpn.id}">
              <span class="material-symbols-outlined onboarding-option-icon">${vpn.icon}</span>
              <div class="onboarding-option-text">
                <span class="onboarding-option-title">${vpn.name}</span>
              </div>
              <span style="font-size: 12px; color: var(--accent-primary); font-weight: 600; white-space: nowrap;">
                ${t('onboarding.followTutorial')}
                <span class="material-symbols-outlined md-16" style="vertical-align: middle;">arrow_forward</span>
              </span>
            </button>
          `).join('')}
        </div>

        <!-- Contribute CTA -->
        <div style="margin-top: 14px; padding: 12px; background: rgba(88, 101, 242, 0.06); border: 1px solid rgba(88, 101, 242, 0.2); border-radius: var(--radius-md);">
          <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">
            💡 ${t('onboarding.contributeTitle')}
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 8px;">
            ${t('onboarding.contributeDesc')}
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="btn btn-secondary" id="onboarding-suggest" style="font-size: 12px; padding: 5px 12px;">
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;">lightbulb</span>
              ${t('onboarding.suggestBtn')}
            </button>
            <button class="btn btn-secondary" id="onboarding-contribute" style="font-size: 12px; padding: 5px 12px;">
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;">code</span>
              ${t('onboarding.contributeBtn')}
            </button>
          </div>
        </div>

        <div style="margin-top: 12px;">
          <button class="btn btn-secondary" id="onboarding-vpn-back" style="font-size: 12px; padding: 6px 14px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">arrow_back</span>
            ${t('common.back')}
          </button>
        </div>
      </div>
    `;
  }

  /* ── VPS selection ── */

  private renderVpsSelect(target: HTMLElement): void {
    const providers = [
      { id: 'oracle', name: 'Oracle Cloud (Free Tier)', icon: 'cloud' },
      { id: 'generic', name: t('onboarding.vpsGenericProvider'), icon: 'cloud' },
    ];

    target.innerHTML = `
      <div class="modal-card onboarding-card" style="max-width: 480px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
          <span class="material-symbols-outlined" style="color: var(--accent-primary);">cloud</span>
          <h2 style="font-size: 17px; font-weight: 800; color: var(--text-primary); margin: 0;">
            ${t('onboarding.vpsSelectTitle')}
          </h2>
        </div>
        <p style="font-size: 13px; color: var(--text-secondary); margin: 0 0 14px 0; line-height: 1.5;">
          ${t('onboarding.vpsSelectSubtitle')}
        </p>

        <div style="display: flex; flex-direction: column; gap: 8px;">
          ${providers.map((p) => `
            <button class="onboarding-option-card onboarding-tutorial-trigger" data-vps="${p.id}">
              <span class="material-symbols-outlined onboarding-option-icon">${p.icon}</span>
              <div class="onboarding-option-text">
                <span class="onboarding-option-title">${p.name}</span>
              </div>
              <span style="font-size: 12px; color: var(--accent-primary); font-weight: 600; white-space: nowrap;">
                ${t('onboarding.followTutorial')}
                <span class="material-symbols-outlined md-16" style="vertical-align: middle;">arrow_forward</span>
              </span>
            </button>
          `).join('')}
        </div>

        <!-- Contribute CTA -->
        <div style="margin-top: 14px; padding: 12px; background: rgba(88, 101, 242, 0.06); border: 1px solid rgba(88, 101, 242, 0.2); border-radius: var(--radius-md);">
          <div style="font-size: 13px; font-weight: 600; color: var(--text-primary); margin-bottom: 4px;">
            💡 ${t('onboarding.contributeTitle')}
          </div>
          <div style="font-size: 12px; color: var(--text-secondary); line-height: 1.45; margin-bottom: 8px;">
            ${t('onboarding.contributeDesc')}
          </div>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="btn btn-secondary" id="onboarding-suggest-vps" style="font-size: 12px; padding: 5px 12px;">
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;">lightbulb</span>
              ${t('onboarding.suggestBtn')}
            </button>
            <button class="btn btn-secondary" id="onboarding-contribute-vps" style="font-size: 12px; padding: 5px 12px;">
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;">code</span>
              ${t('onboarding.contributeBtn')}
            </button>
          </div>
        </div>

        <div style="margin-top: 12px;">
          <button class="btn btn-secondary" id="onboarding-vps-back" style="font-size: 12px; padding: 6px 14px;">
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">arrow_back</span>
            ${t('common.back')}
          </button>
        </div>
      </div>
    `;
  }

  /* ─── events ────────────────────────────────────────────────────────── */

  private attachEvents(content: HTMLElement): void {
    // Welcome screen
    content.querySelector('#onboarding-join')?.addEventListener('click', () => {
      this.markCompleted();
      this.close('join');
    });
    content.querySelector('#onboarding-host')?.addEventListener('click', () => {
      this.screen = 'host-method';
      this.render();
    });
    content.querySelector('#onboarding-skip')?.addEventListener('click', () => {
      this.markCompleted();
      this.close();
    });

    // Host method screen
    content.querySelector('#onboarding-lan')?.addEventListener('click', () => {
      this.markCompleted();
      this.close('host');
      tutorialViewer.open(lanTutorial);
    });
    content.querySelector('#onboarding-vpn')?.addEventListener('click', () => {
      this.screen = 'vpn-select';
      this.render();
    });
    content.querySelector('#onboarding-port')?.addEventListener('click', () => {
      this.markCompleted();
      this.close('host');
      tutorialViewer.open(portForwardTutorial);
    });
    content.querySelector('#onboarding-vps')?.addEventListener('click', () => {
      this.screen = 'vps-select';
      this.render();
    });
    content.querySelector('#onboarding-back')?.addEventListener('click', () => {
      this.screen = 'welcome';
      this.render();
    });
    content.querySelector('#onboarding-skip2')?.addEventListener('click', () => {
      this.markCompleted();
      this.close();
    });

    // VPN selection
    content.querySelectorAll('[data-vpn]').forEach((el) => {
      el.addEventListener('click', () => {
        const vpnId = el.getAttribute('data-vpn');
        this.markCompleted();
        this.close('host');
        const tutorial = this.getVpnTutorial(vpnId);
        if (tutorial) tutorialViewer.open(tutorial);
      });
    });
    content.querySelector('#onboarding-vpn-back')?.addEventListener('click', () => {
      this.screen = 'host-method';
      this.render();
    });
    content.querySelector('#onboarding-contribute')?.addEventListener('click', () => {
      window.api?.openExternal?.(CONTRIBUTE_URL);
    });
    content.querySelector('#onboarding-suggest')?.addEventListener('click', () => {
      window.api?.openExternal?.(SUGGEST_URL);
    });

    // VPS selection
    content.querySelectorAll('[data-vps]').forEach((el) => {
      el.addEventListener('click', () => {
        const vpsId = el.getAttribute('data-vps');
        this.markCompleted();
        this.close('host');
        const tutorial = this.getVpsTutorial(vpsId);
        if (tutorial) tutorialViewer.open(tutorial);
      });
    });
    content.querySelector('#onboarding-vps-back')?.addEventListener('click', () => {
      this.screen = 'host-method';
      this.render();
    });
    content.querySelector('#onboarding-contribute-vps')?.addEventListener('click', () => {
      window.api?.openExternal?.(CONTRIBUTE_URL);
    });
    this.modalEl?.querySelector('#onboarding-suggest-vps')?.addEventListener('click', () => {
      window.api?.openExternal?.(SUGGEST_URL);
    });
  }

  private getVpnTutorial(id: string | null) {
    switch (id) {
      case 'radmin': return radminTutorial;
      case 'tailscale': return tailscaleTutorial;
      case 'hamachi': return hamachiTutorial;
      case 'zerotier': return zerotierTutorial;
      default: return null;
    }
  }

  private getVpsTutorial(id: string | null) {
    switch (id) {
      case 'oracle': return vpsOracleFreeTutorial;
      case 'generic': return vpsGenericTutorial;
      default: return null;
    }
  }

  private markCompleted(): void {
    settingsStore.onboardingCompleted = true;
    settingsStore.save();
  }
}

export const onboardingWizard = new OnboardingWizard();
