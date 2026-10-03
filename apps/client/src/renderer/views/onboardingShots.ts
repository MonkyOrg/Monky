import { getLanguage, type SupportedLanguage } from '../i18n';
import { escapeHtml } from '../utils/html';

/**
 * App screenshots shown by the onboarding and the hosting tutorials.
 *
 * Files live in `assets/onboarding/<shot>-<language>.png` and are regenerated
 * with `npm run screenshots:onboarding`, so the pictures always match the
 * current UI in every supported language.
 */
export type OnboardingShot =
  | 'home'
  | 'add-server-choice'
  | 'add-server-create'
  | 'add-server-join'
  | 'invite-lan'
  | 'invite-public'
  | 'invite-radmin'
  | 'invite-hamachi'
  | 'invite-tailscale'
  | 'invite-zerotier'
  | 'terminal-ipconfig'
  | 'terminal-gateway'
  | 'terminal-ip-unix'
  | 'terminal-ssh'
  | 'terminal-monky-install'
  | 'terminal-monky-create';

const FILES = import.meta.glob<string>('../assets/onboarding/*.png', { eager: true, import: 'default' });

export function onboardingShotUrl(shot: OnboardingShot, language: SupportedLanguage = getLanguage()): string | null {
  return FILES[`../assets/onboarding/${shot}-${language}.png`]
    ?? FILES[`../assets/onboarding/${shot}-pt-BR.png`]
    ?? null;
}

export function renderOnboardingShot(shot: OnboardingShot, alt: string, className = ''): string {
  const url = onboardingShotUrl(shot);
  if (!url) return '';
  return `<figure class="onboarding-shot ${className}">
    <img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" draggable="false" decoding="async">
  </figure>`;
}
