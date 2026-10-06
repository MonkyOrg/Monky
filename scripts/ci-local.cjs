'use strict';

// Runs the CI checks that apply to this machine, keeps going after failures and lists every
// failure with its log. Commands come from .github/workflows/ci.yml and scripts/test-client-dom.cjs,
// so this mirror cannot silently drift from CI. Steps that only make sense on a disposable runner
// are reported as PULADO instead of failing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { parseArgs } = require('node:util');
const { load } = require('js-yaml');
const dom = require('./test-client-dom.cjs');

const root = path.resolve(__dirname, '..');
const ciOnly = 'PULADO (só CI)';

function jobStep(job, name) {
  const found = job.steps.find(candidate => candidate.name === name);
  if (!found) throw new Error(`ci.yml mudou: passo "${name}" não encontrado.`);
  return found;
}

function lines(job, name) {
  return jobStep(job, name).run.split('\n').map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => line.replace(/^xvfb-run -a /u, ''));
}

function pairs(ci) {
  return [...jobStep(ci.jobs['docs-sync'], 'Conferir pares PT/EN').run.matchAll(/^\s*check_pair "([^"]+)" "([^"]+)"$/gmu)]
    .map(match => [match[1], match[2]]);
}

function nativeRuntimeReady(platform = process.platform) {
  const bin = path.join(root, 'apps', 'client', 'native', 'screen-share', 'bin');
  const arches = platform === 'darwin' ? ['darwin-arm64', 'darwin-x64'] : ['win32-x64'];
  return arches.every(arch => fs.existsSync(path.join(bin, arch, 'rtc-build.json')));
}

