import os from 'node:os';
import readline from 'node:readline';
import { Writable } from 'node:stream';
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

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const onClose = (): void => reject(new Error('Setup cancelado; a configuração não foi alterada.'));
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

function promptModeLabel(mode: SetupMode): string {
  return MODE_LABELS[mode];
}

function promptModes(modes: readonly SetupMode[]): SetupMode[] {
  const preferredOrder: readonly SetupMode[] = ['marketplace', 'manual'];
  return preferredOrder.filter((mode) => modes.includes(mode));
}

async function validatedPrompt<T>(ask: Ask, question: string, validate: (value: string) => T, secret = false): Promise<T> {
  while (true) {
    const answer = await ask(question, secret);
    try {
      return validate(answer);
    } catch (error: unknown) {
      if (!(error instanceof Error)) throw error;
      console.error(color(error.message, ANSI.red));
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
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--mode') {
        if (value !== 'manual' && value !== 'marketplace') throw new Error('--mode must be manual or marketplace.');
        mode = value;
      } else if (argument === '--server-url') serverUrl = validateServerUrl(value);
      else if (argument === '--token-env') tokenEnv = validateTokenEnv(value);
      else if (argument === '--serve-port') servePort = validateServePort(value);
      else if (argument === '--public-host') publicHost = validatePublicHost(value);
      else if (argument === '--name') botName = validateBotName(value);
      else botDir = normalizeBotDir(value);
      continue;
    }
    throw new Error(`Unknown setup option: ${argument}`);
  }
  const common = { ...(botName ? { botName } : {}), ...(botDir ? { botDir } : {}) };
  if (mode === 'manual') {
    if (servePort !== undefined || publicHost !== undefined) throw new Error('Manifest options require --mode marketplace.');
    if (!serverUrl) throw new Error('setup --non-interactive requires --server-url <ws://...>.');
    return { ...common, mode, serverUrl, tokenEnv: tokenEnv ?? DEFAULT_TOKEN_ENV };
  }
  if (serverUrl !== undefined || tokenEnv !== undefined) throw new Error('Server and token options require --mode manual.');
  if (!publicHost) throw new Error('setup --non-interactive --mode marketplace requires --public-host <hostname-or-IP>.');
  return { ...common, mode, servePort: servePort ?? DEFAULT_MARKETPLACE_PORT, publicHost };
}

function setupWillOverwrite(context: CliContext, existing: BotConfig | null, assumeYes: boolean): void {
  if (!existing || assumeYes) return;
  throw new Error(`A config already exists at ${context.configFile}. Re-run with --yes to replace it.`);
}

