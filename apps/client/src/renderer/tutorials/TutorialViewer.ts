import type { TutorialDefinition } from './TutorialDefinition';
import { t } from '../i18n';
import { enterModal, exitModal } from '../utils/modalSurface';
import { replaceModalStep } from '../utils/modalSteps';
import { enableBackdropClose } from '../utils/modal';
import { renderOnboardingShot } from '../views/onboardingShots';

/**
 * Generic in-app tutorial viewer.
 *
 * Receives any `TutorialDefinition` and renders a multi-step modal with
 * progress bar, Next/Prev navigation and text content.  Designed so adding a
 * new tutorial is as simple as creating a `TutorialDefinition` file — zero UI
 * code required from the tutorial author.
 */
export class TutorialViewer {
  private modalEl: HTMLElement | null = null;
  private currentStep = 0;
  private renderedStep = 0;
  private definition: TutorialDefinition | null = null;
  private onCloseCallback: (() => void) | null = null;

  /** Opens the viewer for the given tutorial. */
  public open(definition: TutorialDefinition, onClose?: () => void): void {
    this.close();
    this.definition = definition;
    this.currentStep = 0;
    this.onCloseCallback = onClose ?? null;
    this.render();
  }

  public close(): void {
    if (this.modalEl) {
      exitModal(this.modalEl);
      this.modalEl = null;
    }
    if (this.onCloseCallback) {
      this.onCloseCallback();
      this.onCloseCallback = null;
    }
    this.definition = null;
  }

  /* ─── rendering ─────────────────────────────────────────────────────── */

  private render(): void {
    if (!this.definition) return;
    const opening = !this.modalEl;

    const def = this.definition;
    const step = def.steps[this.currentStep];
    const total = def.steps.length;
    const isFirst = this.currentStep === 0;
    const isLast = this.currentStep === total - 1;
    const progressPct = ((this.currentStep + 1) / total) * 100;
    const shots = (step.images ?? [])
      .map((image) => renderOnboardingShot(image.shot, t(image.alt), 'tutorial-shot'))
      .join('');

    if (!this.modalEl) {
      this.modalEl = document.createElement('div');
      this.modalEl.className = 'modal-backdrop';
      document.body.appendChild(this.modalEl);
      enableBackdropClose(this.modalEl, () => this.close());
    }

    const next = document.createElement('div');
    next.innerHTML = `
      <div class="modal-card onboarding-tutorial-card" style="max-width: 560px;">
        <!-- Header -->
        <div class="modal-header" style="display: flex; align-items: center; justify-content: space-between;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span class="material-symbols-outlined" style="color: var(--accent-primary);">${def.icon}</span>
            <span style="font-weight: 700; font-size: 15px;">${t(def.name)}</span>
          </div>
          <div style="display: flex; align-items: center; gap: 12px;">
            <span style="font-size: 12px; color: var(--text-muted);">
              ${t('tutorial.stepOf', { current: this.currentStep + 1, total })}
            </span>
            <button class="modal-close-btn" id="tutorial-close">&times;</button>
          </div>
        </div>

        <!-- Progress bar -->
        <div style="width: 100%; height: 4px; background: var(--bg-tertiary); border-radius: 2px; overflow: hidden;">
          <div style="width: ${progressPct}%; height: 100%; background: var(--accent-primary); transition: width 0.3s ease;"></div>
        </div>

        <!-- Step content -->
        <div class="tutorial-step-body">
          <h3 style="font-size: 16px; font-weight: 700; color: var(--text-primary); margin: 0 0 12px 0;">
            ${t(step.title)}
          </h3>

          ${shots || `
            <div class="tutorial-image-placeholder">
              <span class="material-symbols-outlined" style="font-size: 32px; color: var(--text-muted);">image</span>
              <span style="font-size: 11px; color: var(--text-muted);">${t('tutorial.imagePlaceholder')}</span>
            </div>
          `}

          <div class="tutorial-content" style="font-size: 13px; color: var(--text-secondary); line-height: 1.65;">
            ${t(step.content)}
          </div>
          ${step.tip ? `
            <div style="margin-top: 14px; padding: 10px 14px; background: rgba(88, 101, 242, 0.08); border: 1px solid rgba(88, 101, 242, 0.25); border-radius: var(--radius-md); font-size: 12px; color: var(--text-secondary); line-height: 1.5;">
              <span style="font-weight: 600; color: var(--accent-primary);">💡 ${t('tutorial.tip')}:</span> ${t(step.tip)}
            </div>
          ` : ''}
        </div>

        <!-- Navigation -->
        <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 8px; border-top: 1px solid var(--border-color);">
          <button class="btn btn-secondary" id="tutorial-prev" ${isFirst ? 'disabled style="visibility: hidden;"' : ''}>
            <span class="material-symbols-outlined md-16" style="margin-right: 4px;">arrow_back</span>
            ${t('common.previous')}
          </button>
          ${isLast ? `
            <button class="btn btn-primary" id="tutorial-finish">
              <span class="material-symbols-outlined md-16" style="margin-right: 4px;">check_circle</span>
              ${t('common.done')}
            </button>
          ` : `
            <button class="btn btn-primary" id="tutorial-next">
              ${t('common.next')}
              <span class="material-symbols-outlined md-16" style="margin-left: 4px;">arrow_forward</span>
            </button>
          `}
        </div>
      </div>
    `;

    const content = replaceModalStep(this.modalEl, next.firstElementChild as HTMLElement, this.currentStep - this.renderedStep);
    this.renderedStep = this.currentStep;
    this.attachEvents(content);
    if (opening) enterModal(this.modalEl);
    else content.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  }

