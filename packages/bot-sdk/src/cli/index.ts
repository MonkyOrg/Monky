import { ANSI, color } from './constants';
import { createCliContext, type CliContext } from './config';
import { normalizeBotLocale, type BotLocale } from '@monky/shared';
import {
  chooseCliLocale, CliError, cliErrorMessage, cliText, isInteractiveCliAccess, parseCliLocaleArgs,
  saveCliLocale, shouldPromptCliLocale,
} from './locale';
import { autoUpdateCommand, updateCommand } from './commands/update';
import {
  configCommand,
  logsCommand,
  restartCommand,
  startCommand,
  statusCommand,
  stopCommand,
} from './commands/lifecycle';
import { setupCommand } from './commands/setup';

function printUsage(context: CliContext): void {
  const modes = context.project.definition.modes.join(', ');
  console.log(cliText(context.locale, `
${color(context.cliName, ANSI.bold)} — ${context.displayName} runtime CLI

${color('USO', ANSI.bold)}
  ${context.cliName} <comando> [opções]

${color('COMANDOS', ANSI.bold)}
  setup                         Configura o bot (${modes})
  start [--foreground]          Inicia em background via pm2 ou em foreground
  stop                          Para o processo gerenciado
  restart [--fresh]             Reinicia usando a configuração salva
  status                        Mostra estado do processo e configuração
  logs [--lines N] [--no-follow]
  config                        Exibe a configuração atual
  config set <k> <v>             Ajusta mode, botName, botDir, serverUrl, botToken, tokenEnv, servePort, publicHost
  config update-source          Consulta a origem de atualização deste perfil
  config update-source github <URL> [--asset-name <nome.tgz>] [--token-env <VAR>]
  config update-source https <URL.tgz> [--token-env <VAR>]
  config update-source file <caminho.tgz>
  config update-source reset    Restaura a origem padrão do pacote
  update [--check] [--beta] [--yes]
  autoupdate on [HH:MM] [--beta]
  autoupdate off
  autoupdate status
  language [pt-BR|en]           Consulta ou salva o idioma do CLI

${color('OPÇÕES GLOBAIS', ANSI.bold)}
  --version, -v                 Exibe a versão do bot
  --help, -h                    Exibe esta ajuda
  --locale pt-BR|en             Usa este idioma somente nesta execução

${color('SETUP NÃO INTERATIVO', ANSI.bold)}
  ${context.cliName} setup --non-interactive --mode manual --server-url localhost:3000 --token-env MONKY_BOT_TOKEN [--name "Meu Bot"] [--bot-dir <diretório>] [--yes]
  ${context.cliName} setup --non-interactive --mode marketplace --public-host <IP-ou-domínio> [--serve-port 7780] [--name "Meu Bot"] [--bot-dir <diretório>] [--yes]

${color('ORIGEM DAS ATUALIZAÇÕES', ANSI.bold)}
  O padrão vem de monkyBot.releases ou monkyBot.updateSource no package.json.
  config update-source salva uma escolha por perfil, fora do pacote instalado.
  update e autoupdate usam stable; betas exigem --beta.
`, `
${color(context.cliName, ANSI.bold)} — ${context.displayName} runtime CLI

${color('USAGE', ANSI.bold)}
  ${context.cliName} <command> [options]

${color('COMMANDS', ANSI.bold)}
  setup                         Configure the bot (${modes})
  start [--foreground]          Start via pm2 in the background or in the foreground
  stop                          Stop the managed process
  restart [--fresh]             Restart using the saved configuration
  status                        Show the process state and configuration
  logs [--lines N] [--no-follow]
  config                        Show the current configuration
  config set <k> <v>             Set mode, botName, botDir, serverUrl, botToken, tokenEnv, servePort, publicHost
  config update-source          Show the update source for this profile
  config update-source github <URL> [--asset-name <name.tgz>] [--token-env <VAR>]
  config update-source https <URL.tgz> [--token-env <VAR>]
  config update-source file <path.tgz>
  config update-source reset    Restore the package default source
  update [--check] [--beta] [--yes]
  autoupdate on [HH:MM] [--beta]
  autoupdate off
  autoupdate status
  language [pt-BR|en]           Show or save the CLI language

${color('GLOBAL OPTIONS', ANSI.bold)}
  --version, -v                 Show the bot version
  --help, -h                    Show this help
  --locale pt-BR|en             Use this language for this invocation only

${color('NON-INTERACTIVE SETUP', ANSI.bold)}
  ${context.cliName} setup --non-interactive --mode manual --server-url localhost:3000 --token-env MONKY_BOT_TOKEN [--name "My Bot"] [--bot-dir <directory>] [--yes]
  ${context.cliName} setup --non-interactive --mode marketplace --public-host <IP-or-domain> [--serve-port 7780] [--name "My Bot"] [--bot-dir <directory>] [--yes]

${color('UPDATE SOURCE', ANSI.bold)}
  Defaults come from monkyBot.releases or monkyBot.updateSource in package.json.
  config update-source saves a per-profile choice outside the installed package.
  update and autoupdate use stable; beta releases require --beta.
`).trim());
}

