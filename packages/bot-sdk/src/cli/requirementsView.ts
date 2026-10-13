import type { BotLocale } from '@monky/shared';
import {
  EMPTY_BOT_REQUIREMENTS, MANIFEST_PORT_ID, localizedText, type BotLocalizedText, type BotPortActivation,
  type BotPortExposure, type BotPortProtocol, type BotPortRequirement,
} from '../tooling/requirements';
import type { BotMode } from '../tooling/config';
import { DEFAULT_MARKETPLACE_PORT, ANSI, color } from './constants';
import type { BotConfig, CliContext } from './config';
import { cliText } from './locale';
import { readProfileEnvironment, resolveDeclaredVariables, displayValue, type ResolvedVariable } from './profileEnvironment';

export interface EffectivePort {
  id: string;
  description: BotLocalizedText;
  protocol: BotPortProtocol;
  exposure: BotPortExposure;
  when: BotPortActivation;
  modes: BotMode[];
  /** Null when the configured value is invalid; `invalid` explains why. */
  port: number | null;
  bindHost: string;
  /** http(s) origin other machines use; null when unknown (e.g. manual mode without a public URL). */
  publicOrigin: string | null;
  declared?: BotPortRequirement;
  invalid?: { pt: string; en: string };
}

const MANIFEST_DESCRIPTION: BotLocalizedText = {
  'pt-BR': 'Manifest e registro da instalação por URL; precisa ser acessível pelos servidores Monky que instalarem o bot',
  en: 'Manifest and registration for install by URL; must be reachable by the Monky servers that install the bot',
};

function urlHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** Canonical origin (default ports dropped, host lowercased), as the server expects. */
function originOf(host: string, port: number): string | null {
  try {
    return new URL(`http://${urlHost(host)}:${port}`).origin;
  } catch {
    return null;
  }
}

function valueOf(resolved: ResolvedVariable[], name: string | undefined): ResolvedVariable | undefined {
  return name === undefined ? undefined : resolved.find((entry) => entry.variable.name === name);
}

/**
 * Ports this bot uses with the configuration and environment that would apply
 * to its process. `env` is the bot process environment when it is running.
 */
export function effectivePorts(
  context: CliContext, config: BotConfig | null, env: NodeJS.ProcessEnv | Record<string, unknown>,
  saved: Record<string, string> = readProfileEnvironment(context.homeDir),
): EffectivePort[] {
  const definition = context.project.definition;
  const requirements = definition.requirements ?? EMPTY_BOT_REQUIREMENTS;
  const resolved = resolveDeclaredVariables(requirements, saved, env);
  const mode = config?.mode;
  const ports: EffectivePort[] = [];
  if (definition.modes.includes('marketplace') && (!mode || mode === 'marketplace')) {
    const serveHost = env.MONKY_SERVE_HOST;
    const servePort = config?.mode === 'marketplace' ? config.servePort : DEFAULT_MARKETPLACE_PORT;
    ports.push({
      id: MANIFEST_PORT_ID, description: MANIFEST_DESCRIPTION, protocol: 'tcp', exposure: 'public', when: 'always',
      modes: ['marketplace'], port: servePort,
      bindHost: typeof serveHost === 'string' && serveHost ? serveHost : '0.0.0.0',
      publicOrigin: config?.mode === 'marketplace' ? originOf(config.publicHost, servePort) : null,
    });
  }
  for (const declared of requirements.ports) {
    if (mode && !declared.modes.includes(mode)) continue;
    const portValue = valueOf(resolved, declared.portEnv)?.value ?? String(declared.defaultPort);
    const port = /^\d{1,5}$/.test(portValue) && Number(portValue) >= 1 && Number(portValue) <= 65535 ? Number(portValue) : null;
    const publicUrl = valueOf(resolved, declared.publicUrlEnv)?.value;
    let publicOrigin: string | null = null;
    let invalid: EffectivePort['invalid'];
    if (port === null) {
      invalid = { pt: `${declared.portEnv} contém uma porta inválida.`, en: `${declared.portEnv} contains an invalid port.` };
    }
    if (publicUrl !== undefined) {
      try {
        const url = new URL(publicUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
          throw new Error('Invalid public URL.');
        }
        publicOrigin = url.origin;
      } catch {
        invalid = { pt: `${declared.publicUrlEnv} não é uma URL http(s) sem caminho.`, en: `${declared.publicUrlEnv} is not an http(s) URL without a path.` };
      }
    } else if (declared.exposure === 'public' && declared.protocol === 'tcp' && config?.mode === 'marketplace' && port !== null) {
      publicOrigin = originOf(config.publicHost, port);
    }
    ports.push({
      id: declared.id, description: declared.description, protocol: declared.protocol, exposure: declared.exposure,
      when: declared.when, modes: declared.modes, port, bindHost: valueOf(resolved, declared.hostEnv)?.value ?? '0.0.0.0',
      publicOrigin, declared, ...(invalid ? { invalid } : {}),
    });
  }
  return ports;
}

