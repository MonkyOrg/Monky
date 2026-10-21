import type { HostedUpdateServer } from '@monky/shared';
import { DatabaseConnection } from './DatabaseConnection';
import type { IDatabaseDriver } from './SqliteWrapper';

export function readUpdateInventory(db: IDatabaseDriver): Omit<HostedUpdateServer, 'serverId'> {
  const meta: unknown = db.prepare('SELECT name FROM server_meta LIMIT 1').get();
  if (!meta || typeof meta !== 'object' || !('name' in meta) || typeof meta.name !== 'string') {
    throw new Error('Local server metadata is unavailable.');
  }
  const columns: unknown[] = db.prepare('PRAGMA table_info(bots)').all();
  const hasProtocol = columns.some(column =>
    !!column && typeof column === 'object' && 'name' in column && column.name === 'last_protocol_version');
  const rows: unknown[] = columns.length
    ? db.prepare(`SELECT id, name, ${hasProtocol ? 'last_protocol_version' : 'NULL'} AS protocol FROM bots`).all()
    : [];
  const bots = rows.map(row => {
    if (!row || typeof row !== 'object' || !('id' in row) || typeof row.id !== 'string' ||
        !('name' in row) || typeof row.name !== 'string' || !('protocol' in row) ||
        (row.protocol !== null && (typeof row.protocol !== 'number' || !Number.isSafeInteger(row.protocol) || row.protocol < 1))) {
      throw new Error('Invalid local bot compatibility record.');
    }
    return { id: row.id, name: row.name, protocolVersion: row.protocol };
  });
  return { serverName: meta.name, bots };
}

export async function readStoredUpdateInventory(dbPath: string): Promise<Omit<HostedUpdateServer, 'serverId'>> {
  const connection = await DatabaseConnection.create(dbPath, { readOnly: true });
  try {
    return readUpdateInventory(connection.getDb());
  } finally {
    connection.close();
  }
}
