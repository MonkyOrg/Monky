import { classifyGroup, stripType, extractEntries, buildChangelog, buildClientNotes, buildReleaseNotes, getClientNotesInRange, getCommitsInRange } from './generate-changelog.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

console.log('=== Início dos Testes do Changelog (#547) ===');

// console.assert nao muda o exit code no Node: sem este contador o script
// terminaria com sucesso mesmo com asserções quebradas e o CI nao veria nada.
let failures = 0;
const nativeAssert = console.assert.bind(console);
console.assert = (condition, ...args) => {
  if (!condition) failures += 1;
  nativeAssert(condition, ...args);
};

// 1. classifyGroup: a seção sai do tipo do assunto (subject) do commit.
console.assert(classifyGroup('feat: soundboard novo (#10)') === 'novidades', 'feat -> novidades');
console.assert(classifyGroup('feature: algo (#10)') === 'novidades', 'feature -> novidades');
console.assert(classifyGroup('minor: algo') === 'novidades', 'minor -> novidades');
console.assert(classifyGroup('feat(voz): push to talk') === 'novidades', 'feat(scope) -> novidades');
console.assert(classifyGroup('feat!: quebra protocolo') === 'novidades', 'feat! -> novidades');
console.assert(classifyGroup('fix: corrige audio (#11)') === 'correcoes', 'fix -> correcoes');
console.assert(classifyGroup('bugfix: corrige crash') === 'correcoes', 'bugfix -> correcoes');
console.assert(classifyGroup('fix(ui): ajuste (#12)') === 'correcoes', 'fix(scope) -> correcoes');
console.assert(classifyGroup('refactor: limpa modulo') === 'outros', 'refactor -> outros');
console.assert(classifyGroup('chore: bump deps') === 'outros', 'chore -> outros');
console.assert(classifyGroup('mensagem sem tipo') === 'outros', 'sem tipo -> outros');
console.log('✔ classifyGroup agrupou por tipo de commit');

// 2. stripType: remove o prefixo de tipo, preserva o resto (inclui "(#NNN)").
console.assert(stripType('feat: changelog no client (#547)') === 'changelog no client (#547)', 'remove feat:');
console.assert(stripType('fix(ui): ajuste do modal') === 'ajuste do modal', 'remove fix(scope):');
console.assert(stripType('* fix: bullet de squash') === 'bullet de squash', 'remove bullet + tipo');
console.assert(stripType('texto puro') === 'texto puro', 'sem tipo fica igual');
console.log('✔ stripType removeu o prefixo de tipo');

// 3. extractEntries: prioriza linhas "#NNN:" curadas do corpo.
const commitComIssue = [
  'feat: changelog no client (#547)',
  '',
  '#547: changelog amigavel agrupado e exibicao apos atualizar',
  '',
  'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>',
].join('\n');
console.assert(
  JSON.stringify(extractEntries(commitComIssue)) ===
    JSON.stringify(['#547: changelog amigavel agrupado e exibicao apos atualizar']),
  'extrai a linha #NNN e ignora Co-authored-by'
);

// Linhas de continuacao (quebra de linha) sao dobradas de volta na mesma entrada.
const commitWrap = [
  'fix: reconexao (#44)',
  '',
  '#44: reconecta imediatamente quando a rede volta em vez',
  'de esperar o proximo heartbeat',
].join('\n');
console.assert(
  JSON.stringify(extractEntries(commitWrap)) ===
    JSON.stringify(['#44: reconecta imediatamente quando a rede volta em vez de esperar o proximo heartbeat']),
  'linhas de continuacao viram uma unica entrada'
);

// Varias linhas #NNN num mesmo commit viram varias entradas.
const commitMulti = [
  'feat: pacote (#1)',
  '',
  '#1: primeira coisa',
  '#2: segunda coisa',
].join('\n');
console.assert(
  JSON.stringify(extractEntries(commitMulti)) === JSON.stringify(['#1: primeira coisa', '#2: segunda coisa']),
  'multiplas linhas #NNN viram multiplas entradas'
);

// Sem linhas #NNN: cai para bullets do corpo (ignorando bullets de squash).
const commitBullets = [
  'chore: limpeza',
  '',
  '- remove codigo morto',
  '* fix: nao deve aparecer como bullet',
  '- ajusta script',
].join('\n');
console.assert(
  JSON.stringify(extractEntries(commitBullets)) === JSON.stringify(['remove codigo morto', 'ajusta script']),
  'fallback para bullets, ignorando bullets de squash tipados'
);

// Sem corpo util: cai para o assunto sem o tipo.
console.assert(
  JSON.stringify(extractEntries('feat: novidade solta (#9)')) === JSON.stringify(['novidade solta (#9)']),
  'fallback para o assunto sem o tipo'
);
console.log('✔ extractEntries priorizou #NNN, dobrou continuacao e fez fallback');