export async function runBotCli(packageRoot: string, args: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliLocaleArgs(args);
  const versionOnly = ['--version', '-v', 'version'].includes(parsed.args[0]);
  const selectedLanguage = parsed.args[0] === 'language' && parsed.args.length === 2
    ? normalizeBotLocale(parsed.args[1]) : undefined;
  const context = createCliContext(packageRoot, process.env, {
    locale: parsed.locale ?? selectedLanguage ?? (versionOnly ? 'pt-BR' : undefined),
    toleratePreferenceErrors: !isInteractiveCliAccess(parsed.args),
  });
  try {
    await dispatchBotCli(context, parsed.args, parsed.locale);
  } catch (error) {
    if (error instanceof CliError) throw new Error(cliErrorMessage(error, context.locale));
    throw error;
  }
}

async function dispatchBotCli(context: CliContext, args: string[], explicitLocale?: BotLocale): Promise<void> {
  const [command, ...rest] = args;
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`${context.cliName} ${context.version}`);
    return;
  }
  if (shouldPromptCliLocale(context.homeDir, args, explicitLocale)) {
    context.locale = await chooseCliLocale(context.locale);
    saveCliLocale(context.homeDir, context.locale);
  }
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printUsage(context);
    return;
  }
  if (command === 'language') {
    if (rest.length > 1 || (rest.length === 1 && !normalizeBotLocale(rest[0]))) {
      throw new Error(cliText(context.locale, 'Use language pt-BR ou language en.', 'Use language pt-BR or language en.'));
    }
    const selected = normalizeBotLocale(rest[0]) ??
      (!rest.length && isInteractiveCliAccess(args) ? await chooseCliLocale(context.locale) : undefined);
    if (selected) {
      saveCliLocale(context.homeDir, selected);
      context.locale = selected;
    }
    console.log(cliText(context.locale, `Idioma: ${context.locale}`, `Language: ${context.locale}`));
    return;
  }
  if (command === 'setup') {
    await setupCommand(context, rest);
    return;
  }
  if (command === 'start') {
    await startCommand(context, rest);
    return;
  }
  if (command === 'stop') {
    stopCommand(context, rest);
    return;
  }
  if (command === 'restart') {
    await restartCommand(context, rest);
    return;
  }
  if (command === 'status') {
    statusCommand(context, rest);
    return;
  }
  if (command === 'logs') {
    logsCommand(context, rest);
    return;
  }
  if (command === 'config') {
    await configCommand(context, rest);
    return;
  }
  if (command === 'update') {
    await updateCommand(context, rest);
    return;
  }
  if (command === 'autoupdate') {
    await autoUpdateCommand(context, rest);
    return;
  }
  throw new Error(cliText(context.locale,
    `Comando desconhecido. Use "${context.cliName} --help".`,
    `Unknown CLI command. Use "${context.cliName} --help".`));
}
