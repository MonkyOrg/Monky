#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildBotPackage, parseBuildArguments } from './tooling/build';
import { isRecord, loadBotProject } from './tooling/config';
import { resolvePackage } from './tooling/bundle';
import { normalizeBotLocale, PROTOCOL_VERSION, type BotLocale } from '@monky/shared';
import {
  parseCliLocaleArgs, cliErrorMessage, cliText, CliError, defaultCliLocale, readSavedCliLocale,
  chooseCliLocale, saveCliLocale, isInteractiveCliAccess, languageCommand,
} from './cli/locale';
import { askCliChoice, askCliValue, CliPromptCancelled } from './cli/prompts';
import { createBotCommand } from './tooling/create';
import { doctorCommand } from './tooling/doctor';
import { addFeatureCommand, FEATURE_KINDS } from './tooling/features';

export { parseBuildArguments } from './tooling/build';

interface SdkContext {
  homeDir: string;
  locale: BotLocale;
  explicitLocale?: BotLocale;
  root?: string;
}

function printHelp(locale: BotLocale): void {
  console.log(cliText(locale, `monky-bot-sdk - desenvolvimento e gerenciamento de bots

  monky-bot-sdk                         Assistente interativo
  monky-bot-sdk create [PASTA] [--name NOME] [--display-name NOME] [--no-install] [--non-interactive]
  monky-bot-sdk add [command|form|selector|settings|screen] [NOME]
    form: --field nome:text|integer|boolean|string-list ou nome:select:A,B (repetível)
    selector: --choice "Texto" (repetível); --public ou --private
  monky-bot-sdk doctor
  monky-bot-sdk build [--out PASTA] [--version VERSAO] [--skip-build]
  monky-bot-sdk cli <comando> [opções]
  monky-bot-sdk config language [pt-BR|en-US]
  monky-bot-sdk info --json              Versão e recursos da ferramenta
  --locale pt-BR|en-US                 Idioma desta execução
  --root PASTA                         Projeto para add/doctor/build

create prepara TypeScript, dependências, /ping e o registro de funcionalidades.
add gera e conecta módulos, sem sobrescrever arquivos existentes.
doctor confere dependências, protocolo, entrada e tipos sem iniciar o bot.
build gera um .tgz autocontido; cli abre o gerenciador operacional do bot.
O idioma do SDK é separado do idioma/configuração de cada bot.
Projetos usam seu SDK instalado; atualizar a ferramenta global não os atualiza.`,
    `monky-bot-sdk - bot development and runtime tooling

  monky-bot-sdk                         Interactive assistant
  monky-bot-sdk create [DIR] [--name NAME] [--display-name NAME] [--no-install] [--non-interactive]
  monky-bot-sdk add [command|form|selector|settings|screen] [NAME]
    form: --field name:text|integer|boolean|string-list or name:select:A,B (repeatable)
    selector: --choice "Label" (repeatable); --public or --private
  monky-bot-sdk doctor
  monky-bot-sdk build [--out DIR] [--version VERSION] [--skip-build]
  monky-bot-sdk cli <command> [options]
  monky-bot-sdk config language [pt-BR|en-US]
  monky-bot-sdk info --json              Tool version and capabilities
  --locale pt-BR|en-US                 Language for this invocation
  --root DIR                           Project for add/doctor/build

create sets up TypeScript, dependencies, /ping and feature registration.
add creates and connects modules without overwriting existing files.
doctor checks dependencies, protocol, entry and types without starting a bot.
build produces a self-contained .tgz; cli opens the bot runtime manager.
The SDK language is separate from each bot's language and configuration.
Projects use their installed SDK; updating the global tool does not update them.`));
}

function detectedProject(root: string): string | undefined {
  const manifest = path.join(root, 'package.json');
  if (!fs.existsSync(manifest)) return undefined;
  if (fs.statSync(manifest).size > 1024 * 1024) {
    throw new CliError('package.json excede o limite de 1 MiB.', 'package.json exceeds the 1 MiB limit.');
  }
  const input: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (!isRecord(input)) throw new CliError('package.json deve conter um objeto.', 'package.json must contain an object.');
  return input.monkyBot !== undefined ||
    (isRecord(input.dependencies) && typeof input.dependencies['@monky/bot-sdk'] === 'string')
    ? loadBotProject(root).root : undefined;
}

