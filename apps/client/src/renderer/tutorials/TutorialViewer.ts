import type { HostingSkillId } from '@monky/shared';
import type { TutorialDefinition } from './TutorialDefinition';
import { t } from '../i18n';
import type { OnboardingShot } from '../views/onboardingShots';
import { renderOnboardingShot } from '../views/onboardingShots';
import { showErrorToast, showSuccessToast } from '../views/CopyToast';

/** What the buttons of a tutorial step do; the onboarding wizard owns the navigation. */
export interface TutorialStepActions {
  /** Previous step, or back to the list of tutorials on the first step. */
  previous(): void;
  next(): void;
  finish(): void;
  close(): void;
}

/**
 * Markup of one tutorial step. It renders inside the onboarding modal card,
 * so moving between the guide, a tutorial and its steps never swaps dialogs.
 * Adding a tutorial only needs a `TutorialDefinition` file.
 */
export function renderTutorialStep(definition: TutorialDefinition, index: number): string {
  const step = definition.steps[index];
  const total = definition.steps.length;
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const shots = (step.images ?? [])
    .map((image) => renderOnboardingShot(image.shot, t(image.alt), 'tutorial-shot'))
    .join('');

  return `
    <section class="modal-card onboarding-card onboarding-card--tutorial" role="dialog" aria-modal="true" aria-labelledby="tutorial-step-title">
      <header class="tutorial-header">
        <div class="tutorial-name">
          <span class="material-symbols-outlined" aria-hidden="true">${definition.icon}</span>
          <span>${t(definition.name)}</span>
        </div>
        <div class="tutorial-header-actions">
          <span class="tutorial-step-count">${t('tutorial.stepOf', { current: index + 1, total })}</span>
          <button type="button" class="modal-close-btn" id="tutorial-close" aria-label="${t('common.close')}">&times;</button>
        </div>
      </header>

      <div class="tutorial-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="${index + 1}">
        <div class="tutorial-progress-fill" style="width: ${((index + 1) / total) * 100}%;"></div>
      </div>

      <button type="button" class="tutorial-ai-skill" id="tutorial-ai-skill">
        <span class="material-symbols-outlined tutorial-ai-skill-icon" aria-hidden="true">smart_toy</span>
        <span class="tutorial-ai-skill-text">
          <strong>${t('tutorial.aiSkillTitle')}</strong>
          <span>${t('tutorial.aiSkillDesc')}</span>
        </span>
        <span class="tutorial-ai-skill-cta">
          <span class="material-symbols-outlined md-16" aria-hidden="true">download</span>
          ${t('tutorial.aiSkillAction')}
        </span>
      </button>

      <div class="tutorial-step-body">
        <h3 class="tutorial-step-title" id="tutorial-step-title">${t(step.title)}</h3>
        ${shots}
        <div class="tutorial-content">${t(step.content)}</div>
        ${step.tip ? `
          <div class="tutorial-tip">
            <span class="material-symbols-outlined md-16" aria-hidden="true">lightbulb</span>
            <span><strong>${t('tutorial.tip')}:</strong> ${t(step.tip)}</span>
          </div>
        ` : ''}
      </div>

      <div class="tutorial-nav">
        <button type="button" class="btn btn-secondary" id="tutorial-prev">
          <span class="material-symbols-outlined md-16" aria-hidden="true">arrow_back</span>
          ${isFirst ? t('common.back') : t('common.previous')}
        </button>
        ${isLast ? `
          <button type="button" class="btn btn-primary" id="tutorial-finish">
            <span class="material-symbols-outlined md-16" aria-hidden="true">check_circle</span>
            ${t('common.done')}
          </button>
        ` : `
          <button type="button" class="btn btn-primary" id="tutorial-next">
            ${t('common.next')}
            <span class="material-symbols-outlined md-16" aria-hidden="true">arrow_forward</span>
          </button>
        `}
      </div>
    </section>
  `;
}

export function tutorialStepShots(definition: TutorialDefinition, index: number): OnboardingShot[] {
  return (definition.steps[index]?.images ?? []).map((image) => image.shot);
}

export function attachTutorialStep(content: HTMLElement, definition: TutorialDefinition, actions: TutorialStepActions): void {
  content.querySelector('#tutorial-close')?.addEventListener('click', () => actions.close());
  content.querySelector('#tutorial-prev')?.addEventListener('click', () => actions.previous());
  content.querySelector('#tutorial-next')?.addEventListener('click', () => actions.next());
  content.querySelector('#tutorial-finish')?.addEventListener('click', () => actions.finish());
  const skillButton = content.querySelector<HTMLButtonElement>('#tutorial-ai-skill');
  skillButton?.addEventListener('click', () => void saveSkill(skillButton, definition.skill));

  // Links inside the tutorial text open in the system browser.
  content.querySelectorAll<HTMLAnchorElement>('.tutorial-content a').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      if (link.href) window.api?.openExternal?.(link.href);
    });
  });

  // Terminal command blocks get syntax highlighting and a copy button.
  content.querySelectorAll<HTMLElement>('.tutorial-cmd').forEach((block) => {
    const command = block.textContent?.trim() || '';
    block.innerHTML = highlightCommand(command);

    const copyButton = document.createElement('button');
    copyButton.type = 'button';
    copyButton.className = 'tutorial-cmd-copy';
    copyButton.title = t('tutorial.copyCommand');
    copyButton.setAttribute('aria-label', t('tutorial.copyCommand'));
    copyButton.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">content_copy</span>';
    copyButton.addEventListener('click', () => {
      navigator.clipboard.writeText(command).then(() => {
        copyButton.classList.add('copied');
        copyButton.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">check</span>';
        setTimeout(() => {
          copyButton.classList.remove('copied');
          copyButton.innerHTML = '<span class="material-symbols-outlined" style="font-size: 14px;">content_copy</span>';
        }, 2000);
      }).catch(() => undefined);
    });
    block.appendChild(copyButton);
  });
}

/**
 * The main process picks where the zip goes. The button stays focusable while
 * saving (disabling it would drop keyboard focus) and ignores repeated clicks.
 */
async function saveSkill(button: HTMLButtonElement, skill: HostingSkillId): Promise<void> {
  if (button.getAttribute('aria-busy') === 'true') return;
  button.setAttribute('aria-busy', 'true');
  try {
    const result = await window.api.saveHostingSkill(skill);
    if (result.status === 'saved') showSuccessToast(t('tutorial.aiSkillSaved'), 6000);
    else if (result.status === 'failed') showErrorToast(result.error);
  } catch (error) {
    console.warn('[Onboarding] Could not save the hosting skill.', error);
    showErrorToast(t('tutorial.aiSkillFailed'));
  } finally {
    button.removeAttribute('aria-busy');
  }
}

/**
 * Terminal-style highlighting for a shell command: command (green), flags
 * (cyan), urls (yellow), pipes (magenta).
 */
function highlightCommand(command: string): string {
  const escaped = command
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return escaped
    .replace(/(https?:\/\/[^\s]+)/g, '<span class="sh-url">$1</span>')
    .replace(/(\|)/g, '<span class="sh-pipe">$1</span>')
    .replace(/(\s)(--?\w[\w-]*)/g, '$1<span class="sh-flag">$2</span>')
    .replace(/^(sudo)\b/, '<span class="sh-sudo">$1</span>')
    .replace(/(^|\|\s*)(curl|bash|npm|npx|monky|git|ssh|apt|iptables|ipconfig|ip)\b/g,
      '$1<span class="sh-cmd">$2</span>');
}