  private attachEvents(content: HTMLElement): void {
    content.querySelector('#tutorial-close')?.addEventListener('click', () => this.close());
    content.querySelector('#tutorial-prev')?.addEventListener('click', () => {
      if (this.currentStep > 0) {
        this.currentStep--;
        this.render();
      }
    });
    content.querySelector('#tutorial-next')?.addEventListener('click', () => {
      if (this.definition && this.currentStep < this.definition.steps.length - 1) {
        this.currentStep++;
        this.render();
      }
    });
    content.querySelector('#tutorial-finish')?.addEventListener('click', () => this.close());

    // Make links inside tutorial content open in the system browser
    content.querySelectorAll('.tutorial-content a').forEach((el) => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        const href = (el as HTMLAnchorElement).href;
        if (href) window.api?.openExternal?.(href);
      });
    });

    // Inject copy buttons and syntax highlighting into terminal command blocks
    content.querySelectorAll('.tutorial-cmd').forEach((block) => {
      const cmd = block.textContent?.trim() || '';

      // Apply syntax highlighting
      block.innerHTML = TutorialViewer.highlightCommand(cmd);

      const copyBtn = document.createElement('button');
      copyBtn.className = 'tutorial-cmd-copy';
      copyBtn.title = 'Copy';
      copyBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">content_copy</span>';
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(cmd).then(() => {
          copyBtn.classList.add('copied');
          copyBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size: 14px;">check</span>`;
          setTimeout(() => {
            copyBtn.classList.remove('copied');
            copyBtn.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">content_copy</span>';
          }, 2000);
        });
      });
      block.appendChild(copyBtn);
    });
  }

  /**
   * Applies terminal-style syntax highlighting to a shell command string.
   * Colors: command (green), flags (cyan), urls (yellow), pipes/operators (magenta),
   * strings (orange), comments (gray).
   */
  private static highlightCommand(cmd: string): string {
    // Escape HTML first
    const escaped = cmd
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    return escaped
      // URLs (https://... or http://...)
      .replace(/(https?:\/\/[^\s]+)/g, '<span class="sh-url">$1</span>')
      // Pipes and redirects
      .replace(/(\|)/g, '<span class="sh-pipe">$1</span>')
      // Flags (--word or -letter)
      .replace(/(\s)(--?\w[\w-]*)/g, '$1<span class="sh-flag">$2</span>')
      // Sudo
      .replace(/^(sudo)\b/, '<span class="sh-sudo">$1</span>')
      // Known commands at start of line or after pipe
      .replace(/(^|\|\s*)(curl|bash|npm|npx|monky|git|ssh|apt|iptables|ipconfig|ip)\b/g,
        '$1<span class="sh-cmd">$2</span>');
  }
}

export const tutorialViewer = new TutorialViewer();
