import fs from 'fs';
import path from 'path';
import { LIMITS } from '@monky/shared';
import { DatabaseConnection } from '../infrastructure/database/DatabaseConnection';
import type { DatabaseOpenOptions, IDatabaseDriver } from '../infrastructure/database/SqliteWrapper';
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
import { t, getCliLanguage } from './i18n/index';
import { assertServerStopped, findRunningServer } from './runningServer';

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

async function openContext(dataDir: string, options: DatabaseOpenOptions): Promise<CliContext> {
  const dbConn = await DatabaseConnection.create(dataDbPath(dataDir), options);
  const db = dbConn.getDb();
  return {
    dataDir,
    dbConn,
    serverRepo: new SqliteServerRepository(db),
    userRepo: new SqliteUserRepository(db),
    roleRepo: new SqliteRoleRepository(db),
  };
}

async function seedContext(ctx: CliContext): Promise<void> {
  try {
    await ensureServerSeedData(
      {
        serverName: DEFAULT_SERVER_NAME,
        password: '',
        maxUsers: LIMITS.MAX_USERS_DEFAULT,
        initialTextChannel: 'geral',
        initialVoiceChannel: 'Geral',
        categoryLocale: getCliLanguage(),
      },
      ctx.serverRepo,
      new SqliteChannelRepository(ctx.dbConn.getDb()),
      ctx.roleRepo
    );
  } catch (error) {
    ctx.dbConn.close({ discardChanges: true });
    throw error;
  }
}

export async function withContext<T>(
  dataDir: string,
  fn: (ctx: CliContext) => Promise<T>,
  seed: boolean = true,
  options: DatabaseOpenOptions = {}
): Promise<T> {
  if (options.readOnly && seed) throw new Error('A read-only CLI context cannot seed server data.');
  const ctx = await openContext(dataDir, options);
  if (seed) await seedContext(ctx);

  try {
    return await fn(ctx);
  } finally {
    ctx.dbConn.close();
  }
}

/**
 * Database writes for a server that must be stopped.
 *
 * A running server keeps the whole database in memory and rewrites the file
 * from it, so a change saved here would vanish within seconds. The command
 * runs inside one transaction: sql.js then skips its own save timer, so
 * nothing reaches `server.db` while an interactive command waits, a failed
 * command saves nothing at all, and the check runs again right before the
 * only save, in case the server started in the meantime.
 */
export async function withWritableContext<T>(dataDir: string, fn: (ctx: CliContext) => Promise<T>): Promise<T> {
  assertServerStopped(dataDir);
  const ctx = await openContext(dataDir, {});
  await seedContext(ctx);
  let saved = false;
  try {
    const result = await ctx.dbConn.getDb().transactionAsync(() => fn(ctx));
    if (findRunningServer(dataDir)) throw new Error(t('guard.startedDuringCommand'));
    ctx.dbConn.close();
    saved = true;
    return result;
  } finally {
    if (!saved) ctx.dbConn.close({ discardChanges: true });
  }
}

/** Migration files shipped with this build, found the way the server finds them. */
function bundledMigrations(): string[] {
  const databaseDir = path.join(__dirname, '..', 'infrastructure', 'database');
  for (const directory of [
    path.join(databaseDir, 'migrations'),
    path.join(databaseDir, '..', '..', '..', 'src', 'infrastructure', 'database', 'migrations'),
  ]) {
    if (fs.existsSync(directory)) return fs.readdirSync(directory).filter((file) => file.endsWith('.sql'));
  }
  return [];
}

/** Versions in the migration ledger; empty when the database predates it. */
export function appliedMigrations(db: IDatabaseDriver): Set<string> {
  const applied = new Set<string>();
  const ledger: unknown = db.prepare(
    "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'"
  ).get();
  if (!ledger) return applied;
  for (const row of db.prepare('SELECT version FROM schema_migrations').all()) {
    const entry: unknown = row;
    if (entry && typeof entry === 'object' && 'version' in entry && typeof entry.version === 'string') {
      applied.add(entry.version);
    }
  }
  return applied;
}

function hasPendingMigrations(db: IDatabaseDriver): boolean {
  const applied = appliedMigrations(db);
  return bundledMigrations().some((file) => !applied.has(file));
}

/** A starting server saves its upgraded database a few seconds after it opens it. Tests shorten these. */
export const snapshotTiming = { upgradeWaitMs: 6_000, pollMs: 250 };

async function waitForUpgradedSnapshot(dataDir: string): Promise<CliContext> {
  const deadline = Date.now() + snapshotTiming.upgradeWaitMs;
  while (Date.now() < deadline) {
    await new Promise<void>((resolve) => setTimeout(resolve, snapshotTiming.pollMs));
    const ctx = await openContext(dataDir, { readOnly: true });
    if (!hasPendingMigrations(ctx.dbConn.getDb())) return ctx;
    ctx.dbConn.close();
  }
  throw new Error(t('guard.outdatedSchemaRunning'));
}

/**
 * Snapshot for commands that only show data: it never writes `server.db`, so
 * reading cannot replace a newer file saved by a running server.
 *
 * A database older than this CLI is upgraded first, but only while no server
 * holds it. A running server either has just started and is about to save the
 * upgraded file, or still runs the previous version.
 */
export async function withReadOnlyContext<T>(dataDir: string, fn: (ctx: CliContext) => Promise<T>): Promise<T> {
  let ctx = await openContext(dataDir, { readOnly: true });
  try {
    if (hasPendingMigrations(ctx.dbConn.getDb())) {
      ctx.dbConn.close();
      if (findRunningServer(dataDir)) {
        ctx = await waitForUpgradedSnapshot(dataDir);
      } else {
        (await DatabaseConnection.create(dataDbPath(dataDir))).close();
        ctx = await openContext(dataDir, { readOnly: true });
      }
    }
    return await fn(ctx);
  } finally {
    ctx.dbConn.close();
  }
}