function plan({ base, head, title = '', packageApp = false, platform = process.platform,
  ci = load(fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8')),
  nativeReady = nativeRuntimeReady(platform) } = {}) {
  const shell = (stage, command, extra = {}) => ({ stage, label: command, command, ...extra });
  const bots = ci.jobs['bot-tests'];
  const packaging = ci.jobs[platform === 'darwin' ? 'package-mac' : 'package-win'];
  const noNative = 'PULADO (sem runtime nativo: rode npm run prepare:native-screen)';
  const steps = [
    shell('build', 'npm run build'),
    ...['Build shared contracts', 'Test bot contracts and SDK', 'Test server, client state and real bot conversations',
      'Exercise an isolated SDK installation'].flatMap(name => lines(bots, name).map(command => shell('bots', command))),
    shell('docs', 'node --test scripts/test-client-release-notes.js'),
    shell('docs', `node scripts/check-client-release-notes.js --base ${base} --head ${head} --merge-base`),
    shell('docs', 'node scripts/check-protocol-bump.js', { env: { BASE_SHA: base, HEAD_SHA: head, PR_TITLE: title } }),
    { stage: 'docs', label: 'pares PT/EN', fn: () => checkPairs(pairs(ci), base, head) },
    ...[`node apps/client/native/screen-share/scripts/verifyOutputs.cjs ${platform === 'darwin' ? 'mac --legal' : 'win'}`,
      ...lines(packaging, 'Exercise native screen contracts and legal metadata')]
      .map(command => shell('native', command, nativeReady ? {} : { skip: noNative })),
    ...lines(packaging, 'Exercise prepared application startup and scenarios').map(command => shell('package', command)),
    { stage: 'package', label: 'copiar migrations', fn: copyMigrations },
    shell('package', `npx --no-install electron-builder --${platform === 'darwin' ? 'mac' : 'win'} --dir --publish never`, {
      cwd: path.join(root, 'apps', 'client'),
      skip: packageApp ? undefined : 'PULADO (use --package para empacotar)',
    }),
    // In CI the packaging step above builds the N-API screen-audio addon that the shortcut smokes load.
    ...packageApp ? [] : [shell('package', 'npm exec --no -- node-gyp rebuild --directory=apps/client/native/screen-audio')],
    ...lines(packaging, 'Exercise shortcut capture and worker recovery').map(command => shell('package', command)),
    shell('package', 'node scripts/ci-build-artifact.js collect', { skip: ciOnly }),
    ...dom.commands.map(command => shell('dom', command.join(' '),
      command.includes('--system-clipboard') ? { skip: ciOnly } : {})),
  ];
  return steps;
}

function checkPairs(list, base, head) {
  const changed = new Set(execFileSync('git', ['diff', '--name-only', base, head], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/u).filter(Boolean));
  const errors = [];
  const pair = (pt, en) => { if (changed.has(pt) !== changed.has(en)) errors.push(`${pt} <-> ${en}`); };
  for (const [pt, en] of list) pair(pt, en);
  const docs = path.join(root, 'docs-site');
  for (const file of fs.readdirSync(docs).filter(name => name.endsWith('.md'))) {
    if (!fs.existsSync(path.join(docs, 'en', file))) errors.push(`docs-site/${file} sem docs-site/en/${file}`);
    pair(`docs-site/${file}`, `docs-site/en/${file}`);
  }
  for (const file of fs.readdirSync(path.join(docs, 'en')).filter(name => name.endsWith('.md')))
    if (!fs.existsSync(path.join(docs, file))) errors.push(`docs-site/en/${file} sem docs-site/${file}`);
  if (errors.length) throw new Error(`Pares PT/EN inconsistentes: ${errors.join('; ')}`);
}

function copyMigrations() {
  const from = path.join(root, 'apps', 'server', 'src', 'infrastructure', 'database', 'migrations');
  const to = path.join(root, 'apps', 'server', 'dist', 'infrastructure', 'database', 'migrations');
  fs.mkdirSync(to, { recursive: true });
  for (const file of fs.readdirSync(from).filter(name => name.endsWith('.sql')))
    fs.copyFileSync(path.join(from, file), path.join(to, file));
}

function execute(step, log, env) {
  return new Promise(resolve => {
    const out = fs.openSync(log, 'w');
    const child = spawn(step.command, { cwd: step.cwd ?? root, env: { ...env, ...step.env },
      stdio: ['ignore', out, out], shell: true });
    child.on('error', error => { fs.appendFileSync(log, String(error)); resolve(1); });
    child.on('exit', (code, signal) => { fs.closeSync(out); resolve(code ?? signal); });
  });
}

function options(argv) {
  const { values } = parseArgs({ args: argv, options: {
    base: { type: 'string' }, head: { type: 'string', default: 'HEAD' }, title: { type: 'string', default: '' },
    only: { type: 'string' }, package: { type: 'boolean', default: false }, logs: { type: 'string' },
  } });
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const head = git('rev-parse', '--verify', `${values.head}^{commit}`);
  const base = values.base ? git('rev-parse', '--verify', `${values.base}^{commit}`)
    : git('merge-base', 'origin/main', head);
  return { base, head, title: values.title, packageApp: values.package,
    only: values.only ? new RegExp(values.only, 'u') : null,
    logs: path.resolve(values.logs ?? path.join(os.tmpdir(), 'monky-ci-local', new Date().toISOString().replace(/[:.]/gu, '-'))) };
}

async function main(argv = process.argv.slice(2)) {
  const config = options(argv);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(config.logs, { recursive: true });
  console.log(`Base ${config.base.slice(0, 12)}, head ${config.head.slice(0, 12)}. Logs em ${config.logs}`);
  const results = [];
  for (const [index, step] of plan(config).entries()) {
    if (config.only && !config.only.test(`${step.stage} ${step.label}`)) continue;
    const number = String(index + 1).padStart(2, '0');
    const log = path.join(config.logs, `${number}-${step.stage}.log`);
    const started = Date.now();
    let status = 0;
    if (step.skip) status = 'skip';
    else if (step.fn) {
      try { step.fn(); fs.writeFileSync(log, 'ok\n'); } catch (error) { fs.writeFileSync(log, String(error.stack ?? error)); status = 1; }
    } else status = await execute(step, log, env);
    const seconds = Math.round((Date.now() - started) / 1000);
    results.push({ number, ...step, status, log });
    const mark = status === 'skip' ? step.skip : status === 0 ? 'OK' : 'FALHOU';
    console.log(`${mark.padEnd(6)} ${number} [${step.stage}] ${step.label}${status === 'skip' ? '' : ` (${seconds}s)`}`);
  }
  const failed = results.filter(result => result.status !== 0 && result.status !== 'skip');
  const skipped = results.filter(result => result.status === 'skip');
  console.log(`\n${results.length - failed.length - skipped.length} OK, ${skipped.length} pulados, ${failed.length} falhas.`);
  for (const result of failed) console.log(`FALHOU ${result.number} [${result.stage}] ${result.label}\n       ${result.log}`);
  return failed.length ? 1 : 0;
}

module.exports = { plan, pairs, lines };
if (require.main === module) main().then(code => { process.exitCode = code; },
  error => { console.error(error.message ?? error); process.exitCode = 1; });
