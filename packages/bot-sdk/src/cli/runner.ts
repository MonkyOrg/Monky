import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeBotLocale } from '@monky/shared';
import { defaultBotName, readConfigFile, type BotConfig } from './config';
import { assertHostConsent } from './consent';
import { keyPaths, loadBotKeys } from './keys';
import { cliErrorMessage } from './locale';
import { profileRuntimeValues, readProfileEnvironment } from './profileEnvironment';
import { createReachabilityIdentity, setRuntimeBotIdentity } from '../reachability';
import { loadBotProject, type BotProject } from '../tooling/config';

export interface RuntimeEnvironmentPlan {
  values: Record<string, string>;
  clear: string[];
}

const dynamicImport = new Function('file', 'return import(file);') as (file: string) => Promise<unknown>;

function requiredEnvironmentValue(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (typeof value !== 'string' || !value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export function createRuntimeEnvironment(
  config: BotConfig,
  publicKeyHex: string,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
  profileValues: Record<string, string> = {},
): RuntimeEnvironmentPlan {
  const values: Record<string, string> = {
    ...profileValues,
    MONKY_BOT_PUBLIC_KEY: publicKeyHex,
    MONKY_BOT_NAME: config.botName,
  };
  if (config.mode === 'manual') {
    const token = config.botToken === undefined ? inheritedEnv[config.tokenEnv] : config.botToken;
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error(`Missing required environment variable ${config.tokenEnv} for manual mode.`);
    }
    values.MONKY_SERVER_URL = config.serverUrl;
    values.MONKY_BOT_TOKEN = token;
    return {
      values,
      clear: ['MONKY_SERVE', 'MONKY_SERVE_PORT', 'MONKY_SERVE_HOST', 'MONKY_SERVE_PUBLIC_HOST', 'MONKY_BOT_REGISTRATION_FILE'],
    };
  }
  values.MONKY_SERVE = 'true';
  values.MONKY_SERVE_PORT = String(config.servePort);
  values.MONKY_SERVE_PUBLIC_HOST = config.publicHost;
  values.MONKY_BOT_REGISTRATION_FILE = keyPaths(config.botDir).registrationsFile;
  return { values, clear: ['MONKY_SERVER_URL', 'MONKY_BOT_TOKEN'] };
}

/** Finds the installed bot package; ecosystems written before 37 do not name it. */
function runtimeProject(entry: string, env: NodeJS.ProcessEnv): BotProject {
  if (env.MONKY_BOT_CLI_PACKAGE_ROOT) return loadBotProject(env.MONKY_BOT_CLI_PACKAGE_ROOT);
  let directory = path.dirname(entry);
  for (let depth = 0; depth < 6; depth++) {
    if (fs.existsSync(path.join(directory, 'package.json'))) {
      try {
        const project = loadBotProject(directory);
        const relative = path.relative(project.root, fs.realpathSync(entry));
        if (relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) return project;
      } catch {
        // A nested package.json (e.g. dist/package.json) is not the bot package.
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('The installed bot package could not be located from its entry.');
}

export async function runConfiguredBot(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configFile = requiredEnvironmentValue('MONKY_BOT_CLI_CONFIG_FILE', env);
  const entry = path.resolve(requiredEnvironmentValue('MONKY_BOT_CLI_ENTRY', env));
  const project = runtimeProject(entry, env);
  const config = readConfigFile(configFile, { botName: defaultBotName({ displayName: project.definition.displayName }) });
  const homeDir = path.dirname(configFile);
  assertHostConsent(homeDir, config.botDir, project.definition, project.definition.cliName, env);
  const keys = loadBotKeys(config.botDir);
  const plan = createRuntimeEnvironment(config, keys.publicKeyHex, env,
    profileRuntimeValues(project.definition.requirements, readProfileEnvironment(homeDir), env));
  setRuntimeBotIdentity(createReachabilityIdentity(keys.publicKeyHex, keys.privateKeyPem));

  process.chdir(config.botDir);
  process.argv[1] = entry;
  for (const key of plan.clear) delete process.env[key];
  Object.assign(process.env, plan.values);
  await dynamicImport(pathToFileURL(entry).href);
}

if (require.main === module) {
  void runConfiguredBot().catch((error: unknown) => {
    console.error(cliErrorMessage(error, normalizeBotLocale(process.env.MONKY_BOT_LOCALE) ?? 'pt-BR') || 'Bot runner failed.');
    process.exitCode = 1;
  });
}
