import { appEvents } from '../core/EventBus';
import { ptBR } from './locales/pt-BR';
import { en } from './locales/en';
import { TOUCH_POINTER_QUERY } from '../utils/viewport';

/**
 * Minimal i18n layer for the renderer (#16).
 *
 * The renderer has no framework: views build their HTML with template strings
 * and re-render themselves. So translation is a plain lookup — `t('some.key')`
 * — and switching languages just emits `i18n.language_changed`, which the views
 * listen to in order to re-render with the new catalog.
 *
 * Adding a language means adding one file under `locales/` and registering it
 * in `CATALOGS` + `SUPPORTED_LANGUAGES`; nothing else in the app changes.
 */

export type TranslationKey = keyof typeof ptBR;
export type TranslationMap = Record<TranslationKey, string>;
export type SupportedLanguage = 'pt-BR' | 'en';

export const SUPPORTED_LANGUAGES: Array<{ code: SupportedLanguage; label: string }> = [
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'en', label: 'English' },
];

const FALLBACK_LANGUAGE: SupportedLanguage = 'pt-BR';
const STORAGE_KEY = 'monky_language';

const CATALOGS: Record<SupportedLanguage, TranslationMap> = {
  'pt-BR': ptBR,
  en,
};

function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return SUPPORTED_LANGUAGES.some((lang) => lang.code === value);
}

/**
 * Picks a language from the OS/browser locale list. Used only until the user
 * makes an explicit choice in the settings.
 */
export function detectSystemLanguage(): SupportedLanguage {
  const candidates: string[] = [];

  try {
    if (Array.isArray(navigator.languages)) candidates.push(...navigator.languages);
    if (navigator.language) candidates.push(navigator.language);
  } catch {
    // navigator unavailable (tests/headless) — fall through to the default.
  }

  for (const candidate of candidates) {
    const prefix = String(candidate).toLowerCase().split('-')[0];
    const match = SUPPORTED_LANGUAGES.find((lang) => lang.code.toLowerCase().split('-')[0] === prefix);
    if (match) return match.code;
  }

  return FALLBACK_LANGUAGE;
}

function loadStoredLanguage(): SupportedLanguage | null {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isSupportedLanguage(stored) ? stored : null;
  } catch {
    return null;
  }
}

let currentLanguage: SupportedLanguage = loadStoredLanguage() ?? detectSystemLanguage();

export function getLanguage(): SupportedLanguage {
  return currentLanguage;
}

/** True when the user picked a language by hand (instead of OS detection). */
export function hasExplicitLanguage(): boolean {
  return loadStoredLanguage() !== null;
}

export function setLanguage(language: SupportedLanguage): void {
  if (!isSupportedLanguage(language)) return;

  const changed = language !== currentLanguage;
  currentLanguage = language;

  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    // Persisting is best-effort; the choice still applies to this session.
  }

  try {
    document.documentElement.lang = language;
  } catch {
    // No DOM (tests) — nothing to do.
  }

  syncLanguageWithMainProcess();

  if (changed) {
    appEvents.emit('i18n.language_changed', language);
  }
}

/**
 * Native dialogs live in the main process, which has its own small catalog —
 * keep it aligned with what the user sees here.
 */
function syncLanguageWithMainProcess(): void {
  try {
    void window.api?.setLanguage?.(currentLanguage);
  } catch {
    // The bridge is optional (e.g. plain browser build) — ignore.
  }
}

/** Applies the current language to the document. Call once at startup. */
export function initI18n(): void {
  try {
    document.documentElement.lang = currentLanguage;
  } catch {
    // No DOM — nothing to do.
  }

  syncLanguageWithMainProcess();
}

/**
 * Translates `key`, replacing `{placeholders}` with `params`.
 * Missing keys fall back to pt-BR and, ultimately, to the key itself, so a
 * half-translated catalog never blanks out the UI.
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const catalog = CATALOGS[currentLanguage] ?? CATALOGS[FALLBACK_LANGUAGE];
  const template = catalog[key] ?? CATALOGS[FALLBACK_LANGUAGE][key] ?? String(key);

  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match
  );
}

/** Keys that have a `…Touch` wording for screens without a mouse. */
export type TouchTranslationKey = {
  [K in TranslationKey]: `${K}Touch` extends TranslationKey ? K : never;
}[TranslationKey];

/**
 * Like `t`, but on touch screens picks the `<key>Touch` variant, which says
 * "tap" instead of "click" and drops hover and right-click hints.
 */
export function tTouch(key: TouchTranslationKey, params?: Record<string, string | number>): string {
  const touch = typeof matchMedia === 'function' && matchMedia(TOUCH_POINTER_QUERY).matches;
  return t(touch ? `${key}Touch` : key, params);
}

/**
 * Count-aware variant: looks up `<key>.one` or `<key>.other` and exposes the
 * count as `{count}`. Keeps English plurals correct without a plural engine.
 */
export function tCount(
  key: string,
  count: number,
  params?: Record<string, string | number>
): string {
  const suffix = Math.abs(count) === 1 ? 'one' : 'other';
  return t(`${key}.${suffix}` as TranslationKey, { count, ...(params || {}) });
}
