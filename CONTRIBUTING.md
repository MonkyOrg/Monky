# Contribuindo com o Monky

***Português** · [English](CONTRIBUTING.en.md)*

Obrigado pelo interesse! Este documento explica como propor ideias, votar no que
vem primeiro e — se você quiser codar — como abrir um PR que entra sem atrito.

O Monky é MIT e o desenvolvimento acontece todo em público, nas
[Issues](https://github.com/MonkyOrg/Monky/issues).

---

## 🗳️ A forma mais fácil de ajudar: dizer o que você quer

Você **não precisa saber programar** para influenciar o rumo do projeto. O que
entra em cada ciclo é decidido pelos votos da comunidade.

### Propor uma ideia

Abra uma discussão em
**[Discussions › Ideas](https://github.com/MonkyOrg/Monky/discussions/categories/ideas)**.

Duas regras que fazem a votação funcionar:

1. **Procure antes de postar.** Se a ideia já existe, vote nela em vez de abrir
   outra — duas propostas iguais dividem os votos e as duas perdem.
2. **Uma ideia por discussão.** Numa lista com cinco pedidos ninguém consegue
   dizer que concorda com o terceiro e discorda do quinto.

### Votar

Use o **botão de upvote** (⬆️) da discussão. É ele que conta — reações 👍 nos
comentários não entram no ranking.

Vote com honestidade: votos inflados por contas novas ou pedidos de mutirão são
descartados. O objetivo é medir o que as pessoas realmente querem, não quem
consegue mobilizar mais gente.

### O ciclo: como um voto vira código

Toda ideia carrega um label que diz em que pé ela está:

| Label | Significa |
|---|---|
| `ideia` | Aberta para votos e discussão |
| `planejado` | Selecionada — já virou issue |
| `em-andamento` | Alguém está implementando |
| `entregue` | Está em uma release publicada |
| `fora-de-escopo` | Não vamos fazer — sempre com o motivo explicado |

**Na primeira semana de cada mês**, as ideias em votação são revisadas. As **três
mais votadas** que tiverem **pelo menos 5 votos** são selecionadas: viram issues
com escopo e critérios de aceite e recebem o label `planejado`. Dali seguem o
fluxo normal: implementação → PR → release → validação → entrega.

O piso de 5 votos existe para o ciclo não promover ruído em meses parados — se
nenhuma ideia alcançar o piso, nenhuma é selecionada e todas continuam
acumulando votos para o mês seguinte. Votos não zeram entre ciclos.

Uma ideia não selecionada **não é recusada** — ela continua em votação. Só recebe
`fora-de-escopo` quando há uma decisão explícita de não fazer, sempre com o
motivo escrito na discussão.

Duas coisas que assumimos como compromisso:

- **Voto alto não é promessa automática.** Uma ideia muito votada pode ser
  recusada se conflitar com o que o Monky é — P2P, self-hosted, sem
  servidor central e sem coleta de dados. Quando isso acontecer, o motivo é
  escrito na discussão, não deixamos morrer no silêncio.
- **O status volta para a discussão.** Se nada nunca muda de label, a votação
  vira teatro e as pessoas param de votar. Fechar esse ciclo é obrigação de quem
  mantém o projeto.

### Reportar um bug

Bugs começam em **[Discussions › Bug Reports](https://github.com/MonkyOrg/Monky/discussions/categories/bug-reports)**, não em Issues.

O caminho é: você relata → alguém do projeto confirma que reproduz → vira uma
issue com o label `bug` e entra na fila de correção.

Esse passo de confirmação existe para separar defeito de configuração de rede,
de versão antiga ou de mal-entendido — coisas que consomem a fila sem serem
bugs. Relate mesmo assim quando estiver em dúvida: descobrir que não era bug
também é resultado.

**Não há votação em bug.** A categoria existe para triagem, não para disputa de
popularidade: um problema confirmado é corrigido independente de quantas
pessoas votaram nele. Voto vale para ideias, onde a pergunta é *o que fazer
primeiro* — num bug a pergunta é apenas *isso está quebrado?*.

---

## 💻 Contribuindo com código

### Rodando o projeto

Requisitos: **Node.js 22+** e as ferramentas de build nativas da sua plataforma
(o módulo de captura de áudio de tela é C++: MSVC no Windows, Xcode Command Line
Tools no macOS).

```bash
git clone https://github.com/MonkyOrg/Monky.git
cd Monky
npm install
npm run build
npm start
```

Durante o desenvolvimento, em dois terminais:

```bash
npm run dev:server   # servidor WebSocket + SQLite
npm run dev:client   # app Electron com rebuild
```

Testes:

```bash
npm run test --workspace=apps/server   # testes do servidor
npm test                               # tudo, incluindo os testes de versionamento
```

O Monky CLI vive em `apps/server/src/cli/` e é empacotado à parte:

```bash
npm run pack:cli     # gera o tarball que vai para a release
```

Para experimentar o CLI sem mexer nos seus servidores reais, aponte a variável
`MONKY_HOME` para uma pasta descartável — é lá que fica o registro de servidores
da máquina.

### Antes de começar a codar

**Trabalhe a partir de uma issue.** Se o que você quer fazer ainda não é uma
issue, abra a discussão primeiro — evita você investir tempo em algo que seria
recusado no PR por estar fora do escopo do projeto.

**Se a issue não estiver clara, pergunte antes.** Requisitos ambíguos, critérios
de aceite vagos ou decisões de design em aberto viram retrabalho garantido.
Nunca assuma — comente na issue e espere a resposta.

**Não pegue issues marcadas como bloqueadas.** Se você acha que uma delas
deveria andar, comente nela explicando o porquê antes de começar.

### Abrindo o PR

A `main` é protegida — todo merge passa por PR com squash.

**Ramifique sempre da `main` atualizada**, nunca da branch em que você estava:

```bash
git checkout main && git pull        # antes de criar a branch
git checkout -b feat/minha-mudanca
# ... commits ...
git push -u origin feat/minha-mudanca
```

Ramificar de uma branch com PR aberto faz o seu PR arrastar os commits dela no
diff, e os dois passam a depender um do outro para mergear. Se a sua mudança
realmente depende de outro PR aberto, combine o empilhamento antes de ramificar.

Prefixos de branch e commit seguem [Conventional Commits](https://www.conventionalcommits.org/):
`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `ci:`. Referencie a issue no
título quando houver: `fix(voice): restaura microfone ao des-ensurdecer (#89)`.

**O tipo do commit decide a versão publicada** — não é só convenção de nome. O
workflow de release lê as mensagens desde a última tag e calcula o SemVer
sozinho:

| Mensagem do commit | Efeito na versão |
|---|---|
| `feat:`, `feature:`, `minor:` | **minor** — `1.X.0` |
| qualquer tipo com `!` (`feat!:`, `fix!:`, …), `major:`, ou `BREAKING CHANGE:` no corpo | **major** — `X.0.0` |
| qualquer outra coisa (`fix:`, `docs:`, `chore:`, `refactor:`…) | **patch** — `1.0.X` |

Repare que **patch é o padrão**: todo merge na `main` publica alguma versão, nem
que seja um commit de documentação.

**Cada commit move o número, um de cada vez.** A conta não pega só o tipo mais
alto do intervalo: um PR com três `fix:` leva `1.0.0` a `1.0.3`, e um com duas
`feat:` seguidas de três `fix:` leva a `1.2.3`. Como os saltos são aplicados na
ordem em que os commits foram feitos, a ordem importa — uma `feat:` depois de um
`fix:` zera o patch que ele tinha acabado de somar.

Isso vale mesmo com **squash**, que é como a `main` recebe todo PR. O merge
colapsa o PR num commit só, mas o GitHub mantém a lista dos commits originais no
corpo da mensagem, e é ela que é lida. Se você reescrever esse corpo à mão e
apagar a lista, o PR inteiro volta a valer um salto só — o do título.

A conta parte da **última release publicada, betas inclusive**. Ou seja, uma
`feat:` mergeada logo depois da beta `1.1.0-beta` sai como `1.2.0-beta`, e não
como um segundo beta da mesma `1.1.0`.

Betas são publicadas como `vX.Y.Z-beta`, sem contador: como a base muda a cada
release, não existe uma segunda beta da mesma versão para numerar.

Se a sua mudança quebra a compatibilidade entre cliente e servidor, ela
**precisa** sair como major. Marcar uma breaking change como `feat:` publica uma
minor, e quem atualizar só um dos lados fica sem conseguir conectar.

### Notas da versão: dois públicos, dois textos

O **changelog técnico do GitHub** continua vindo dos commits: mantenha os
detalhes, as referências `#123:` no corpo e as informações de compatibilidade.
O **resumo mostrado no app** vem de arquivos separados, escritos para quem usa
o Monky, não para quem desenvolve.

Para uma mudança visível no app, adicione um arquivo novo em
`release-notes/`, como `release-notes/617-copy-version.json`:

```json
{
  "group": "novidades",
  "pt-BR": "Quer compartilhar sua versão do Monky? Clique nela para copiar. Sem decorar os números!",
  "en": "Need to share your Monky version? Click it to copy. No need to memorize the numbers!"
}
```

- Use `novidades`, `correcoes` ou `outros`; grupos vazios não aparecem.
- Escreva nos **dois idiomas**, com até 280 caracteres por texto. Conte o que a
  pessoa pode fazer ou o incômodo que deixou de existir. Seja breve, natural e
  levemente divertido, sem inventar benefícios.
- Não inclua números de issues, links, código ou instruções de implementação.
  Mudanças apenas internas podem ficar só no changelog técnico.
- Mantenha os arquivos publicados: **não os renomeie nem reaproveite** para uma
  mudança nova. O gerador lê os arquivos adicionados entre a tag anterior e o
  `HEAD`; promover uma beta usa a tag estável anterior e reúne as notas das betas.
  Arquivos ainda não commitados não entram na geração de uma release.

`node scripts/test-changelog.js` valida o formato e os arquivos de notas.
`scripts/generate-changelog.js` publica as traduções em um bloco de dados oculto
na descrição da release, separado do `Changelog` técnico. O cliente continua
buscando a tag instalada pela API do GitHub, sem serviço de tradução.
Releases antigas exibem uma contagem de mudanças identificada como resumo e
um botão para os detalhes no GitHub; não tentamos traduzir commits automaticamente.

### O que o CI verifica

Todo PR roda o workflow de **CI**. Além do build, ele tem verificações que barram
o merge e costumam pegar de surpresa quem não as conhece:

- **Build check (win/mac)** — build e empacotamento com `electron-builder --dir`,
  sem publicar. Pega regressão de módulo nativo antes do merge.
- **Docs traduzidos em sincronia** — toda página em `docs-site/` precisa do par
  PT/EN. Adicionar só um dos idiomas reprova o PR.
- **Mudança de protocolo exige release major** — mexer no `PROTOCOL_VERSION` sem
  marcar a mudança como major reprova. Cliente e servidor exigem igualdade
  exata, então subir o protocolo é sempre breaking change.
- **Slug dos templates de discussão** — confere que os templates continuam
  apontando para categorias que existem.

Um limite conhecido: **configuração de assinatura do macOS não é validável pelo
CI**, porque o `Build check (mac)` roda `--dir`, que pula a assinatura por
completo. Só a release exercita esse caminho.

### Descreva como testar

No PR (ou na issue), inclua duas seções em PT-BR:

- **Como foi implementado** — resumo técnico: arquivos e áreas alteradas,
  decisões relevantes.
- **Como testar** — passo a passo para o QA validar: cenários, resultado
  esperado e casos de borda.

Isso não é burocracia: quem valida a mudança testa a partir do **build
publicado**, não do seu ambiente. Sem o passo a passo, a validação trava.

### Depois do merge

O push na `main` dispara o workflow **Release** automaticamente, que builda e
publica a nova versão com os artefatos de Windows e macOS. A validação só
começa **depois que a release estiver publicada** — nunca só após o merge.

> 🤖 Se você é um agente de IA trabalhando neste repositório, o fluxo completo e
> obrigatório está em [`AGENTS.md`](AGENTS.md).

---

## 🧭 O que o Monky é (e o que não é)

Ajuda a calibrar propostas antes de escrevê-las:

- **É** um app de voz, vídeo, tela e chat **P2P** com servidor **self-hosted**,
  para grupos pequenos de amigos.
- **É** privado por construção: sem servidor central, sem conta obrigatória, sem
  telemetria, sem coleta de dados.
- **Não é** uma alternativa ao Discord em escala — o WebRTC mesh é ótimo para
  poucos participantes e ruim para dezenas.
- **Não é** um SaaS. Não haverá infraestrutura hospedada por nós que as pessoas
  precisem usar.

Propostas que exigem servidor central, cadastro ou coleta de dados vão contra a
razão de existir do projeto e serão recusadas — mesmo que sejam boas ideias em
abstrato.

---

## 📜 Licença

Ao contribuir, você concorda que sua contribuição será licenciada sob a
[licença MIT](LICENSE) do projeto.