export function describePort(locale: BotLocale, port: EffectivePort): string {
  const text = (pt: string, en: string): string => cliText(locale, pt, en);
  const reach = port.exposure === 'public'
    ? text('liberar no firewall/roteador', 'allow through the firewall/router') : text('somente local', 'local only');
  const activation = port.when === 'on-demand' ? text('sob demanda', 'on demand') : text('sempre', 'always');
  return `${port.id}: ${port.protocol.toUpperCase()} ${port.port ?? '?'} (${reach}; ${activation})`;
}

export function printRequirements(
  context: CliContext, config: BotConfig | null, env: NodeJS.ProcessEnv | Record<string, unknown> = process.env,
): void {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  const saved = readProfileEnvironment(context.homeDir);
  const ports = effectivePorts(context, config, env, saved);
  console.log(color(text('Portas', 'Ports'), ANSI.bold));
  if (!ports.length) console.log(text('  Nenhuma porta de entrada: o bot só abre conexões de saída.', '  No inbound ports: the bot only opens outbound connections.'));
  for (const port of ports) {
    console.log(`  ${describePort(context.locale, port)}`);
    console.log(`      ${localizedText(port.description, context.locale)}`);
    if (port.publicOrigin) console.log(text(`      Endereço público: ${port.publicOrigin}`, `      Public address: ${port.publicOrigin}`));
    else if (port.exposure === 'public' && port.declared?.publicUrlEnv) {
      console.log(text(`      Defina ${port.declared.publicUrlEnv} com a URL pública acessível por quem usa o recurso.`,
        `      Set ${port.declared.publicUrlEnv} to the public URL reachable by whoever uses this feature.`));
    }
    if (port.invalid) console.log(color(`      ${text(port.invalid.pt, port.invalid.en)}`, ANSI.red));
  }
  if (!config && context.project.definition.modes.includes('marketplace')) {
    console.log(text('  A porta do manifest só é usada na instalação por URL.', '  The manifest port is used only for install by URL.'));
  }
  const requirements = context.project.definition.requirements ?? EMPTY_BOT_REQUIREMENTS;
  const variables = resolveDeclaredVariables(requirements, saved, env)
    .filter((entry) => !config || entry.variable.modes.includes(config.mode));
  console.log(color(text('Configurações', 'Settings'), ANSI.bold));
  if (!variables.length) console.log(text('  Nenhuma configuração extra além do setup.', '  No settings beyond setup.'));
  for (const entry of variables) {
    const state = entry.value === undefined
      ? (entry.variable.required ? color(text('FALTANDO', 'MISSING'), ANSI.red) : text('não definida', 'not set'))
      : displayValue(entry);
    const required = entry.variable.required ? text('obrigatória', 'required') : text('opcional', 'optional');
    console.log(`  ${entry.variable.name} [${required}]: ${state}`);
    console.log(`      ${localizedText(entry.variable.description, context.locale)}`);
  }
  console.log(text(`Configure com "${context.cliName} config env set NOME" ou pelo ambiente do processo (o ambiente prevalece).`,
    `Configure with "${context.cliName} config env set NAME" or through the process environment (the environment wins).`));
}

export function requirementsCommand(context: CliContext, args: string[], config: BotConfig | null): void {
  if (args.length) {
    throw new Error(cliText(context.locale, 'requirements não aceita argumentos.', 'requirements takes no arguments.'));
  }
  console.log(color(cliText(context.locale, `${context.displayName} — o que abrir e configurar`,
    `${context.displayName} — what to open and configure`), ANSI.bold));
  printRequirements(context, config);
  console.log(cliText(context.locale, `Para verificar se está tudo pronto: ${context.cliName} doctor`,
    `To check that everything is ready: ${context.cliName} doctor`));
}
