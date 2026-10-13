import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BotLocale } from '@monky/shared';
import { isRecord, type BotMode, type BotPackageDefinition } from '../tooling/config';
import {
  localizedText, parseBotRequirements, requirementsFingerprint, type BotRequirements,
} from '../tooling/requirements';
import type { BotConfig, CliContext } from './config';
import { readJsonFile, writePrivateJson } from './fs';
import { keyPaths } from './keys';
import { CliError, cliText } from './locale';
import { askCliChoice } from './prompts';

export const HOST_CONSENT_FILE = 'host-consent.json';
export const HOST_CONSENT_ENV = 'MONKY_HOST_CONSENT';

export type HostConsentState = 'accepted' | 'inherited' | 'pending';

export interface HostConsentRecord {
  version: 1;
  state: HostConsentState;
  fingerprint: string;
  botDir: string;
  updatedAt: number;
}

export type HostConsentStatus =
  | { ok: true; state: 'accepted' | 'inherited' | 'environment' | 'legacy'; fingerprint: string }
  | { ok: false; state: 'pending' | 'outdated' | 'other-directory' | 'environment-mismatch'; fingerprint: string };

type ConsentDefinition = Pick<BotPackageDefinition, 'modes' | 'requirements'>;

/** Ports, settings, notice and modes define the access the operator approves. */
export function hostConsentFingerprint(definition: ConsentDefinition): string {
  return requirementsFingerprint([...definition.modes], definition.requirements ?? null);
}

/**
 * Fingerprint of a release candidate's package.json. A declaration this CLI
 * cannot parse still produces a deterministic, different fingerprint, so it
 * always requires a new confirmation instead of being silently accepted.
 */
export function candidateHostConsent(monkyBot: unknown): { fingerprint: string; definition?: ConsentDefinition } {
  const raw = isRecord(monkyBot) ? monkyBot : {};
  const rawModes = raw.modes ?? ['manual'];
  try {
    const modes = Array.isArray(rawModes)
      ? rawModes.filter((mode): mode is BotMode => mode === 'manual' || mode === 'marketplace') : [];
    if (!Array.isArray(rawModes) || !modes.length || modes.length !== rawModes.length) throw new Error('Unsupported modes.');
    const requirements = parseBotRequirements(raw.requirements, modes);
    const declared = !!requirements.notice || requirements.ports.length > 0 || requirements.settings.length > 0;
    const definition: ConsentDefinition = { modes, ...(declared ? { requirements } : {}) };
    return { fingerprint: hostConsentFingerprint(definition), definition };
  } catch {
    return { fingerprint: requirementsFingerprint({ unparsed: rawModes }, raw.requirements ?? null) };
  }
}

function consentFile(homeDir: string): string {
  return path.join(homeDir, HOST_CONSENT_FILE);
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (directory: string): string => process.platform === 'win32'
    ? path.resolve(directory).toLowerCase() : path.resolve(directory);
  return normalize(left) === normalize(right);
}

export function readHostConsent(homeDir: string): HostConsentRecord | null {
  const file = consentFile(homeDir);
  let stored: unknown;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('Not a regular file.');
    stored = readJsonFile(file, 'Host consent', 16_384);
  } catch (error: unknown) {
    if (isRecord(error) && error.code === 'ENOENT') return null;
    throw new CliError(`Não foi possível ler ${file}. Remova o arquivo e confirme novamente com consent.`,
      `Could not read ${file}. Remove it and confirm again with consent.`);
  }
  if (!isRecord(stored) || stored.version !== 1 ||
      (stored.state !== 'accepted' && stored.state !== 'inherited' && stored.state !== 'pending') ||
      typeof stored.fingerprint !== 'string' || !/^[0-9a-f]{12}$/.test(stored.fingerprint) ||
      typeof stored.botDir !== 'string' || !path.isAbsolute(stored.botDir) ||
      typeof stored.updatedAt !== 'number' || !Number.isSafeInteger(stored.updatedAt)) {
    throw new CliError(`${file} tem um formato inválido. Remova o arquivo e confirme novamente com consent.`,
      `${file} has an invalid format. Remove it and confirm again with consent.`);
  }
  return { version: 1, state: stored.state, fingerprint: stored.fingerprint, botDir: stored.botDir, updatedAt: stored.updatedAt };
}

