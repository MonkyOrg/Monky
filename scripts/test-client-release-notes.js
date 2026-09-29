import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { checkClientReleaseNotes, requiresClientNote } from './check-client-release-notes.js';

const script = fileURLToPath(new URL('./check-client-release-notes.js', import.meta.url));
const note = { group: 'correcoes', 'pt-BR': 'O som voltou ao lugar.', en: 'Sound is back where it belongs.' };
const app = 'apps/client/src/player.ts';
const fresh = 'release-notes/new-note.json';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'monky-client-notes-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (args) => execFileSync('git', ['--no-pager', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (file, value) => {
    mkdirSync(dirname(join(cwd, file)), { recursive: true });
    writeFileSync(join(cwd, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const commit = () => {
    git(['add', '.']);
    git(['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fix: a technical description is not a client note']);
    return git(['rev-parse', 'HEAD']).trim();
  };
  git(['init', '--quiet', '-b', 'main']);
  git(['config', 'user.name', 'Release notes test']);
  git(['config', 'user.email', 'release-notes@example.invalid']);
  git(['config', 'core.hooksPath', join(cwd, '.git', 'empty-hooks')]);
  write(app, 'export const sound = 1;\n');
  write('release-notes/old-note.json', note);
  const base = commit();
  return { cwd, git, write, commit, base };
}

test('application code, assets, native code, dependencies and patches require notes', () => {
  for (const file of [
    app, 'apps/server/src/cli/main.ts', 'packages/bot-sdk/src/index.ts',
    'packages/shared/src/ipc.ts', 'apps/client/native/screen-share/runtime/textureTransfer.cjs',
    'apps/client/native/screen-audio/src/capture.cpp', 'apps/light/src/main.cpp',
    'apps/client/src/renderer/style.css', 'apps/client/assets/icon.png',
    'apps/client/package.json', 'package.json', 'package-lock.json', 'patches/electron.patch',
  ]) assert.equal(requiresClientNote(file), true, file);
});

test('documentation, tests, fixtures and infrastructure alone do not invent highlights', () => {
  for (const file of [
    'CONTRIBUTING.md', 'docs-site/guide.md', 'apps/client/README.en.md',
    'apps/client/test/playout.test.cjs', 'apps/client/test-browser/smoke.cjs',
    'apps/server/src/test-voice.ts', 'packages/bot-sdk/src/voice.spec.ts',
    'packages/shared/src/__tests__/voice.ts', 'apps/server/tests/voice.ts',
    'apps/client/fixtures/tone.wav', 'packages/shared/__fixtures__/data.json',
    'scripts/test-native-ci.js', '.github/workflows/ci.yml', fresh,
  ]) assert.equal(requiresClientNote(file), false, file);
});

test('missing notes fail even with technical commits and existing historical notes', (t) => {
  const f = fixture(t);
  f.write(app, 'export const sound = 2;\n');
  f.commit();
  assert.throws(() => checkClientReleaseNotes({ base: f.base }, f.git), /Missing client release notes.*player\.ts/);
});

test('a new bilingual fragment passes and uses the requested commit, not checkout HEAD', (t) => {
  const f = fixture(t);
  f.write(app, 'export const sound = 2;\n');
  f.write(fresh, note);
  const head = f.commit();
  f.git(['checkout', '--quiet', f.base]);
  assert.deepEqual(checkClientReleaseNotes({ base: f.base, head }, f.git), { changed: [app], notes: 1 });
});

test('editing an old note and an uncommitted new note cannot satisfy the release range', (t) => {
  const f = fixture(t);
  f.write(app, 'export const sound = 2;\n');
  f.write('release-notes/old-note.json', { ...note, en: 'Updated old note.' });
  f.commit();
  f.write(fresh, note);
  assert.throws(() => checkClientReleaseNotes({ base: f.base }, f.git), /Missing client release notes/);
});

for (const [name, value] of [
  ['missing English', { group: 'correcoes', 'pt-BR': note['pt-BR'] }],
  ['invalid JSON', '{'],
  ['empty text', { ...note, en: '' }],
  ['technical references', { ...note, en: 'Fix #732: audio.' }],
]) {
  test(`new notes reject ${name}, including notes-only PRs`, (t) => {
    const f = fixture(t);
    f.write(fresh, value);
    f.commit();
    assert.throws(() => checkClientReleaseNotes({ base: f.base }, f.git), /release-notes\/new-note\.json/);
  });
}

test('deleting runtime code still requires a note', (t) => {
  const f = fixture(t);
  f.git(['rm', app]);
  f.commit();
  assert.throws(() => checkClientReleaseNotes({ base: f.base }, f.git), /Missing client release notes/);
});

test('the gate enforces the same aggregate payload limit as the release generator', (t) => {
  const f = fixture(t);
  for (let index = 0; index <= 100; index++) {
    f.write(`release-notes/note-${index}.json`, { ...note, en: `${note.en} ${index}` });
  }
  f.commit();
  assert.throws(() => checkClientReleaseNotes({ base: f.base }, f.git), /at most 100 entries per group/);
});

test('documentation and test-only ranges pass without a fragment', (t) => {
  const f = fixture(t);
  f.write('apps/client/test/player.test.cjs', 'test;\n');
  f.write('apps/client/README.md', '# Player\n');
  f.commit();
  assert.deepEqual(checkClientReleaseNotes({ base: f.base }, f.git), { changed: [], notes: 0 });
});

test('the PR merge base excludes changes newly added to main', (t) => {
  const f = fixture(t);
  f.git(['checkout', '--quiet', '-b', 'pr']);
  f.write('CONTRIBUTING.md', '# Docs\n');
  const head = f.commit();
  f.git(['checkout', '--quiet', 'main']);
  f.write('apps/server/src/feature.ts', 'export {};\n');
  const base = f.commit();
  assert.deepEqual(checkClientReleaseNotes({ base, head, mergeBase: true }, f.git), { changed: [], notes: 0 });
});

test('a stale PR cannot borrow a release note newly merged into main', (t) => {
  const f = fixture(t);
  f.git(['checkout', '--quiet', '-b', 'pr']);
  f.write(app, 'export const sound = 2;\n');
  const head = f.commit();
  f.git(['checkout', '--quiet', 'main']);
  f.write(fresh, note);
  const base = f.commit();
  assert.throws(() => checkClientReleaseNotes({ base, head, mergeBase: true }, f.git), /Missing client release notes/);
});

test('the first release checks all tracked application files and notes', (t) => {
  const f = fixture(t);
  assert.deepEqual(checkClientReleaseNotes({ base: '' }, f.git), { changed: [app], notes: 1 });
  f.git(['rm', 'release-notes/old-note.json']);
  f.commit();
  assert.throws(() => checkClientReleaseNotes({ base: '' }, f.git), /Missing client release notes/);
});

test('empty release ranges pass, while missing context and git failures are explicit errors', (t) => {
  const f = fixture(t);
  assert.deepEqual(checkClientReleaseNotes({ base: f.base }, f.git), { changed: [], notes: 0 });
  assert.throws(() => checkClientReleaseNotes({}, f.git), /Provide --base/);
  assert.throws(() => checkClientReleaseNotes({ base: '', mergeBase: true }, f.git), /requires a base commit/);
  assert.throws(() => checkClientReleaseNotes({ base: 'missing-tag' }, f.git));
  assert.throws(() => checkClientReleaseNotes({ base: f.base, head: 'missing-head' }, f.git));
});

test('the CLI returns failure for missing notes/context and success for valid notes', (t) => {
  const f = fixture(t);
  f.write(app, 'export const sound = 2;\n');
  f.commit();
  const run = (args) => spawnSync(process.execPath, [script, ...args], { cwd: f.cwd, encoding: 'utf8' });
  const missing = run(['--base', f.base]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Missing client release notes/);
  assert.equal(missing.stdout, '');
  assert.equal(run([]).status, 1);
  assert.equal(run(['--base', 'missing-tag']).status, 1);
  f.write(fresh, note);
  f.commit();
  const valid = run(['--base', f.base, '--head', 'HEAD', '--merge-base']);
  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /1 new bilingual note/);
  assert.equal(run(['--base', '']).status, 0, 'first release accepts an explicit empty base');
});

