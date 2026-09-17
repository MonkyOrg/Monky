import fs from 'fs';
import path from 'path';
import { LIMITS } from '@monky/shared';
import { DatabaseConnection } from '../infrastructure/database/DatabaseConnection';
import type { DatabaseOpenOptions } from '../infrastructure/database/SqliteWrapper';
import {
  SqliteChannelRepository,
  SqliteRoleRepository,
  SqliteServerRepository,
  SqliteUserRepository,
} from '../infrastructure/database/SqliteRepositories';
import { ensureServerSeedData } from '../server';
import {
  DEFAULT_DATA_DIR,
  DEFAULT_DATA_INPUT,
  DEFAULT_SERVER_NAME,
  SERVER_DB_NAME,
} from './constants';
import { t } from './i18n/index';

export interface CliContext {
  dataDir: string;
  dbConn: DatabaseConnection;
  serverRepo: SqliteServerRepository;
  userRepo: SqliteUserRepository;
  roleRepo: SqliteRoleRepository;
}

export interface GlobalArgs {
  dataDir: string;
  dataDirSpecified: boolean;
  args: string[];
}

export interface LocalConfig {
  port?: number;
}

export function parseGlobalArgs(argv: string[]): GlobalArgs {
  const args: string[] = [];
  let dataDir = DEFAULT_DATA_DIR;
  let dataDirSpecified = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--data') {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(t('context.noPathAfterData'));
      }
      dataDir = path.resolve(value);
      dataDirSpecified = true;
      i++;
      continue;
    }
    args.push(arg);
  }

  return { dataDir, dataDirSpecified, args };
}

export function dataDbPath(dataDir: string): string {
  return path.join(dataDir, SERVER_DB_NAME);
}

export function dataConfigPath(dataDir: string): string {
  return path.join(dataDir, 'monky.json');
}

export function readLocalConfig(dataDir: string): LocalConfig {
  const configPath = dataConfigPath(dataDir);
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return {};
  }
}

export function writeLocalConfig(dataDir: string, config: LocalConfig): void {
  fs.writeFileSync(dataConfigPath(dataDir), JSON.stringify(config, null, 2), 'utf8');
}

export function formatDataDirForPrompt(dataDir: string): string {
  return dataDir === DEFAULT_DATA_DIR ? DEFAULT_DATA_INPUT : dataDir;
}

export function resolveInputPath(value: string): string {
  return path.resolve(value.trim() || DEFAULT_DATA_INPUT);
}

export function isHelpArg(value?: string): boolean {
  return value === 'help' || value === '--help' || value === '-h';
}

export async function withContext<T>(
  dataDir: string,
  fn: (ctx: CliContext) => Promise<T>,
  seed: boolean = true,
  options: DatabaseOpenOptions = {}
): Promise<T> {
  if (options.readOnly && seed) throw new Error('A read-only CLI context cannot seed server data.');
  const dbConn = await DatabaseConnection.create(dataDbPath(dataDir), options);
  const db = dbConn.getDb();
  const serverRepo = new SqliteServerRepository(db);
  const userRepo = new SqliteUserRepository(db);
  const channelRepo = new SqliteChannelRepository(db);
  const roleRepo = new SqliteRoleRepository(db);

  if (seed) {
    await ensureServerSeedData(
      {
        serverName: DEFAULT_SERVER_NAME,
        password: '',
        maxUsers: LIMITS.MAX_USERS_DEFAULT,
        initialTextChannel: 'geral',
        initialVoiceChannel: 'Geral',
      },
      serverRepo,
      channelRepo,
      roleRepo
    );
  }

  try {
    return await fn({ dataDir, dbConn, serverRepo, userRepo, roleRepo });
  } finally {
    dbConn.close();
  }
}
