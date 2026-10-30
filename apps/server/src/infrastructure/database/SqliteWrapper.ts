import initSqlJs, { Database as SqlJsDatabase, Statement } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { describeFailure, ServerResourceScope } from '../lifecycle/ServerResourceScope';

export interface DatabaseCloseOptions {
  discardChanges?: boolean;
}

export interface DatabaseOpenOptions {
  readOnly?: boolean;
}

export interface IDatabaseDriver {
  prepare(sql: string): {
    get(...params: any[]): any;
    all(...params: any[]): any[];
    run(...params: any[]): { changes: number; lastInsertRowid: number | bigint };
  };
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
  transactionAsync<T>(fn: () => Promise<T>): Promise<T>;
  pragma(pragmaStr: string): void;
  /**
   * Writable connections always enforce foreign keys; only the schema
   * migrations turn them off, as SQLite's table rebuilds require.
   */
  setForeignKeys(enabled: boolean): void;
  /** Persists pending changes now instead of at the end of the debounce. */
  flush(): void;
  close(options?: DatabaseCloseOptions): void;
}

export class SqlJsDriver implements IDatabaseDriver {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private inTransaction: number = 0;
  private isClosed: boolean = false;
  /** The file lacks changes the in-memory database has. */
  private dirty: boolean = false;
  /** The open transaction changed rows: they are persisted only if it commits. */
  private transactionWrote = false;
  private foreignKeys = true;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 3000;

  private constructor(dbPath: string, db: SqlJsDatabase, private readonly readOnly = false) {
    this.dbPath = dbPath;
    this.db = db;
  }

  public static async create(dbPath: string, options: DatabaseOpenOptions = {}): Promise<SqlJsDriver> {
    const SQL = await initSqlJs();
    const readOnly = options.readOnly === true;
    const dir = path.dirname(dbPath);
    if (!readOnly && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let db: SqlJsDatabase;
    if (readOnly || fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    const driver = new SqlJsDriver(dbPath, db, readOnly);
    const resources = new ServerResourceScope();
    resources.defer('SQLite allocation', () => driver.close({ discardChanges: true }));
    try {
      if (readOnly) {
        // get/all can also execute SQL with side effects, so SQLite enforces the snapshot.
        db.exec('PRAGMA query_only = ON;');
      } else {
        driver.applyForeignKeys();
        // A failed initial write must not publish an unpersisted database.
        driver.flushToDisk(true);
      }
      return driver;
    } catch (error) {
      return resources.fail(error);
    }
  }

  private assertWritable(): void {
    if (this.readOnly) throw new Error('Cannot modify a read-only database snapshot.');
  }

  /** Changed rows reach the file after the debounce, or when the open transaction commits. */
  private recordWrite(): void {
    if (this.inTransaction > 0) this.transactionWrote = true;
    else this.markDirty();
  }

  /**
   * Marks the in-memory database as needing persistence and schedules a
   * debounced flush. This avoids exporting and rewriting the entire database
   * file on every single write, which is prohibitively expensive with sql.js.
   */
  private markDirty(): void {
    if (this.isClosed) return;
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.isClosed || this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushToDisk();
    }, SqlJsDriver.SAVE_DEBOUNCE_MS);
  }

