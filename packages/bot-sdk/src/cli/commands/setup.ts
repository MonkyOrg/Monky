import os from 'node:os';
import readline from 'node:readline';
import {
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
  validatePublicHost,
  validateServerUrl,
  validateServePort,
  validateTokenEnv,
  writeConfig,
  normalizeBotDir,
  type BotConfig,
  type CliContext,
} from '../config';

interface NonInteractiveSetupInput {
  serverUrl: string;
  tokenEnv: string;
  botName?: string;
  botDir?: string;
}

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
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
  let serverUrl: string | undefined;
  let tokenEnv = DEFAULT_TOKEN_ENV;
  let botName: string | undefined;
  let botDir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--non-interactive') continue;
    if (argument === '--yes' || argument === '-y') continue;
    if (['--server-url', '--token-env', '--name', '--bot-dir'].includes(argument)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value.`);
      if (argument === '--server-url') serverUrl = validateServerUrl(value);
      else if (argument === '--token-env') tokenEnv = validateTokenEnv(value);
      else if (argument === '--name') botName = validateBotName(value);
      else botDir = normalizeBotDir(value);
      continue;
    }
    throw new Error(`Unknown setup option: ${argument}`);
  }
  if (!serverUrl) throw new Error('setup --non-interactive requires --server-url <ws://...>.');
  return { serverUrl, tokenEnv, ...(botName ? { botName } : {}), ...(botDir ? { botDir } : {}) };
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
    const config = manualConfig(context, {
      botName: nonInteractive.botName,
      botDir: nonInteractive.botDir || undefined,
      serverUrl: nonInteractive.serverUrl,
      tokenEnv: nonInteractive.tokenEnv,
    });
    writeConfig(context, config);
    console.log(`Configuração salva em ${context.configFile}.`);
    console.log(`Defina ${config.tokenEnv} no ambiente antes de executar ${context.cliName} start.`);
    return;
  }

  for (const argument of args) {
    if (!['--yes', '-y'].includes(argument)) throw new Error(`Unknown setup option: ${argument}`);
  }
  if (!process.stdin.isTTY) {
    throw new Error('Use setup --non-interactive when no interactive terminal is available.');
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`${context.displayName} — setup`);
    if (existing) {
      console.log(`Configuração atual detectada em ${context.configFile}.`);
      if (!assumeYes) {
        const answer = await prompt(rl, 'Substituir a configuração existente? [s/N] ');
        if (!['s', 'sim', 'y', 'yes'].includes(answer.toLowerCase())) {
          console.log('Setup cancelado.');
          return;
        }
      }
    }

    const modes = context.project.definition.modes;
    let mode = modes[0] ?? 'manual';
    if (modes.length > 1) {
      console.log('Escolha o modo de operação:');
      for (const [index, available] of modes.entries()) {
        console.log(`  ${index + 1}. ${available === 'manual' ? 'Manual' : 'Marketplace'}`);
      }
      const answer = await prompt(rl, `Modo [1]: `);
      const selected = Number(answer || '1') - 1;
      if (!Number.isInteger(selected) || selected < 0 || selected >= modes.length) {
        throw new Error(`Choose a mode between 1 and ${modes.length}.`);
      }
      mode = modes[selected];
    } else {
      ensureModeSupported(context, mode);
      console.log(`Modo suportado: ${mode}`);
    }

    const current = existing ?? (mode === 'manual' ? manualConfig(context) : marketplaceConfig(context));
    const botDirValue = await prompt(rl, `Diretório do bot [${current.botDir}]: `);
    const botDir = normalizeBotDir(botDirValue || current.botDir);
    const nameValue = await prompt(rl, `Nome do bot [${current.botName}]: `);
    const botName = validateBotName(nameValue || current.botName);

    const config = mode === 'manual'
      ? manualConfig(context, {
        botName,
        botDir,
        serverUrl: validateServerUrl(await prompt(rl,
          `URL do servidor [${current.mode === 'manual' ? current.serverUrl : DEFAULT_MANUAL_SERVER_URL}]: `) ||
          (current.mode === 'manual' ? current.serverUrl : DEFAULT_MANUAL_SERVER_URL)),
        tokenEnv: validateTokenEnv(await prompt(rl,
          `Variável de ambiente do token [${current.mode === 'manual' ? current.tokenEnv : DEFAULT_TOKEN_ENV}]: `) ||
          (current.mode === 'manual' ? current.tokenEnv : DEFAULT_TOKEN_ENV)),
      })
      : marketplaceConfig(context, {
        botName,
        botDir,
        servePort: validateServePort(await prompt(rl,
          `Porta do manifest [${current.mode === 'marketplace' ? current.servePort : DEFAULT_MARKETPLACE_PORT}]: `) ||
          String(current.mode === 'marketplace' ? current.servePort : DEFAULT_MARKETPLACE_PORT)),
        publicHost: validatePublicHost(await prompt(rl,
          `Host público [${current.mode === 'marketplace' ? current.publicHost : localIpv4() ?? 'localhost'}]: `) ||
          (current.mode === 'marketplace' ? current.publicHost : localIpv4() ?? 'localhost')),
      });

    writeConfig(context, config);
    console.log(`Configuração salva em ${context.configFile}.`);
    if (config.mode === 'manual') {
      console.log(`Defina ${config.tokenEnv} no ambiente antes de executar ${context.cliName} start.`);
    }
  } finally {
    rl.close();
  }
}