export function writeHostConsent(homeDir: string, state: HostConsentState, fingerprint: string, botDir: string): void {
  const pending = path.join(homeDir, `.host-consent-${randomUUID()}.pending`);
  try {
    writePrivateJson(pending, { version: 1, state, fingerprint, botDir: path.resolve(botDir), updatedAt: Date.now() });
    fs.renameSync(pending, consentFile(homeDir));
  } catch {
    throw new CliError('Não foi possível salvar o consentimento.', 'Could not save the consent.');
  } finally {
    fs.rmSync(pending, { force: true });
  }
}

/**
 * A profile created before consent existed has a config but no consent file:
 * it keeps running with the current declaration ("legacy"). New setups always
 * write a consent file, accepted or pending.
 */
export function hostConsentStatus(
  homeDir: string, botDir: string, fingerprint: string, env: NodeJS.ProcessEnv = process.env,
): HostConsentStatus {
  const explicit = env[HOST_CONSENT_ENV];
  if (explicit !== undefined) {
    return explicit === fingerprint ? { ok: true, state: 'environment', fingerprint }
      : { ok: false, state: 'environment-mismatch', fingerprint };
  }
  const record = readHostConsent(homeDir);
  if (!record) return { ok: true, state: 'legacy', fingerprint };
  if (record.state === 'pending') return { ok: false, state: 'pending', fingerprint };
  if (!sameDirectory(record.botDir, botDir)) return { ok: false, state: 'other-directory', fingerprint };
  if (record.fingerprint !== fingerprint) return { ok: false, state: 'outdated', fingerprint };
  return { ok: true, state: record.state, fingerprint };
}

export function hostConsentFailure(status: HostConsentStatus, cliName: string): CliError {
  const reason = {
    pending: ['ainda não foi confirmado', 'has not been confirmed yet'],
    outdated: ['foi dado para acessos diferentes dos declarados por esta versão', 'was given for different access than this version declares'],
    'other-directory': ['foi dado para outro diretório de trabalho', 'was given for another working directory'],
    'environment-mismatch': [`em ${HOST_CONSENT_ENV} não corresponde aos acessos desta versão`, `in ${HOST_CONSENT_ENV} does not match this version's access`],
  }[status.state as 'pending' | 'outdated' | 'other-directory' | 'environment-mismatch'];
  return new CliError(
    `O consentimento de quem hospeda ${reason[0]}. Revise os acessos com "${cliName} consent". ` +
    `Em automação, leia os acessos e defina explicitamente ${HOST_CONSENT_ENV}=${status.fingerprint}.`,
    `The host operator consent ${reason[1]}. Review the access with "${cliName} consent". ` +
    `For automation, review the access and explicitly set ${HOST_CONSENT_ENV}=${status.fingerprint}.`);
}

/** Enforced by start, restart and the runner; records legacy profiles as inherited. */
export function assertHostConsent(
  homeDir: string, botDir: string, definition: ConsentDefinition, cliName: string, env: NodeJS.ProcessEnv = process.env,
): HostConsentStatus {
  const fingerprint = hostConsentFingerprint(definition);
  const status = hostConsentStatus(homeDir, botDir, fingerprint, env);
  if (!status.ok) throw hostConsentFailure(status, cliName);
  if (status.state === 'legacy') writeHostConsent(homeDir, 'inherited', fingerprint, botDir);
  return status;
}

export function ensureContextHostConsent(context: CliContext, config: BotConfig, env: NodeJS.ProcessEnv = process.env): void {
  const status = assertHostConsent(context.homeDir, config.botDir, context.project.definition, context.cliName, env);
  if (status.state === 'legacy') {
    console.log(cliText(context.locale,
      `Aviso: este perfil é anterior ao consentimento e herdou os acessos atuais. Revise com "${context.cliName} consent".`,
      `Warning: this profile predates consent and inherited the current access. Review it with "${context.cliName} consent".`));
  }
}

