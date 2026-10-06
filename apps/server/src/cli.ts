#!/usr/bin/env node

import { ANSI, color } from './cli/constants';
import {
  GlobalArgs,
  isHelpArg,
  parseGlobalArgs,
  withContext,
} from './cli/context';
import { resolveTargetServer } from './cli/target';
import { createCommand } from './cli/commands/create';
import {
  listServersCommand,
  logsServerCommand,
  restartServerCommand,
  startServerCommand,
  statusServerCommand,
  stopServerCommand,
} from './cli/commands/serverLifecycle';
import {
  changeAdminRole,
  listMembers,
  showMemberInfo,
} from './cli/commands/members';
import {
  assignRoleInteractive,
  createRoleInteractive,
  deleteRoleInteractive,
  listRoles,
} from './cli/commands/roles';
import { setConfig, showConfig } from './cli/commands/config';
import { cliLanguageCommand, cliSettingsMenu } from './cli/commands/cliSettings';
import { updateCommand, getLocalVersion } from './cli/commands/update';
import { destroyCommand } from './cli/commands/destroy';
import {
  getCliLanguage,
  initCliI18n,
  normalizeCliLanguage,
  SUPPORTED_CLI_LANGUAGES,
  setCliLanguage,
  persistLanguage,
  t,
  SupportedCliLanguage,
} from './cli/i18n/index';

function printUsage(): void {
  const isPtBR = getCliLanguage() === 'pt-BR';

  if (isPtBR) {
    console.log(`
${color('monky', ANSI.bold)} — ferramenta de administração do servidor Monky

${color('USO', ANSI.bold)}
  monky <comando> [subcomando] [opções]

${color('SERVIDORES', ANSI.bold)}
  create                   Cria um novo servidor (interativo)
  list                     Lista os servidores desta máquina
  start                    Inicia um servidor já criado
  stop                     Para o servidor
  restart                  Reinicia o servidor aplicando a configuração atual
  status                   Exibe o estado do servidor
  logs                     Exibe os logs do servidor
  update                   Atualiza o Monky para a última versão
  destroy                  Apaga todos os dados do servidor (irreversível)

${color('MEMBROS E CARGOS', ANSI.bold)}
  members                  Lista membros
  members info <id>        Exibe um membro em detalhe
  admin add [membro]       Concede admin (interativo se sem argumento)
  admin remove [membro]    Remove admin
  roles                    Lista cargos
  roles create             Cria um cargo (interativo)
  roles assign             Atribui um cargo a um membro
  roles unassign           Remove um cargo de um membro
  roles delete             Apaga um cargo

${color('CONFIGURAÇÃO', ANSI.bold)}
  config                   Abre Configurações (exibe o servidor em scripts)
  config language [pt-BR|en-US]  Consulta ou altera o idioma do CLI
  config set <chave> [valor]  Altera uma configuração

${color('OPÇÕES GLOBAIS', ANSI.bold)}
  --version, -v            Exibe a versão instalada do Monky CLI
  --data <pasta>           Servidor a usar (obrigatório se houver vários)
  --help, -h               Exibe esta ajuda
  --lang <código>          Define o idioma (en/en-US, pt-BR)

${color('OPÇÕES POR COMANDO', ANSI.bold)}
  start   --port <n>  --fresh
  restart --fresh          Recria o processo no PM2 do zero (use após trocar a versão do Node)
  status  --watch          Modo dashboard em tempo real (Ctrl+C para sair)
  logs    --lines <n>  --level INFO|WARN|ERROR  --no-follow
  update  --beta  --check  --yes

${color('EXEMPLOS', ANSI.bold)}
  monky create                        Cria e inicia o primeiro servidor
  monky start                         Inicia o único servidor da máquina
  monky logs --level ERROR --no-follow  Imprime os erros recentes e sai
  monky --data /srv/monky restart     Reinicia um servidor específico
  monky --lang pt-BR                  Salva o idioma do CLI

Documentação completa: https://monkyorg.github.io/Monky/cli
`.trim());
  } else {
    console.log(`
${color('monky', ANSI.bold)} — Monky server administration tool

${color('USAGE', ANSI.bold)}
  monky <command> [subcommand] [options]

${color('SERVERS', ANSI.bold)}
  create                   Create a new server (interactive)
  list                     List servers on this machine
  start                    Start an existing server
  stop                     Stop the server
  restart                  Restart the server applying current settings
  status                   Show server state
  logs                     Show server logs
  update                   Update Monky to the latest version
  destroy                  Delete all server data (irreversible)

${color('MEMBERS & ROLES', ANSI.bold)}
  members                  List members
  members info <id>        Show member details
  admin add [member]       Grant admin (interactive if no argument)
  admin remove [member]    Revoke admin
  roles                    List roles
  roles create             Create a role (interactive)
  roles assign             Assign a role to a member
  roles unassign           Remove a role from a member
  roles delete             Delete a role

${color('SETTINGS', ANSI.bold)}
  config                   Open Settings (show server configuration in scripts)
  config language [pt-BR|en-US]  Show or change the CLI language
  config set <key> [value] Change a setting

${color('GLOBAL OPTIONS', ANSI.bold)}
  --version, -v            Show installed Monky CLI version
  --data <dir>             Server to use (required if there are multiple)
  --help, -h               Show this help
  --lang <code>            Set language (en/en-US, pt-BR)

${color('COMMAND OPTIONS', ANSI.bold)}
  start   --port <n>  --fresh
  restart --fresh          Recreate the PM2 process from scratch (use after changing Node version)
  status  --watch          Real-time dashboard mode (Ctrl+C to exit)
  logs    --lines <n>  --level INFO|WARN|ERROR  --no-follow
  update  --beta  --check  --yes

${color('EXAMPLES', ANSI.bold)}
  monky create                        Create and start first server
  monky start                         Start the only server on this machine
  monky logs --level ERROR --no-follow  Print recent errors and exit
  monky --data /srv/monky restart     Restart a specific server
  monky --lang en                     Save the CLI language

Full documentation: https://monkyorg.github.io/Monky/en/cli
`.trim());
  }
}