// 4. buildChangelog: agrupa, deduplica e anexa o link de comparacao.
const commits = [
  ['feat: changelog no client (#547)', '', '#547: exibe changelog apos atualizar'].join('\n'),
  ['fix: soundbar (#543)', '', '#543: corrige barra de progresso ao trocar de audio'].join('\n'),
  ['refactor: organiza updater', '', '#500: separa fetch das notas'].join('\n'),
];
const notes = buildChangelog(commits, { repo: 'MonkyOrg/Monky', version: '8.3.0-beta', prevTag: 'v8.2.8-beta' });

console.assert(notes.includes('#### ✨ Novidades'), 'tem secao Novidades');
console.assert(notes.includes('#### 🐛 Correções'), 'tem secao Correções');
console.assert(notes.includes('#### 🔧 Outros'), 'tem secao Outros');
console.assert(notes.includes('- #547: exibe changelog apos atualizar'), 'entrada de novidade presente');
console.assert(notes.includes('- #543: corrige barra de progresso ao trocar de audio'), 'entrada de correcao presente');
console.assert(notes.includes('- #500: separa fetch das notas'), 'entrada de outros presente');
console.assert(
  notes.includes('**Comparação completa**: https://github.com/MonkyOrg/Monky/compare/v8.2.8-beta...v8.3.0-beta'),
  'link de comparacao correto'
);
// Ordem das secoes: Novidades antes de Correções antes de Outros.
console.assert(
  notes.indexOf('Novidades') < notes.indexOf('Correções') &&
    notes.indexOf('Correções') < notes.indexOf('Outros'),
  'secoes na ordem Novidades > Correções > Outros'
);

// Secao vazia nao aparece.
const soFeat = buildChangelog([['feat: algo (#1)', '', '#1: coisa nova'].join('\n')], {});
console.assert(soFeat.includes('Novidades') && !soFeat.includes('Correções') && !soFeat.includes('Outros'), 'omite secoes vazias');

