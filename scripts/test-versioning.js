import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bumpVersion, determineBumpType, calculateNextVersion, promoteBetaTag, validatePromotionTag, PUBLISHED_VERSION, BETA_SUFFIX, parseVersionTag, compareVersionTags, getLatestReleaseTag, getLatestSemverTag, splitCommitEntries, bumpTypeForEntry, collectBumps, applyBumps, isReleasableCommit, getGitCommitsSinceTag } from './calculate-version.js';
import { requiresClientNote } from './check-client-release-notes.js';
import { isClientNoteFile } from './generate-changelog.js';

console.log('=== Início dos Testes de Versionamento SemVer (#122) ===');

// console.assert nao muda o exit code no Node: sem este contador o script
// terminaria com sucesso mesmo com asserções quebradas e o CI nao veria nada.
let failures = 0;
const nativeAssert = console.assert.bind(console);
console.assert = (condition, ...args) => {
  if (!condition) failures += 1;
  nativeAssert(condition, ...args);
};

// 1. Test bumpVersion
console.assert(bumpVersion('1.0.55', 'patch') === '1.0.56', 'Patch bump: 1.0.55 -> 1.0.56');
console.assert(bumpVersion('1.0.55', 'minor') === '1.1.0', 'Minor bump: 1.0.55 -> 1.1.0');
console.assert(bumpVersion('1.0.55', 'major') === '2.0.0', 'Major bump: 1.0.55 -> 2.0.0');

console.assert(bumpVersion('v1.2.3', 'patch') === '1.2.4', 'Patch com v prefix');
console.assert(bumpVersion('v1.2.3', 'minor') === '1.3.0', 'Minor com v prefix');
console.assert(bumpVersion('v1.2.3', 'major') === '2.0.0', 'Major com v prefix');
console.log('✔ bumpVersion passou em todos os cenários');

// 2. Test determineBumpType
console.assert(determineBumpType(['fix: fix audio bug']) === 'patch', 'fix -> patch');
console.assert(determineBumpType(['fix(ui): adjust layout']) === 'patch', 'fix(scope) -> patch');
console.assert(determineBumpType(['chore: update dependencies', 'docs: update readme']) === 'patch', 'chore/docs -> patch');

console.assert(determineBumpType(['feat: add new feature']) === 'minor', 'feat -> minor');
console.assert(determineBumpType(['feat(soundboard): add shortcuts', 'fix: fix bug']) === 'minor', 'feat + fix -> minor');
console.assert(determineBumpType(['feature: new feature']) === 'minor', 'feature -> minor');

console.assert(determineBumpType(['feat!: breaking change in auth']) === 'major', 'feat! -> major');
console.assert(determineBumpType(['fix(core)!: breaking fix']) === 'major', 'fix! -> major');
console.assert(determineBumpType(['refactor: rewrite\n\nBREAKING CHANGE: new API']) === 'major', 'BREAKING CHANGE -> major');
console.assert(determineBumpType(['refactor: rewrite\n\nBREAKING-CHANGE: new API']) === 'major', 'BREAKING-CHANGE -> major');
console.assert(determineBumpType(['major: redesign architecture']) === 'major', 'major: -> major');
console.log('✔ determineBumpType identificou corretamente major, minor e patch');

// 3. Test calculateNextVersion helper
//
// Cada commit move o número: a feature leva 1.0.55 a 1.1.0 e o fix seguinte
// soma o patch em cima dela (#465).
const resMinor = calculateNextVersion({
  prevTag: 'v1.0.55',
  commits: ['feat(ui): toggle noise suppression', 'fix(ui): fix alignment'],
});
console.assert(resMinor.nextVersion === '1.1.1', 'feat seguido de fix deve resultar em 1.1.1');
console.assert(resMinor.nextTag === 'v1.1.1', 'nextTag deve ser v1.1.1');

const resPatch = calculateNextVersion({
  prevTag: 'v1.0.55',
  commits: ['fix: fix bug in player'],
});
console.assert(resPatch.nextVersion === '1.0.56', 'calculateNextVersion com fix deve resultar em 1.0.56');

const resMajor = calculateNextVersion({
  prevTag: 'v1.0.55',
  commits: ['refactor!: rewrite networking engine'],
});
console.assert(resMajor.nextVersion === '2.0.0', 'calculateNextVersion com breaking change deve resultar em 2.0.0');

