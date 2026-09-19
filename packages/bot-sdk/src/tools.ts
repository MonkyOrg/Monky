#!/usr/bin/env node
import path from 'node:path';
import { buildBotPackage, parseBuildArguments } from './tooling/build';
import { loadBotProject } from './tooling/config';
import { normalizeBotLocale } from '@monky/shared';
import { parseCliLocaleArgs, cliErrorMessage, cliText } from './cli/locale';
import { CliPromptCancelled } from './cli/prompts';
import { createBotCommand } from './tooling/create';
import { doctorCommand } from './tooling/doctor';

export { parseBuildArguments } from './tooling/build';

export async function runSdkTools(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliLocaleArgs(args);
  const [command, ...rest] = parsed.args;
  const locale = parsed.locale ?? normalizeBotLocale(process.env.MONKY_BOT_LOCALE ?? process.env.MONKY_LANG ?? process.env.LANG) ?? 'pt-BR';
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`monky-bot-sdk ${loadBotProject(path.resolve(__dirname, '..')).manifest.version}`);
    return;
  }
  if (!command || ['--help', '-h', 'help'].includes(command) ||
      command !== 'cli' && (rest.includes('--help') || rest.includes('-h'))) {
    console.log(cliText(locale, `monky-bot-sdk - desenvolvimento e gerenciamento de bots

  monky-bot-sdk create [PASTA] [--name NOME] [--display-name NOME] [--no-install] [--non-interactive]
  monky-bot-sdk doctor
  monky-bot-sdk build [--out PASTA] [--version VERSAO] [--skip-build]
  monky-bot-sdk cli <comando> [opções]
  --locale pt-BR|en

create gera e compila um projeto TypeScript /ping com o SDK instalado.
doctor confere projeto, dependências, entrada e tipos, sem iniciar o bot.
build executa o compilador do projeto e gera um .tgz autocontido com CLI.
Configure o pacote em package.json.monkyBot.
cli executa o mesmo gerenciador a partir da pasta do bot.`,
      `monky-bot-sdk - bot development and runtime tooling

  monky-bot-sdk create [DIR] [--name NAME] [--display-name NAME] [--no-install] [--non-interactive]
  monky-bot-sdk doctor
  monky-bot-sdk build [--out DIR] [--version VERSION] [--skip-build]
  monky-bot-sdk cli <command> [options]
  --locale pt-BR|en

create scaffolds a TypeScript /ping bot with the installed SDK and builds it.
doctor checks the project, dependencies, entry and types without starting a bot.
build runs the project's compiler script and creates a self-contained .tgz
with a generated management CLI. Configure it in package.json.monkyBot.
cli runs the same management CLI from the current bot project.`));
    return;
  }
  try {
    if (command === 'create') { await createBotCommand(rest, locale); return; }
    if (command === 'doctor') { doctorCommand(rest, locale); return; }
  } catch (error: unknown) {
    if (error instanceof CliPromptCancelled) { console.log(cliErrorMessage(error, locale)); return; }
    throw new Error(cliErrorMessage(error, locale));
  }
  if (command === 'build') {
    const result = buildBotPackage(parseBuildArguments(rest));
    console.log(`[bot build] ${result.file}`);
    console.log(`[bot build] CLI ${result.cliName}; protocol ${result.protocolVersion}; ${result.packageCount} bundled packages`);
    return;
  }
  if (command === 'cli') {
    const { runBotCli } = await import('./cli');
    await runBotCli(process.cwd(), [...rest, ...(parsed.locale ? ['--locale', parsed.locale] : [])]);
    return;
  }
  throw new Error(cliText(locale, 'Comando do SDK desconhecido. Use monky-bot-sdk --help.',
    'Unknown SDK tool command. Use monky-bot-sdk --help.'));
}

if (require.main === module) {
  void runSdkTools().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'SDK tooling failed.');
    process.exitCode = 1;
  });
}
