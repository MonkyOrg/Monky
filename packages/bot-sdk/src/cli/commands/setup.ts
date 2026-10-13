import os from 'node:os';
import type { BotLocale } from '@monky/shared';
import { localizedText, MANIFEST_PORT_ID } from '../../tooling/requirements';
import { CliError, cliErrorMessage, cliText } from '../locale';
import { askCliChoice, askCliText } from '../prompts';
import { readBotPublicKey } from '../keys';
import {
  assertDeclaredPortAvailable, assertManifestPortAvailable, assertNoOwnPortConflict, type OwnPort, type PortUse,
} from '../ports';
import {
  declaredPortStates, ownPort, profileEnvironmentFile, readProfileEnvironment, stalePublicUrlNotice, validateDeclaredValue,
  writeProfileEnvironment, type DeclaredPortState,
} from '../profileEnvironment';
import {
  HOST_CONSENT_ENV, hostAccessNotice, hostConsentFingerprint, hostConsentStatus, readHostConsent, reviewHostConsent,
  writeHostConsent,
} from '../consent';
import { printRequirements } from '../requirementsView';
import {
  ANSI,
  color,
  DEFAULT_MANUAL_SERVER_URL,
  DEFAULT_MARKETPLACE_PORT,
  DEFAULT_TOKEN_ENV,
} from '../constants';
import {
  ensureModeSupported,
  manualConfig,
  marketplaceConfig,
  readConfig,
  validateBotName,
  validateBotToken,
  validatePublicHost,
  validateServerUrl,
  validateServePort,
  validateTokenEnv,
  writeConfig,
  normalizeBotDir,
  type BotConfig,
  type CliContext,
  type ManualBotCredentials,
} from '../config';

type NonInteractiveSetupInput = {
  botName?: string;
  botDir?: string;
} & (
  | { mode: 'manual'; serverUrl: string; tokenEnv: string }
  | { mode: 'marketplace'; servePort: number; publicHost: string }
);

const SETUP_CANCELLED_MESSAGE = 'Setup cancelado; a configuração não foi alterada.';

type Ask = (question: string, secret?: boolean) => Promise<string>;

type SetupMode = BotConfig['mode'];

const MODE_LABELS: Record<SetupMode, string> = {
  marketplace: 'Instalação por URL — recomendado',
  manual: 'Conexão manual por token — avançado',
};

function promptModeLabel(mode: SetupMode, locale: BotLocale): string {
  return cliText(locale, MODE_LABELS[mode], mode === 'marketplace'
    ? 'Install by URL — recommended' : 'Manual token connection — advanced');
}

function promptModes(modes: readonly SetupMode[]): SetupMode[] {
  const preferredOrder: readonly SetupMode[] = ['marketplace', 'manual'];
  return preferredOrder.filter((mode) => modes.includes(mode));
}

async function validatedPrompt<T>(
  locale: BotLocale, ask: Ask, question: string, validate: (value: string) => T | Promise<T>, secret = false,
): Promise<T> {
  while (true) {
    const answer = await ask(question, secret);
    try {
      return await validate(answer);
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      console.error(color(cliErrorMessage(error, locale), ANSI.red));
    }
  }
}