  /** Synchronously exports the in-memory database to disk if dirty. */
  private flushToDisk(throwOnError = false): void {
    if (this.isClosed || this.readOnly) {
      return;
    }
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!this.dirty && fs.existsSync(this.dbPath)) {
      return;
    }
    try {
      const data = this.db.export();
      try {
        this.writeSnapshot(data);
        this.dirty = false;
      } finally {
        // sql.js 1.14 closes and reopens the connection inside export(), which
        // resets every pragma; versions that keep it open make this a no-op (S-APP-1).
        this.applyForeignKeys();
      }
    } catch (e) {
      console.error('[DATABASE] Error persisting sqlite database to disk:', e);
      if (throwOnError) throw e;
    }
  }

  /** Applies the foreign key enforcement this driver promises and checks SQLite took it. */
  private applyForeignKeys(): void {
    const expected = this.foreignKeys ? 1 : 0;
    this.db.exec(`PRAGMA foreign_keys = ${expected};`);
    const [result] = this.db.exec('PRAGMA foreign_keys;');
    if (result?.values[0]?.[0] !== expected) {
      throw new Error(`SQLite did not ${expected ? 'enable' : 'disable'} foreign key enforcement.`);
    }
  }

  private writeSnapshot(data: Uint8Array): void {
    const temporaryPath = `${this.dbPath}.tmp-${randomUUID()}`;
    let created = false;
    try {
      const mode = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).mode & 0o777 : 0o666;
      const descriptor = fs.openSync(temporaryPath, 'wx', mode);
      created = true;
      let writeFailed = false;
      let writeError: unknown;
      try {
        fs.writeFileSync(descriptor, data);
        // The rename must not publish bytes still in the OS cache: a power loss
        // would leave a truncated or zeroed database in place of the old one.
        fs.fsyncSync(descriptor);
      } catch (error) {
        writeFailed = true;
        writeError = error;
        throw error;
      } finally {
        try {
          fs.closeSync(descriptor);
        } catch (closeError) {
          if (writeFailed) {
            throw new AggregateError([writeError, closeError], `Database snapshot failed: ${describeFailure(writeError)}; ${describeFailure(closeError)}`);
          }
          throw closeError;
        }
      }
      fs.renameSync(temporaryPath, this.dbPath);
      created = false;
    } catch (error) {
      if (created) {
        try {
          fs.unlinkSync(temporaryPath);
        } catch (cleanupError) {
          if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) {
            throw new AggregateError([error, cleanupError], `Database snapshot failed: ${describeFailure(error)}; temporary cleanup failed: ${describeFailure(cleanupError)}`);
          }
        }
      }
      throw error;
    }
  }

  public prepare(sql: string) {
    const db = this.db;
    const self = this;

    return {
      get(...params: any[]): any {
        const stmt: Statement = db.prepare(sql);
        try {
          if (params.length > 0) {
            stmt.bind(params);
          }
          if (stmt.step()) {
            return stmt.getAsObject();
          }
          return undefined;
        } finally {
          stmt.free();
        }
      },

      all(...params: any[]): any[] {
        const stmt: Statement = db.prepare(sql);
        const results: any[] = [];
        try {
          if (params.length > 0) {
            stmt.bind(params);
          }
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          return results;
        } finally {
          stmt.free();
        }
      },

      run(...params: any[]) {
        self.assertWritable();
        const stmt: Statement = db.prepare(sql);
        try {
          if (params.length > 0) {
            stmt.bind(params);
          }
          stmt.step();
          // run() only executes DML, so the count is this statement's own. One
          // that changed nothing must not rewrite the database file (S-APP-3).
          const changes = db.getRowsModified();
          if (changes > 0) self.recordWrite();
          return {
            changes,
            lastInsertRowid: 0,
          };
        } finally {
          stmt.free();
        }
      },
    };
  }

  /** Schema changes and scripts report no row count, so they are always persisted. */
  public exec(sql: string): void {
    this.assertWritable();
    this.db.exec(sql);
    this.recordWrite();
  }

  public transaction<T>(fn: () => T): () => T {
    const self = this;
    return () => {
      self.assertWritable();
      self.inTransaction++;
      if (self.inTransaction === 1) {
        self.transactionWrote = false;
        self.db.exec('BEGIN TRANSACTION;');
      }
      let committed = false;
      try {
        const result = fn();
        if (self.inTransaction === 1) {
          self.db.exec('COMMIT;');
          committed = true;
        }
        return result;
      } catch (err) {
        if (self.inTransaction === 1) {
          try {
            self.db.exec('ROLLBACK;');
          } catch (e) {}
        }
        throw err;
      } finally {
        self.inTransaction--;
        if (self.inTransaction === 0) {
          // Read-only and rolled-back transactions leave the file as it was (S-APP-3).
          if (committed && self.transactionWrote) self.markDirty();
          self.transactionWrote = false;
        }
      }
    };
  }

  public async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.assertWritable();
    if (this.inTransaction !== 0) {
      throw new Error('An asynchronous database transaction must own the outer transaction');
    }
    // Exporting sql.js while setup is awaiting work would end its transaction.
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.db.exec('BEGIN TRANSACTION;');
    this.inTransaction = 1;
    this.transactionWrote = false;
    let committed = false;
    try {
      const result = await fn();
      this.db.exec('COMMIT;');
      committed = true;
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Database setup failed: ${describeFailure(error)}. Rollback failed: ${describeFailure(rollbackError)}`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      this.inTransaction = 0;
      if (committed && this.transactionWrote) this.dirty = true;
      this.transactionWrote = false;
      // The flush cancelled above may still owe earlier changes to the file.
      if (this.dirty) this.scheduleFlush();
    }
  }

  public pragma(pragmaStr: string): void {
    this.assertWritable();
    try {
      this.db.exec(`PRAGMA ${pragmaStr};`);
    } catch (e) {
      // Ignore unsupported pragmas in WASM
    }
  }

  public setForeignKeys(enabled: boolean): void {
    this.assertWritable();
    // SQLite silently ignores the pragma inside a transaction.
    if (this.inTransaction > 0) throw new Error('Foreign key enforcement cannot change inside a transaction.');
    this.foreignKeys = enabled;
    this.applyForeignKeys();
  }

  public flush(): void {
    // An export would end the open transaction.
    if (this.inTransaction > 0) throw new Error('Cannot persist the database while a transaction is open.');
    this.flushToDisk(true);
  }

  public close(options: DatabaseCloseOptions = {}): void {
    if (this.isClosed) {
      return;
    }
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (!options.discardChanges) this.flushToDisk(true);
    this.db.close();
    this.isClosed = true;
  }
}
