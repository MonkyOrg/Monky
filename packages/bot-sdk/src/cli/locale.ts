import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { normalizeBotLocale, type BotLocale } from '@monky/shared';
import { ensurePrivateDirectory, writePrivateJson } from './fs';

export function cliText(locale: BotLocale, portuguese: string, english: string): string {
  return locale === 'en' ? english : portuguese;
}

export class CliError extends Error {
  constructor(readonly portuguese: string, readonly english: string) {
    super(english);
  }
}

export function cliErrorMessage(error: unknown, locale: BotLocale): string {
  if (error instanceof CliError) return cliText(locale, error.portuguese, error.english);
  return error instanceof Error ? error.message : cliText(locale, 'Falha inesperada no CLI.', 'Unexpected CLI failure.');
}

export function readSavedCliLocale(homeDir: string): BotLocale | undefined {
  let contents: string;
  try {
    const file = path.join(homeDir, 'preferences.json');
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024) {
      throw new CliError('O arquivo de idioma do CLI deve ser um arquivo JSON de até 1024 bytes.',
        'The CLI language preference must be a JSON file of at most 1024 bytes.');
    }
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    if (error instanceof CliError) throw error;
    throw new CliError('Não foi possível ler a preferência de idioma do CLI.',
      'Could not read the CLI language preference.');
  }
  let input: unknown;
  try {
    input = JSON.parse(contents);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new CliError('A preferência de idioma do CLI contém JSON inválido.',
      'The CLI language preference contains invalid JSON.');
  }
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new CliError('A preferência de idioma do CLI deve conter um objeto.',
      'The CLI language preference must contain an object.');
  }
  if (!('locale' in input)) return undefined;
  const locale = normalizeBotLocale(input.locale);
  if (!locale) throw new CliError('A preferência de idioma do CLI deve ser pt-BR ou en.',
    'The CLI language preference must be pt-BR or en.');
  return locale;
}

export function defaultCliLocale(
  homeDir: string, env: NodeJS.ProcessEnv = process.env, toleratePreferenceErrors = false,
): BotLocale {
  const variable = env.MONKY_BOT_LOCALE !== undefined ? 'MONKY_BOT_LOCALE' : 'MONKY_LANG';
  if (env[variable] !== undefined) {
    const environment = normalizeBotLocale(env[variable]);
    if (!environment) throw new CliError(`Use pt-BR ou en em ${variable}.`, `Use pt-BR or en in ${variable}.`);
    return environment;
  }
  const system = env.LC_ALL || env.LC_MESSAGES || env.LANG || env.LANGUAGE || '';
  const fallback = system.split(':').map(normalizeBotLocale).find((locale) => locale !== undefined) ?? 'pt-BR';
  try {
    return readSavedCliLocale(homeDir) ?? fallback;
  } catch (error) {
    if (!toleratePreferenceErrors || !(error instanceof CliError)) throw error;
    console.warn(cliText(fallback, 'Aviso: ', 'Warning: ') + cliErrorMessage(error, fallback));
    return fallback;
  }
}

export function saveCliLocale(homeDir: string, locale: BotLocale): void {
  const pending = path.join(homeDir, `.preferences-${randomUUID()}.pending`);
  try {
    ensurePrivateDirectory(homeDir);
    writePrivateJson(pending, { locale });
    fs.renameSync(pending, path.join(homeDir, 'preferences.json'));
  } catch {
    try {
      fs.rmSync(pending, { force: true });
    } catch {
      throw new CliError('Não foi possível salvar o idioma nem remover o arquivo temporário da preferência.',
        'Could not save the language or remove the temporary preference file.');
    }
    throw new CliError('Não foi possível salvar o idioma; a preferência anterior foi preservada.',
      'Could not save the language; the previous preference was preserved.');
  }
}

export function parseCliLocaleArgs(args: string[]): { args: string[]; locale?: BotLocale } {
  const remaining: string[] = [];
  let locale: BotLocale | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument !== '--locale' && !argument.startsWith('--locale=')) {
      remaining.push(argument);
      continue;
    }
    const value = argument === '--locale' ? args[++index] : argument.slice('--locale='.length);
    const parsed = normalizeBotLocale(value);
    if (!parsed || locale) throw new Error('Use --locale pt-BR ou/or --locale en.');
    locale = parsed;
  }
  return { args: remaining, ...(locale ? { locale } : {}) };
}

export function shouldPromptCliLocale(
  homeDir: string, args: string[], explicitLocale?: BotLocale, env: NodeJS.ProcessEnv = process.env,
): boolean {
  const command = args[0];
  return isInteractiveCliAccess(args, env) && !explicitLocale &&
    env.MONKY_BOT_LOCALE === undefined && env.MONKY_LANG === undefined &&
    !(command === 'config' && args[1] === 'language') &&
    (!command || ['menu', 'setup', 'start', 'stop', 'restart', 'status', 'logs', 'config', 'update', 'autoupdate'].includes(command)) &&
    !readSavedCliLocale(homeDir);
}

export function isInteractiveCliAccess(args: string[], env: NodeJS.ProcessEnv = process.env): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY && !env.CI &&
    !['help', 'version'].includes(args[0]) &&
    !args.some((arg) => ['--non-interactive', '--yes', '-y', '--check', '--help', '-h', '--version', '-v',
      '--from-env', '--status', '--clear'].includes(arg));
}

export async function chooseCliLocale(current: BotLocale): Promise<BotLocale> {
  const { askCliChoice } = await import('./prompts');
  return askCliChoice(current, 'Idioma / Language', [
    { value: 'pt-BR', label: 'Português (Brasil)' }, { value: 'en', label: 'English (US)' },
  ], current);
}

export async function languageCommand(context: { homeDir: string; locale: BotLocale }, args: string[]): Promise<void> {
  if (args.length > 1 || (args.length === 1 && !normalizeBotLocale(args[0]))) {
    throw new CliError('Use config language pt-BR ou config language en-US.',
      'Use config language pt-BR or config language en-US.');
  }
  const selected = normalizeBotLocale(args[0]) ??
    (!args.length && isInteractiveCliAccess(['language']) ? await chooseCliLocale(context.locale) : undefined);
  if (selected) {
    saveCliLocale(context.homeDir, selected);
    context.locale = selected;
  }
  const tag = context.locale === 'en' ? 'en-US' : 'pt-BR';
  console.log(cliText(context.locale, `Idioma: ${tag}`, `Language: ${tag}`));
}
