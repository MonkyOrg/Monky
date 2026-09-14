import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import type { BotLocale } from '@monky/shared';
import { runNpm } from '../../tooling/process';
import { isRecord } from '../../tooling/config';
import { DEFAULT_AUTOUPDATE_SCHEDULE, GENERATED_WRAPPER_FILE } from '../constants';
import { readConfig, type BotConfig, type CliContext } from '../config';
import {
  deleteProcess,
  findProcess,
  requirePm2,
  saveProcessList,
  startOrRestart,
  writeUpdaterEcosystem,
  type Pm2Process,
} from '../pm2';
import { compareVersions } from '../updateReleases';
import { configuredUpdateSource, withUpdateCandidate } from '../updateSources';
import { CliError, cliText } from '../locale';
import { createUpdateProgressReporter } from '../updateProgress';

function promptYesNo(question: string, defaultYes: boolean, locale: BotLocale): Promise<boolean> {
  const hint = defaultYes ? cliText(locale, '[S/n]', '[Y/n]') : cliText(locale, '[s/N]', '[y/N]');
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, historySize: 0 });
    const onClose = (): void => reject(new CliError('Atualização cancelada.', 'Update cancelled.'));
    rl.once('close', onClose);
    rl.on('SIGINT', () => rl.close());
    rl.question(`${question} ${hint} `, (answer) => {
      rl.off('close', onClose);
      rl.close();
      const normalized = answer.trim().toLowerCase();
      if (!normalized) {
        resolve(defaultYes);
        return;
      }
      resolve(['y', 'yes', 's', 'sim'].includes(normalized));
    });
  });
}

function parseUpdateArgs(args: string[]): { includeBeta: boolean; checkOnly: boolean; assumeYes: boolean } {
  let includeBeta = false;
  let checkOnly = false;
  let assumeYes = false;
  for (const argument of args) {
    if (argument === '--beta') {
      includeBeta = true;
      continue;
    }
    if (argument === '--check') {
      checkOnly = true;
      continue;
    }
    if (argument === '--yes' || argument === '-y') {
      assumeYes = true;
      continue;
    }
    throw new CliError('Opção de update desconhecida. Use --beta, --check ou --yes.',
      'Unknown update option. Use --beta, --check or --yes.');
  }
  return { includeBeta, checkOnly, assumeYes };
}

function requireGlobalInstall(context: CliContext): void {
  let globalRoot: string;
  try {
    globalRoot = runNpm(['root', '--global']).trim();
  } catch {
    throw new CliError('Não foi possível determinar o prefixo global ativo do npm.',
      'Could not determine the active npm global prefix.');
  }
  const installedRoot = path.join(globalRoot, ...context.project.manifest.name.split('/'));
  if (!path.isAbsolute(globalRoot) || !fs.existsSync(installedRoot) ||
      fs.realpathSync(installedRoot) !== fs.realpathSync(context.packageRoot)) {
    throw new CliError('Execute update pelo CLI do bot instalado globalmente. Um checkout ou uma instalação npm local só permite update --check.',
      'Run update from the globally installed bot CLI. A source checkout or local npm installation supports update --check only.');
  }
}

function requireExternalRuntimeData(context: CliContext): void {
  const config = readConfig(context);
  const roots = [path.resolve(context.packageRoot), context.project.root];
  const isInsidePackage = (directory: string): boolean => roots.some((root) => {
    const relative = path.relative(root, directory);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });
  for (const directory of [context.homeDir, ...(config ? [config.botDir] : [])]) {
    if (isInsidePackage(path.resolve(directory)) ||
        (fs.existsSync(directory) && isInsidePackage(fs.realpathSync(directory)))) {
      throw new CliError('A configuração ou os dados do bot estão dentro do pacote instalado. Mova-os para fora do pacote antes de atualizar para preservar perfil e chaves.',
        'The bot config or runtime directory is inside its installed package. Move it outside the package before updating to preserve the profile and keys.');
    }
  }
}