test('CI checks the PR diff and releases check their exact range before building', () => {
  const ci = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  const docsJob = ci.slice(ci.indexOf('  docs-sync:'), ci.indexOf('  client-dom:'));
  assert.match(docsJob, /fetch-depth: 0/);
  assert.match(docsJob, /node --test scripts\/test-client-release-notes\.js/);
  assert.match(docsJob, /if: github\.event_name == 'pull_request'/);
  assert.ok(docsJob.includes('BASE_SHA: ${{ github.event.pull_request.base.sha }}'));
  assert.ok(docsJob.includes('HEAD_SHA: ${{ github.event.pull_request.head.sha }}'));
  assert.ok(docsJob.includes('node scripts/check-client-release-notes.js --base "$BASE_SHA" --head "$HEAD_SHA" --merge-base'));
  const release = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const gate = release.slice(release.indexOf('      - name: Require bilingual client release notes before building'),
    release.indexOf('      - name: Select approved CI build'));
  assert.match(gate, /if: github\.event_name == 'push'/, 'legacy beta promotions remain compatible');
  assert.ok(gate.includes('PREV_TAG: ${{ steps.bump.outputs.prev_tag }}'));
  assert.ok(gate.includes('CHECKOUT_REF: ${{ steps.ref.outputs.checkout_ref }}'));
  assert.ok(gate.includes('node scripts/check-client-release-notes.js --base "$PREV_TAG" --head "$CHECKOUT_REF"'));
});
