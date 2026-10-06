import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { buildClientNotes, getClientNotesInRange } from './generate-changelog.js';

export function requiresClientNote(file) {
  if (/^(?:package(?:-lock)?\.json$|patches\/)/.test(file)) return true;
  if (!/^(?:apps|packages)\//.test(file)) return false;
  if (/\.(?:md|mdx)$/i.test(file)) return false;
  if (/(?:^|\/)(?:test(?:s|-[^/]+)?|__tests__|__fixtures__|fixtures|docs|coverage)(?:\/|$)/.test(file)) return false;
  if (/(?:^|\/)test[-.]|[.-](?:test|spec)\.[^/]+$/.test(file)) return false;
  return true;
}

function readGit(args) {
  return execFileSync('git', ['--no-pager', ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function checkClientReleaseNotes({ base, head = 'HEAD', mergeBase = false }, git = readGit) {
  if (typeof base !== 'string' || !head.trim()) {
    throw new Error('Provide --base <commit/tag> and --head <commit/tag>. An empty base is only for the first release.');
  }
  const revision = git(['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`]).trim();
  let start = base ? git(['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]).trim() : '';
  if (mergeBase) {
    if (!start) throw new Error('A pull request check requires a base commit.');
    start = git(['merge-base', start, revision]).trim();
  }
  const files = git(start
    ? ['diff', '--no-renames', '--name-only', '-z', start, revision, '--']
    : ['ls-tree', '-r', '--name-only', '-z', revision])
    .split('\0').filter(Boolean);
  const changed = files.filter(requiresClientNote);
  const notes = getClientNotesInRange(start, git, revision);
  buildClientNotes(notes);
  if (changed.length > 0 && notes.length === 0) {
    throw new Error(
      `Missing client release notes for ${changed.length} application/dependency file(s): ${changed.slice(0, 8).join(', ')}. ` +
      'Add a NEW release-notes/*.json file with group, pt-BR and en, describing the user-visible change. ' +
      'Editing an old note or adding only a technical commit description does not count. See CONTRIBUTING.md.',
    );
  }
  return { changed, notes: notes.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        base: { type: 'string' },
        head: { type: 'string', default: 'HEAD' },
        'merge-base': { type: 'boolean', default: false },
      },
    });
    const result = checkClientReleaseNotes({
      base: values.base, head: values.head, mergeBase: values['merge-base'],
    });
    console.log(`[Changelog] ${result.changed.length} application/dependency file(s), ${result.notes} new bilingual note(s).`);
  } catch (error) {
    console.error(`[Changelog] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