console.log('✔ calculateNextVersion validado com sucesso!');

// 4. Test beta channel (#release-beta)
const betaFirst = calculateNextVersion({
  prevTag: 'v1.7.0',
  commits: ['feat: nova feature de chat'],
  channel: 'beta',
});
console.assert(betaFirst.nextVersion === '1.8.0-beta', 'beta channel deve gerar 1.8.0-beta');
console.assert(betaFirst.nextTag === 'v1.8.0-beta', 'nextTag beta deve ser v1.8.0-beta');
console.assert(betaFirst.prerelease === true, 'beta deve marcar prerelease=true');
console.assert(betaFirst.baseVersion === '1.8.0', 'baseVersion deve ser 1.8.0');

const betaPatch = calculateNextVersion({
  prevTag: 'v1.7.0',
  commits: ['fix: corrige bug'],
  channel: 'beta',
});
console.assert(betaPatch.nextVersion === '1.7.1-beta', 'beta patch deve gerar 1.7.1-beta');

// O sufixo nao carrega mais contador. O zero-padding mantinha em ordem as
// betas de uma *mesma base* na pagina de releases do GitHub, que ordena pelo
// nome da tag (#338); como a base sobe a cada release (#378), nao ha duas
// betas da mesma base para desempatar e o contador so repetia "001" (#382).
console.assert(BETA_SUFFIX === 'beta', 'o sufixo de beta e apenas "beta"');
console.assert(
  !/\d/.test(String(betaFirst.nextVersion.split('-')[1])),
  'o sufixo de beta nao pode conter digitos'
);
const betaSeguinte = calculateNextVersion({
  prevTag: 'v1.8.0-beta',
  commits: ['fix: qualquer coisa'],
  channel: 'beta',
});
console.assert(
  betaSeguinte.baseVersion !== '1.8.0',
  'a beta seguinte nunca reutiliza a base da anterior'
);
// `semver.prerelease` le "beta" como o canal beta; "beta001" era interpretado
// como um canal customizado e travava o electron-updater (#354).
console.assert(betaFirst.nextVersion.endsWith('-beta'), 'a versao termina no canal "beta"');

// Stable channel (default) permanece inalterado
const stableStill = calculateNextVersion({ prevTag: 'v1.7.0', commits: ['fix: x'] });
console.assert(stableStill.nextVersion === '1.7.1', 'stable default deve gerar 1.7.1');
console.assert(stableStill.prerelease === false, 'stable deve marcar prerelease=false');

// promoteBetaTag: o formato atual e os numerados que ja foram publicados
console.assert(promoteBetaTag('v1.8.0-beta') === '1.8.0', 'promoteBetaTag deve extrair 1.8.0');
console.assert(
  promoteBetaTag('v1.8.0-beta003') === '1.8.0',
  'promoteBetaTag deve aceitar o formato com contador'
);
console.assert(promoteBetaTag('1.8.0-beta012') === '1.8.0', 'promoteBetaTag sem prefixo v');
console.assert(
  promoteBetaTag('v1.8.0-beta.3') === '1.8.0',
  'promoteBetaTag deve aceitar o formato antigo'
);

// A promoção manual recebe a tag digitada no formulário do workflow. Só passa o
// nome exato de uma tag beta que existe: um erro de digitação ou um valor
// forjado para no cálculo da versão, antes de virar checkout, arquivo ou comando.
const tagsExistentes = new Set(['v1.8.0-beta', 'v1.8.0-beta003', 'v1.8.0-beta.3', 'v1.7.0']);
const existe = (tag) => tagsExistentes.has(tag);
console.assert(validatePromotionTag('v1.8.0-beta', { exists: existe }) === '1.8.0', 'promove a beta existente');
console.assert(validatePromotionTag('v1.8.0-beta003', { exists: existe }) === '1.8.0', 'promove a beta com contador');
console.assert(validatePromotionTag('v1.8.0-beta.3', { exists: existe }) === '1.8.0', 'promove a beta no formato antigo');
const promocaoRecusada = (tag) => {
  try {
    validatePromotionTag(tag, { exists: existe });
    return false;
  } catch {
    return true;
  }
};
for (const tag of ['v1.7.0', '1.8.0-beta', 'v9.9.9-beta', ' v1.8.0-beta', 'v1.8.0-beta ', 'v1.8.0-beta\n',
  'v1.8.0-beta; touch pwned', 'v1.8.0-beta$(id)', 'v1.8.0-beta\nrelease=false', 'beta', '', undefined, null]) {
  console.assert(promocaoRecusada(tag), `a promoção recusa ${JSON.stringify(tag)}`);
}
for (const versao of ['1.8.0', '40.7.14-beta']) {
  console.assert(PUBLISHED_VERSION.test(versao), `${versao} é uma versão publicável`);
}
for (const versao of ['v1.8.0', '1.8.0-beta003', '1.8.0\nrelease=false', '1.8', '']) {
  console.assert(!PUBLISHED_VERSION.test(versao), `${JSON.stringify(versao)} nunca sai como versão`);
}
console.log('✔ Canal beta e promoção validados com sucesso!');