function verifyInstalledRelease(context: CliContext, expectedVersion: string): void {
  let manifest: unknown;
  try {
    const file = path.join(context.packageRoot, 'package.json');
    if (fs.statSync(file).size > 1024 * 1024) throw new Error('Invalid manifest.');
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(cliText(context.locale, 'O pacote instalado não pôde ser verificado. O bot não foi reiniciado.',
      'The installed package could not be verified. The bot was not restarted.'));
  }
  if (!isRecord(manifest) || manifest.version !== expectedVersion || manifest.name !== context.project.manifest.name ||
      !isRecord(manifest.monkyBot) || manifest.monkyBot.cliName !== context.cliName) {
    throw new Error(cliText(context.locale,
      'O npm concluiu, mas o bot instalado não corresponde à release esperada. O processo não foi reiniciado.',
      'npm completed, but the installed bot does not match the expected release. The running process was not restarted.'));
  }
}

function restartInstalledCli(context: CliContext, config: BotConfig, runningProcess: Pm2Process): void {
  let wrapper: string;
  try {
    const root = fs.realpathSync(context.packageRoot);
    wrapper = fs.realpathSync(path.join(root, GENERATED_WRAPPER_FILE));
    const relative = path.relative(root, wrapper);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.statSync(wrapper).isFile()) {
      throw new Error('Invalid CLI entry.');
    }
  } catch {
    throw new Error(cliText(context.locale,
      'O pacote foi atualizado, mas o novo CLI não está disponível. O bot não foi reiniciado.',
      'The package was updated, but the new CLI is unavailable. The bot was not restarted.'));
  }
  const env: NodeJS.ProcessEnv = { ...process.env, MONKY_BOT_LOCALE: context.locale };
  if (config.mode === 'manual' && config.tokenEnv !== undefined && env[config.tokenEnv] === undefined) {
    // The shell that originally started PM2 may no longer exist. Recover only
    // the declared credential, without copying unrelated managed secrets.
    const token = runningProcess.pm2_env?.env?.[config.tokenEnv];
    if (typeof token === 'string') env[config.tokenEnv] = token;
  }
  let result: ReturnType<typeof spawnSync>;
  try {
    // Reload the installed SDK in a fresh process; this updater still has the old modules cached.
    result = spawnSync(process.execPath, [wrapper, 'restart', '--fresh'], {
      cwd: context.packageRoot,
      env,
      shell: false,
      stdio: 'pipe',
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    });
  } catch {
    throw new Error(cliText(context.locale,
      'O pacote foi atualizado, mas não foi possível iniciar o novo CLI para reiniciar o bot.',
      'The package was updated, but the new CLI could not be started to restart the bot.'));
  }
  if (result.error || result.status !== 0) {
    // Child/npm/PM2 diagnostics can include credentials from the runtime environment.
    throw new Error(cliText(context.locale,
      `O pacote foi atualizado, mas o reinício falhou. Confira a configuração e execute ${context.cliName} restart.`,
      `The package was updated, but restart failed. Check the configuration and run ${context.cliName} restart.`));
  }
}

