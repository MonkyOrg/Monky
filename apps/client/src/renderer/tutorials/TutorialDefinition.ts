import type { TranslationKey } from '../i18n';
import type { OnboardingShot } from '../views/onboardingShots';

/** A single slide in an in-app tutorial. */
export interface TutorialStep {
  /** i18n key for the step title. */
  title: TranslationKey;
  /** i18n key for the step body (may contain lightweight HTML). */
  content: TranslationKey;
  /** Optional tip/callout shown below the main content. */
  tip?: TranslationKey;
  /** Optional Monky screenshots illustrating the step, in the app language. */
  images?: { shot: OnboardingShot; alt: TranslationKey }[];
}

/** Full definition of a step-by-step tutorial rendered by `TutorialViewer`. */
export interface TutorialDefinition {
  /** Unique slug, e.g. 'radmin-vpn', 'port-forward'. */
  id: string;
  /** i18n key for the tutorial name shown in the header. */
  name: TranslationKey;
  /** Material Symbols icon name or emoji. */
  icon: string;
  /** Ordered list of steps. */
  steps: TutorialStep[];
}