async function runDataCommand(
  globalArgs: GlobalArgs,
  fn: (dataDir: string) => Promise<void>
): Promise<void> {
  const target = await resolveTargetServer(globalArgs, t('action.manage'));
  await fn(target.dataDir);
}

const COMMANDS = new Set([
  'create', 'bootstrap', 'list', 'ls', 'start', 'stop', 'restart', 'logs',
  'status', 'update', 'destroy', 'members', 'admin', 'roles', 'config',
]);

const SUBCOMMANDS = new Map<string, readonly string[]>([
  ['members', ['list', 'info']],
  ['admin', ['add', 'remove']],
  ['roles', ['list', 'create', 'assign', 'unassign', 'delete']],
  ['config', ['show', 'set', 'language']],
]);

function commandKind(args: string[]): 'help' | 'version' | 'command' {
  const [section, action] = args;
  if (!section || isHelpArg(section) || args.includes('--help') || args.includes('-h')) return 'help';
  if (section === 'version' || args.includes('--version') || args.includes('-v')) return 'version';
  if (!COMMANDS.has(section)) throw new Error(t('cli.unknownCommand', { command: section }));
  const actions = SUBCOMMANDS.get(section);
  if (actions && ((action && !actions.includes(action)) || (section === 'admin' && !action))) {
    throw new Error(t('cli.invalidSubcommand', { command: section, actions: actions.join(', ') }));
  }
  return 'command';
}

export async function runCommand(globalArgs: GlobalArgs): Promise<void> {
  const [section, action, ...rest] = globalArgs.args;
  const kind = commandKind(globalArgs.args);

  if (kind === 'help') {
    printUsage();
    return;
  }

  if (kind === 'version') {
    console.log(`monky ${getLocalVersion()}`);
    return;
  }

  // "bootstrap" is kept as a hidden alias so existing scripts and older
  // documentation keep working after the rename to "create".
  if (section === 'create' || section === 'bootstrap') {
    await createCommand(globalArgs, [action, ...rest].filter(Boolean));
    return;
  }

  if (section === 'list' || section === 'ls') {
    await listServersCommand();
    return;
  }

  if (section === 'start') {
    await startServerCommand(globalArgs, [action, ...rest].filter(Boolean));
    return;
  }

  if (section === 'stop') {
    await stopServerCommand(globalArgs);
    return;
  }

  if (section === 'restart') {
    await restartServerCommand(globalArgs, [action, ...rest].filter(Boolean));
    return;
  }

  if (section === 'logs') {
    await logsServerCommand(globalArgs, [action, ...rest].filter(Boolean));
    return;
  }

  if (section === 'status') {
    await statusServerCommand(globalArgs, [action, ...rest].filter(Boolean));
    return;
  }

  if (section === 'update') {
    await updateCommand(globalArgs, [action, ...rest].filter(Boolean));
    return;
  }

  if (section === 'destroy') {
    await destroyCommand(globalArgs);
    return;
  }

  if (section === 'members') {
    const memberAction = action || 'list';
    await runDataCommand(globalArgs, async (dataDir) => {
      await withContext(dataDir, async (ctx) => {
        if (memberAction === 'list') {
          await listMembers(ctx);
          return;
        }
        if (memberAction === 'info') {
          await showMemberInfo(ctx, rest.join(' '));
          return;
        }
      });
    });
    return;
  }

  if (section === 'admin') {
    await runDataCommand(globalArgs, async (dataDir) => {
      await withContext(dataDir, async (ctx) => {
        if (action === 'add') {
          await changeAdminRole(ctx, rest.join(' '), true);
          return;
        }
        if (action === 'remove') {
          await changeAdminRole(ctx, rest.join(' '), false);
          return;
        }
      });
    });
    return;
  }

  if (section === 'roles') {
    const roleAction = action || 'list';
    await runDataCommand(globalArgs, async (dataDir) => {
      await withContext(dataDir, async (ctx) => {
        if (roleAction === 'list') {
          await listRoles(ctx);
          return;
        }
        if (roleAction === 'create') {
          await createRoleInteractive(ctx, rest);
          return;
        }
        if (roleAction === 'assign') {
          await assignRoleInteractive(ctx, rest, false);
          return;
        }
        if (roleAction === 'unassign') {
          await assignRoleInteractive(ctx, rest, true);
          return;
        }
        if (roleAction === 'delete') {
          await deleteRoleInteractive(ctx, rest);
          return;
        }
      });
    });
    return;
  }

  if (section === 'config') {
    if (action === 'language') {
      await cliLanguageCommand(rest);
      return;
    }
    if (!action && process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) {
      await cliSettingsMenu(globalArgs);
      return;
    }
    const configAction = action || 'show';
    await runDataCommand(globalArgs, async (dataDir) => {
      await withContext(dataDir, async (ctx) => {
        if (configAction === 'show') {
          await showConfig(ctx);
          return;
        }
        if (configAction === 'set') {
          await setConfig(ctx, rest[0] || '', rest.length > 1 ? rest.slice(1).join(' ') : undefined);
          return;
        }
      });
    });
    return;
  }

  throw new Error(t('cli.unknownCommand', { command: section }));
}