function localIpv4(): string | null {
  const interfaces = os.networkInterfaces();
  for (const entries of Object.values(interfaces)) {
    if (!entries) continue;
    for (const entry of entries) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

function parseNonInteractiveSetup(args: string[]): { input: NonInteractiveSetupInput; ports: ReadonlyMap<string, string> } | null {
  if (!args.includes('--non-interactive')) return null;
  let mode: 'manual' | 'marketplace' = 'manual';
  let serverUrl: string | undefined;
  let tokenEnv: string | undefined;
  let servePort: number | undefined;
  let publicHost: string | undefined;
  let botName: string | undefined;
  let botDir: string | undefined;
  const ports = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--non-interactive') continue;
    if (argument === '--yes' || argument === '-y') continue;
    if (['--mode', '--server-url', '--token-env', '--serve-port', '--public-host', '--name', '--bot-dir', '--port'].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new CliError(`${argument} requer um valor.`, `${argument} requires a value.`);
      if (argument === '--mode') {
        if (value !== 'manual' && value !== 'marketplace') throw new CliError('--mode deve ser manual ou marketplace.',
          '--mode must be manual or marketplace.');
        mode = value;
      } else if (argument === '--server-url') serverUrl = validateServerUrl(value);
      else if (argument === '--token-env') tokenEnv = validateTokenEnv(value);
      else if (argument === '--serve-port') servePort = validateServePort(value);
      else if (argument === '--public-host') publicHost = validatePublicHost(value);
      else if (argument === '--name') botName = validateBotName(value);
      else if (argument === '--port') {
        const match = /^([a-z][a-z0-9-]{0,31})=(.+)$/.exec(value);
        if (!match) throw new CliError('--port usa o formato <id>=<porta>, por exemplo --port games=7790.',
          '--port uses the <id>=<port> format, for example --port games=7790.');
        if (ports.has(match[1])) throw new CliError(`--port ${match[1]} foi informada mais de uma vez.`, `--port ${match[1]} was given more than once.`);
        ports.set(match[1], match[2]);
      } else botDir = normalizeBotDir(value);
      continue;
    }
    throw new CliError('Opção de setup desconhecida.', 'Unknown setup option.');
  }
  const common = { ...(botName ? { botName } : {}), ...(botDir ? { botDir } : {}) };
  if (mode === 'manual') {
    if (servePort !== undefined || publicHost !== undefined) throw new CliError('Opções de manifest exigem --mode marketplace.',
      'Manifest options require --mode marketplace.');
    if (!serverUrl) throw new CliError('setup --non-interactive requer --server-url <ws://...>.',
      'setup --non-interactive requires --server-url <ws://...>.');
    return { input: { ...common, mode, serverUrl, tokenEnv: tokenEnv ?? DEFAULT_TOKEN_ENV }, ports };
  }
  if (serverUrl !== undefined || tokenEnv !== undefined) throw new CliError('Opções de servidor e token exigem --mode manual.',
    'Server and token options require --mode manual.');
  if (!publicHost) throw new CliError('setup --non-interactive --mode marketplace requer --public-host <domínio-ou-IP>.',
    'setup --non-interactive --mode marketplace requires --public-host <hostname-or-IP>.');
  return { input: { ...common, mode, servePort: servePort ?? DEFAULT_MARKETPLACE_PORT, publicHost }, ports };
}

/** A declared port whose value this setup sets (and saves in the profile). */
interface DeclaredPortChoice {
  state: DeclaredPortState;
  port: number;
}

function manifestPort(config: BotConfig): OwnPort[] {
  return config.mode === 'marketplace' ? [{ id: MANIFEST_PORT_ID, protocol: 'tcp', port: config.servePort }] : [];
}

/** Ports the environment sets: setup cannot change them, so other answers must avoid them. */
function environmentPorts(states: readonly DeclaredPortState[]): OwnPort[] {
  return states.flatMap((state) => state.resolved.source === 'environment' && state.port !== null
    ? [ownPort(state.requirement, state.port)] : []);
}

function invalidPortError(state: DeclaredPortState): CliError {
  return new CliError(`${state.requirement.portEnv} contém uma porta inválida (${state.resolved.value ?? ''}).`,
    `${state.requirement.portEnv} contains an invalid port (${state.resolved.value ?? ''}).`);
}

function portFlagChoices(states: readonly DeclaredPortState[], flags: ReadonlyMap<string, string>, mode: SetupMode): DeclaredPortChoice[] {
  const choices: DeclaredPortChoice[] = [];
  for (const [id, value] of flags) {
    if (id === MANIFEST_PORT_ID) {
      throw new CliError('Use --serve-port para a porta do manifest.', 'Use --serve-port for the manifest port.');
    }
    const state = states.find((entry) => entry.requirement.id === id);
    if (!state) {
      const declared = states.map((entry) => entry.requirement.id).join(', ') || '—';
      throw new CliError(`--port ${id}: o bot não declara essa porta no modo ${mode}. Portas do modo: ${declared}.`,
        `--port ${id}: the bot declares no such port in the ${mode} mode. Ports in this mode: ${declared}.`);
    }
    if (state.resolved.source === 'environment') {
      throw new CliError(`--port ${id}: ${state.requirement.portEnv} está definida no ambiente, que prevalece sobre o perfil. Altere-a no ambiente do serviço.`,
        `--port ${id}: ${state.requirement.portEnv} is set in the environment, which overrides the profile. Change it in the service environment.`);
    }
    choices.push({ state, port: Number(validateDeclaredValue(state.resolved.variable, value)) });
  }
  return choices;
}

/**
 * Values setup sets (manifest port and --port) must be valid and free; the
 * others come from the profile, the defaults or the environment and only warn.
 */
async function checkNonInteractivePorts(
  context: CliContext, config: BotConfig, states: readonly DeclaredPortState[], choices: readonly DeclaredPortChoice[],
  publicKey: string | undefined,
): Promise<PortUse[]> {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  const valueOf = (state: DeclaredPortState): number | null => choices.find((choice) => choice.state === state)?.port ?? state.port;
  const planned: OwnPort[] = [
    ...manifestPort(config),
    ...states.flatMap((state) => {
      const port = valueOf(state);
      return port === null ? [] : [ownPort(state.requirement, port)];
    }),
  ];
  const uses: PortUse[] = [];
  for (const manifest of manifestPort(config)) {
    assertNoOwnPortConflict(manifest, planned);
    uses.push(await assertManifestPortAvailable(manifest.port, context.cliName, undefined, context.locale, publicKey));
  }
  for (const state of states) {
    const chosen = choices.some((choice) => choice.state === state);
    const port = valueOf(state);
    try {
      if (port === null) throw invalidPortError(state);
      const target = ownPort(state.requirement, port);
      assertNoOwnPortConflict(target, planned);
      uses.push(await assertDeclaredPortAvailable({ ...target, host: state.bindHost }, context.cliName, publicKey));
    } catch (error: unknown) {
      if (chosen || !(error instanceof Error)) throw error;
      const { id, portEnv } = state.requirement;
      console.log(color(`${text('Atenção', 'Warning')}: ${cliErrorMessage(error, context.locale)} ${state.resolved.source === 'environment'
        ? text(`Corrija ${portEnv} no ambiente do serviço.`, `Fix ${portEnv} in the service environment.`)
        : text(`Para escolher outra: --port ${id}=<porta>.`, `To choose another: --port ${id}=<port>.`)}`, ANSI.yellow));
    }
  }
  return uses;
}

async function askDeclaredPorts(
  context: CliContext, ask: Ask, states: readonly DeclaredPortState[], taken: OwnPort[], publicKey: string | undefined,
  uses: PortUse[],
): Promise<DeclaredPortChoice[]> {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  if (!states.length) return [];
  const fixed = environmentPorts(states);
  const others = (): OwnPort[] => [...taken, ...fixed.filter((port) => !taken.some((entry) => entry.id === port.id))];
  const choices: DeclaredPortChoice[] = [];
  console.log();
  console.log(color(text('Portas do bot', 'Bot ports'), ANSI.cyan));
  for (const state of states) {
    const { requirement } = state;
    const label = `${requirement.protocol.toUpperCase()} "${requirement.id}"`;
    console.log(`${requirement.id}: ${localizedText(requirement.description, context.locale)}${requirement.when === 'on-demand'
      ? text(' (aberta sob demanda)', ' (opened on demand)') : ''}`);
    if (state.resolved.source === 'environment') {
      console.log(text(`Porta ${label}: ${state.resolved.value ?? ''}, definida no ambiente em ${requirement.portEnv}, que prevalece sobre o perfil; o setup não a altera.`,
        `${label} port: ${state.resolved.value ?? ''}, set in the environment through ${requirement.portEnv}, which overrides the profile; setup does not change it.`));
      try {
        if (state.port === null) throw invalidPortError(state);
        const target = ownPort(requirement, state.port);
        assertNoOwnPortConflict(target, others());
        uses.push(await assertDeclaredPortAvailable({ ...target, host: state.bindHost }, context.cliName, publicKey));
        taken.push(target);
      } catch (error: unknown) {
        if (!(error instanceof Error)) throw error;
        console.log(color(`${text('Atenção', 'Warning')}: ${cliErrorMessage(error, context.locale)} ${text(
          `Corrija ${requirement.portEnv} no ambiente do serviço.`, `Fix ${requirement.portEnv} in the service environment.`)}`, ANSI.yellow));
      }
      continue;
    }
    const suggested = String(state.port ?? requirement.defaultPort);
    const port = await validatedPrompt(context.locale, ask, text(`Porta ${label} [${suggested}]: `, `${label} port [${suggested}]: `),
      async (answer) => {
        const target = ownPort(requirement, Number(validateDeclaredValue(state.resolved.variable, answer || suggested)));
        assertNoOwnPortConflict(target, others());
        uses.push(await assertDeclaredPortAvailable({ ...target, host: state.bindHost }, context.cliName, publicKey));
        return target.port;
      });
    taken.push(ownPort(requirement, port));
    choices.push({ state, port });
  }
  return choices;
}

/** Saves only values that differ from the declared default, so an unchanged port keeps following it. */
function saveDeclaredPorts(context: CliContext, choices: readonly DeclaredPortChoice[]): boolean {
  if (!choices.length) return false;
  const saved = readProfileEnvironment(context.homeDir);
  let changed = false;
  for (const { state: { requirement }, port } of choices) {
    const next = port === requirement.defaultPort ? undefined : String(port);
    if (saved[requirement.portEnv] === next) continue;
    if (next === undefined) delete saved[requirement.portEnv];
    else saved[requirement.portEnv] = next;
    changed = true;
  }
  if (changed) writeProfileEnvironment(context.homeDir, saved);
  return changed;
}

function reportDeclaredPorts(context: CliContext, choices: readonly DeclaredPortChoice[], saved: boolean, uses: readonly PortUse[]): void {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  if (saved) {
    console.log(text(`Portas do bot salvas em ${profileEnvironmentFile(context.homeDir)}.`,
      `Bot ports saved to ${profileEnvironmentFile(context.homeDir)}.`));
  }
  for (const choice of choices) {
    const notice = stalePublicUrlNotice(context, choice.state, choice.port);
    if (notice) console.log(color(notice, ANSI.yellow));
  }
  if (uses.includes('this-bot')) {
    console.log(text(`O bot está em execução nas portas desta configuração; reinicie-o para aplicar: ${context.cliName} restart`,
      `The bot is running on this configuration's ports; restart it to apply: ${context.cliName} restart`));
  }
}

function setupWillOverwrite(context: CliContext, existing: BotConfig | null, assumeYes: boolean): void {
  if (!existing || assumeYes) return;
  throw new CliError(`Já existe uma configuração em ${context.configFile}. Execute novamente com --yes para substituir.`,
    `A config already exists at ${context.configFile}. Re-run with --yes to replace it.`);
}

/** True when the operator already approved exactly these accesses for this directory. */
function consentAlreadyGiven(context: CliContext, botDir: string): boolean {
  const status = hostConsentStatus(context.homeDir, botDir, hostConsentFingerprint(context.project.definition));
  return status.ok && (status.state === 'accepted' || status.state === 'environment');
}

/**
 * Non-interactive setup never approves on its own: an explicit matching
 * MONKY_HOST_CONSENT records the approval, otherwise the profile stays pending.
 * A legacy profile (config without a consent file) keeps running as before.
 */
function recordNonInteractiveConsent(context: CliContext, existing: BotConfig | null, config: BotConfig): void {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  const fingerprint = hostConsentFingerprint(context.project.definition);
  if (process.env[HOST_CONSENT_ENV] === fingerprint) {
    writeHostConsent(context.homeDir, 'accepted', fingerprint, config.botDir);
    console.log(text(`Consentimento registrado por ${HOST_CONSENT_ENV}.`, `Consent recorded through ${HOST_CONSENT_ENV}.`));
    return;
  }
  if (consentAlreadyGiven(context, config.botDir) || (existing && !readHostConsent(context.homeDir))) return;
  writeHostConsent(context.homeDir, 'pending', fingerprint, config.botDir);
  console.log(hostAccessNotice(context.locale, context.displayName, config.botDir, context.project.definition, context.pm2Home));
  console.log(text(
    `O bot só inicia depois da sua confirmação: "${context.cliName} consent" em um terminal, ` +
    `"${context.cliName} consent --accept ${fingerprint}" ou ${HOST_CONSENT_ENV}=${fingerprint} no ambiente do serviço.`,
    `The bot only starts after your confirmation: "${context.cliName} consent" in a terminal, ` +
    `"${context.cliName} consent --accept ${fingerprint}" or ${HOST_CONSENT_ENV}=${fingerprint} in the service environment.`));
}

export async function setupCommand(context: CliContext, args: string[]): Promise<void> {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  const existing = readConfig(context);
  const assumeYes = args.includes('--yes') || args.includes('-y');
  const publicKey = existing ? readBotPublicKey(existing.botDir) : undefined;
  const parsed = parseNonInteractiveSetup(args);
  if (parsed) {
    const nonInteractive = parsed.input;
    setupWillOverwrite(context, existing, assumeYes);
    const input = {
      ...nonInteractive,
      botName: nonInteractive.botName ?? existing?.botName,
      botDir: nonInteractive.botDir ?? existing?.botDir,
    };
    const config = input.mode === 'manual'
      ? manualConfig(context, input)
      : marketplaceConfig(context, input);
    const states = declaredPortStates(context.project.definition.requirements, readProfileEnvironment(context.homeDir),
      process.env, config.mode);
    const choices = portFlagChoices(states, parsed.ports, config.mode);
    const uses = await checkNonInteractivePorts(context, config, states, choices, publicKey);
    const portsSaved = saveDeclaredPorts(context, choices);
    writeConfig(context, config);
    console.log(text(`Configuração salva em ${context.configFile}.`, `Configuration saved to ${context.configFile}.`));
    reportDeclaredPorts(context, choices, portsSaved, uses);
    if (config.mode === 'manual') {
      console.log(text(`Defina ${config.tokenEnv} no ambiente antes de executar ${context.cliName} start.`,
        `Set ${config.tokenEnv} in the environment before running ${context.cliName} start.`));
    }
    recordNonInteractiveConsent(context, existing, config);
    printRequirements(context, config);
    return;
  }

  for (const argument of args) {
    if (!['--yes', '-y'].includes(argument)) throw new CliError('Opção de setup desconhecida.', 'Unknown setup option.');
  }
  if (!process.stdin.isTTY) {
    throw new CliError('Use setup --non-interactive quando não houver um terminal interativo.',
      'Use setup --non-interactive when no interactive terminal is available.');
  }

  let closed = false;
  const onClose = (): void => { closed = true; };
  process.stdin.once('end', onClose);
  process.stdin.once('close', onClose);
  process.once('SIGINT', onClose);
  const ask: Ask = async (question, secret = false) => {
    if (closed) throw new Error(text(SETUP_CANCELLED_MESSAGE, 'Setup cancelled; the configuration was not changed.'));
    return askCliText(context.locale, question.trim().replace(/:$/, ''), { secret });
  };
  try {
    console.log(color(`${context.displayName} — Setup`, ANSI.bold));
    console.log();
    if (existing) {
      console.log(text(`Configuração atual detectada em ${context.configFile}.`, `Current configuration found at ${context.configFile}.`));
      if (!assumeYes) {
        const answer = await askCliChoice(context.locale, text('Substituir a configuração existente?', 'Replace the existing configuration?'), [
          { value: 'no', label: text('Não', 'No') }, { value: 'yes', label: text('Sim', 'Yes') },
        ]);
        if (answer !== 'yes') {
          console.log(text('Setup cancelado.', 'Setup cancelled.'));
          return;
        }
      }
    }

    const modes = promptModes(context.project.definition.modes);
    let mode = modes[0] ?? 'manual';
    if (modes.length > 1) {
      mode = await askCliChoice(context.locale, text('Escolha o modo de operação:', 'Choose the operating mode:'),
        modes.map(value => ({ value, label: promptModeLabel(value, context.locale) })), existing?.mode);
    } else {
      ensureModeSupported(context, mode);
      console.log(text(`Modo suportado: ${promptModeLabel(mode, context.locale)}`, `Supported mode: ${promptModeLabel(mode, context.locale)}`));
    }

    const current = existing ?? (mode === 'manual' ? manualConfig(context) : marketplaceConfig(context));
    const portStates = declaredPortStates(context.project.definition.requirements, readProfileEnvironment(context.homeDir),
      process.env, mode);
    const portUses: PortUse[] = [];
    const botDir = await validatedPrompt(context.locale, ask, text(`Diretório de trabalho [${current.botDir}]: `, `Working directory [${current.botDir}]: `),
      (answer) => normalizeBotDir(answer || current.botDir));
    let config: BotConfig;
    console.log();
    if (mode === 'manual') {
      console.log(color(text('Modo Manual', 'Manual Mode'), ANSI.cyan));
      console.log(text('Para obter o token:', 'To get a token:'));
      console.log(text('  1. No app Monky → Configurações do Servidor → Bots', '  1. In Monky → Server Settings → Bots'));
      console.log(text('  2. Na seção Avançado, gere um vínculo/token', '  2. In the Advanced section, generate a link/token'));
      console.log(text('  3. Copie o token exibido (só aparece uma vez!)', '  3. Copy the displayed token (it is shown only once!)'));
      console.log();
      const defaultUrl = current.mode === 'manual' ? current.serverUrl : DEFAULT_MANUAL_SERVER_URL;
      const serverUrl = await validatedPrompt(context.locale, ask, text(`URL do servidor [${defaultUrl}]: `, `Server URL [${defaultUrl}]: `),
        (answer) => validateServerUrl(answer || defaultUrl));
      const tokenHint = existing?.mode === 'manual'
        ? existing.botToken === undefined
          ? text(` [Enter mantém ${existing.tokenEnv}]`, ` [Enter keeps ${existing.tokenEnv}]`)
          : text(' [Enter mantém o atual]', ' [Enter keeps the current token]')
        : '';
      const credentials = await validatedPrompt(context.locale, ask, text(`Token do bot${tokenHint}: `, `Bot token${tokenHint}: `), (answer): ManualBotCredentials => {
        if (answer) return { botToken: validateBotToken(answer) };
        if (existing?.mode === 'manual') {
          return existing.botToken === undefined
            ? { tokenEnv: existing.tokenEnv }
            : { botToken: existing.botToken };
        }
        throw new Error(text('Token é obrigatório no modo manual.', 'A token is required in manual mode.'));
      }, true);
      config = manualConfig(context, { botDir, botName: current.botName, serverUrl, ...credentials });
    } else {
      console.log(color(text('Modo Marketplace', 'Marketplace Mode'), ANSI.cyan));
      console.log(text('Qualquer servidor Monky poderá instalar o bot via URL.', 'Any Monky server can install the bot by URL.'));
      console.log(text('O host e a porta do manifest precisam ser acessíveis pelos servidores que vão instalar o bot.',
        'The manifest host and port must be reachable by the servers that will install the bot.'));
      console.log();
      const defaultPort = current.mode === 'marketplace' ? current.servePort : DEFAULT_MARKETPLACE_PORT;
      const servePort = await validatedPrompt(context.locale, ask, text(`Porta do manifest [${defaultPort}]: `, `Manifest port [${defaultPort}]: `),
        async (answer) => {
          const port = validateServePort(answer || String(defaultPort));
          assertNoOwnPortConflict({ id: MANIFEST_PORT_ID, protocol: 'tcp', port }, environmentPorts(portStates));
          portUses.push(await assertManifestPortAvailable(port, context.cliName, undefined, context.locale, publicKey));
          return port;
        });
      const detectedIp = localIpv4();
      console.log(text(`Informe o IP ou domínio público desta máquina.${detectedIp ? ` (IP local detectado: ${detectedIp})` : ''}`,
        `Enter this machine's public IP or domain.${detectedIp ? ` (Detected local IP: ${detectedIp})` : ''}`));
      const defaultHost = existing?.mode === 'marketplace' ? existing.publicHost : '';
      const publicHost = await validatedPrompt(context.locale, ask, text(`Host público${defaultHost ? ` [${defaultHost}]` : ''}: `,
        `Public host${defaultHost ? ` [${defaultHost}]` : ''}: `),
        (answer) => validatePublicHost(answer || defaultHost));
      if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(publicHost.toLowerCase())) {
        console.log(color(text('Host local: somente servidores na mesma máquina conseguirão acessar.',
          'Local host: only servers on this machine will be able to connect.'), ANSI.yellow));
      }
      config = marketplaceConfig(context, { botDir, botName: current.botName, servePort, publicHost });
    }
    const declaredChoices = await askDeclaredPorts(context, ask, portStates, manifestPort(config), publicKey, portUses);
    config = { ...config, botName: await validatedPrompt(context.locale, ask, text(`Nome do bot [${current.botName}]: `, `Bot name [${current.botName}]: `),
      (answer) => validateBotName(answer || current.botName)) };

    if (config.mode === 'marketplace') {
      await assertManifestPortAvailable(config.servePort, context.cliName, undefined, context.locale, publicKey);
    }
    for (const { state, port } of declaredChoices) {
      await assertDeclaredPortAvailable({ ...ownPort(state.requirement, port), host: state.bindHost }, context.cliName, publicKey);
    }
    if (closed) throw new Error(text(SETUP_CANCELLED_MESSAGE, 'Setup cancelled; the configuration was not changed.'));
    const approve = !consentAlreadyGiven(context, config.botDir);
    if (approve) {
      console.log();
      if (!await reviewHostConsent(context.locale, context.displayName, config.botDir, context.project.definition, context.pm2Home)) {
        console.log(text('Execução não autorizada. A configuração não foi alterada e o bot não foi iniciado.',
          'Execution not authorized. The configuration was not changed and the bot was not started.'));
        return;
      }
    }
    if (closed) throw new Error(text(SETUP_CANCELLED_MESSAGE, 'Setup cancelled; the configuration was not changed.'));
    const portsSaved = saveDeclaredPorts(context, declaredChoices);
    writeConfig(context, config);
    if (approve) writeHostConsent(context.homeDir, 'accepted', hostConsentFingerprint(context.project.definition), config.botDir);
    console.log();
    console.log(color(text('Configuração salva!', 'Configuration saved!'), ANSI.green));
    console.log(text(`Configuração salva em ${context.configFile}.`, `Configuration saved to ${context.configFile}.`));
    reportDeclaredPorts(context, declaredChoices, portsSaved, portUses);
    if (config.mode === 'manual' && config.botToken === undefined) {
      console.log(text(`Defina ${config.tokenEnv} no ambiente antes de executar ${context.cliName} start.`,
        `Set ${config.tokenEnv} in the environment before running ${context.cliName} start.`));
    }
    console.log();
    printRequirements(context, config);
    console.log();
    console.log(color(text('Próximos passos:', 'Next steps:'), ANSI.bold));
    console.log(text(`  ${context.cliName} start    — Inicia o bot em background`, `  ${context.cliName} start    — Start the bot in the background`));
    console.log(text(`  ${context.cliName} doctor   — Verifica se o bot pode operar`, `  ${context.cliName} doctor   — Check whether the bot can operate`));
    console.log(text(`  ${context.cliName} status   — Verifica o estado`, `  ${context.cliName} status   — Check the status`));
    console.log(text(`  ${context.cliName} logs     — Exibe os logs`, `  ${context.cliName} logs     — Show the logs`));
  } finally {
    process.stdin.off('end', onClose);
    process.stdin.off('close', onClose);
    process.off('SIGINT', onClose);
  }
}