// 5. Numeração a partir da última release, betas incluídas (#378)
//
// Antes, toda a linha de beta mirava a mesma versão: 1.0.0 + feature virava
// 1.1.0-beta001 e qualquer beta seguinte continuava em 1.1.0, então promover
// depois de dezenas de mudanças ainda publicava 1.1.0. Agora cada release é
// numerada a partir da imediatamente anterior.
console.assert(parseVersionTag('v1.8.0').beta === null, 'tag estável não tem beta');
console.assert(parseVersionTag('v1.8.0').prerelease === false, 'tag estável não é prerelease');
console.assert(parseVersionTag('v1.8.0-beta').prerelease === true, 'v1.8.0-beta é prerelease');
console.assert(parseVersionTag('v1.8.0-beta').beta === null, '-beta sem contador não tem número');
console.assert(parseVersionTag('v1.8.0-beta003').beta === 3, 'beta003 deve ser lido como 3');
console.assert(parseVersionTag('v1.8.0-beta.3').beta === 3, 'formato antigo -beta.3 aceito');
console.assert(parseVersionTag('1.8.0').major === 1, 'tag sem prefixo v é aceita');
console.assert(parseVersionTag('nightly') === null, 'tag fora do padrão retorna null');
console.assert(parseVersionTag('v1.8') === null, 'versão incompleta retorna null');

// Precedência SemVer: a beta fica abaixo da estável de mesmos números.
console.assert(compareVersionTags('v1.8.0-beta', 'v1.8.0') < 0, 'beta < estável da mesma base');
console.assert(compareVersionTags('v1.8.0-beta003', 'v1.8.0') < 0, 'beta numerada < estável');
console.assert(compareVersionTags('v1.8.0-beta009', 'v1.8.0-beta014') < 0, 'beta009 < beta014');
console.assert(compareVersionTags('v1.9.0-beta', 'v1.8.0') > 0, 'base maior vence a estável menor');
console.assert(compareVersionTags('v1.8.0', 'v1.8.0') === 0, 'tags iguais empatam');
console.assert(compareVersionTags('v1.8.0-beta', 'v1.8.0-beta') === 0, 'betas iguais empatam');
// Na virada de formato as duas convivem: a numerada foi publicada antes.
console.assert(
  compareVersionTags('v1.8.0-beta', 'v1.8.0-beta001') < 0,
  '-beta sem contador fica abaixo da numerada da mesma base'
);
console.assert(
  compareVersionTags('v1.8.1-beta', 'v1.8.0-beta010') > 0,
  'a base decide antes do contador'
);

// A estável criada ao promover aponta para o mesmo commit da beta, então as
// duas tags têm a mesma data — ordenar por data não distinguiria as duas.
console.assert(
  getLatestReleaseTag(['v1.7.0', 'v1.8.0-beta001', 'v1.8.0-beta002']) === 'v1.8.0-beta002',
  'getLatestReleaseTag deve considerar betas'
);
console.assert(
  getLatestReleaseTag(['v1.8.0-beta002', 'v1.8.0']) === 'v1.8.0',
  'a estável promovida supera a própria beta'
);
// A release seguinte à virada de formato precisa enxergar as betas numeradas,
// senão contaria a partir de uma tag antiga demais (#382).
console.assert(
  getLatestReleaseTag(['v1.7.0', 'v1.8.0-beta003', 'v1.8.1-beta']) === 'v1.8.1-beta',
  'getLatestReleaseTag mistura os dois formatos de beta'
);
console.assert(
  getLatestReleaseTag(['v1.7.0', 'nightly', 'sem-tag']) === 'v1.7.0',
  'tags fora do padrão são ignoradas'
);
console.assert(getLatestReleaseTag([]) === null, 'sem tags, getLatestReleaseTag retorna null');
console.assert(
  getLatestSemverTag(['v1.7.0', 'v1.8.0-beta002', 'v1.8.0-beta003']) === 'v1.7.0',
  'getLatestSemverTag continua ignorando betas (usado na promoção)'
);

