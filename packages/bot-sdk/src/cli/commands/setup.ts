import os from 'node:os';
import readline from 'node:readline';
import { Writable } from 'node:stream';
import type { BotLocale } from '@monky/shared';
import { CliError, cliErrorMessage, cliText } from '../locale';
import { assertManifestPortAvailable } from '../ports';
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

function prompt(rl: readline.Interface, question: string, locale: BotLocale): Promise<string> {
  return new Promise((resolve, reject) => {
    const onClose = (): void => reject(new Error(cliText(locale, SETUP_CANCELLED_MESSAGE,
      'Setup cancelled; the configuration was not changed.')));
    rl.once('close', onClose);
    rl.question(question, (answer) => {
      rl.off('close', onClose);
      resolve(answer.trim());
    });
  });
}

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

function parseNonInteractiveSetup(args: string[]): NonInteractiveSetupInput | null {
  if (!args.includes('--non-interactive')) return null;
  let mode: 'manual' | 'marketplace' = 'manual';
  let serverUrl: string | undefined;
  let tokenEnv: string | undefined;
  let servePort: number | undefined;
  let publicHost: string | undefined;
  let botName: string | undefined;
  let botDir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--non-interactive') continue;
    if (argument === '--yes' || argument === '-y') continue;
    if (['--mode', '--server-url', '--token-env', '--serve-port', '--public-host', '--name', '--bot-dir'].includes(argument)) {
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
      else botDir = normalizeBotDir(value);
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
    return { ...common, mode, serverUrl, tokenEnv: tokenEnv ?? DEFAULT_TOKEN_ENV };
  }
  if (serverUrl !== undefined || tokenEnv !== undefined) throw new CliError('Opções de servidor e token exigem --mode manual.',
    'Server and token options require --mode manual.');
  if (!publicHost) throw new CliError('setup --non-interactive --mode marketplace requer --public-host <domínio-ou-IP>.',
    'setup --non-interactive --mode marketplace requires --public-host <hostname-or-IP>.');
  return { ...common, mode, servePort: servePort ?? DEFAULT_MARKETPLACE_PORT, publicHost };
}

function setupWillOverwrite(context: CliContext, existing: BotConfig | null, assumeYes: boolean): void {
  if (!existing || assumeYes) return;
  throw new CliError(`Já existe uma configuração em ${context.configFile}. Execute novamente com --yes para substituir.`,
    `A config already exists at ${context.configFile}. Re-run with --yes to replace it.`);
}

