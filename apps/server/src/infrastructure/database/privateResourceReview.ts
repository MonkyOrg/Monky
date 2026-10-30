import { Logger } from '../logger/Logger';
import type { IDatabaseDriver } from './SqliteWrapper';

export const FOREIGN_KEY_INTEGRITY_MIGRATION = '057_foreign_key_integrity.sql';

const MAX_LISTED = 200;

const KINDS = new Map<unknown, string>([
  ['event', 'Evento / Event'],
  ['native_form', 'Formulário / Form'],
  ['live_action', 'Ação ao vivo / Live action'],
]);

interface PrivateResourceRow {
  kind: unknown;
  title: unknown;
  location: unknown;
  channel: unknown;
  timestampMs: unknown;
}

function oneLine(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/\s+/g, ' ').trim().slice(0, 200);
  return text || fallback;
}

function describe(row: PrivateResourceRow): string {
  const kind = KINDS.get(row.kind) ?? '?';
  // The label of an external location is free text, possibly an address: it is not logged.
  const place = row.location === 'external' ? 'local externo / external location'
    : typeof row.channel === 'string' ? `#${oneLine(row.channel, '?')}` : 'canal removido / deleted channel';
  const date = new Date(typeof row.timestampMs === 'number' ? row.timestampMs : Number.NaN);
  const when = Number.isNaN(date.getTime()) ? '?' : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
  return `- ${kind} "${oneLine(row.title, 'sem título / untitled')}" · ${place} · ${when}`;
}

/**
 * Lists the private events, forms and live actions for the owner to review,
 * once, when the foreign key repair runs. Before it, editing an audience left
 * the removed people's rows behind, and an event that later started, ended or
 * repeated wrote them back into its saved record: nothing stored tells such a
 * row apart from a real choice (S-APP-2). Only names, channels and dates are
 * logged, never who was selected.
 */
export function logPrivateResourcesToReview(db: IDatabaseDriver): void {
  try {
    const rows: PrivateResourceRow[] = db.prepare(`
      SELECT 'event' AS kind, 0 AS position,
        CASE WHEN json_valid(e.snapshot) THEN json_extract(e.snapshot, '$.title') END AS title,
        CASE WHEN json_valid(e.snapshot) THEN json_extract(e.snapshot, '$.location.kind') END AS location,
        c.name AS channel, e.starts_at AS timestampMs
      FROM server_events e
      JOIN community_resource_audiences a ON a.resource_type = 'event' AND a.resource_id = e.id
      LEFT JOIN channels c ON c.id = CASE WHEN json_valid(e.snapshot) THEN json_extract(e.snapshot, '$.location.channelId') END
      UNION ALL
      SELECT 'native_form', 1, CASE WHEN json_valid(f.snapshot) THEN json_extract(f.snapshot, '$.form.title') END,
        'channel', c.name, f.expires_at
      FROM native_live_forms f
      JOIN community_resource_audiences a ON a.resource_type = 'native_form' AND a.resource_id = f.id
      LEFT JOIN channels c ON c.id = f.channel_id
      UNION ALL
      SELECT 'live_action', 2, CASE WHEN json_valid(l.snapshot) THEN json_extract(l.snapshot, '$.title') END,
        'channel', c.name, l.expires_at
      FROM bot_live_actions l
      JOIN community_resource_audiences a ON a.resource_type = 'live_action' AND a.resource_id = l.id
      LEFT JOIN channels c ON c.id = l.channel_id
      ORDER BY position, timestampMs`).all();
    if (rows.length === 0) return;
    Logger.warn('DATABASE', 'Revise quem pode ver estes eventos, formulários e ações ao vivo privados: alguém tirado do público antes desta versão pode ter mantido o acesso.');
    Logger.warn('DATABASE', 'Review who can see these private events, forms and live actions: someone removed from their audience before this version may have kept access.');
    for (const row of rows.slice(0, MAX_LISTED)) Logger.warn('DATABASE', describe(row));
    const hidden = rows.length - MAX_LISTED;
    if (hidden > 0) Logger.warn('DATABASE', `Mais ${hidden} não listados. / ${hidden} more not listed.`);
  } catch (error) {
    // The list only helps the owner review: it never stands in the way of starting.
    Logger.error('DATABASE', 'Não foi possível listar os recursos privados. / Could not list the private resources.', error);
  }
}
