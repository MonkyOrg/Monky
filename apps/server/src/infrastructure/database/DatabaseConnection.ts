import fs from 'fs';
import path from 'path';
import { Logger } from '../logger/Logger';
import { type DatabaseCloseOptions, IDatabaseDriver, SqlJsDriver } from './SqliteWrapper';
import { ServerResourceScope } from '../lifecycle/ServerResourceScope';

export class DatabaseConnection {
  private db: IDatabaseDriver;

  private constructor(db: IDatabaseDriver) {
    this.db = db;
  }

  public static async create(dbPath: string): Promise<DatabaseConnection> {
    const driver = await SqlJsDriver.create(dbPath);
    const resources = new ServerResourceScope();
    resources.defer('SQLite migrations', () => driver.close({ discardChanges: true }));
    // Note: sql.js runs entirely in-memory (WASM) and is persisted to disk via
    // a manual, debounced export. WAL journal_mode is therefore meaningless here
    // and would be silently ignored, so we do not set it. foreign_keys is still
    // requested to enforce referential integrity when supported by the build.
    try {
      driver.pragma('foreign_keys = ON');
      const conn = new DatabaseConnection(driver);
      conn.runMigrations();
      return conn;
    } catch (error) {
      return resources.fail(error);
    }
  }

  public getDb(): IDatabaseDriver {
    return this.db;
  }

  private runMigrations(): void {
    // Migration table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
    `);

    let migrationsDir = path.join(__dirname, 'migrations');
    if (!fs.existsSync(migrationsDir)) {
      migrationsDir = path.join(__dirname, '../../../src/infrastructure/database/migrations');
    }
    if (!fs.existsSync(migrationsDir)) {
      return;
    }

    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    const applied = new Set(
      (this.db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((r) => r.version)
    );

    const pending = files.filter((file) => !applied.has(file));
    if (pending.length === 0) return;

    // Disable foreign key enforcement while applying migrations. Some migrations
    // recreate tables (the SQLite-recommended way to alter constraints), and a
    // DROP TABLE with foreign keys enabled would cascade-delete dependent rows.
    // PRAGMA foreign_keys is a no-op inside a transaction, so it must be toggled
    // here, outside of the per-migration transactions below.
    this.db.pragma('foreign_keys = OFF');
    try {
      for (const file of pending) {
        Logger.info('DATABASE', `Applying migration ${file}`);
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        this.db.transaction(() => {
          this.db.exec(sql);
          this.db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(file, Date.now());
        })();
        Logger.info('DATABASE', `Migration ${file} applied successfully`);
      }
    } finally {
      this.db.pragma('foreign_keys = ON');
    }
  }

  public close(options?: DatabaseCloseOptions): void {
    this.db.close(options);
  }
}
