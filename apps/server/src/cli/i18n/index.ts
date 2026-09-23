/**
 * CLI i18n module.
 *
 * Mirrors the client's approach: pt-BR is the source-of-truth, English mirrors
 * it, and `t()` replaces `{placeholders}` at call sites.
 *
 * The CLI preference lives in MONKY_HOME/cli-config.json (or ~/.monky).
 * Explicit process locales never read an Electron profile.
 */
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ptBR } from './locales/pt-BR';
import { en } from './locales/en';

export type CliTranslationKey = keyof typeof ptBR;
export type CliTranslationMap = Record<CliTranslationKey, string>;
export type SupportedCliLanguage = 'pt-BR' | 'en';

export const SUPPORTED_CLI_LANGUAGES: Array<{ code: SupportedCliLanguage; label: string }> = [
  { code: 'en', label: 'English (US)' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
];

const FALLBACK_LANGUAGE: SupportedCliLanguage = 'en';

const CATALOGS: Record<SupportedCliLanguage, CliTranslationMap> = {
  'pt-BR': ptBR,
  en,
};

let currentLanguage: SupportedCliLanguage = FALLBACK_LANGUAGE;

export function getCliLanguage(): SupportedCliLanguage {
  return currentLanguage;
}

export function setCliLanguage(language: SupportedCliLanguage): void {
  currentLanguage = language;
}

/** Accept language tags from flags, the app and POSIX locale variables. */
export function normalizeCliLanguage(value: string): SupportedCliLanguage | null {
  const language = value.trim().replace(/_/g, '-').split(/[.@]/)[0].toLowerCase();
  if (/^en(?:-[a-z0-9]{2,8})*$/.test(language)) return 'en';
  if (/^pt(?:-[a-z0-9]{2,8})*$/.test(language)) return 'pt-BR';
  return null;
}

/**
 * Translates `key`, replacing `{placeholders}` with `params`.
 * Missing keys fall back to pt-BR and, ultimately, to the key itself.
 */
export function t(key: CliTranslationKey, params?: Record<string, string | number>): string {
  const catalog = CATALOGS[currentLanguage] ?? CATALOGS[FALLBACK_LANGUAGE];
  const template = catalog[key] ?? CATALOGS['pt-BR'][key] ?? String(key);

  if (!params) return template;

  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    params[name] !== undefined ? String(params[name]) : match
  );
}

// ── Language persistence ──────────────────────────────────────────────────

export function getCliConfigPath(): string {
  const directory = process.env.MONKY_HOME || path.join(os.homedir(), '.monky');
  return path.join(directory, 'cli-config.json');
}

interface GlobalCliConfig {
  [key: string]: unknown;
  language?: SupportedCliLanguage;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readGlobalConfig(configPath = getCliConfigPath()): GlobalCliConfig {
  let contents: string;
  try {
    contents = fs.readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw new Error(t('language.configReadFailed', { path: configPath, reason: errorMessage(error) }));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw new Error(t('language.configInvalid', { path: configPath, reason: errorMessage(error) }));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(t('language.configInvalid', { path: configPath, reason: t('language.configExpectedObject') }));
  }
  if (!('language' in parsed)) return { ...parsed };
  const language = typeof parsed.language === 'string' ? normalizeCliLanguage(parsed.language) : null;
  if (!language) {
    throw new Error(t('language.configInvalid', { path: configPath, reason: t('language.configInvalidLanguage') }));
  }
  return { ...parsed, language };
}

function writeGlobalConfig(configPath: string, config: GlobalCliConfig): void {
  const pendingPath = `${configPath}.${randomUUID()}.pending`;
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    // Replace only after a complete write, so an interrupted save preserves the
    // previous preference rather than leaving a truncated JSON document.
    fs.writeFileSync(pendingPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(pendingPath, configPath);
  } catch (error) {
    let reason = errorMessage(error);
    try {
      fs.rmSync(pendingPath, { force: true });
    } catch (cleanupError) {
      reason += `; ${t('language.configCleanupFailed', { path: pendingPath, reason: errorMessage(cleanupError) })}`;
    }
    throw new Error(t('language.configWriteFailed', { path: configPath, reason }));
  }
}

/**
 * Loads the persisted language or returns null if none is set.
 */
export function loadPersistedLanguage(): SupportedCliLanguage | null {
  return readGlobalConfig().language ?? null;
}

/** Persists the chosen language to the global CLI config. */
export function persistLanguage(language: SupportedCliLanguage): void {
  const configPath = getCliConfigPath();
  const config = readGlobalConfig(configPath);
  config.language = language;
  writeGlobalConfig(configPath, config);
}

export function detectCliLanguage(): SupportedCliLanguage {
  const locale = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || process.env.LANGUAGE || '';
  for (const preference of locale.split(':')) {
    const language = normalizeCliLanguage(preference);
    if (language) return language;
  }
  return FALLBACK_LANGUAGE;
}

/**
 * Flags and an app/process-selected MONKY_LANG override the stored preference
 * without reading it. OS detection is only a fallback, not a saved choice.
 * Returns false when an interactive command still needs a first-run choice.
 */
export function initCliI18n(explicitLanguage?: SupportedCliLanguage): boolean {
  setCliLanguage(detectCliLanguage());
  if (explicitLanguage) {
    setCliLanguage(explicitLanguage);
    return true;
  }
  if (process.env.MONKY_LANG !== undefined) {
    const language = normalizeCliLanguage(process.env.MONKY_LANG);
    if (!language) {
      throw new Error(t('language.invalidEnvironment', { value: process.env.MONKY_LANG }));
    }
    setCliLanguage(language);
    return true;
  }
  const stored = loadPersistedLanguage();
  if (stored) {
    setCliLanguage(stored);
    return true;
  }
  return false;
}
