import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { load } = require('js-yaml');
const { isDocumentation, docsOnly, changedFiles, PACKAGED_PAGES } = require('./ci-changes.cjs');
const root = fileURLToPath(new URL('..', import.meta.url));
const workflow = name => load(fs.readFileSync(path.join(root, '.github', 'workflows', name), 'utf8'));
const ci = workflow('ci.yml');
const GATE = "needs.changes.outputs.docs-only != 'true'";

// Mirror of the required checks in main's branch protection
// (gh api repos/MonkyOrg/Monky/branches/main/protection/required_status_checks).
const REQUIRED = [
  'Build check (win)', 'Build check (mac)', 'Bot interactions and SDK package', 'Docs traduzidos em sincronia',
  'Light native (windows-x64)', 'Light native (macos-x64)', 'Light native (macos-arm64)',
  'mac-native-sources / Native media (x64)', 'mac-native-sources / Native media (arm64)',
];

test('only files known to be documentation make a PR documentation-only', () => {
  for (const file of [
    'README.md', 'README.en.md', 'CONTRIBUTING.md', 'CONTRIBUTING.en.md', 'AGENTS.md', 'docs/crash-recovery.md',
    'docs-site/guia.md', 'docs-site/en/guia.md', 'docs-site/convite/index.md', 'docs-site/bots-api-midia.md',
    'docs-site/public/screenshots/inicio-pt.png', 'docs-site/public/og/home-en.jpg',
    'docs-site/diagramas/pt/06-camadas.claro.svg', 'docs-site/diagramas/src/pt/06-camadas.mmd',
  ]) assert.ok(isDocumentation(file), file);

  for (const file of [
    // Pages packed as the SDK and CLI READMEs.
    'docs-site/bots-desenvolvimento.md', 'docs-site/en/bots-desenvolvimento.md', 'docs-site/cli.md',
    // Site code, generators and installers.
    'docs-site/.vitepress/config.ts', 'docs-site/.vitepress/theme/Layout.vue', 'docs-site/.vitepress/theme/custom.css',
    'docs-site/scripts/generate-bot-reference.mjs', 'docs-site/og/gerar.mjs', 'docs-site/og/template.html',
    'docs-site/diagramas/scripts/gerar.mjs', 'docs-site/download.data.ts', 'docs-site/public/install-bot-sdk.sh',
    'docs-site/public/install-bot-sdk.ps1',
    // Markdown that builds, packages or tests read, and everything else that is not documentation.
    'apps/light/README.md', 'apps/client/native/screen-share/README.md', 'packages/bot-sdk/README.md',
    'release-notes/README.md', 'release-notes/800-docs.json', 'scripts/ci-changes.cjs', '.github/workflows/ci.yml',
    '.github/DISCUSSION_TEMPLATE/bug-reports.yml', '.github/ISSUE_TEMPLATE/config.yml', 'patches/x.patch',
    'package.json', 'package-lock.json', 'LICENSE', 'images/Logo.png', '.agents/skills/pr-review/scripts/pr-helper.js',
    'Prompt/CodeReview.md', 'tsconfig.base.json',
  ]) assert.ok(!isDocumentation(file), file);

  assert.equal(docsOnly(['README.md', 'README.en.md', 'docs-site/guia.md', 'docs-site/en/guia.md']), true);
  assert.equal(docsOnly(['README.md', 'apps/client/src/main/main.ts']), false, 'One code file runs every lane.');
  assert.equal(docsOnly([]), false, 'An empty or unreadable diff runs every lane.');
});

test('every documentation page a CI job packs is treated as code', () => {
  const sdk = fs.readFileSync(path.join(root, 'scripts', 'pack-bot-sdk.js'), 'utf8');
  assert.match(sdk, /\['bots-desenvolvimento\.md', 'README\.md'\]/u);
  assert.match(sdk, /\[path\.join\('en', 'bots-desenvolvimento\.md'\), 'README\.en\.md'\]/u);
  assert.match(sdk, /path\.join\(ROOT, 'docs-site', source\)/u);
  assert.match(fs.readFileSync(path.join(root, 'scripts', 'pack-cli.js'), 'utf8'), /path\.join\(ROOT, 'docs-site', 'cli\.md'\)/u);
  assert.deepEqual([...PACKAGED_PAGES].sort(),
    ['docs-site/bots-desenvolvimento.md', 'docs-site/cli.md', 'docs-site/en/bots-desenvolvimento.md']);
});