// O marcador de prerelease é descartado antes do incremento.
console.assert(bumpVersion('v1.8.0-beta', 'patch') === '1.8.1', 'patch sobre beta -> 1.8.1');
console.assert(bumpVersion('v1.8.0-beta', 'minor') === '1.9.0', 'minor sobre beta -> 1.9.0');
console.assert(bumpVersion('v1.8.0-beta', 'major') === '2.0.0', 'major sobre beta -> 2.0.0');
console.assert(
  bumpVersion('v1.8.0-beta003', 'patch') === '1.8.1',
  'patch sobre a beta numerada continua funcionando'
);

// O cenário descrito na issue: cada push move o número conforme o que carrega.
const linha1 = calculateNextVersion({
  prevTag: 'v1.0.0',
  commits: ['feat: primeira feature'],
  channel: 'beta',
});
console.assert(linha1.nextVersion === '1.1.0-beta', 'feature sobre 1.0.0 -> 1.1.0-beta');

const linha2 = calculateNextVersion({
  prevTag: 'v1.1.0-beta',
  commits: ['fix: corrige bug'],
  channel: 'beta',
});
console.assert(linha2.nextVersion === '1.1.1-beta', 'fix sobre a beta -> 1.1.1-beta');

const linha3 = calculateNextVersion({
  prevTag: 'v1.1.1-beta',
  commits: ['feat: outra feature'],
  channel: 'beta',
});
console.assert(linha3.nextVersion === '1.2.0-beta', 'nova feature sobre a beta -> 1.2.0-beta');

const linhaBreaking = calculateNextVersion({
  prevTag: 'v1.2.0-beta',
  commits: ['feat!: muda o protocolo'],
  channel: 'beta',
});
console.assert(
  linhaBreaking.nextVersion === '2.0.0-beta',
  'breaking change sobre a beta -> 2.0.0-beta'
);

// A virada de formato: a proxima release conta a partir da ultima numerada.
const viradaDeFormato = calculateNextVersion({
  prevTag: 'v3.1.1-beta001',
  commits: ['fix: ajuste qualquer'],
  channel: 'beta',
});
console.assert(
  viradaDeFormato.nextVersion === '3.1.2-beta',
  'a beta seguinte a uma numerada sai como 3.1.2-beta'
);

// Promover a última beta publica exatamente os números dela.
console.assert(promoteBetaTag('v1.2.0-beta') === '1.2.0', 'promoção usa os números da beta');
console.log('✔ Numeração a partir da última release validada com sucesso! (#378)');

// 6. Um bump por commit, não um por release (#465)
//
// Antes, a release inteira ganhava um único bump: o do tipo mais alto que
// aparecesse no intervalo. Um PR com três correções movia um patch só, e o
// squash piorava isso, porque colapsava o PR inteiro num commit e só o título
// era lido. Agora cada commit descrito no intervalo move o número.

// Uma mensagem simples é um commit só.
console.assert(splitCommitEntries('fix: algo').length === 1, 'mensagem simples é um commit');
console.assert(splitCommitEntries('').length === 0, 'mensagem vazia não gera commit');

// A mensagem de squash que o GitHub escreve: título + a lista dos commits.
const squash = [
  'fix: varias correcoes (#469)',
  '',
  '* fix: primeira correcao',
  '',
  'Um corpo qualquer explicando a primeira.',
  '',
  '* fix: segunda correcao',
  '',
  '* fix: terceira correcao',
  '',
  'Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>',
].join('\n');
console.assert(splitCommitEntries(squash).length === 3, 'o squash rende os 3 commits que carrega');
console.assert(
  collectBumps([squash]).join(',') === 'patch,patch,patch',
  'os 3 commits do squash valem 3 patches'
);
// O cenário exato da issue: 1.0.0 com 3 bugs vira 1.0.3.
console.assert(
  calculateNextVersion({ prevTag: 'v1.0.0', commits: [squash] }).nextVersion === '1.0.3',
  '3 correcoes num PR levam 1.0.0 a 1.0.3'
);

