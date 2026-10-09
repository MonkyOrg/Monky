import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { randomUUID } from 'node:crypto';
import { normalizeBotReachabilityOrigin } from '@monky/shared';
import { isRecord, type BotMode } from '../tooling/config';
import {
  EMPTY_BOT_REQUIREMENTS, localizedText, type BotLocalizedText, type BotPortRequirement, type BotRequirements,
} from '../tooling/requirements';
import type { CliContext } from './config';
import { readJsonFile, writePrivateJson } from './fs';
import { CliError, cliText } from './locale';
import { askCliValue } from './prompts';

export const PROFILE_ENVIRONMENT_FILE = 'environment.json';
const MAX_VALUE_LENGTH = 4096;

export type DeclaredVariableKind = 'setting' | 'port' | 'host' | 'public-url';

export interface DeclaredVariable {
  name: string;
  kind: DeclaredVariableKind;
  description: BotLocalizedText;
  required: boolean;
  secret: boolean;
  modes: BotMode[];
  port?: BotPortRequirement;
}

export type VariableSource = 'environment' | 'profile' | 'default' | 'missing';

export interface ResolvedVariable {
  variable: DeclaredVariable;
  value?: string;
  source: VariableSource;
  /** True when the environment overrides a different value saved in the profile. */
  overridesProfile: boolean;
}

function portDescription(port: BotPortRequirement, kind: Exclude<DeclaredVariableKind, 'setting'>): BotLocalizedText {
  if (kind === 'port') {
    return { 'pt-BR': `Porta ${port.protocol.toUpperCase()} de "${port.id}" (padrão ${port.defaultPort})`,
      en: `${port.protocol.toUpperCase()} port for "${port.id}" (default ${port.defaultPort})` };
  }
  if (kind === 'host') {
    return { 'pt-BR': `Endereço de escuta de "${port.id}" (padrão 0.0.0.0)`, en: `Listening address for "${port.id}" (default 0.0.0.0)` };
  }
  return { 'pt-BR': `URL pública http(s) de "${port.id}", sem caminho`, en: `Public http(s) URL for "${port.id}", without a path` };
}

export function declaredVariables(requirements: BotRequirements = EMPTY_BOT_REQUIREMENTS): DeclaredVariable[] {
  const variables: DeclaredVariable[] = requirements.settings.map((setting) => ({
    name: setting.env, kind: 'setting', description: setting.description,
    required: setting.required, secret: setting.secret, modes: setting.modes,
  }));
  for (const port of requirements.ports) {
    const entries: [string | undefined, Exclude<DeclaredVariableKind, 'setting'>][] = [
      [port.portEnv, 'port'], [port.hostEnv, 'host'], [port.publicUrlEnv, 'public-url'],
    ];
    for (const [name, kind] of entries) {
      if (name) variables.push({ name, kind, description: portDescription(port, kind), required: false, secret: false, modes: port.modes, port });
    }
  }
  return variables;
}

function validHost(value: string): boolean {
  const unwrapped = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
  if (isIP(unwrapped)) return !unwrapped.includes('%');
  return /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(value);
}

export function validateDeclaredValue(variable: DeclaredVariable, value: unknown): string {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > MAX_VALUE_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(value)) {
    throw new CliError(`${variable.name}: informe um valor sem espaços nas pontas, quebras de linha ou caracteres de controle.`,
      `${variable.name}: provide a value without surrounding spaces, line breaks or control characters.`);
  }
  if (variable.kind === 'port') {
    const port = Number(value);
    if (!/^\d{1,5}$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
      throw new CliError(`${variable.name}: a porta deve ser um inteiro entre 1 e 65535.`,
        `${variable.name}: the port must be an integer between 1 and 65535.`);
    }
    return String(port);
  }
  if (variable.kind === 'host' && !validHost(value)) {
    throw new CliError(`${variable.name}: informe um IP ou nome de host, sem protocolo nem porta.`,
      `${variable.name}: provide an IP or hostname, without a scheme or port.`);
  }
  if (variable.kind === 'public-url') {
    const origin = normalizeBotReachabilityOrigin(value);
    if (!origin) {
      throw new CliError(`${variable.name}: use uma URL http:// ou https:// sem credenciais, caminho, consulta ou fragmento.`,
        `${variable.name}: use an http:// or https:// URL without credentials, path, query or fragment.`);
    }
    return origin;
  }
  return value;
}

export function profileEnvironmentFile(homeDir: string): string {
  return path.join(homeDir, PROFILE_ENVIRONMENT_FILE);
}