test('the PR diff is read against the base the PR was merged into, never against later main commits', t => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'monky-ci-changes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (file, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'ci@example.com']);
  git(['config', 'user.name', 'CI']);
  git(['config', 'commit.gpgsign', 'false']);
  write('apps/server/index.ts', 'one\n'); write('README.md', 'one\n');
  git(['add', '.']); git(['commit', '-qm', 'base']);
  git(['checkout', '-qb', 'docs']);
  write('README.md', 'two\n'); write('docs-site/guia.md', 'novo\n'); write('docs-site/old.md', 'x\n');
  git(['add', '.']); git(['commit', '-qm', 'docs']);
  git(['checkout', '-q', 'main']);
  write('apps/server/index.ts', 'two\n');
  git(['commit', '-qam', 'code on main']);
  assert.throws(() => changedFiles(git), Error, 'A run that is not a PR merge has no reliable base.');
  git(['merge', '-q', '--no-ff', '-m', 'pr', 'docs']);
  assert.deepEqual(changedFiles(git).sort(), ['README.md', 'docs-site/guia.md', 'docs-site/old.md']);
  assert.equal(docsOnly(changedFiles(git)), true);

  // A rename away from code keeps the deleted code path in the diff.
  git(['checkout', '-q', 'docs']);
  git(['mv', 'apps/server/index.ts', 'docs-site/index-moved.md']);
  git(['commit', '-qm', 'move']);
  git(['checkout', '-q', 'main']);
  git(['merge', '-q', '--no-ff', '-X', 'theirs', '-m', 'pr2', 'docs']);
  assert.ok(changedFiles(git).includes('apps/server/index.ts'));
  assert.equal(docsOnly(changedFiles(git)), false);
});

test('a documentation-only PR runs only the docs check and reports every other required check explicitly', () => {
  const classify = ci.jobs.changes;
  assert.equal(classify.needs, undefined);
  assert.equal(classify['runs-on'], 'ubuntu-latest');
  assert.deepEqual(classify.outputs, { 'docs-only': '${{ steps.classify.outputs.docs-only }}' });
  const checkout = classify.steps.find(candidate => candidate.uses === 'actions/checkout@v4');
  assert.equal(checkout.with['fetch-depth'], 2, 'The PR merge and both of its parents.');
  const run = classify.steps.find(candidate => candidate.id === 'classify');
  assert.equal(run.run, 'node scripts/ci-changes.cjs');
  for (const candidate of classify.steps)
    assert.equal(candidate.if, "github.event_name == 'pull_request'", 'Manual runs are never classified, so they run everything.');

  const needs = job => [job.needs ?? []].flat();
  const skippedWhenDocsOnly = id => {
    const job = ci.jobs[id];
    if (job.if === GATE) return needs(job).includes('changes');
    // Without its own condition a job is skipped when any job it needs was skipped.
    return job.if === undefined && needs(job).some(skippedWhenDocsOnly);
  };
  const always = ['changes', 'docs-sync', 'build', 'not-applicable'];
  for (const id of Object.keys(ci.jobs).filter(id => !always.includes(id)))
    assert.ok(skippedWhenDocsOnly(id), `${id} must be skipped for a documentation-only PR`);
  assert.equal(ci.jobs['docs-sync'].needs, undefined);
  assert.equal(ci.jobs['docs-sync'].if, undefined, 'The docs check always runs.');
  assert.equal(ci.jobs.build.if, 'always()');
  assert.ok(needs(ci.jobs.build).includes('changes'));

  const standIn = ci.jobs['not-applicable'];
  assert.equal(standIn.name, '${{ matrix.check }}');
  assert.equal(standIn.needs, 'changes');
  assert.equal(standIn.if, "needs.changes.outputs.docs-only == 'true'");
  assert.equal(standIn['runs-on'], 'ubuntu-latest');
  assert.ok(standIn.steps.every(candidate => candidate.run && !candidate.uses), 'Stand-ins check nothing out.');
  // Skipped matrix and reusable-workflow jobs never expand their names, so these must match exactly.
  const light = ci.jobs['light-native'];
  const native = workflow('native-macos-validation.yml').jobs.sources;
  const expanded = [
    ...light.strategy.matrix.include.map(({ target }) => light.name.replace('${{ matrix.target }}', target)),
    ...native.strategy.matrix.include.map(({ arch }) =>
      `mac-native-sources / ${native.name.replace('${{ matrix.arch }}', arch)}`),
  ];
  assert.deepEqual([...standIn.strategy.matrix.check].sort(), expanded.sort());

  // In a documentation-only PR every required check completes: docs runs, the build gate passes as
  // not applicable, a skipped single job reports success, and the stand-ins cover the matrices.
  const reported = new Set([
    ci.jobs['docs-sync'].name, ...ci.jobs.build.strategy.matrix.platform.map(platform =>
      ci.jobs.build.name.replace('${{ matrix.platform }}', platform)),
    ...Object.values(ci.jobs).filter(job => !job.strategy && !job.uses && job.if === GATE).map(job => job.name),
    ...standIn.strategy.matrix.check,
  ]);
  for (const name of REQUIRED) assert.ok(reported.has(name), `${name} would stay pending`);
});