// O título do squash não pode ser contado junto com os itens, senão o mesmo
// trabalho bumparia duas vezes.
console.assert(
  splitCommitEntries('fix: uma coisa (#1)\n\n* fix: uma coisa').length === 1,
  'o título do squash é ignorado quando os itens estão presentes'
);

// 2 features e 3 correções no mesmo PR, na ordem em que foram feitas.
const squashMisto = [
  'feat: pacote de mudancas (#470)',
  '',
  '* feat: primeira feature',
  '* feat: segunda feature',
  '* fix: primeiro bug',
  '* fix: segundo bug',
  '* fix: terceiro bug',
].join('\n');
console.assert(
  calculateNextVersion({ prevTag: 'v1.0.0', commits: [squashMisto] }).nextVersion === '1.2.3',
  '2 features e 3 correcoes levam 1.0.0 a 1.2.3'
);

// A ordem importa, porque os bumps são aplicados em sequência.
console.assert(applyBumps('1.0.0', ['patch', 'minor']) === '1.1.0', 'o minor zera o patch anterior');
console.assert(applyBumps('1.0.0', ['minor', 'patch']) === '1.1.1', 'o patch soma sobre o minor');
console.assert(applyBumps('1.0.0', []) === '1.0.1', 'sem commits reconhecidos ainda anda um patch');
console.assert(applyBumps('v1.8.0-beta', ['patch', 'patch']) === '1.8.2', 'aplica sobre uma beta');

// Classificação de um commit isolado, com ou sem o marcador de lista.
console.assert(bumpTypeForEntry('* feat: x') === 'minor', 'item de lista com feat é minor');
console.assert(bumpTypeForEntry('- fix(ui): x') === 'patch', 'item de lista com fix é patch');
console.assert(bumpTypeForEntry('* feat!: x') === 'major', 'item de lista com ! é major');
console.assert(bumpTypeForEntry('* feat!(chat): x') === 'major', 'marcador antes do escopo permanece major');
console.assert(bumpTypeForEntry('- fix(chat)!: x') === 'major', 'marcador convencional depois do escopo permanece major');
console.assert(
  bumpTypeForEntry('* refactor: x\n\nBREAKING CHANGE: muda tudo') === 'major',
  'BREAKING CHANGE no corpo do item é major'
);
console.assert(bumpTypeForEntry('sem tipo nenhum') === 'patch', 'commit sem tipo é patch');

// O breaking change de um item não pode contaminar os outros: o bloco de cada
// commit vai até o item seguinte.
const squashComBreaking = [
  'feat: mudancas (#471)',
  '',
  '* fix: correcao comum',
  '',
  '* feat!: muda o protocolo',
  '',
  'BREAKING CHANGE: cliente e servidor precisam subir juntos.',
].join('\n');
console.assert(
  collectBumps([squashComBreaking]).join(',') === 'patch,major',
  'o breaking change fica no item a que pertence'
);
console.assert(
  calculateNextVersion({ prevTag: 'v1.0.0', commits: [squashComBreaking] }).nextVersion === '2.0.0',
  'o major zera o patch que veio antes dele'
);
console.assert(
  determineBumpType([squashComBreaking]) === 'major',
  'determineBumpType continua reportando o tipo mais alto'
);

// O PR #714 usou ! antes do escopo; descartar esse item perdia também seu footer.
for (const header of ['feat!(chat)', 'feat(chat)!']) {
  for (const footer of ['', '\n\nBREAKING CHANGE: protocolo 27.\n\n']) {
    const protocolSquash = [
      `${header}: editor Markdown (#714)`,
      '',
      `* ${header}: editor e protocolo 27${footer}`,
      '* fix(ci): comandos nativos',
      '* test(ci): aguardar captura',
      '* fix(build): espelho fixado',
      '* fix(ci): barra de formatacao',
    ].join('\n');
    console.assert(splitCommitEntries(protocolSquash).length === 5, `${header}: nenhum item perdido no squash`);
    console.assert(
      collectBumps([protocolSquash]).join(',') === 'major,patch,patch,patch,patch',
      `${header}: exatamente um major seguido de quatro patches, com ou sem footer`
    );
    console.assert(
      calculateNextVersion({ prevTag: 'v29.2.2-beta', commits: [protocolSquash], channel: 'beta' }).nextVersion === '30.0.4-beta',
      `${header}: squash do protocolo deve produzir 30.0.4-beta, nao 29.2.6-beta`
    );
  }
}

