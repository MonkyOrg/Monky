import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'packages', 'bot-sdk', 'src', 'tooling', 'install.ts');
const destination = path.join(root, 'docs-site', 'public', 'install-bot-sdk.cjs');
const compiled = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  fileName: source, reportDiagnostics: true,
});
const errors = (compiled.diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
  getCurrentDirectory: () => root, getCanonicalFileName: file => file, getNewLine: () => '\n',
}));
if ([...compiled.outputText.matchAll(/require\(["']([^"']+)["']\)/g)].some(match => !match[1].startsWith('node:'))) {
  throw new Error('The standalone installer must only depend on Node built-ins.');
}
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, compiled.outputText);
fs.writeFileSync(`${destination}.sha256`, createHash('sha256').update(compiled.outputText).digest('hex') + '\n');
console.log('[docs] SDK installer prepared.');
