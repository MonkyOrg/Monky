import initSqlJs, { Database as SqlJsDatabase, Statement } from 'sql.js';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'node:crypto';
import { describeFailure, ServerResourceScope } from '../lifecycle/ServerResourceScope';

export interface DatabaseCloseOptions {
  discardChanges?: boolean;
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
  close(options?: DatabaseCloseOptions): void;
}

export class SqlJsDriver implements IDatabaseDriver {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private inTransaction: number = 0;
  private isClosed: boolean = false;
  private dirty: boolean = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly SAVE_DEBOUNCE_MS = 3000;

  private constructor(dbPath: string, db: SqlJsDatabase) {
    this.dbPath = dbPath;
    this.db = db;
  }

  public static async create(dbPath: string): Promise<SqlJsDriver> {
    const SQL = await initSqlJs();
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let db: SqlJsDatabase;
    if (fs.existsSync(dbPath)) {
      const fileBuffer = fs.readFileSync(dbPath);
      db = new SQL.Database(fileBuffer);
    } else {
      db = new SQL.Database();
    }

    const driver = new SqlJsDriver(dbPath, db);
    const resources = new ServerResourceScope();
    resources.defer('SQLite allocation', () => driver.close({ discardChanges: true }));
    try {
      // A failed initial write must not publish an unpersisted database.
      driver.flushToDisk(true);
      return driver;
    } catch (error) {
      return resources.fail(error);
    }
  }

  /**
   * Marks the in-memory database as needing persistence and schedules a
   * debounced flush. This avoids exporting and rewriting the entire database
   * file on every single write, which is prohibitively expensive with sql.js.
   */
  private saveToDisk(): void {
    if (this.isClosed || this.inTransaction > 0) {
      return;
    }
    this.dirty = true;
    if (this.saveTimer === null) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        this.flushToDisk();
      }, SqlJsDriver.SAVE_DEBOUNCE_MS);
    }
  }

  /** Synchronously exports the in-memory database to disk if dirty. */
  private flushToDisk(throwOnError = false): void {
    if (this.isClosed) {
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
      const buffer = Buffer.from(data);
      this.writeSnapshot(buffer);
      this.dirty = false;
    } catch (e) {
      console.error('[DATABASE] Error persisting sqlite database to disk:', e);
      if (throwOnError) throw e;
    }
  }

  private writeSnapshot(buffer: Buffer): void {
    const temporaryPath = `${this.dbPath}.tmp-${randomUUID()}`;
    let created = false;
    try {
      const mode = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).mode & 0o777 : 0o666;
      const descriptor = fs.openSync(temporaryPath, 'wx', mode);
      created = true;
      let writeFailed = false;
      let writeError: unknown;
      try {
        fs.writeFileSync(descriptor, buffer);
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
        const stmt: Statement = db.prepare(sql);
        try {
          if (params.length > 0) {
            stmt.bind(params);
          }
          stmt.step();
          self.saveToDisk();
          return {
            changes: db.getRowsModified(),
            lastInsertRowid: 0,
          };
        } finally {
          stmt.free();
        }
      },
    };
  }

  public exec(sql: string): void {
    this.db.exec(sql);
    this.saveToDisk();
  }

  public transaction<T>(fn: () => T): () => T {
    const self = this;
    return () => {
      self.inTransaction++;
      if (self.inTransaction === 1) {
        self.db.exec('BEGIN TRANSACTION;');
      }
      try {
        const result = fn();
        if (self.inTransaction === 1) {
          self.db.exec('COMMIT;');
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
          self.saveToDisk();
        }
      }
    };
  }

  public async transactionAsync<T>(fn: () => Promise<T>): Promise<T> {
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
    let settled = false;
    try {
      const result = await fn();
      this.db.exec('COMMIT;');
      settled = true;
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
        settled = true;
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
      if (settled) this.saveToDisk();
    }
  }

  public pragma(pragmaStr: string): void {
    try {
      this.db.exec(`PRAGMA ${pragmaStr};`);
    } catch (e) {
      // Ignore unsupported pragmas in WASM
    }
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
