export const CLIENT_NOTE_GROUPS = ['novidades', 'correcoes', 'outros'] as const;
export type ClientNoteGroup = typeof CLIENT_NOTE_GROUPS[number];
export interface LocalizedClientNote {
  'pt-BR': string;
  en: string;
}

export type ClientReleaseNotes =
  | { kind: 'curated'; groups: Record<ClientNoteGroup, LocalizedClientNote[]> }
  | { kind: 'legacy'; counts: Record<ClientNoteGroup, number> }
  | { kind: 'empty' }
  | { kind: 'invalid' };

const MARKER_PREFIX = '<!-- monky-client-notes:';
const MARKER = `${MARKER_PREFIX}v1\n`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNoteText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 280 &&
    !/[\r\n<>`]|#\d+|https?:\/\/|\[[^\]]+\]\(/i.test(value);
}

/** A present but malformed payload must never fall through to technical text. */
export function parseClientReleaseNotes(body: string): ClientReleaseNotes {
  if (body.length > 200_000) return { kind: 'invalid' };
  const normalized = body.replace(/\r\n/g, '\n');
  const start = normalized.indexOf(MARKER_PREFIX);
  if (start < 0) return summarizeLegacyNotes(normalized);
  const end = normalized.indexOf('-->', start);
  if (!normalized.startsWith(MARKER, start) || end < 0 ||
      normalized.indexOf(MARKER_PREFIX, start + MARKER_PREFIX.length) >= 0) {
    return { kind: 'invalid' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(normalized.slice(start + MARKER.length, end).trim());
  } catch {
    return { kind: 'invalid' };
  }
  if (!isRecord(payload) || payload.schemaVersion !== 1 || !isRecord(payload.groups) ||
      Object.keys(payload.groups).some((key) => !CLIENT_NOTE_GROUPS.some((group) => group === key))) {
    return { kind: 'invalid' };
  }
  const groups: Record<ClientNoteGroup, LocalizedClientNote[]> = { novidades: [], correcoes: [], outros: [] };
  for (const group of CLIENT_NOTE_GROUPS) {
    const entries: unknown = payload.groups[group];
    if (!Array.isArray(entries) || entries.length > 100) return { kind: 'invalid' };
    for (const entry of entries) {
      if (!isRecord(entry) || !isNoteText(entry['pt-BR']) || !isNoteText(entry.en)) return { kind: 'invalid' };
      groups[group].push({ 'pt-BR': entry['pt-BR'].trim(), en: entry.en.trim() });
    }
  }
  return CLIENT_NOTE_GROUPS.some((group) => groups[group].length > 0)
    ? { kind: 'curated', groups }
    : { kind: 'empty' };
}

/**
 * Published releases cannot be retroactively translated. Only report their
 * recorded group counts, explicitly labelled as a summary in the UI; never
 * pretend that stripping "#123" makes an arbitrary commit user-friendly.
 */
function summarizeLegacyNotes(body: string): ClientReleaseNotes {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => /^(#{2,4})\s+Changelog\s*$/i.test(line));
  if (start < 0) return { kind: 'empty' };
  const sectionDepth = /^#+/.exec(lines[start])?.[0].length ?? 3;
  const entries: Record<ClientNoteGroup, Set<string>> = {
    novidades: new Set(), correcoes: new Set(), outros: new Set(),
  };
  let group: ClientNoteGroup | null = 'outros';
  let inCode = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      if (heading[1].length <= sectionDepth) break;
      const label = heading[2].normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
      group = /\b(novidades|features|what's new)\b/.test(label) ? 'novidades'
        : /\b(correcoes|fixes)\b/.test(label) ? 'correcoes'
          : /\b(outros|other)\b/.test(label) ? 'outros' : null;
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (group && bullet && !/^\*\*(?:Compara[çc][ãa]o completa|Full Changelog)\*\*/i.test(bullet[1])) {
      entries[group].add(bullet[1].trim());
    }
  }
  const counts = { novidades: entries.novidades.size, correcoes: entries.correcoes.size, outros: entries.outros.size };
  return CLIENT_NOTE_GROUPS.some((key) => counts[key] > 0) ? { kind: 'legacy', counts } : { kind: 'empty' };
}