// Deduplicacao: a mesma linha vinda de dois commits aparece uma vez.
const dup = buildChangelog(
  [
    ['fix: a (#1)', '', '#1: mesma correcao'].join('\n'),
    ['fix: b (#1)', '', '#1: mesma correcao'].join('\n'),
  ],
  {}
);
console.assert((dup.match(/#1: mesma correcao/g) || []).length === 1, 'linhas duplicadas sao unificadas');

// Sem link quando faltam metadados; sem commits, usa a linha de fallback.
console.assert(!soFeat.includes('Comparação completa'), 'sem metadados nao anexa link');
console.assert(buildChangelog([], {}) === '- Nenhuma alteração registrada neste intervalo.', 'sem commits informa intervalo vazio, sem inventar melhorias');
console.log('✔ buildChangelog agrupou, deduplicou e montou o link de comparacao');

// 5. Notas do app são autorais e bilíngues, não versões "limpas" de commits.
const clientFragments = [
  { group: 'novidades', 'pt-BR': 'Copie sua versão com um clique. Prontinho!', en: 'Copy your version with a click. All set!' },
  { group: 'correcoes', 'pt-BR': 'O som voltou ao lugar.', en: 'Sound is back where it belongs.' },
  { group: 'outros', 'pt-BR': 'Um ajuste na apresentação.', en: 'A presentation tweak.' },
];
const clientNotes = buildClientNotes([...clientFragments, clientFragments[0]]);
assert.equal(clientNotes.schemaVersion, 1);
assert.equal(clientNotes.groups.novidades.length, 1, 'deduplica o par de traduções');
assert.equal(clientNotes.groups.correcoes[0].en, clientFragments[1].en);
assert.deepEqual(buildClientNotes([]).groups, { novidades: [], correcoes: [], outros: [] }, 'sem notas não inventa melhorias');

for (const invalid of [
  {}, { ...clientFragments[0], group: 'fix' }, { ...clientFragments[0], en: undefined },
  { ...clientFragments[0], 'pt-BR': '' }, { ...clientFragments[0], en: 'x'.repeat(281) },
  { ...clientFragments[0], en: 'Fix #617: navigator.clipboard' },
  { ...clientFragments[0], en: 'Run `npm install`' },
  { ...clientFragments[0], en: '<script>boom()</script>' },
  { ...clientFragments[0], en: 'Read https://example.com' },
  { ...clientFragments[0], en: 'First line\nsecond line' },
]) {
  assert.throws(() => buildClientNotes([invalid]), /Client note 1/, 'fonte inválida falha em vez de publicar sucesso falso');
}

const releaseBody = buildReleaseNotes(commits, {
  repo: 'MonkyOrg/Monky', version: '8.3.0-beta', prevTag: 'v8.2.8-beta', fragments: clientFragments,
});
const block = /<!-- monky-client-notes:v1\n([\s\S]*?)\n-->/.exec(releaseBody);
assert.ok(block, 'payload separado está presente');
assert.deepEqual(JSON.parse(block[1]), buildClientNotes(clientFragments));
assert.ok(releaseBody.indexOf('monky-client-notes:v1') < releaseBody.indexOf('### Changelog'),
  'clientes antigos não leem o JSON depois da seção técnica');
assert.equal(releaseBody.split('### Changelog\n')[1], notes, 'changelog técnico mantém detalhes e issues sem alterações');
assert.ok(!block[1].includes('#547') && !block[1].includes('Comparação completa'));

// A seleção usa exatamente o intervalo da release (inclusive ao promover beta)
// e o conteúdo do HEAD, sem criar commits de teste ou ler a árvore de trabalho.
const gitCalls = [];
const fakeGit = args => {
  gitCalls.push(args);
  if (args[0] === 'diff' || args[0] === 'ls-tree') {
    return 'release-notes/617-copy-version.json\0release-notes/README.md\0';
  }
  assert.deepEqual(args, ['show', 'HEAD:release-notes/617-copy-version.json']);
  return JSON.stringify(clientFragments[0]);
};
assert.deepEqual(getClientNotesInRange('v8.2.8-beta', fakeGit), [clientFragments[0]]);
assert.deepEqual(gitCalls[0], ['diff', '--no-renames', '--name-only', '-z', '--diff-filter=A', 'v8.2.8-beta', 'HEAD', '--', 'release-notes']);
gitCalls.length = 0;
getClientNotesInRange('v8.0.0', fakeGit);
assert.equal(gitCalls[0][5], 'v8.0.0', 'promoção mantém o intervalo desde a estável anterior');
gitCalls.length = 0;
getClientNotesInRange('', fakeGit);
assert.deepEqual(gitCalls[0], ['ls-tree', '-r', '--name-only', '-z', 'HEAD', '--', 'release-notes']);
assert.throws(() => getClientNotesInRange('v1', args => args[0] === 'diff' ? 'release-notes/bad.json' : '{'),
  /release-notes\/bad\.json/, 'JSON inválido identifica o arquivo e aborta a geração');
assert.throws(() => getClientNotesInRange('v1', () => { throw new Error('git unavailable'); }), /git unavailable/);
assert.throws(() => getCommitsInRange('refs/tags/monky-test-nonexistent-tag'), /git --no-pager log/,
  'erro no intervalo git não vira um changelog de melhorias inventadas');
assert.deepEqual(getClientNotesInRange('v1', args => {
  if (args[0] === 'diff') return 'release-notes/ação amigável.json\0';
  assert.deepEqual(args, ['show', 'HEAD:release-notes/ação amigável.json']);
  return JSON.stringify(clientFragments[0]);
}), [clientFragments[0]], 'nomes com espaços e acentos não são descartados silenciosamente');

const fragmentDir = new URL('../release-notes/', import.meta.url);
const repositoryFragments = readdirSync(fragmentDir).filter(file => file.endsWith('.json'))
  .map(file => JSON.parse(readFileSync(new URL(file, fragmentDir), 'utf8')));
assert.ok(repositoryFragments.length >= 2, 'as mudanças desta implementação têm notas reais');
for (const fragment of repositoryFragments) buildClientNotes([fragment]);
const workflow = readFileSync(fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url)), 'utf8');
assert.ok(workflow.includes("if ! grep -q '^### Changelog$'"), 'promoção de beta antiga preserva o cabeçalho técnico');
const generator = fileURLToPath(new URL('./generate-changelog.js', import.meta.url));
const emptyRange = spawnSync(process.execPath, [generator, '--prev', 'HEAD'], { encoding: 'utf8' });
assert.equal(emptyRange.status, 0, emptyRange.stderr);
assert.ok(emptyRange.stdout.includes('"novidades":[]') && emptyRange.stdout.includes('Nenhuma alteração registrada'),
  'CLI não repete notas já presentes no começo do intervalo nem lê arquivos locais ainda não commitados');
const badRange = spawnSync(process.execPath, [generator, '--prev', 'refs/tags/monky-test-nonexistent-tag'], { encoding: 'utf8' });
assert.equal(badRange.status, 1);
assert.equal(badRange.stdout, '', 'CLI com erro não deixa conteúdo com aparência de sucesso no output da release');
assert.ok(badRange.stderr.includes('Could not generate release notes'));
console.log(`✔ Notas bilíngues, separação técnica, intervalo git e ${repositoryFragments.length} arquivos de notas validados`);

if (failures > 0) {
  console.error(`\n✖ ${failures} asserção(ões) falharam nos testes do changelog.`);
  process.exit(1);
}
console.log('\n✅ Todos os testes do changelog passaram!');
