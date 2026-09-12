import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readConfigFile, type BotConfig } from './config';
import { loadBotKeys } from './keys';

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
  inheritedEnv: NodeJS.ProcessEnv = process.env
): RuntimeEnvironmentPlan {
  const values: Record<string, string> = {
    MONKY_BOT_PUBLIC_KEY: publicKeyHex,
    MONKY_BOT_NAME: config.botName,
  };
  if (config.mode === 'manual') {
    const token = inheritedEnv[config.tokenEnv];
    if (typeof token !== 'string' || !token.trim()) {
      throw new Error(`Missing required environment variable ${config.tokenEnv} for manual mode.`);
    }
    values.MONKY_SERVER_URL = config.serverUrl;
    values.MONKY_BOT_TOKEN = token;
    return { values, clear: ['MONKY_SERVE', 'MONKY_SERVE_PORT', 'MONKY_SERVE_PUBLIC_HOST'] };
  }
  values.MONKY_SERVE = 'true';
  values.MONKY_SERVE_PORT = String(config.servePort);
  values.MONKY_SERVE_PUBLIC_HOST = config.publicHost;
  return { values, clear: ['MONKY_SERVER_URL', 'MONKY_BOT_TOKEN'] };
}

export async function runConfiguredBot(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const configFile = requiredEnvironmentValue('MONKY_BOT_CLI_CONFIG_FILE', env);
  const entry = path.resolve(requiredEnvironmentValue('MONKY_BOT_CLI_ENTRY', env));
  const config = readConfigFile(configFile);
  const { publicKeyHex } = loadBotKeys(config.botDir);
  const plan = createRuntimeEnvironment(config, publicKeyHex, env);

  process.chdir(config.botDir);
  process.argv[1] = entry;
  for (const key of plan.clear) delete process.env[key];
  Object.assign(process.env, plan.values);
  await dynamicImport(pathToFileURL(entry).href);
}

if (require.main === module) {
  void runConfiguredBot().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Bot runner failed.');
    process.exitCode = 1;
  });
}
