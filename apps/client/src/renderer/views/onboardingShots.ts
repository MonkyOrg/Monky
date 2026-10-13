import { getLanguage, type SupportedLanguage } from '../i18n';
import { escapeHtml } from '../utils/html';
import { ONBOARDING_SHOT_SIZES } from './onboardingShotSizes';

/**
 * Pictures shown by the onboarding and the hosting tutorials.
 *
 * Monky screenshots and illustrations live in
 * `assets/onboarding/<shot>-<language>.png` and are regenerated with
 * `npm run screenshots:onboarding`, so they always match the current UI in
 * every supported language. Pictures of other apps that do not change with
 * the Monky language use `<shot>.png`.
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
  | 'terminal-monky-create'
  | 'illustration-lan'
  | 'illustration-router-menu'
  | 'illustration-router-rule'
  | 'illustration-public-ip'
  | 'illustration-vps-providers'
  | 'illustration-oracle-instance'
  | 'illustration-oracle-ingress'
  | 'site-radmin'
  | 'site-hamachi'
  | 'site-tailscale'
  | 'site-zerotier'
  | 'site-oracle-free'
  | 'app-radmin-create'
  | 'app-radmin-join'
  | 'app-radmin-ip'
  | 'app-hamachi-create'
  | 'app-hamachi-join'
  | 'app-hamachi-ip'
  | 'app-tailscale-keys'
  | 'app-tailscale-ip'
  | 'app-zerotier-create'
  | 'app-zerotier-join'
  | 'app-zerotier-ip';

interface ShotImage {
  url: string;
  size: readonly [number, number] | undefined;
}

const FILES = import.meta.glob<string>('../assets/onboarding/*.png', { eager: true, import: 'default' });
const preloaded = new Set<string>();

function resolveShot(shot: OnboardingShot, language: SupportedLanguage): ShotImage | null {
  for (const name of [`${shot}-${language}`, shot, `${shot}-pt-BR`]) {
    const url = FILES[`../assets/onboarding/${name}.png`];
    if (url) return { url, size: ONBOARDING_SHOT_SIZES[name] };
  }
  return null;
}

export function onboardingShotUrl(shot: OnboardingShot, language: SupportedLanguage = getLanguage()): string | null {
  return resolveShot(shot, language)?.url ?? null;
}

/** The width and height reserve the picture's space, so the card keeps its size while it loads. */
export function renderOnboardingShot(shot: OnboardingShot, alt: string, className = ''): string {
  const image = resolveShot(shot, getLanguage());
  if (!image) return '';
  const size = image.size ? ` width="${image.size[0]}" height="${image.size[1]}"` : '';
  return `<figure class="onboarding-shot ${className}">
    <img src="${escapeHtml(image.url)}" alt="${escapeHtml(alt)}"${size} draggable="false">
  </figure>`;
}

/** Decodes the pictures of the step the user is likely to open next, so it appears complete. */
export function preloadOnboardingShots(shots: readonly OnboardingShot[]): void {
  for (const shot of shots) {
    const url = onboardingShotUrl(shot);
    if (!url || preloaded.has(url)) continue;
    preloaded.add(url);
    const image = new Image();
    image.src = url;
    image.decode().catch(() => preloaded.delete(url));
  }
}