function projectArguments(args: string[]): { root: string; args: string[] } {
  const remaining: string[] = [];
  let root: string | undefined;
  for (let index = 0; index < args.length; index++) {
    if (args[index] !== '--root') { remaining.push(args[index]); continue; }
    const value = args[++index];
    if (root !== undefined || !value || value.startsWith('-')) {
      throw new CliError('Informe --root PASTA uma única vez.', 'Specify --root DIR only once.');
    }
    root = path.resolve(value);
  }
  return { root: root ?? process.cwd(), args: remaining };
}

async function runProjectTool(command: string, args: string[], root: string, context: SdkContext): Promise<void> {
  const localSdk = resolvePackage(root, '@monky/bot-sdk');
  const tools = localSdk && path.join(localSdk, 'dist', 'tools.js');
  if (tools && fs.existsSync(tools) && fs.realpathSync(tools) !== fs.realpathSync(__filename)) {
    const locale = command === 'cli' ? context.explicitLocale : context.locale;
    const result = spawnSync(process.execPath, [tools, command, ...args, ...(locale ? ['--locale', locale] : [])], {
      cwd: root, stdio: 'inherit', shell: false, windowsHide: true,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new CliError(`A ferramenta do projeto terminou com erro (${result.status ?? result.signal}). Veja a saída acima.`,
      `The project tool failed (${result.status ?? result.signal}). See its output above.`);
    return;
  }
  if (command === 'add') { await addFeatureCommand(args, context.locale, root); return; }
  if (command === 'doctor') { doctorCommand(args, context.locale, root); return; }
  if (command === 'build') {
    const result = buildBotPackage({ ...parseBuildArguments(args), root });
    console.log(`[bot build] ${result.file}`);
    console.log(cliText(context.locale,
      `[bot build] CLI ${result.cliName}; protocolo ${result.protocolVersion}; ${result.packageCount} pacotes incluídos`,
      `[bot build] CLI ${result.cliName}; protocol ${result.protocolVersion}; ${result.packageCount} bundled packages`));
    return;
  }
  if (command === 'cli') {
    const { runBotCli } = await import('./cli');
    await runBotCli(root, [...args, ...(context.explicitLocale ? ['--locale', context.explicitLocale] : [])]);
    return;
  }
  throw new CliError('Comando de projeto desconhecido.', 'Unknown project command.');
}

async function settingsMenu(context: SdkContext): Promise<void> {
  while (true) {
    const action = await askCliChoice(context.locale, cliText(context.locale, 'Configurações do SDK', 'SDK settings'), [
      { value: 'language', label: 'Idioma / Language' },
      { value: 'back', label: cliText(context.locale, 'Voltar', 'Back') },
    ]);
    if (action === 'back') return;
    await languageCommand(context, []);
  }
}

async function sdkMenu(context: SdkContext): Promise<void> {
  context.root ??= detectedProject(process.cwd());
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  while (true) {
    const action = await askCliChoice(context.locale, `Monky Bot SDK${context.root ? ` — ${context.root}` : ''}`, [
      ...(context.root ? [
        { value: 'add', label: text('Adicionar funcionalidade', 'Add a feature') },
        { value: 'doctor', label: text('Verificar projeto (doctor)', 'Check project (doctor)') },
        { value: 'compile', label: text('Compilar projeto', 'Compile project') },
        { value: 'build', label: text('Gerar pacote distribuível', 'Build distributable package') },
        { value: 'cli', label: text('Abrir gerenciador do bot', 'Open bot runtime manager') },
      ] : []),
      { value: 'create', label: text('Criar novo bot', 'Create a new bot') },
      { value: 'open', label: text('Abrir projeto existente', 'Open an existing project') },
      { value: 'config', label: text('Configurações', 'Settings') },
      { value: 'exit', label: text('Sair', 'Exit') },
    ]);
    if (action === 'exit') return;
    try {
      if (action === 'create') context.root = await createBotCommand([], context.locale);
      else if (action === 'open') {
        context.root = await askCliValue(context.locale, text('Pasta do projeto', 'Project directory'), value => {
          const root = detectedProject(path.resolve(value));
          if (!root) throw new CliError('Esta pasta não declara um projeto de bot.', 'This directory does not declare a bot project.');
          return root;
        });
      } else if (action === 'config') await settingsMenu(context);
      else if (context.root) {
        if (action === 'compile') {
          const { runNpm } = await import('./tooling/process');
          runNpm(['run', 'build'], { cwd: context.root, stdio: 'inherit' });
        } else await runProjectTool(action, [], context.root, context);
      }
    } catch (error) {
      if (error instanceof CliPromptCancelled) console.log(cliErrorMessage(error, context.locale));
      else console.error(cliErrorMessage(error, context.locale));
    }
  }
}

export async function runSdkTools(args = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliLocaleArgs(args);
  const [command, ...rest] = parsed.args;
  if (['--version', '-v', 'version'].includes(command)) {
    console.log(`monky-bot-sdk ${loadBotProject(path.resolve(__dirname, '..')).manifest.version}`);
    return;
  }
  if (command === 'info' && rest.length === 1 && rest[0] === '--json') {
    console.log(JSON.stringify({
      name: '@monky/bot-sdk',
      version: loadBotProject(path.resolve(__dirname, '..')).manifest.version,
      protocolVersion: PROTOCOL_VERSION, authoringVersion: 1, generators: FEATURE_KINDS, locales: ['pt-BR', 'en-US'],
    }));
    return;
  }
  const homeDir = path.resolve(process.env.MONKY_BOT_SDK_HOME ?? path.join(os.homedir(), '.monky-bot-sdk'));
  const requestedLanguage = command === 'language' ? rest[0] : command === 'config' && rest[0] === 'language' ? rest[1] : undefined;
  const context: SdkContext = {
    homeDir,
    locale: parsed.locale ?? normalizeBotLocale(requestedLanguage) ??
      (command === 'cli' ? 'pt-BR' : defaultCliLocale(homeDir, process.env, !isInteractiveCliAccess(parsed.args))),
    explicitLocale: parsed.locale,
  };
  try {
    if (command === 'cli') { await runProjectTool(command, rest, process.cwd(), context); return; }
    if (['help', '--help', '-h'].includes(command) || rest.includes('--help') || rest.includes('-h') ||
        (!command && !isInteractiveCliAccess(parsed.args))) {
      printHelp(context.locale);
      return;
    }
    const interactive = isInteractiveCliAccess(parsed.args);
    if (interactive && !parsed.locale && !requestedLanguage && command !== 'language' && command !== 'config' &&
        process.env.MONKY_BOT_LOCALE === undefined && process.env.MONKY_LANG === undefined &&
        (!command || ['menu', 'create', 'add'].includes(command)) && !readSavedCliLocale(homeDir)) {
      const locale = await chooseCliLocale(context.locale);
      saveCliLocale(homeDir, locale);
      context.locale = locale;
    }
    if (!command || command === 'menu') {
      if (rest.length || !interactive) throw new CliError('O assistente exige um terminal interativo. Use --help para automação.',
        'The assistant requires an interactive terminal. Use --help for automation.');
      await sdkMenu(context);
    } else if (command === 'config' || command === 'language') {
      if (command === 'language' || rest[0] === 'language') {
        await languageCommand(context, command === 'language' ? rest : rest.slice(1));
      } else if (!rest.length && interactive) await settingsMenu(context);
      else if (!rest.length) console.log(cliText(context.locale, `Idioma: ${context.locale === 'en' ? 'en-US' : 'pt-BR'}`,
        `Language: ${context.locale === 'en' ? 'en-US' : 'pt-BR'}`));
      else throw new CliError('Use config language [pt-BR|en-US].', 'Use config language [pt-BR|en-US].');
    } else if (command === 'create') await createBotCommand(rest, context.locale);
    else if (['add', 'doctor', 'build'].includes(command)) {
      const project = projectArguments(rest);
      await runProjectTool(command, project.args, project.root, context);
    } else throw new CliError('Comando do SDK desconhecido. Use monky-bot-sdk --help.',
      'Unknown SDK tool command. Use monky-bot-sdk --help.');
  } catch (error) {
    if (error instanceof CliPromptCancelled) { console.log(cliErrorMessage(error, context.locale)); return; }
    throw new Error(cliErrorMessage(error, context.locale));
  }
}

if (require.main === module) {
  void runSdkTools().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'SDK tooling failed.');
    process.exitCode = 1;
  });
}