// Prosa no corpo não pode virar commit. Só listas com um tipo conhecido contam.
const comProsa = [
  'fix: uma correcao (#472)',
  '',
  '- o problema acontecia ao sair da chamada',
  '- a correcao limpa o estado no teardown',
].join('\n');
console.assert(
  collectBumps([comProsa]).length === 1,
  'bullets de prosa não são contados como commits'
);

console.log('✔ Bump por commit validado com sucesso! (#465)');

// 7. Só gera versão o que chega ao usuário
//
// Todo commit contava, então um PR só de testes ou de CI publicava uma beta
// sem nada novo para quem usa o Monky (o #764 virou a v36.8.12-beta). A regra
// agora é a das notas de release: conta o commit que muda arquivo de aplicação
// ou de dependência, ou que traz uma nota nova. O resto não publica e também
// não soma no número da próxima versão.
const arquivos = (...changes) => changes.map(([status, path]) => ({ status, path }));
const somenteTestes = {
  hash: 'aaa0767',
  message: 'test: estabilizar testes DOM (#767)\n\n* test: esperar o vídeo recriado\n\n* test: falhar quando a rota troca',
  files: arquivos(['M', 'apps/client/test/automaticScreenPipSmoke.cjs'],
    ['M', 'packages/bot-sdk/test-browser/voiceRendererSmoke.cjs']),
};
const somenteCi = {
  hash: 'bbb0764',
  message: 'fix(ci): não travar a suíte nativa (#764)',
  files: arquivos(['M', '.github/workflows/ci.yml'], ['M', 'scripts/test-native-ci.js'],
    ['M', 'apps/client/native/screen-share/test/nativeRtcProcess.test.cjs']),
};
const correcao = {
  hash: 'ccc0790',
  message: 'fix(voz): corrige o eco',
  files: arquivos(['M', 'apps/client/src/renderer/core/webrtc/RemoteMediaRouter.ts'], ['A', 'release-notes/790-eco.json']),
};
console.assert(!isReleasableCommit(somenteTestes), 'PR só de testes não gera versão');
console.assert(!isReleasableCommit(somenteCi), 'PR só de CI e scripts não gera versão');
console.assert(isReleasableCommit(correcao), 'mudança no app gera versão');
console.assert(
  !isReleasableCommit({ files: arquivos(['M', 'docs-site/guia.md'], ['M', 'apps/light/README.md'], ['M', 'AGENTS.md']) }),
  'documentação, mesmo dentro de apps/, não gera versão'
);
console.assert(isReleasableCommit({ files: arquivos(['M', 'package-lock.json']) }), 'dependência gera versão');
console.assert(
  isReleasableCommit({ files: arquivos(['M', 'patches/h264-profile-level-id+2.3.3.patch']) }),
  'patch de dependência gera versão'
);
console.assert(isReleasableCommit({ files: arquivos(['D', 'apps/server/src/antigo.ts']) }), 'apagar arquivo do app gera versão');
// A nota nova é o jeito de publicar uma mudança de build ou CI que o usuário precisa.
console.assert(
  isReleasableCommit({ files: arquivos(['M', '.github/workflows/release.yml'], ['A', 'release-notes/791-assinatura.json']) }),
  'nota nova gera versão mesmo sem arquivo do app'
);
console.assert(!isReleasableCommit({ files: arquivos(['M', 'release-notes/790-eco.json']) }), 'editar nota antiga não gera versão');
console.assert(!isReleasableCommit({ files: [] }), 'commit sem mudança não gera versão');
// Sem a lista de arquivos, o commit continua contando, como todos contavam.
console.assert(isReleasableCommit('fix: só a mensagem'), 'mensagem sem arquivos continua contando');
console.assert(isReleasableCommit({ message: 'fix: arquivos desconhecidos' }), 'commit sem lista de arquivos continua contando');