export async function setupCommand(context: CliContext, args: string[]): Promise<void> {
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
    writeConfig(context, config);
    console.log(`Configuração salva em ${context.configFile}.`);
    if (config.mode === 'manual') {
      console.log(`Defina ${config.tokenEnv} no ambiente antes de executar ${context.cliName} start.`);
    }
    return;
  }

  for (const argument of args) {
    if (!['--yes', '-y'].includes(argument)) throw new Error(`Unknown setup option: ${argument}`);
  }
  if (!process.stdin.isTTY) {
    throw new Error('Use setup --non-interactive when no interactive terminal is available.');
  }

  let muted = false;
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  rl.on('SIGINT', () => rl.close());
  const ask: Ask = async (question, secret = false) => {
    const answer = prompt(rl, question);
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
      console.log(`Configuração atual detectada em ${context.configFile}.`);
      if (!assumeYes) {
        const answer = await ask('Substituir a configuração existente? [s/N] ');
        if (!['s', 'sim', 'y', 'yes'].includes(answer.toLowerCase())) {
          console.log('Setup cancelado.');
          return;
        }
      }
    }

    const modes = promptModes(context.project.definition.modes);
    let mode = modes[0] ?? 'manual';
    if (modes.length > 1) {
      console.log(color('Escolha o modo de operação:', ANSI.bold));
      for (const [index, available] of modes.entries()) {
        console.log(`  ${index + 1}. ${promptModeLabel(available)}`);
      }
      const defaultMode = existing && modes.includes(existing.mode) ? modes.indexOf(existing.mode) + 1 : 1;
      mode = await validatedPrompt(ask, `Modo [${defaultMode}]: `, (answer) => {
        const selected = Number(answer || defaultMode) - 1;
        if (!Number.isInteger(selected) || selected < 0 || selected >= modes.length) {
          throw new Error(`Escolha um modo entre 1 e ${modes.length}.`);
        }
        return modes[selected];
      });
    } else {
      ensureModeSupported(context, mode);
      console.log(`Modo suportado: ${promptModeLabel(mode)}`);
    }

    const current = existing ?? (mode === 'manual' ? manualConfig(context) : marketplaceConfig(context));
    const botDir = await validatedPrompt(ask, `Diretório de trabalho [${current.botDir}]: `,
      (answer) => normalizeBotDir(answer || current.botDir));
    let config: BotConfig;
    console.log();
    if (mode === 'manual') {
      console.log(color('Modo Manual', ANSI.cyan));
      console.log('Para obter o token:');
      console.log('  1. No app Monky → Configurações do Servidor → Bots');
      console.log('  2. Na seção Avançado, gere um vínculo/token');
      console.log('  3. Copie o token exibido (só aparece uma vez!)');
      console.log();
      const defaultUrl = current.mode === 'manual' ? current.serverUrl : DEFAULT_MANUAL_SERVER_URL;
      const serverUrl = await validatedPrompt(ask, `URL do servidor [${defaultUrl}]: `,
        (answer) => validateServerUrl(answer || defaultUrl));
      const tokenHint = existing?.mode === 'manual'
        ? existing.botToken === undefined ? ` [Enter mantém ${existing.tokenEnv}]` : ' [Enter mantém o atual]'
        : '';
      const credentials = await validatedPrompt(ask, `Token do bot${tokenHint}: `, (answer): ManualBotCredentials => {
        if (answer) return { botToken: validateBotToken(answer) };
        if (existing?.mode === 'manual') {
          return existing.botToken === undefined
            ? { tokenEnv: existing.tokenEnv }
            : { botToken: existing.botToken };
        }
        throw new Error('Token é obrigatório no modo manual.');
      }, true);
      config = manualConfig(context, { botDir, botName: current.botName, serverUrl, ...credentials });
    } else {
      console.log(color('Modo Marketplace', ANSI.cyan));
      console.log('Qualquer servidor Monky poderá instalar o bot via URL.');
      console.log('O host e a porta do manifest precisam ser acessíveis pelos servidores que vão instalar o bot.');
      console.log();
      const defaultPort = current.mode === 'marketplace' ? current.servePort : DEFAULT_MARKETPLACE_PORT;
      const servePort = await validatedPrompt(ask, `Porta do manifest [${defaultPort}]: `,
        (answer) => validateServePort(answer || String(defaultPort)));
      const detectedIp = localIpv4();
      console.log(`Informe o IP ou domínio público desta máquina.${detectedIp ? ` (IP local detectado: ${detectedIp})` : ''}`);
      const defaultHost = existing?.mode === 'marketplace' ? existing.publicHost : '';
      const publicHost = await validatedPrompt(ask, `Host público${defaultHost ? ` [${defaultHost}]` : ''}: `,
        (answer) => validatePublicHost(answer || defaultHost));
      if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(publicHost.toLowerCase())) {
        console.log(color('Host local: somente servidores na mesma máquina conseguirão acessar.', ANSI.yellow));
      }
      config = marketplaceConfig(context, { botDir, botName: current.botName, servePort, publicHost });
    }
    config = { ...config, botName: await validatedPrompt(ask, `Nome do bot [${current.botName}]: `,
      (answer) => validateBotName(answer || current.botName)) };

    writeConfig(context, config);
    console.log();
    console.log(color('Configuração salva!', ANSI.green));
    console.log(`Configuração salva em ${context.configFile}.`);
    if (config.mode === 'manual' && config.botToken === undefined) {
      console.log(`Defina ${config.tokenEnv} no ambiente antes de executar ${context.cliName} start.`);
    }
    console.log();
    console.log(color('Próximos passos:', ANSI.bold));
    console.log(`  ${context.cliName} start    — Inicia o bot em background`);
    console.log(`  ${context.cliName} status   — Verifica o estado`);
    console.log(`  ${context.cliName} logs     — Exibe os logs`);
  } finally {
    rl.close();
    output.end();
  }
}
