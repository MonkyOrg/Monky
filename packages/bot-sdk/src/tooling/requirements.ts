import { createHash } from 'node:crypto';
import type { BotLocale } from '@monky/shared';
import type { BotMode } from './config';

export interface BotLocalizedText {
  'pt-BR': string;
  en: string;
}

export type BotPortProtocol = 'tcp' | 'udp';
/** `public`: must be reachable from other machines; `local`: only this host uses it. */
export type BotPortExposure = 'public' | 'local';
/** `on-demand`: the bot opens the listener only when a feature needs it. */
export type BotPortActivation = 'always' | 'on-demand';

export interface BotPortRequirement {
  id: string;
  description: BotLocalizedText;
  protocol: BotPortProtocol;
  portEnv: string;
  defaultPort: number;
  hostEnv?: string;
  /** Environment variable holding the public http(s) origin, e.g. behind a reverse proxy. */
  publicUrlEnv?: string;
  exposure: BotPortExposure;
  when: BotPortActivation;
  modes: BotMode[];
}

export interface BotSettingRequirement {
  env: string;
  description: BotLocalizedText;
  required: boolean;
  secret: boolean;
  modes: BotMode[];
}

export interface BotRequirements {
  /** Bot-specific host access shown in the operator consent, e.g. external services it contacts. */
  notice?: BotLocalizedText;
  ports: BotPortRequirement[];
  settings: BotSettingRequirement[];
}

export const MANIFEST_PORT_ID = 'manifest';
export const EMPTY_BOT_REQUIREMENTS: BotRequirements = Object.freeze({ ports: [], settings: [] }) as BotRequirements;

const MAX_PORTS = 8;
const MAX_SETTINGS = 32;
const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,99}$/;
const RESERVED_ENV = new Set([
  'MONKY_SERVER_URL', 'MONKY_BOT_TOKEN', 'MONKY_BOT_PUBLIC_KEY', 'MONKY_BOT_NAME', 'MONKY_SERVE', 'MONKY_SERVE_PORT',
  'MONKY_SERVE_HOST', 'MONKY_SERVE_PUBLIC_HOST', 'MONKY_BOT_REGISTRATION_FILE', 'MONKY_HOST_CONSENT', 'MONKY_BOT_LOCALE',
  'MONKY_LANG', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_ENV', 'PATH', 'HOME', 'USERPROFILE', 'PM2_HOME',
]);
const RESERVED_PREFIXES = ['MONKY_BOT_CLI_', 'PM2_', 'NPM_', 'LD_', 'DYLD_'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const key = Object.keys(value).find((entry) => !allowed.includes(entry));
  if (key) throw new Error(`Unknown ${label} property: ${key}.`);
}

function text(value: unknown, label: string, max: number, multiline = false): string {
  const invalid = multiline ? /[\u0000-\u0009\u000b-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || invalid.test(value)) {
    throw new Error(`${label} must be a non-empty single-language text of at most ${max} characters.`);
  }
  return value;
}

function localized(value: unknown, label: string, max: number, multiline = false): BotLocalizedText {
  if (!isRecord(value)) throw new Error(`${label} must contain "pt-BR" and "en" texts.`);
  rejectUnknown(value, ['pt-BR', 'en'], label);
  return { 'pt-BR': text(value['pt-BR'], `${label}.pt-BR`, max, multiline), en: text(value.en, `${label}.en`, max, multiline) };
}

export function localizedText(value: BotLocalizedText, locale: BotLocale): string {
  return locale === 'en' ? value.en : value['pt-BR'];
}

function envName(value: unknown, label: string): string {
  if (typeof value !== 'string' || !ENV_NAME.test(value)) {
    throw new Error(`${label} must be an environment variable name using A-Z, 0-9 and _.`);
  }
  if (RESERVED_ENV.has(value) || RESERVED_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    throw new Error(`${label} uses ${value}, which is reserved for the runtime CLI or the system.`);
  }
  return value;
}

function modesValue(value: unknown, supported: readonly BotMode[], label: string): BotMode[] {
  if (value === undefined) return [...supported];
  if (!Array.isArray(value) || value.length === 0 || value.length > 2 || new Set(value).size !== value.length ||
      !value.every((mode): mode is BotMode => typeof mode === 'string' && supported.some((entry) => entry === mode))) {
    throw new Error(`${label} must list modes declared in monkyBot.modes, without duplicates.`);
  }
  return value;
}

function choice<T extends string>(value: unknown, options: readonly T[], fallback: T, label: string): T {
  if (value === undefined) return fallback;
  const selected = options.find((option) => option === value);
  if (!selected) throw new Error(`${label} must be one of: ${options.join(', ')}.`);
  return selected;
}

function booleanValue(value: unknown, label: string): boolean {
  if (value === undefined) return false;
  if (typeof value !== 'boolean') throw new Error(`${label} must be true or false.`);
  return value;
}