function portLine(locale: BotLocale, id: string, protocol: string, port: string, exposure: 'public' | 'local',
  when: 'always' | 'on-demand', description: string): string {
  const text = (pt: string, en: string): string => cliText(locale, pt, en);
  const reach = exposure === 'public' ? text('acessível de fora', 'reachable from outside') : text('somente local', 'local only');
  const activation = when === 'on-demand' ? text('sob demanda', 'on demand') : text('sempre', 'always');
  return `  - ${id}: ${protocol.toUpperCase()} ${port} (${reach}; ${activation}) — ${description}`;
}

export function hostAccessNotice(
  locale: BotLocale, displayName: string, botDir: string, definition: ConsentDefinition, managerHome: string,
): string {
  const text = (pt: string, en: string): string => cliText(locale, pt, en);
  const requirements: BotRequirements = definition.requirements ?? { ports: [], settings: [] };
  const keys = keyPaths(path.resolve(botDir)).directory;
  const lines = [
    text(
      `${displayName} será executado nesta máquina com as permissões da conta do sistema; esta confirmação não cria uma sandbox.`,
      `${displayName} will run on this machine with the system account permissions; this confirmation does not create a sandbox.`),
    text(
      `Ele lê o próprio programa e recursos, grava identidade e vínculos em "${keys}", conecta-se a servidores Monky ` +
      `e é gerenciado pelo PM2 deste perfil (${managerHome}).`,
      `It reads its own program and assets, writes identity and links to "${keys}", connects to Monky servers ` +
      `and is managed by this profile's PM2 (${managerHome}).`),
  ];
  const ports: string[] = [];
  if (definition.modes.includes('marketplace')) {
    ports.push(portLine(locale, 'manifest', 'tcp', '7780', 'public', 'always',
      text('somente na instalação por URL (porta configurável no setup); precisa ser acessível pelos servidores Monky que instalarem o bot',
        'install by URL only (port set during setup); must be reachable by the Monky servers that install the bot')));
  }
  for (const port of requirements.ports) {
    ports.push(portLine(locale, port.id, port.protocol, String(port.defaultPort), port.exposure, port.when,
      localizedText(port.description, locale)));
  }
  if (ports.length) lines.push(text('Portas que o bot abre:', 'Ports the bot listens on:'), ...ports);
  const settings = requirements.settings.map((setting) => `  - ${setting.env}${setting.secret ? text(' (segredo)', ' (secret)') : ''}: ${
    localizedText(setting.description, locale)}`);
  if (settings.length) lines.push(text('Configurações que o bot lê:', 'Settings the bot reads:'), ...settings);
  if (requirements.notice) lines.push(localizedText(requirements.notice, locale));
  lines.push(text(
    'Cada administrador de servidor continua decidindo quais capacidades o bot pode usar no próprio servidor.',
    'Each server administrator still decides which capabilities the bot may use on their server.'));
  return lines.join('\n');
}

export async function reviewHostConsent(
  locale: BotLocale, displayName: string, botDir: string, definition: ConsentDefinition, managerHome: string,
): Promise<boolean> {
  console.log(hostAccessNotice(locale, displayName, botDir, definition, managerHome));
  console.log(cliText(locale, `Impressão digital dos acessos: ${hostConsentFingerprint(definition)}`,
    `Access fingerprint: ${hostConsentFingerprint(definition)}`));
  return await askCliChoice(locale, cliText(locale, 'Autorizar a execução nesta máquina com esses acessos?',
    'Allow execution on this machine with these accesses?'), [
    { value: 'no', label: cliText(locale, 'Não', 'No') },
    { value: 'yes', label: cliText(locale, 'Sim, autorizo', 'Yes, I allow it') },
  ]) === 'yes';
}