export async function setupCommand(context: CliContext, args: string[]): Promise<void> {
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  const existing = readConfig(context);
  const assumeYes = args.includes('--yes') || args.includes('-y');
  const nonInteractive = parseNonInteractiveSetup(args);
  if (nonInteractive) {
    setupWillOverwrite(context, existing, assumeYes);
    const input = {
      ...nonInteractive,
      botName: nonInteractive.botName ?? existing?.botName,
      botDir: nonInteractive.botDir ?? existing?.botDir,
    };
    const config = input.mode === 'manual'
      ? manualConfig(context, input)
      : marketplaceConfig(context, input);
    if (config.mode === 'marketplace') {
      await assertManifestPortAvailable(config.servePort, context.cliName, undefined, context.locale);
    }
    writeConfig(context, config);
    console.log(text(`Configuração salva em ${context.configFile}.`, `Configuration saved to ${context.configFile}.`));
    if (config.mode === 'manual') {
      console.log(text(`Defina ${config.tokenEnv} no ambiente antes de executar ${context.cliName} start.`,
        `Set ${config.tokenEnv} in the environment before running ${context.cliName} start.`));
    }
    return;
  }

  for (const argument of args) {
    if (!['--yes', '-y'].includes(argument)) throw new CliError('Opção de setup desconhecida.', 'Unknown setup option.');
  }
  if (!process.stdin.isTTY) {
    throw new CliError('Use setup --non-interactive quando não houver um terminal interativo.',
      'Use setup --non-interactive when no interactive terminal is available.');
  }

  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  let closed = false;
  rl.once('close', () => { closed = true; });
  rl.on('SIGINT', () => rl.close());
  const ask: Ask = async (question, secret = false) => {
    if (closed) throw new Error(text(SETUP_CANCELLED_MESSAGE, 'Setup cancelled; the configuration was not changed.'));
    const answer = prompt(rl, question, context.locale);
    muted = secret;
    try {
      return await answer;
    } finally {
      muted = false;
      if (secret) console.log();
    }
  };
  try {
    console.log(color(`${context.displayName} — Setup`, ANSI.bold));
    console.log();
    if (existing) {
      console.log(text(`Configuração atual detectada em ${context.configFile}.`, `Current configuration found at ${context.configFile}.`));
      if (!assumeYes) {
        const answer = await ask(text('Substituir a configuração existente? [s/N] ', 'Replace the existing configuration? [y/N] '));
        if (!['s', 'sim', 'y', 'yes'].includes(answer.toLowerCase())) {
          console.log(text('Setup cancelado.', 'Setup cancelled.'));
          return;
        }
      }
    }

    const modes = promptModes(context.project.definition.modes);
    let mode = modes[0] ?? 'manual';
    if (modes.length > 1) {
      console.log(color(text('Escolha o modo de operação:', 'Choose the operating mode:'), ANSI.bold));
      for (const [index, available] of modes.entries()) {
        console.log(`  ${index + 1}. ${promptModeLabel(available, context.locale)}`);
      }
      const defaultMode = existing && modes.includes(existing.mode) ? modes.indexOf(existing.mode) + 1 : 1;
      mode = await validatedPrompt(context.locale, ask, text(`Modo [${defaultMode}]: `, `Mode [${defaultMode}]: `), (answer) => {
        const selected = Number(answer || defaultMode) - 1;
        if (!Number.isInteger(selected) || selected < 0 || selected >= modes.length) {
          throw new Error(text(`Escolha um modo entre 1 e ${modes.length}.`, `Choose a mode between 1 and ${modes.length}.`));
        }
        return modes[selected];
      });
    } else {
      ensureModeSupported(context, mode);
      console.log(text(`Modo suportado: ${promptModeLabel(mode, context.locale)}`, `Supported mode: ${promptModeLabel(mode, context.locale)}`));
    }

    const current = existing ?? (mode === 'manual' ? manualConfig(context) : marketplaceConfig(context));
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
          await assertManifestPortAvailable(port, context.cliName, undefined, context.locale);
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
    config = { ...config, botName: await validatedPrompt(context.locale, ask, text(`Nome do bot [${current.botName}]: `, `Bot name [${current.botName}]: `),
      (answer) => validateBotName(answer || current.botName)) };

    if (config.mode === 'marketplace') {
      await assertManifestPortAvailable(config.servePort, context.cliName, undefined, context.locale);
    }
    if (closed) throw new Error(text(SETUP_CANCELLED_MESSAGE, 'Setup cancelled; the configuration was not changed.'));
    writeConfig(context, config);
    console.log();
    console.log(color(text('Configuração salva!', 'Configuration saved!'), ANSI.green));
    console.log(text(`Configuração salva em ${context.configFile}.`, `Configuration saved to ${context.configFile}.`));
    if (config.mode === 'manual' && config.botToken === undefined) {
      console.log(text(`Defina ${config.tokenEnv} no ambiente antes de executar ${context.cliName} start.`,
        `Set ${config.tokenEnv} in the environment before running ${context.cliName} start.`));
    }
    console.log();
    console.log(color(text('Próximos passos:', 'Next steps:'), ANSI.bold));
    console.log(text(`  ${context.cliName} start    — Inicia o bot em background`, `  ${context.cliName} start    — Start the bot in the background`));
    console.log(text(`  ${context.cliName} status   — Verifica o estado`, `  ${context.cliName} status   — Check the status`));
    console.log(text(`  ${context.cliName} logs     — Exibe os logs`, `  ${context.cliName} logs     — Show the logs`));
  } finally {
    rl.close();
    output.end();
  }
}
