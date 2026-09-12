import { ANSI, color } from './constants';
import { createCliContext } from './config';
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

function printUsage(packageRoot: string, args: string[] = []): void {
  const context = createCliContext(packageRoot);
  const modes = context.project.definition.modes.join(', ');
  console.log(`
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
  config set <k> <v>            Ajusta mode, name, bot-dir, server-url, token-env, serve-port, public-host
  update [--check] [--beta] [--yes]
  autoupdate on [HH:MM] [--beta]
  autoupdate off
  autoupdate status

${color('OPÇÕES GLOBAIS', ANSI.bold)}
  --version, -v                 Exibe a versão do bot
  --help, -h                    Exibe esta ajuda

${color('SETUP NÃO INTERATIVO', ANSI.bold)}
  ${context.cliName} setup --non-interactive --server-url ws://localhost:3000 --token-env MONKY_BOT_TOKEN [--name "Meu Bot"] [--bot-dir C:\\Bots\\${context.cliName}] [--yes]
`.trim());
}

export async function runBotCli(packageRoot: string, args: string[] = process.argv.slice(2)): Promise<void> {
  const context = createCliContext(packageRoot);
  const [command, ...rest] = args;
  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printUsage(packageRoot, rest);
    return;
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(`${context.cliName} ${context.version}`);
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
    restartCommand(context, rest);
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
    configCommand(context, rest);
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
  throw new Error(`Unknown CLI command: ${command}. Use "${context.cliName} --help".`);
}