export function parseLanguageArgs(rawArgs: string[]): { args: string[]; language?: SupportedCliLanguage } {
  const args: string[] = [];
  let language: SupportedCliLanguage | undefined;
  for (let index = 0; index < rawArgs.length; index++) {
    const argument = rawArgs[index];
    if (argument === '--lang' || argument.startsWith('--lang=')) {
      if (language) throw new Error(t('language.duplicateOption'));
      const value = argument === '--lang' ? rawArgs[++index] : argument.slice('--lang='.length);
      if (!value || value.startsWith('-')) throw new Error(t('language.missingValue'));
      const normalized = normalizeCliLanguage(value);
      if (!normalized) throw new Error(t('language.unsupported', { value }));
      language = normalized;
    } else {
      args.push(argument);
    }
  }
  return { args, language };
}

export async function main(rawArgs: string[] = process.argv.slice(2)): Promise<void> {
  // Pick the diagnostic language before validating flags. A valid override
  // skips stored settings; an invalid flag is explained in the saved locale.
  const languageIndex = rawArgs.findIndex((argument) => argument === '--lang' || argument.startsWith('--lang='));
  const languageValue = languageIndex < 0 ? undefined : rawArgs[languageIndex] === '--lang'
    ? rawArgs[languageIndex + 1]
    : rawArgs[languageIndex].slice('--lang='.length);
  const hasLanguage = initCliI18n(languageValue ? normalizeCliLanguage(languageValue) ?? undefined : undefined);
  const { args, language } = parseLanguageArgs(rawArgs);
  const globalArgs = parseGlobalArgs(args);

  // A standalone --lang is an explicit preference edit. Help, version and
  // commands run by scripts only use the flag for that invocation.
  if (language && args.length === 0) {
    persistLanguage(language);
    console.log(t('language.saved', { language }));
    return;
  }

  const kind = commandKind(globalArgs.args);
  if (kind !== 'command') {
    await runCommand(globalArgs);
    return;
  }
  if (process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) {
    if (language) {
      persistLanguage(language);
    } else if (!hasLanguage && !(globalArgs.args[0] === 'config' && globalArgs.args[1] === 'language')) {
      await promptLanguageSelection();
    }
  }
  // A one-off --lang must also reach child CLIs (for example, the fresh CLI
  // that restarts a server after an update), without changing saved settings.
  const previousEnvironmentLanguage = process.env.MONKY_LANG;
  process.env.MONKY_LANG = getCliLanguage();
  try {
    await runCommand(globalArgs);
  } finally {
    if (previousEnvironmentLanguage === undefined) delete process.env.MONKY_LANG;
    else process.env.MONKY_LANG = previousEnvironmentLanguage;
  }
}

/**
 * Keep one readline interface through retries; EOF cancels instead of leaving
 * an unresolved question or silently persisting a different language.
 */
export async function promptLanguageSelection(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout
): Promise<void> {
  const readline = await import('readline');
  const labels = SUPPORTED_CLI_LANGUAGES.map((l, i) => `  ${i + 1}. ${l.label}`).join('\n');
  output.write(`${t('language.selectPrompt')}\n${labels}\n> `);
  const rl = readline.createInterface({ input, output });
  try {
    for await (const answer of rl) {
      const value = answer.trim();
      const chosen = /^\d+$/.test(value)
        ? SUPPORTED_CLI_LANGUAGES[Number(value) - 1]?.code
        : normalizeCliLanguage(value);
      if (!chosen) {
        output.write(`${t('language.invalidSelection')}\n> `);
        continue;
      }
      persistLanguage(chosen);
      setCliLanguage(chosen);
      output.write(`${t('language.saved', { language: chosen })}\n`);
      return;
    }
    throw new Error(t('prompt.cancelled'));
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(color(t('cli.error', { message }), ANSI.red));
    console.error(color(t('cli.useHelp'), ANSI.dim));
    process.exit(1);
  });
}
