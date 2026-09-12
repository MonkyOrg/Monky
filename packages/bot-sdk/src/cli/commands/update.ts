import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { runNpm } from '../../tooling/process';
import { DEFAULT_AUTOUPDATE_SCHEDULE } from '../constants';
import { createCliContext, readConfig, resolveInstalledEntry, type CliContext } from '../config';
import {
  deleteProcess,
  findProcess,
  requirePm2,
  saveProcessList,
  startOrRestart,
  writeBotEcosystem,
  writeUpdaterEcosystem,
} from '../pm2';
import { compareVersions } from '../updateReleases';
import { configuredUpdateSource, withUpdateCandidate } from '../updateSources';

function promptYesNo(question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} ${hint} `, (answer) => {
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
    throw new Error('Unknown update option. Use --beta, --check or --yes.');
  }
  return { includeBeta, checkOnly, assumeYes };
}

function requireGlobalInstall(context: CliContext): void {
  let globalRoot: string;
  try {
    globalRoot = runNpm(['root', '--global']).trim();
  } catch {
    throw new Error('Could not determine the active npm global prefix.');
  }
  const installedRoot = path.join(globalRoot, ...context.project.manifest.name.split('/'));
  if (!path.isAbsolute(globalRoot) || !fs.existsSync(installedRoot) ||
      fs.realpathSync(installedRoot) !== fs.realpathSync(context.packageRoot)) {
    throw new Error('Run update from the globally installed bot CLI. A source checkout or local npm installation supports update --check only.');
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
      throw new Error('The bot config or runtime directory is inside its installed package. Move it outside the package before updating to preserve the profile and keys.');
    }
  }
}

export async function updateCommand(context: CliContext, args: string[]): Promise<void> {
  configuredUpdateSource(context.project);
  const options = parseUpdateArgs(args);
  await withUpdateCandidate(context.project, options.includeBeta, async (latest) => {
    console.log(`Versão instalada: ${context.version}`);
    if (!latest) {
      console.log('Nenhuma release instalável encontrada no canal solicitado.');
      return;
    }
    const comparison = compareVersions(latest.version, context.version);
    if (comparison <= 0) {
      console.log(comparison === 0
        ? 'Você já está na versão mais recente desse canal.'
        : 'A release encontrada é mais antiga do que a instalada; downgrade bloqueado.');
      return;
    }
    console.log(`Nova versão disponível: ${latest.version}`);
    if (latest.htmlUrl) console.log(latest.htmlUrl);
    if (options.checkOnly) return;
    requireGlobalInstall(context);
    if (!options.assumeYes && !process.stdin.isTTY) {
      throw new Error('Use update --yes to install a release non-interactively, or --check to inspect it.');
    }
    if (!options.assumeYes && !(await promptYesNo(`Atualizar ${context.cliName} para ${latest.version}?`, true))) {
      console.log('Atualização cancelada.');
      return;
    }

    requireExternalRuntimeData(context);
    const wasRunning = findProcess(context)?.pm2_env?.status === 'online';
    await latest.withVerifiedArchive((file) => {
      try {
        runNpm(['install', '-g', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', file], {
          stdio: 'pipe',
          timeout: 300_000,
        });
      } catch {
        // npm diagnostics can contain environment credentials or authenticated registry URLs.
        throw new Error('The offline npm installation failed. The running bot was not restarted.');
      }
    });
    const refreshed = createCliContext(context.packageRoot);
    if (refreshed.version !== latest.version || refreshed.cliName !== context.cliName ||
        refreshed.project.manifest.name !== context.project.manifest.name) {
      throw new Error('npm completed, but the installed bot does not match the expected release. The running process was not restarted.');
    }
    console.log(`Atualizado para ${latest.version}.`);
    if (wasRunning) {
      const config = readConfig(refreshed);
      if (!config) throw new Error('The bot package was updated, but the config disappeared before the process could be restarted.');
      startOrRestart(refreshed, writeBotEcosystem(refreshed, resolveInstalledEntry(refreshed)));
      saveProcessList(refreshed);
      console.log('Processo reiniciado com a mesma configuração.');
    }
  });
}

function parseAutoUpdateArgs(args: string[]): { action: 'on' | 'off' | 'status'; schedule: string; includeBeta: boolean } {
  const action = args[0] ?? 'status';
  if (action === 'status' && args.length <= 1) {
    return { action, schedule: DEFAULT_AUTOUPDATE_SCHEDULE, includeBeta: false };
  }
  if (action === 'off') {
    if (args.length !== 1) throw new Error('autoupdate off does not accept extra options.');
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
      throw new Error('Unknown autoupdate option. Use HH:MM and/or --beta.');
    }
    return { action, schedule, includeBeta };
  }
  if (action === 'status' && args.length === 1) {
    return { action, schedule: DEFAULT_AUTOUPDATE_SCHEDULE, includeBeta: false };
  }
  throw new Error('Unknown autoupdate subcommand. Use on, off or status.');
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
    console.log('Auto-update desativado.');
    return;
  }
  configuredUpdateSource(context.project);
  requirePm2(context, 'enable auto-update');
  startOrRestart(context, writeUpdaterEcosystem(context, parsed.schedule, parsed.includeBeta));
  saveProcessList(context);
  console.log(`Auto-update ativado às ${parsed.schedule}.`);
}
