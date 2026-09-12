import { spawnSync } from 'node:child_process';
import { loadBotProject } from '../tooling/config';
import { DEFAULT_AUTOUPDATE_SCHEDULE } from './constants';
import { parseVersion } from './updateReleases';

export interface AutoUpdateSettings {
  packageRoot: string;
  updateCwd: string;
  updateArgs: string[];
  schedule: string;
  includeBeta: boolean;
}

function required(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function loadAutoUpdateSettings(env: NodeJS.ProcessEnv = process.env): AutoUpdateSettings {
  const updateArgsRaw = required('MONKY_BOT_CLI_UPDATE_ARGS', env);
  let updateArgs: unknown;
  try {
    updateArgs = JSON.parse(updateArgsRaw);
  } catch {
    throw new Error('MONKY_BOT_CLI_UPDATE_ARGS contains invalid JSON.');
  }
  if (!Array.isArray(updateArgs) || updateArgs.some((entry) => typeof entry !== 'string')) {
    throw new Error('MONKY_BOT_CLI_UPDATE_ARGS must be a JSON array of strings.');
  }
  const schedule = env.MONKY_BOT_CLI_SCHEDULE ?? DEFAULT_AUTOUPDATE_SCHEDULE;
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(schedule)) {
    throw new Error('MONKY_BOT_CLI_SCHEDULE must use HH:MM.');
  }
  return {
    packageRoot: required('MONKY_BOT_CLI_PACKAGE_ROOT', env),
    updateCwd: required('MONKY_BOT_CLI_UPDATE_CWD', env),
    updateArgs,
    schedule,
    includeBeta: env.MONKY_BOT_CLI_INCLUDE_BETA === 'true',
  };
}

export function msUntilNextRun(schedule: string, now = new Date()): number {
  const [hour, minute] = schedule.split(':').map(Number);
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function shouldIncludeBeta(installedVersion: string, explicit: boolean): boolean {
  const parsed = parseVersion(installedVersion);
  if (!parsed) throw new Error('Installed bot version is invalid.');
  return explicit || parsed.prerelease.length > 0;
}

export function runAutoUpdateOnce(settings: AutoUpdateSettings, env: NodeJS.ProcessEnv = process.env): void {
  const project = loadBotProject(settings.packageRoot);
  if (!project.definition.releases) {
    throw new Error('Auto-update is disabled because this bot no longer configures a GitHub Releases source.');
  }
  const includeBeta = shouldIncludeBeta(project.manifest.version, settings.includeBeta);
  const args = [...settings.updateArgs];
  if (includeBeta) args.push('--beta');
  const result = spawnSync(process.execPath, args, {
    cwd: settings.updateCwd,
    env,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Auto-update command failed with status ${result.status ?? result.signal}.`);
}

export function startAutoUpdateLoop(settings: AutoUpdateSettings, env: NodeJS.ProcessEnv = process.env): void {
  const scheduleNext = (): void => {
    const delay = msUntilNextRun(settings.schedule);
    setTimeout(() => {
      try {
        runAutoUpdateOnce(settings, env);
      } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : 'Auto-update failed.');
      }
      scheduleNext();
    }, delay);
  };
  scheduleNext();
}

if (require.main === module) {
  try {
    startAutoUpdateLoop(loadAutoUpdateSettings());
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : 'Auto-update bootstrap failed.');
    process.exitCode = 1;
  }
}