export async function updateCommand(context: CliContext, args: string[]): Promise<void> {
  configuredUpdateSource(context.project);
  const options = parseUpdateArgs(args);
  const text = (pt: string, en: string): string => cliText(context.locale, pt, en);
  const progress = createUpdateProgressReporter(context.locale);
  try {
    await withUpdateCandidate(context.project, options.includeBeta, async (latest) => {
      console.log(text(`Versão instalada: ${context.version}`, `Installed version: ${context.version}`));
      if (!latest) {
        console.log(text('Nenhuma release instalável encontrada no canal solicitado.', 'No installable release found on the requested channel.'));
        return;
      }
      const comparison = compareVersions(latest.version, context.version);
      if (comparison <= 0) {
        console.log(comparison === 0
          ? text('Você já está na versão mais recente desse canal.', 'You already have the latest version on this channel.')
          : text('A release encontrada é mais antiga do que a instalada; downgrade bloqueado.',
            'The available release is older than the installed version; downgrades are blocked.'));
        return;
      }
      console.log(text(`Nova versão disponível: ${latest.version}`, `New version available: ${latest.version}`));
      if (latest.htmlUrl) console.log(latest.htmlUrl);
      if (options.checkOnly) return;
      requireGlobalInstall(context);
      if (!options.assumeYes && (!process.stdin.isTTY || !process.stdout.isTTY)) {
        throw new CliError('Use update --yes para instalar sem interação ou --check para consultar.',
          'Use update --yes to install a release non-interactively, or --check to inspect it.');
      }
      if (!options.assumeYes && !(await promptYesNo(text(`Atualizar ${context.cliName} para ${latest.version}?`,
        `Update ${context.cliName} to ${latest.version}?`), true, context.locale))) {
        console.log(text('Atualização cancelada.', 'Update cancelled.'));
        return;
      }

      requireExternalRuntimeData(context);
      const runningProcess = findProcess(context);
      await latest.withVerifiedArchive((file) => {
        progress.report({ stage: 'installing' });
        try {
          runNpm(['install', '-g', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', file], {
            stdio: 'pipe',
            timeout: 300_000,
          });
        } catch {
          // npm diagnostics can contain environment credentials or authenticated registry URLs.
          throw new CliError('A instalação offline com npm falhou. O bot em execução não foi reiniciado.',
            'The offline npm installation failed. The running bot was not restarted.');
        }
      });
      verifyInstalledRelease(context, latest.version);
      console.log(text(`Atualizado para ${latest.version}.`, `Updated to ${latest.version}.`));
      if (runningProcess?.pm2_env?.status === 'online') {
        const config = readConfig(context);
        if (!config) throw new CliError('O pacote foi atualizado, mas a configuração desapareceu antes do reinício.',
          'The bot package was updated, but the config disappeared before the process could be restarted.');
        progress.report({ stage: 'restarting' });
        restartInstalledCli(context, config, runningProcess);
        console.log(text('Processo reiniciado com a mesma configuração.', 'Process restarted with the same configuration.'));
      }
    }, process.env, progress.report);
  } finally {
    progress.close();
  }
}

function parseAutoUpdateArgs(args: string[]): { action: 'on' | 'off' | 'status'; schedule: string; includeBeta: boolean } {
  const action = args[0] ?? 'status';
  if (action === 'status' && args.length <= 1) {
    return { action, schedule: DEFAULT_AUTOUPDATE_SCHEDULE, includeBeta: false };
  }
  if (action === 'off') {
    if (args.length !== 1) throw new CliError('autoupdate off não aceita opções adicionais.', 'autoupdate off does not accept extra options.');
    return { action, schedule: DEFAULT_AUTOUPDATE_SCHEDULE, includeBeta: false };
  }
  if (action === 'on') {
    let schedule = DEFAULT_AUTOUPDATE_SCHEDULE;
    let includeBeta = false;
    for (let index = 1; index < args.length; index++) {
      const argument = args[index];
      if (argument === '--beta') {
        includeBeta = true;
        continue;
      }
      if (/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(argument) && schedule === DEFAULT_AUTOUPDATE_SCHEDULE) {
        schedule = argument;
        continue;
      }
      throw new CliError('Opção de autoupdate desconhecida. Use HH:MM e/ou --beta.', 'Unknown autoupdate option. Use HH:MM and/or --beta.');
    }
    return { action, schedule, includeBeta };
  }
  if (action === 'status' && args.length === 1) {
    return { action, schedule: DEFAULT_AUTOUPDATE_SCHEDULE, includeBeta: false };
  }
  throw new CliError('Subcomando de autoupdate desconhecido. Use on, off ou status.',
    'Unknown autoupdate subcommand. Use on, off or status.');
}

export async function autoUpdateCommand(context: CliContext, args: string[]): Promise<void> {
  const parsed = parseAutoUpdateArgs(args);
  if (parsed.action === 'status') {
    const { autoUpdateStatusCommand } = await import('./lifecycle');
    autoUpdateStatusCommand(context);
    return;
  }
  if (parsed.action === 'off') {
    requirePm2(context, 'disable auto-update');
    deleteProcess(context, context.updaterProcessName);
    saveProcessList(context);
    console.log(cliText(context.locale, 'Auto-update desativado.', 'Auto-update disabled.'));
    return;
  }
  configuredUpdateSource(context.project);
  requirePm2(context, 'enable auto-update');
  startOrRestart(context, writeUpdaterEcosystem(context, parsed.schedule, parsed.includeBeta));
  saveProcessList(context);
  console.log(cliText(context.locale, `Auto-update ativado às ${parsed.schedule}.`, `Auto-update enabled at ${parsed.schedule}.`));
}
