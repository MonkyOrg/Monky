import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { PROTOCOL_VERSION, type BotLocale } from '@monky/shared';
import { CliError, cliText } from '../cli/locale';
import { isRecord, loadBotProject, botEntryPath } from './config';
import { runNpm } from './process';

export interface DoctorCheck { name: string; ok: boolean; detail: string }

export function inspectBotProject(root: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push({ name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: `${process.versions.node}; >=22` });
  try {
    const version = runNpm(['--version'], { cwd: root, timeout: 15_000 }).trim();
    checks.push({ name: 'npm', ok: /^\d+\.\d+\.\d+$/.test(version), detail: version });
  } catch {
    checks.push({ name: 'npm', ok: false, detail: 'npm --version' });
  }
  let project: ReturnType<typeof loadBotProject>;
  try {
    project = loadBotProject(root);
    checks.push({ name: 'package.json / monkyBot', ok: true, detail: project.manifest.name });
  } catch (error: unknown) {
    checks.push({ name: 'package.json / monkyBot', ok: false, detail: error instanceof Error ? error.message : 'Invalid project' });
    return checks;
  }
  const requireProject = createRequire(path.join(project.root, 'package.json'));
  try {
    const sdk: unknown = requireProject('@monky/bot-sdk');
    const protocol = isRecord(sdk) && typeof sdk.PROTOCOL_VERSION === 'number' ? sdk.PROTOCOL_VERSION : undefined;
    const declared = isRecord(project.manifest.dependencies) && typeof project.manifest.dependencies['@monky/bot-sdk'] === 'string';
    checks.push({ name: '@monky/bot-sdk', ok: declared && protocol === PROTOCOL_VERSION,
      detail: declared ? `PROTOCOL_VERSION: SDK ${protocol ?? '?'} / CLI ${PROTOCOL_VERSION}` : 'package.json dependencies: @monky/bot-sdk' });
  } catch {
    checks.push({ name: '@monky/bot-sdk', ok: false, detail: 'npm install' });
  }
  try {
    const entry = botEntryPath(project);
    checks.push({ name: 'entry', ok: fs.statSync(entry).isFile(), detail: project.definition.entry });
  } catch {
    checks.push({ name: 'entry', ok: false, detail: `${project.definition.entry}; npm run build` });
  }
  if (fs.existsSync(path.join(project.root, 'tsconfig.json'))) {
    let scratch: string | undefined;
    try {
      const compiler = requireProject.resolve('typescript/bin/tsc');
      // noEmit alone can still overwrite a project's incremental build metadata.
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-bot-doctor-'));
      const result = spawnSync(process.execPath, [compiler, '--noEmit', '--pretty', 'false',
        '--incremental', '--tsBuildInfoFile', path.join(scratch, 'check.tsbuildinfo')], {
        cwd: project.root, shell: false, windowsHide: true, encoding: 'utf8', timeout: 60_000,
      });
      checks.push({ name: 'TypeScript', ok: !result.error && result.status === 0,
        detail: result.status === 0 && !result.error ? 'tsc --noEmit' : 'npm run build' });
    } catch {
      checks.push({ name: 'TypeScript', ok: false, detail: 'npm install; npm run build' });
    } finally {
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  return checks;
}

export function doctorCommand(args: string[], locale: BotLocale, root = process.cwd()): void {
  if (args.length) throw new CliError('doctor não aceita argumentos; execute na pasta do bot.', 'doctor takes no arguments; run it in the bot directory.');
  const checks = inspectBotProject(root);
  for (const check of checks) console.log(`[${check.ok ? 'OK' : cliText(locale, 'FALHA', 'FAIL')}] ${check.name}: ${check.detail}`);
  console.log(cliText(locale,
    `Verificação local e sem alterações. Cliente e servidor também precisam do protocolo ${PROTOCOL_VERSION}; nenhuma conexão foi feita.`,
    `Read-only local inspection. Client and server also require protocol ${PROTOCOL_VERSION}; no connection was made.`));
  if (checks.some(check => !check.ok)) throw new CliError('Corrija as falhas acima e execute doctor novamente.', 'Fix the failures above and run doctor again.');
}