export function readProfileEnvironment(homeDir: string): Record<string, string> {
  const file = profileEnvironmentFile(homeDir);
  let stored: unknown;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Not a regular file.');
    stored = readJsonFile(file, 'Bot environment', 512 * 1024);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') return {};
    throw new CliError(`Não foi possível ler ${file}. Corrija ou remova o arquivo e configure novamente com config env set.`,
      `Could not read ${file}. Fix or remove it and configure again with config env set.`);
  }
  if (!isRecord(stored) || stored.version !== 1 || !isRecord(stored.values) ||
      !Object.entries(stored.values).every(([name, value]) => /^[A-Z_][A-Z0-9_]{0,99}$/.test(name) && typeof value === 'string')) {
    throw new CliError(`${file} tem um formato inválido; ele não foi alterado.`, `${file} has an invalid format; it was not changed.`);
  }
  return { ...stored.values } as Record<string, string>;
}

export function writeProfileEnvironment(homeDir: string, values: Record<string, string>): void {
  const pending = path.join(homeDir, `.environment-${randomUUID()}.pending`);
  try {
    writePrivateJson(pending, { version: 1, values });
    fs.renameSync(pending, profileEnvironmentFile(homeDir));
  } catch {
    throw new CliError('Não foi possível salvar as variáveis do bot; o arquivo anterior foi preservado.',
      'Could not save the bot variables; the previous file was preserved.');
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

function providedByEnvironment(env: NodeJS.ProcessEnv | Record<string, unknown>, name: string): string | undefined {
  const value = env[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** The environment wins; the saved profile value only fills variables the environment does not provide. */
export function resolveDeclaredVariables(
  requirements: BotRequirements | undefined, saved: Record<string, string>, env: NodeJS.ProcessEnv | Record<string, unknown>,
): ResolvedVariable[] {
  return declaredVariables(requirements).map((variable) => {
    const environment = providedByEnvironment(env, variable.name);
    const profile = saved[variable.name];
    if (environment !== undefined) {
      return { variable, value: environment, source: 'environment', overridesProfile: profile !== undefined && profile !== environment };
    }
    if (profile !== undefined) return { variable, value: profile, source: 'profile', overridesProfile: false };
    if (variable.kind === 'port' && variable.port) {
      return { variable, value: String(variable.port.defaultPort), source: 'default', overridesProfile: false };
    }
    return { variable, source: 'missing', overridesProfile: false };
  });
}

/** Saved values the runner injects into the bot process. */
export function profileRuntimeValues(
  requirements: BotRequirements | undefined, saved: Record<string, string>, env: NodeJS.ProcessEnv,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const variable of declaredVariables(requirements)) {
    if (providedByEnvironment(env, variable.name) === undefined && saved[variable.name] !== undefined) {
      values[variable.name] = saved[variable.name];
    }
  }
  return values;
}

/**
 * Environment for a restart triggered by an update: the updater's own (possibly
 * old) copies of declared variables are dropped, and the values the managed bot
 * process was actually started with are carried over.
 */
export function updateRestartEnvironment(
  requirements: BotRequirements | undefined, env: NodeJS.ProcessEnv, runningEnv: Record<string, unknown>,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env };
  for (const variable of declaredVariables(requirements)) {
    delete next[variable.name];
    const running = providedByEnvironment(runningEnv, variable.name);
    if (running !== undefined) next[variable.name] = running;
  }
  return next;
}

function sourceLabel(context: CliContext, resolved: ResolvedVariable): string {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  if (resolved.source === 'environment') {
    return resolved.overridesProfile ? text('ambiente (substitui o valor salvo)', 'environment (overrides the saved value)')
      : text('ambiente', 'environment');
  }
  if (resolved.source === 'profile') return text('perfil', 'profile');
  if (resolved.source === 'default') return text('padrão', 'default');
  return text('não definida', 'not set');
}

export function displayValue(resolved: ResolvedVariable): string {
  if (resolved.value === undefined) return '—';
  return resolved.variable.secret ? '[oculto/hidden]' : resolved.value;
}

function findVariable(context: CliContext, name: string | undefined): DeclaredVariable {
  const variable = declaredVariables(context.project.definition.requirements).find((entry) => entry.name === name);
  if (!variable) {
    throw new CliError(`${name ?? ''} não é uma variável declarada por ${context.displayName}. Veja "${context.cliName} config env".`,
      `${name ?? ''} is not a variable declared by ${context.displayName}. See "${context.cliName} config env".`);
  }
  return variable;
}

export function printDeclaredVariables(context: CliContext, env: NodeJS.ProcessEnv = process.env): void {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  const saved = readProfileEnvironment(context.homeDir);
  const resolved = resolveDeclaredVariables(context.project.definition.requirements, saved, env);
  if (!resolved.length) {
    console.log(text(`${context.displayName} não declara variáveis configuráveis.`, `${context.displayName} declares no configurable variables.`));
  }
  for (const entry of resolved) {
    const flags = [
      entry.variable.required ? text('obrigatória', 'required') : text('opcional', 'optional'),
      ...(entry.variable.secret ? [text('segredo', 'secret')] : []),
      entry.variable.modes.join('/'),
    ].join(', ');
    console.log(`${entry.variable.name} = ${displayValue(entry)}  [${sourceLabel(context, entry)}; ${flags}]`);
    console.log(`    ${localizedText(entry.variable.description, context.locale)}`);
  }
  const declared = new Set(resolved.map((entry) => entry.variable.name));
  const obsolete = Object.keys(saved).filter((name) => !declared.has(name));
  if (obsolete.length) {
    console.log(text(`Valores salvos que esta versão não usa mais (não são enviados ao bot): ${obsolete.join(', ')}`,
      `Saved values this version no longer uses (not passed to the bot): ${obsolete.join(', ')}`));
  }
  console.log(text('O ambiente prevalece sobre o valor salvo. Valores salvos ficam em ' + profileEnvironmentFile(context.homeDir) + '.',
    'The environment overrides saved values. Saved values live in ' + profileEnvironmentFile(context.homeDir) + '.'));
}

export async function configEnvCommand(context: CliContext, args: string[]): Promise<void> {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  const [action, name, ...rest] = args;
  if (!action || action === 'list') {
    if (name !== undefined) throw new CliError('config env list não aceita argumentos.', 'config env list takes no arguments.');
    printDeclaredVariables(context);
    return;
  }
  if (action === 'unset') {
    if (rest.length) throw new CliError('Uso: config env unset NOME', 'Usage: config env unset NAME');
    const saved = readProfileEnvironment(context.homeDir);
    if (name === undefined || !(name in saved)) {
      console.log(text('Nenhum valor salvo para essa variável.', 'No saved value for that variable.'));
      return;
    }
    delete saved[name];
    writeProfileEnvironment(context.homeDir, saved);
    console.log(text(`${name} removida do perfil. Reinicie o bot para aplicar: ${context.cliName} restart`,
      `${name} removed from the profile. Restart the bot to apply: ${context.cliName} restart`));
    return;
  }
  if (action !== 'set') {
    throw new CliError('Use config env, config env set NOME [VALOR|--from-env VAR] ou config env unset NOME.',
      'Use config env, config env set NAME [VALUE|--from-env VAR] or config env unset NAME.');
  }
  const variable = findVariable(context, name);
  let value: string;
  if (rest[0] === '--from-env') {
    if (rest.length !== 2 || !/^[A-Z_][A-Z0-9_]{0,99}$/.test(rest[1])) {
      throw new CliError('Uso: config env set NOME --from-env VARIAVEL', 'Usage: config env set NAME --from-env VARIABLE');
    }
    value = validateDeclaredValue(variable, process.env[rest[1]]);
  } else if (rest.length) {
    if (variable.secret) {
      throw new CliError(`${variable.name} é um segredo: não o passe como argumento. Use a entrada oculta ou --from-env.`,
        `${variable.name} is a secret: do not pass it as an argument. Use hidden input or --from-env.`);
    }
    value = validateDeclaredValue(variable, rest.join(' '));
  } else {
    console.log(localizedText(variable.description, context.locale));
    value = await askCliValue(context.locale, variable.secret ? text(`${variable.name} (entrada oculta)`, `${variable.name} (hidden input)`)
      : variable.name, (answer) => validateDeclaredValue(variable, answer), { secret: variable.secret });
  }
  const saved = readProfileEnvironment(context.homeDir);
  saved[variable.name] = value;
  writeProfileEnvironment(context.homeDir, saved);
  console.log(text(`${variable.name} salva no perfil (arquivo privado, fora do pacote).`,
    `${variable.name} saved in the profile (private file, outside the package).`));
  if (providedByEnvironment(process.env, variable.name) !== undefined && process.env[variable.name] !== value) {
    console.log(text(`Atenção: ${variable.name} também está definida no ambiente atual, e o ambiente prevalece.`,
      `Warning: ${variable.name} is also set in the current environment, and the environment takes precedence.`));
  }
  console.log(text(`Reinicie o bot para aplicar: ${context.cliName} restart`, `Restart the bot to apply: ${context.cliName} restart`));
}