function describeStatus(context: CliContext, status: HostConsentStatus): string {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  switch (status.state) {
    case 'accepted': return text('confirmado pelo operador', 'confirmed by the operator');
    case 'inherited': return text(`herdado de um perfil anterior; revise com "${context.cliName} consent"`,
      `inherited from an earlier profile; review it with "${context.cliName} consent"`);
    case 'legacy': return text('perfil anterior ao consentimento; será herdado no próximo start',
      'profile predates consent; it will be inherited on the next start');
    case 'environment': return text(`aprovado por ${HOST_CONSENT_ENV}`, `approved by ${HOST_CONSENT_ENV}`);
    case 'pending': return text('pendente', 'pending');
    case 'outdated': return text('desatualizado: os acessos declarados mudaram', 'outdated: the declared access changed');
    case 'other-directory': return text('dado para outro diretório de trabalho', 'given for another working directory');
    case 'environment-mismatch': return text(`${HOST_CONSENT_ENV} não corresponde`, `${HOST_CONSENT_ENV} does not match`);
  }
}

export function describeHostConsent(context: CliContext, config: BotConfig, env: NodeJS.ProcessEnv = process.env): {
  status: HostConsentStatus; label: string;
} {
  const status = hostConsentStatus(context.homeDir, config.botDir, hostConsentFingerprint(context.project.definition), env);
  return { status, label: describeStatus(context, status) };
}

export async function consentCommand(
  context: CliContext, args: string[], config: BotConfig | null, interactive: boolean,
): Promise<void> {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  if (!config) throw new CliError(`Execute "${context.cliName} setup" antes de revisar o consentimento.`,
    `Run "${context.cliName} setup" before reviewing the consent.`);
  const definition = context.project.definition;
  const fingerprint = hostConsentFingerprint(definition);
  if (args[0] === '--revoke') {
    if (args.length !== 1) throw new CliError('consent --revoke não aceita argumentos.', 'consent --revoke takes no arguments.');
    writeHostConsent(context.homeDir, 'pending', fingerprint, config.botDir);
    console.log(text(`Consentimento revogado. O bot não iniciará até nova confirmação; um processo em execução não foi parado (use ${context.cliName} stop).`,
      `Consent revoked. The bot will not start until it is confirmed again; a running process was not stopped (use ${context.cliName} stop).`));
    return;
  }
  if (args[0] === '--accept') {
    if (args.length !== 2) throw new CliError('Uso: consent --accept <impressão digital>', 'Usage: consent --accept <fingerprint>');
    if (args[1] !== fingerprint) {
      throw new CliError(`A impressão digital informada não corresponde aos acessos atuais (${fingerprint}). Revise-os com "${context.cliName} consent".`,
        `The provided fingerprint does not match the current access (${fingerprint}). Review it with "${context.cliName} consent".`);
    }
    writeHostConsent(context.homeDir, 'accepted', fingerprint, config.botDir);
    console.log(text('Consentimento registrado para este diretório de trabalho.', 'Consent recorded for this working directory.'));
    return;
  }
  if (args.length) throw new CliError('Use consent, consent --accept <impressão digital> ou consent --revoke.',
    'Use consent, consent --accept <fingerprint> or consent --revoke.');
  const { label } = describeHostConsent(context, config);
  console.log(text(`Consentimento: ${label}`, `Consent: ${label}`));
  if (!interactive) {
    console.log(hostAccessNotice(context.locale, context.displayName, config.botDir, definition, context.pm2Home));
    console.log(text(`Impressão digital: ${fingerprint}. Para aprovar sem terminal: ${context.cliName} consent --accept ${fingerprint}`,
      `Fingerprint: ${fingerprint}. To approve without a terminal: ${context.cliName} consent --accept ${fingerprint}`));
    return;
  }
  if (await reviewHostConsent(context.locale, context.displayName, config.botDir, definition, context.pm2Home)) {
    writeHostConsent(context.homeDir, 'accepted', fingerprint, config.botDir);
    console.log(text('Consentimento registrado.', 'Consent recorded.'));
  } else {
    console.log(text('Nada foi alterado.', 'Nothing was changed.'));
  }
}