const semRelease = calculateNextVersion({ prevTag: 'v38.4.0', commits: [somenteTestes, somenteCi], channel: 'beta' });
console.assert(semRelease.shouldRelease === false, 'só testes e CI: nenhuma release');
console.assert(semRelease.skippedCommits.length === 2, 'os dois commits ficam de fora da conta');
console.assert(calculateNextVersion({ prevTag: 'v38.4.0', commits: [] }).shouldRelease === false, 'sem commits desde a tag, nenhuma release');
console.assert(calculateNextVersion({ prevTag: 'v1.0.0', commits: ['fix: x'] }).shouldRelease === true, 'mensagens simples continuam gerando release');

// Quando a próxima mudança do app sai, o que não publicou não soma. Antes, os
// dois itens do squash de testes e o commit de CI empurravam mais 3 patches.
const proxima = calculateNextVersion({ prevTag: 'v38.4.0', commits: [somenteTestes, somenteCi, correcao], channel: 'beta' });
console.assert(proxima.shouldRelease === true, 'a correção do app gera a release');
console.assert(proxima.nextVersion === '38.4.1-beta', `só a correção conta: 38.4.1-beta, não 38.4.4-beta (veio ${proxima.nextVersion})`);

// A leitura do git: os arquivos de cada commit, inclusive merge e nomes incomuns.
const repo = mkdtempSync(join(tmpdir(), 'monky-versioning-'));
try {
  let segundo = 0;
  const git = (...args) => {
    segundo += 1;
    const date = `2026-01-01T00:${String(Math.floor(segundo / 60)).padStart(2, '0')}:${String(segundo % 60).padStart(2, '0')}Z`;
    return execFileSync('git', [
      '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.autocrlf=false',
      '-c', `core.hooksPath=${join(repo, 'sem-hooks')}`, ...args,
    ], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, GIT_AUTHOR_NAME: 'Teste', GIT_AUTHOR_EMAIL: 'teste@example.com',
        GIT_COMMITTER_NAME: 'Teste', GIT_COMMITTER_EMAIL: 'teste@example.com',
        GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      },
    });
  };
  const commit = (message, file, content) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
    git('add', '-A');
    git('commit', '-q', '-m', message);
  };
  git('init', '-q', '-b', 'main');
  commit('chore: início', 'README.md', 'oi');
  git('tag', 'v1.0.0');
  commit('test: estabilizar smoke\n\nCorpo com linha em branco.\n\n* fix: item de squash que não conta', 'apps/client/test/smoke.cjs', '1');
  commit('fix(ci): workflow', '.github/workflows/ci.yml', 'on: push');
  commit('fix: nome com acento e espaço', 'apps/client/src/ação com espaço.ts', 'export {};');
  git('checkout', '-q', '-b', 'ramo');
  commit('feat: no ramo', 'packages/shared/src/novo.ts', 'export {};');
  git('checkout', '-q', 'main');
  git('merge', '-q', '--no-ff', 'ramo', '-m', 'Merge branch ramo');
  commit('docs: nota nova', 'release-notes/1-nota.json', '{}');
  commit('docs: corrige a nota', 'release-notes/1-nota.json', '{"x":1}');

  const lidos = getGitCommitsSinceTag('v1.0.0', { cwd: repo });
  const assunto = (lido) => lido.message.split('\n')[0];
  console.assert(
    lidos.map(assunto).join(' | ') === 'test: estabilizar smoke | fix(ci): workflow | fix: nome com acento e espaço | ' +
      'feat: no ramo | Merge branch ramo | docs: nota nova | docs: corrige a nota',
    `commits lidos do mais antigo ao mais novo: ${lidos.map(assunto).join(' | ')}`
  );
  console.assert(lidos[0]?.message.includes('Corpo com linha em branco.\n\n* fix:'), 'o corpo inteiro fica no mesmo commit');
  console.assert(lidos.every((lido) => /^[0-9a-f]{7,}$/.test(lido.hash)), 'cada commit traz o hash para o log');
  const mudancas = (lido) => (lido?.files ?? []).map(({ status, path }) => `${status} ${path}`).join(', ');
  console.assert(mudancas(lidos[0]) === 'A apps/client/test/smoke.cjs', `arquivos do commit de teste: ${mudancas(lidos[0])}`);
  console.assert(mudancas(lidos[2]) === 'A apps/client/src/ação com espaço.ts', `nome com acento e espaço: ${mudancas(lidos[2])}`);
  console.assert(mudancas(lidos[4]) === 'A packages/shared/src/novo.ts', `o merge traz o que mudou no ramo: ${mudancas(lidos[4])}`);
  console.assert(mudancas(lidos[6]) === 'M release-notes/1-nota.json', `nota editada: ${mudancas(lidos[6])}`);
  console.assert(
    lidos.map((lido) => (isReleasableCommit(lido) ? 'sim' : 'não')).join(',') === 'não,não,sim,sim,sim,sim,não',
    `quais commits geram versão: ${lidos.map((lido) => isReleasableCommit(lido)).join(',')}`
  );

  // A promoção confere a tag no git de verdade, e o CLI para antes de escrever
  // qualquer saída quando a tag digitada não é uma beta existente.
  git('tag', 'v1.1.0-beta');
  console.assert(validatePromotionTag('v1.1.0-beta', { cwd: repo }) === '1.1.0', 'a beta existente é promovida');
  for (const tag of ['v1.2.0-beta', 'v1.0.0']) {
    let recusada = false;
    try { validatePromotionTag(tag, { cwd: repo }); } catch { recusada = true; }
    console.assert(recusada, `${tag} não é uma beta existente para promover`);
  }
  const calcular = (promoteTag) => {
    const saida = join(repo, `saida-${Math.random().toString(16).slice(2)}.txt`);
    writeFileSync(saida, '');
    const resultado = spawnSync(process.execPath, [fileURLToPath(new URL('./calculate-version.js', import.meta.url))], {
      cwd: repo, encoding: 'utf8',
      env: { ...process.env, PROMOTE_TAG: promoteTag, RELEASE_CHANNEL: 'beta', GITHUB_OUTPUT: saida },
    });
    const escrito = readFileSync(saida, 'utf8');
    rmSync(saida);
    return { ...resultado, escrito };
  };
  const promovida = calcular('v1.1.0-beta');
  console.assert(promovida.status === 0, `a promoção válida passa: ${promovida.stderr}`);
  console.assert(
    promovida.escrito === 'version=1.1.0\nprev_tag=v1.0.0\nbump_type=promote\nchannel=stable\nprerelease=false\nrelease=true\n',
    `saída da promoção: ${JSON.stringify(promovida.escrito)}`
  );
  for (const tag of ['1.1.0-beta', 'v1.1.0-beta"; touch pwned; "', 'v1.1.0-beta\nrelease=false']) {
    const recusada = calcular(tag);
    console.assert(recusada.status === 1 && recusada.stderr.includes('::error::'), `o CLI recusa ${JSON.stringify(tag)}`);
    console.assert(recusada.escrito === '', `nada vai para o GITHUB_OUTPUT com ${JSON.stringify(tag)}`);
  }
} finally {
  rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

// O filtro do release.yml só evita execuções sem efeito. Ele precisa cobrir todo
// arquivo que a regra conta, senão uma mudança do app ficaria sem release.
const raiz = fileURLToPath(new URL('..', import.meta.url));
const workflow = readFileSync(join(raiz, '.github', 'workflows', 'release.yml'), 'utf8');
const bloco = /^ {4}paths:\r?\n((?: {6}- '[^']+'\r?\n)+)/m.exec(workflow);
console.assert(bloco, 'o push do release.yml declara o filtro paths');
// Os filtros usam só ** (qualquer coisa) e * (dentro de um diretório).
const globParaRegex = (glob) => {
  const pattern = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '\0').replace(/\*/g, '[^/]*').replace(/\0/g, '.*');
  return new RegExp(`^${pattern}$`);
};
const filtros = bloco ? [...bloco[1].matchAll(/'([^']+)'/g)].map(([, glob]) => globParaRegex(glob)) : [];
const contados = execFileSync('git', ['ls-files', '-z'], { cwd: raiz, encoding: 'utf8' }).split('\0')
  .filter((file) => file && (requiresClientNote(file) || isClientNoteFile(file)));
const descobertos = contados.filter((file) => !filtros.some((filtro) => filtro.test(file)));
console.assert(
  contados.length > 0 && descobertos.length === 0,
  `arquivos que geram versão fora do filtro do release.yml: ${descobertos.slice(0, 5).join(', ')}`
);

console.log('✔ Só o que chega ao usuário gera versão');

if (failures > 0) {
  console.error(`=== ${failures} asserção(ões) de versionamento falharam ===`);
  process.exit(1);
}

console.log('=== Todos os testes de versionamento passaram com sucesso! ===');