function parsePort(value: unknown, index: number, supported: readonly BotMode[]): BotPortRequirement {
  const label = `monkyBot.requirements.ports[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  rejectUnknown(value, ['id', 'description', 'protocol', 'portEnv', 'defaultPort', 'hostEnv', 'publicUrlEnv', 'exposure', 'when', 'modes'], label);
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(value.id)) {
    throw new Error(`${label}.id must use lowercase letters, digits and hyphens (up to 32 characters).`);
  }
  if (value.id === MANIFEST_PORT_ID) throw new Error(`${label}.id "manifest" is reserved for the marketplace manifest port.`);
  const defaultPort = value.defaultPort;
  if (typeof defaultPort !== 'number' || !Number.isInteger(defaultPort) || defaultPort < 1 || defaultPort > 65535) {
    throw new Error(`${label}.defaultPort must be an integer between 1 and 65535.`);
  }
  const protocol = choice(value.protocol, ['tcp', 'udp'] as const, 'tcp', `${label}.protocol`);
  if (value.publicUrlEnv !== undefined && protocol !== 'tcp') throw new Error(`${label}.publicUrlEnv requires a TCP port.`);
  return {
    id: value.id,
    description: localized(value.description, `${label}.description`, 200),
    protocol,
    portEnv: envName(value.portEnv, `${label}.portEnv`),
    defaultPort,
    ...(value.hostEnv === undefined ? {} : { hostEnv: envName(value.hostEnv, `${label}.hostEnv`) }),
    ...(value.publicUrlEnv === undefined ? {} : { publicUrlEnv: envName(value.publicUrlEnv, `${label}.publicUrlEnv`) }),
    exposure: choice(value.exposure, ['public', 'local'] as const, 'public', `${label}.exposure`),
    when: choice(value.when, ['always', 'on-demand'] as const, 'always', `${label}.when`),
    modes: modesValue(value.modes, supported, `${label}.modes`),
  };
}

function parseSetting(value: unknown, index: number, supported: readonly BotMode[]): BotSettingRequirement {
  const label = `monkyBot.requirements.settings[${index}]`;
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  rejectUnknown(value, ['env', 'description', 'required', 'secret', 'modes'], label);
  return {
    env: envName(value.env, `${label}.env`),
    description: localized(value.description, `${label}.description`, 200),
    required: booleanValue(value.required, `${label}.required`),
    secret: booleanValue(value.secret, `${label}.secret`),
    modes: modesValue(value.modes, supported, `${label}.modes`),
  };
}

export function parseBotRequirements(value: unknown, supported: readonly BotMode[]): BotRequirements {
  if (value === undefined) return { ports: [], settings: [] };
  if (!isRecord(value)) throw new Error('monkyBot.requirements must be an object or omitted.');
  rejectUnknown(value, ['notice', 'ports', 'settings'], 'monkyBot.requirements');
  const rawPorts = value.ports ?? [];
  const rawSettings = value.settings ?? [];
  if (!Array.isArray(rawPorts) || rawPorts.length > MAX_PORTS) {
    throw new Error(`monkyBot.requirements.ports must list at most ${MAX_PORTS} ports.`);
  }
  if (!Array.isArray(rawSettings) || rawSettings.length > MAX_SETTINGS) {
    throw new Error(`monkyBot.requirements.settings must list at most ${MAX_SETTINGS} settings.`);
  }
  const ports = rawPorts.map((port, index) => parsePort(port, index, supported));
  const settings = rawSettings.map((setting, index) => parseSetting(setting, index, supported));
  if (new Set(ports.map((port) => port.id)).size !== ports.length) throw new Error('monkyBot.requirements.ports ids must be unique.');
  if (new Set(ports.map((port) => `${port.protocol}:${port.defaultPort}`)).size !== ports.length) {
    throw new Error('monkyBot.requirements.ports must not share a default port and protocol.');
  }
  const names = [...ports.flatMap((port) => [port.portEnv, port.hostEnv, port.publicUrlEnv]), ...settings.map((setting) => setting.env)]
    .filter((name): name is string => name !== undefined);
  if (new Set(names).size !== names.length) {
    throw new Error('Each environment variable may be declared only once in monkyBot.requirements.');
  }
  return {
    ...(value.notice === undefined ? {} : { notice: localized(value.notice, 'monkyBot.requirements.notice', 1000, true) }),
    ports,
    settings,
  };
}

/** Every environment variable the operator may configure for this bot. */
export function declaredEnvironmentNames(requirements: BotRequirements): string[] {
  return [
    ...requirements.settings.map((setting) => setting.env),
    ...requirements.ports.flatMap((port) => [port.portEnv, port.hostEnv, port.publicUrlEnv]),
  ].filter((name): name is string => name !== undefined);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

/**
 * Identifies the host access an operator approves. Any change to the declared
 * ports, settings, notice or modes requires a new confirmation.
 */
export function requirementsFingerprint(modes: unknown, requirements: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical({ modes, requirements: requirements ?? null })), 'utf8')
    .digest('hex')
    .slice(0, 12);
}
