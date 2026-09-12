# Bots

O Monky possui um sistema completo de bots que permite automatizar tarefas, adicionar comandos personalizados e integrar serviços externos ao seu servidor.

## O que é um bot?

Um bot é um **processo externo** que se conecta ao servidor Monky via WebSocket, como qualquer outro usuário. A diferença é que bots:

- Autenticam com **token** em vez de senha
- Podem registrar **slash commands** (`/ping`, `/dado`, etc.)
- Aparecem com badge **BOT** na lista de membros
- Usam seu próprio nome e foto nas mensagens e nos formulários do chat
- Não contam no limite de usuários (têm limite próprio: `maxBots`)

O bot roda na **máquina dele** (VPS, nuvem, seu PC), não no servidor Monky. O servidor apenas roteia mensagens — todo o processamento fica no bot.

```
Usuário digita /ping
        ↓
Servidor Monky (roteia)
        ↓
Bot (processa) → ctx.reply('🏓 Pong!')
        ↓
Servidor Monky (entrega apenas a quem chamou)
        ↓
Usuário vê a resposta
```

## Duas formas de adicionar um bot

### 1. Manual (token)

Ideal para bots internos de um servidor específico.

1. No client, vá em **Configurações do Servidor → Bots**
2. Digite um nome, escolha uma foto se desejar e clique **Criar**
3. Copie o token (exibido **uma única vez**)
4. Use o token no código do bot para conectar

### 2. Via URL (Marketplace)

Ideal para bots distribuídos que servem múltiplos servidores.

1. O desenvolvedor do bot publica um **manifest HTTP** (nome, descrição, URL de registro)
2. No client, vá em **Configurações do Servidor → Bots**
3. Cole a URL do manifest no campo "Adicionar Bot via URL" e clique **Adicionar**
4. O servidor busca o manifest, cria o bot, e envia o token automaticamente
5. O bot auto-conecta e registra seus comandos

## Criando seu próprio bot

### Permissões e canais

Em **Configurações do Servidor → Cargos**, **Adicionar e gerenciar bots** controla quem pode cadastrar, configurar ou remover bots; **Executar comandos de bots** controla quem pode usar seus comandos e interações. A permissão de executar é habilitada inicialmente para membros e cargos existentes.

Ao criar ou editar um canal de texto, o switch **Permitir comandos de bots** vem ativado. Desativá-lo bloqueia comandos e respostas a formulários e seletores nesse canal, **inclusive para administradores**. Digitar `/` mostra o motivo do bloqueio. Alterações de permissões também afetam interações já abertas; mensagens e reações comuns continuam seguindo suas próprias permissões.

### Pré-requisitos

- **Node.js 18+**
- Cliente, servidor e SDK compatíveis com o **protocolo 13**
- O pacote `@monky/bot-sdk` da release correspondente

::: warning Atualização conjunta
O protocolo de comandos mudou: atualize **cliente, servidor e bot** juntos. Versões com protocolos diferentes não se conectam. No novo SDK, `ctx.args` contém valores tipados e `ctx.reply()` é privado; use `ctx.publish()` somente para resultados que devem aparecer para o canal.
:::

### Instalação do SDK

```bash
curl -fsSL https://monkyorg.github.io/install-bot-sdk.sh | bash
```

Para instalar uma versão beta:

```bash
curl -fsSL https://monkyorg.github.io/install-bot-sdk.sh | bash -s -- --beta
```

<details>
<summary>Instalação manual (sem o script)</summary>

Baixe o `.tgz` da versão desejada em [Releases](https://github.com/MonkyOrg/Monky/releases) e instale com:

```bash
npm install https://github.com/MonkyOrg/Monky/releases/download/vX.Y.Z/monky-bot-sdk-X.Y.Z.tgz
```

</details>

### CLI e pacote automático do bot

O SDK também fornece `monky-bot-sdk`, uma ferramenta de build que gera um `.tgz`
autocontido com o **CLI de gerenciamento já pronto**. Não copie o CLI do MonkyBot
para cada bot: declare a entrada e as opções no `package.json`.

```json
{
  "name": "@minha-org/meu-bot",
  "version": "1.0.0",
  "scripts": {
    "build": "tsc",
    "package": "monky-bot-sdk build",
    "cli": "monky-bot-sdk cli"
  },
  "monkyBot": {
    "cliName": "meu-bot",
    "displayName": "Meu Bot",
    "entry": "dist/index.js",
    "files": ["dist", "assets"],
    "modes": ["manual"]
  }
}
```

`npm run package` executa o script de compilação e gera
`release/meu-bot-1.0.0.tgz`, incluindo a entrada compilada, os recursos declarados,
o SDK e a árvore de dependências de produção realmente instalada. `files` aceita
arquivos e diretórios relativos, não globs; remova `assets` se não existir.
Dados de execução, `.env` real, `.keys` e registros autenticados não são material
de release. Dependências locais além de SDK/shared devem declarar seus próprios
arquivos de publicação em `package.files`.

Use `monky-bot-sdk build --version 1.1.0-beta --out release` para definir a versão
do artefato. `--skip-build` permite empacotar uma compilação já existente, mas
nunca substitui a validação da entrada e do SDK. Não coloque a ferramenta no
próprio script `build`: mantenha compilação e `package` separados para não criar
recursão.

No servidor, instale o `.tgz` com npm:

```text
npm install -g --offline --ignore-scripts meu-bot-1.0.0.tgz
meu-bot setup
meu-bot start
meu-bot status
meu-bot logs
```

O CLI oferece `setup`, `start`, `stop`, `restart`, `status`, `logs` e `config`,
com um processo PM2 e configuração isolados por nome do bot. `start --foreground`
roda sem PM2 para desenvolvimento. `npm run cli -- setup` usa o mesmo CLI no
checkout local, depois de compilar.

No modo manual, `setup` pede o servidor e o **nome da variável de ambiente**
do token, não grava seu valor na configuração. Disponibilize `MONKY_BOT_TOKEN`
(ou a variável escolhida) no ambiente do operador/serviço antes de `start` e
`restart`. Para automação, use
`setup --non-interactive --server-url ws://localhost:3000 --token-env MONKY_BOT_TOKEN`.
Configuração e identidade ficam em `~/.<cliName>`, fora do pacote;
`MONKY_BOT_CLI_HOME` muda a pasta-base, preservando o subdiretório de cada bot.

O CLI gera/reutiliza a identidade e fornece `MONKY_BOT_PUBLIC_KEY`,
`MONKY_SERVER_URL`, `MONKY_BOT_TOKEN` e `MONKY_BOT_NAME` ao processo. A entrada do
bot deve consumir essas variáveis. Declare `marketplace` em `modes` somente se
essa entrada também implementar o fluxo `MONKY_SERVE`/`bot.serve()`.

### Atualizações opcionais do CLI

`update` e a ativação de `autoupdate` **só funcionam quando o autor configura
explicitamente GitHub Releases** na definição usada no build:

```json
{
  "monkyBot": {
    "releases": {
      "url": "https://github.com/minha-org/meu-bot/releases",
      "assetName": "meu-bot-{version}.tgz",
      "tokenEnv": "GH_TOKEN"
    }
  }
}
```

Esse trecho complementa a configuração anterior. Sem `releases`, o SDK não
deduz uma origem de `repository`, de `git origin`, do repositório do SDK ou do
registro npm. Um link inválido gera erro, não habilita uma origem alternativa.

`update --check` apenas consulta; `update` usa stable e `update --beta` inclui
pré-releases. A seleção respeita a versão semântica, sem downgrade ou reinstalação
de versão igual. O auto-update segue o canal instalado, salvo `--beta` explícito.
Nenhum desses comandos publica ou promove releases.

Uma instalação de atualização só é permitida pelo CLI instalado globalmente no
prefixo npm atual; checkouts e instalações locais permitem apenas `--check`.
O SDK valida nome, versão e CLI do arquivo recebido e instala o pacote autocontido
offline, sem executar scripts de instalação. Use `update --yes` sem terminal
interativo. Arquivos de configuração e identidade permanecem fora da instalação.

Para um repositório privado, disponibilize o token de leitura na variável de
ambiente indicada, nunca dentro do pacote ou da URL. `autoupdate off` e `status`
continuam disponíveis para administrar um agendamento antigo mesmo se a origem
for removida de uma versão posterior.

### Exemplo básico

```ts
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  serverUrl: 'ws://seu-servidor:3000',
  token: 'TOKEN_DO_BOT',
  publicKey: 'SUA_CHAVE_ED25519_HEX',
});

bot.command({
  name: 'ping',
  description: 'Responde com pong!',
  handler: (ctx) => ctx.reply('🏓 Pong!'),
});

bot.command({
  name: 'dado',
  description: 'Rola um dado',
  options: [
    { name: 'lados', description: 'Número de lados', type: 'integer', min: 2, max: 100, placeholder: 'Ex.: 20' },
  ],
  handler: (ctx) => {
    const sides = typeof ctx.args.lados === 'number' ? ctx.args.lados : 6;
    const result = Math.floor(Math.random() * sides) + 1;
    ctx.reply(`🎲 Resultado: **${result}**`);
  },
});

bot.on('error', (error) => console.error(error));
bot.connect();
```

### Anatomia de um comando

```ts
bot.command({
  name: 'nome',               // Nome do slash command (sem a /)
  description: 'Descrição',    // Exibida no dropup de comandos
  options: [                   // Parâmetros (opcional)
    {
      name: 'param',
      description: 'Descrição do parâmetro',
      type: 'string',         // Tipo do parâmetro
      required: true,          // Obrigatório?
    },
  ],
  handler: (ctx) => {
    // ctx.channelId  — canal onde foi invocado
    // ctx.invokerId  — ID do usuário
    // ctx.invokerNickname — apelido
    // ctx.serverId   — ID do servidor (útil em modo multi-servidor)
    // ctx.args       — argumentos { nome: string | number | boolean }
    // ctx.locale     — idioma de quem chamou ('pt-BR' ou 'en')
    // ctx.reply()    — responde só para quem chamou, dentro do chat
    // ctx.publish()  — publica explicitamente um resultado no canal
    // ctx.prompt()   — aguarda um formulário privado; pode ser chamado em etapas
    // ctx.choose()   — aguarda uma opção privada, por botões ou dropdown
    // ctx.downloadSound() — aguarda um download local autorizado de soundboard
    // ctx.signal     — aborta ao cancelar, desconectar, expirar ou concluir
  },
});
```

### Parâmetros guiados no chat

Ao digitar `/`, o menu mostra os comandos utilizados com mais frequência e os agrupa por bot. Cada item identifica o comando, sua descrição e o bot responsável. Ao navegar, os parâmetros obrigatórios e a quantidade de opcionais ajudam a escolher o comando.

Ao selecionar um comando com parâmetros, o compositor compacto identifica **qual bot e comando** estão selecionados e apresenta campos nomeados com descrição e placeholder. Parâmetros opcionais podem ser adicionados quando necessários. O envio usa os nomes declarados em `options`; não é necessário juntar valores com vírgulas. Comandos sem parâmetros que não solicitam download local, como `/ping` e `/enquete`, iniciam a interação imediatamente ao serem selecionados.

A frequência de uso é local e separada por servidor e identidade. Apenas contagens e recência são guardadas, nunca os valores preenchidos nos parâmetros.

| Tipo | Controle | Valor em `ctx.args` |
|------|----------|--------------------|
| `string` | Texto; `choices` para seleção fixa ou `autocomplete: true` para sugestões dinâmicas | `string` |
| `integer` | Número inteiro, com limites opcionais `min` e `max` | `number` |
| `boolean` | Switch | `boolean` |
| `user` | Seleção de membro | ID do membro (`string`) |

`required: true` impede enviar sem preencher. Um parâmetro opcional não preenchido é omitido; valores válidos como `false` e `0` não são descartados. O servidor valida os parâmetros novamente antes de chamar o bot. Dois bots podem ter um comando com o mesmo nome: a seleção no chat mantém o bot escolhido.

Os obrigatórios aparecem ao selecionar o comando; todos precisam estar válidos para liberar a execução. Os opcionais restantes ficam em `+N`: clique ali ou pressione **Seta direita no fim do último campo** para listar os parâmetros que podem ser adicionados. Selecionar um deles abre seu preenchimento, sem executar o comando. Dentro do texto, a seta continua movendo o cursor normalmente.

### Autocomplete antes de executar

Uma opção `string` pode declarar `autocomplete: true`. Nesse caso, o comando precisa de um callback `autocomplete`; não combine essa opção com `choices` estático.

```ts
const catalog = [
  { label: 'Bell', value: 'bell', description: 'Short bell sound' },
  { label: 'Drum', value: 'drum', description: 'Single drum hit' },
];

bot.command({
  name: 'findsound',
  description: 'Find a sound',
  options: [
    { name: 'sound', description: 'Sound', type: 'string', required: true, autocomplete: true },
  ],
  autocomplete: ({ query }) =>
    catalog.filter((choice) => choice.label.toLowerCase().includes(query.toLowerCase())),
  handler: (ctx) => {
    ctx.reply(ctx.locale === 'en' ? `Selected: ${ctx.args.sound}` : `Selecionado: ${ctx.args.sound}`);
  },
});
```

O callback recebe `{ query, optionName, args, locale, serverId, signal }` e pode retornar uma lista ou uma `Promise` de `SelectionChoice` (`{ label, value, description?, audio? }`). `args` contém somente as outras opções já preenchidas e válidas; obrigatórios ainda ausentes são permitidos nessa etapa. `query` contém o texto da opção editada.

No exemplo, o catálogo é local ao bot. Para uma fonte externa, substitua a filtragem por uma busca de **metadados**, passe `signal` ao `fetch` e valide o retorno. O callback não recebe uma invocação nem métodos de resposta/download. As consultas são enviadas ao bot selecionado enquanto a pessoa digita; não são publicadas no canal nem persistidas no histórico.

O cliente usa debounce de 250 ms; o servidor limita a uma busca por usuário a cada 500 ms, somando os dispositivos. Apenas a busca mais recente da conexão permanece válida, com prazo de 15 segundos. Fechar o compositor, cancelar, perder acesso ou desconectar aborta a busca; respostas antigas são descartadas. Retorne no máximo 20 choices, com valores únicos: `label` até 100 caracteres, `value` até 2.000 e `description` até 500. `query` aceita até 200 caracteres; o bot pode impor um limite menor. Uma lista vazia significa nenhum resultado.

Setas apenas navegam. Enter ou clique confirmam uma sugestão. **Sem parâmetros opcionais, se todos os obrigatórios estiverem válidos, esse mesmo gesto executa o comando uma única vez.** Se houver opcionais, a escolha apenas preenche o campo: o compositor fica aberto para usar `+N` e o envio acontece com um Enter posterior ou pelo botão de executar. Se faltar algum obrigatório, ele precisa ser preenchido antes de executar. Texto digitado sem uma escolha válida não executa o comando. Alterar o texto invalida a escolha anterior. `value` é um identificador opaco, não uma autorização: o handler deve validá-lo novamente antes de resolver os metadados do resultado.

### Seleção com prévia de áudio

Qualquer plugin pode acrescentar `audio` a uma `SelectionChoice`. O mesmo contrato funciona em escolhas estáticas de comandos, respostas de autocomplete, campos `select` de `ctx.prompt()`, `ctx.choose()` e seletores persistentes de `createSelector()`. Sem `audio`, a opção continua sendo uma seleção comum; não é preciso criar um componente específico para cada bot.

```ts
import type { SelectionChoice } from '@monky/bot-sdk';

const choices: SelectionChoice[] = [
  {
    label: 'Bell',
    value: 'bell',
    description: 'Short bell sound',
    audio: {
      url: 'https://cdn.example.com/sounds/bell.mp3',
      fileName: 'bell.mp3',
      durationMs: 1200,
    },
  },
];
```

`audio.url` é obrigatório; `fileName` e `durationMs` são opcionais. A prévia usa HTTPS público e os mesmos formatos e limite de 3 MiB do download. O cliente carrega os bytes em memória pelo processo nativo, validando DNS, redirecionamentos, MIME e estrutura do áudio; não usa a URL externa diretamente no player do renderer.

As opções podem ter descrição, botão de prévia e barra de progresso com tempo decorrido/duração. Há **um controle de volume compartilhado (0–100%) por comando**, mantido ao trocar resultados ou parâmetros, com porcentagem visível. Formulários com vários campos de áudio também usam um único controle; seletores persistentes têm seu próprio volume. Ouvir ou ajustar o volume **não seleciona, envia nem baixa o arquivo para a biblioteca**. Só uma prévia toca por vez, localmente, no dispositivo de saída escolhido; nada é transmitido ao canal de voz. Fechar ou trocar o seletor interrompe carregamento/reprodução e libera os recursos. A prévia não exige pasta configurada. Sugestões aparecem num painel rolável acima do compositor; os campos abaixo se ajustam ao placeholder/conteúdo, respeitam a largura disponível e destacam foco ou valores inválidos. Parâmetros opcionais podem ser removidos pelo **×**, sem perder o rascunho.

### Downloads locais autorizados

Declare `downloadsSound: true` quando um comando puder pedir **um** download para a soundboard. O compositor informa essa capacidade, exige autorização por execução e bloqueia a ativação com um aviso se a pasta não estiver configurada ou autorizada. **Selecionar/executar o comando nunca abre o seletor de pastas.** Configure a pasta previamente nas configurações da soundboard; uma pasta já confirmada é reutilizada. Isso não concede ao bot uma permissão geral para acessar arquivos.

```ts
bot.command({
  name: 'download-sample',
  description: 'Download a soundboard sample',
  downloadsSound: true,
  handler: async (ctx) => {
    const result = await ctx.downloadSound({
      url: 'https://cdn.example.com/sounds/bell.mp3',
      fileName: 'bell.mp3',
      title: 'Bell',
    });
    if (result === null) return;
    const en = ctx.locale === 'en';
    switch (result.status) {
      case 'downloaded':
        ctx.reply(en ? 'Sound saved to your soundboard.' : 'Áudio salvo na sua soundboard.');
        break;
      case 'exists':
        ctx.reply(en ? 'That file already exists; nothing was replaced.' : 'O arquivo já existe; nada foi substituído.');
        break;
      case 'failed':
        ctx.reply(en ? `Download failed (${result.reason}).` : `Falha no download (${result.reason}).`);
        break;
      case 'cancelled':
        ctx.reply(en ? 'Download cancelled.' : 'Download cancelado.');
        break;
    }
  },
});
```

Substitua a URL de exemplo por um áudio público válido. Em um bot de catálogo, use o `value` selecionado para obter apenas URL, nome e título; **não baixe o áudio no bot**. `ctx.downloadSound()` encaminha a solicitação ao computador da conexão que iniciou o comando. O servidor e o bot/VPS não recebem o arquivo nem o caminho local, e outro dispositivo do mesmo usuário não herda a solicitação.

Antes de iniciar a transferência, o cliente pede confirmação do pedido real, mostrando bot, título, arquivo, pasta e origem. Nesse mesmo diálogo, a pessoa pode **alterar o nome do arquivo**, com o nome original preenchido e a extensão preservada. Nomes inválidos bloqueiam a confirmação; arquivos existentes nunca são sobrescritos. O nome escolhido aparece no card local, mas não é enviado ao bot/servidor. O switch **“Não perguntar novamente”** vale somente para esse bot, servidor/endereço e identidade neste perfil local; não autoriza outros plugins. Ao ativá-lo, os próximos downloads usam o nome sugerido pelo bot, sem repetir a confirmação ou reutilizar um nome personalizado anterior. Para reativar, use **botão direito no bot → Configurações do bot → Minhas preferências → Perguntar o nome antes de baixar** e salve. Essa alteração não restaura nem modifica as confirmações de outros bots. Recusar devolve `cancelled`, sem gravar ou abrir o seletor de pastas. Cancelamento, desconexão e expiração também fecham uma confirmação pendente.

O chat mostra um card privado com identidade do bot/comando/usuário autenticada pelo servidor, estado de confirmação pendente e depois progresso real do cliente. Bytes e porcentagens permanecem locais; você não precisa enviar mensagens de progresso. A conclusão é baseada na gravação, não no término do handler.

O resultado, exportado como `SoundDownloadResult`, é discriminado por `status`:

| Status | Significado |
|--------|-------------|
| `downloaded` | O novo arquivo foi gravado |
| `exists` | O destino já existia e não foi alterado |
| `failed` | Falha tipada em `reason` |
| `cancelled` | Download local cancelado enquanto a invocação ainda existia |

`failed.reason` pode ser `no_folder`, `invalid_request`, `invalid_url`, `blocked_url`, `invalid_file_name`, `unsupported_audio`, `too_large`, `http_error`, `network_error`, `write_failed` ou `timeout`. Não há caminho, bytes ou erro bruto do sistema no resultado. `null` significa que a própria invocação terminou, expirou ou perdeu conexão; nesse caso, retorne do handler.

São aceitos HTTPS público, sem credenciais ou fragmentos, e nomes simples de arquivo de até 128 caracteres (`.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac` ou `.webm`); `title` tem até 100 caracteres e a URL até 2.048. O cliente valida destinos/redirecionamentos, conteúdo e tamanho e nunca sobrescreve arquivos existentes. O limite é **3 MiB (3.145.728 bytes)**, o mesmo da reprodução, disponível em `LIMITS.MAX_SOUNDBOARD_FILE_SIZE` no shared e no SDK.

Sempre use `await`. Só é permitida uma solicitação por invocação, mesmo após `exists`, falha ou cancelamento; repetir exige uma nova execução autorizada. O pedido tem prazo de dois minutos, incluindo a espera pela confirmação e limitado também pelo prazo restante da invocação. Cancelar, desconectar ou encerrar o handler interrompe trabalho pendente. Contextos encerrados, comandos sem autorização e chamadas repetidas geram erro no SDK, sem iniciar outro download.

### Respostas privadas e publicação

`ctx.reply()` e `ctx.replyEphemeral()` são privados: somente a conexão de quem chamou vê a resposta, no mesmo chat em que iniciou o comando. Não é uma mensagem direta nem uma mensagem publicada para os demais membros.

As respostas aparecem em cartões com nome, foto e identificação do bot, além do contexto **“Fulano usou /comando”**. O servidor fornece a identidade de quem chamou e o nome do comando; o bot não pode se passar por outra pessoa. Essa referência não expõe os parâmetros preenchidos, inclusive quando um resultado é publicado no canal.

```ts
bot.command({
  name: 'segredo',
  description: 'Conta um segredo só pra você',
  handler: (ctx) => {
    ctx.replyEphemeral('🤫 Só você está vendo isso!');
  },
});
```

Para compartilhar um resultado deliberadamente, use `ctx.publish('Resultado para o canal')`. A publicação respeita a visibilidade do canal, é persistida no histórico e aceita reações; os formulários e suas respostas continuam privados. Respostas privadas de comandos são temporárias e não fazem parte do histórico persistido do canal.

### Formulários e conversas em etapas

O bot pode aguardar entradas do usuário sem abrir um modal e sem pedir mensagens formatadas manualmente. Cada `await ctx.prompt(...)` cria um formulário **dentro do chat de quem chamou**. As respostas de usuários, dispositivos e servidores diferentes ficam isoladas.

```ts
bot.command({
  name: 'lista',
  description: 'Publica uma lista por formulário',
  handler: async (ctx) => {
    const result = await ctx.prompt({
      title: 'Nova lista',
      fields: [
        { name: 'pergunta', label: 'Pergunta', type: 'text', required: true, maxLength: 200 },
        {
          name: 'opcoes', label: 'Opções', type: 'string-list',
          required: true, minItems: 2, maxItems: 10, maxLength: 80,
          placeholder: 'Uma opção por campo',
        },
      ],
    });
    if (!result) return;
    if (typeof result.pergunta !== 'string' || !Array.isArray(result.opcoes)) {
      throw new Error('Resposta de formulário inesperada');
    }
    const text = `**${result.pergunta}**\n${result.opcoes.map((option, i) => `${i + 1}. ${option}`).join('\n')}`;
    ctx.publish(text);
  },
});
```

Os tipos de campo disponíveis são `text` (com `multiline` opcional), `integer`, `select`, `boolean` e `string-list`. Todos aceitam `name`, `label`, `description`, `required` e um `defaultValue` compatível com seu tipo. Use `defaultValue` para permitir editar uma etapa anterior, e `submitLabel` no formulário para personalizar o botão de envio.

Após o servidor aceitar o envio, o formulário desaparece do chat e seus valores são descartados no cliente. Se o envio falhar, o formulário permanece com os valores preenchidos e a mensagem de erro, permitindo tentar novamente.

`prompt()` retorna `null` se a conversa for cancelada, expirar ou perder a conexão. Retorne do handler nesse caso; use `ctx.signal` para cancelar operações externas. Só pode existir um formulário pendente por invocação: aguarde um antes de abrir o próximo. Há até 10 campos, 20 opções por seleção/lista e cinco comandos simultâneos por conexão. Cada invocação dura no máximo cinco minutos e 100 etapas; abrir outro formulário não reinicia esse prazo. O bot não pode enviar respostas depois de encerrar o handler.

### Seletores privados

`ctx.choose()` simplifica perguntas com uma única escolha. Em `presentation: 'buttons'`, clicar responde imediatamente; em `'dropdown'` (padrão), a pessoa seleciona e confirma. A resposta é o `value` declarado, ou `null` quando a interação termina. Cada etapa é visível somente para quem iniciou o comando.

```ts
bot.command({
  name: 'atividade',
  description: 'Escolhe uma atividade em duas etapas',
  handler: async (ctx) => {
    const activity = await ctx.choose({
      title: 'O que vamos fazer?',
      presentation: 'buttons',
      choices: [
        { label: 'Jogar', value: 'game' },
        { label: 'Conversar', value: 'chat' },
      ],
    });
    if (activity === null) return;
    const time = await ctx.choose({
      title: 'Quando?',
      submitLabel: 'Confirmar horário',
      choices: [
        { label: 'Agora', value: 'now' },
        { label: 'Mais tarde', value: 'later' },
      ],
    });
    if (time !== null) ctx.reply(`Escolha: ${activity}, ${time}`);
  },
});
```

Também é possível usar `presentation: 'buttons'` em um campo `select` de `ctx.prompt()`. Ao clicar, o formulário inteiro é validado e enviado; os demais campos obrigatórios precisam estar preenchidos.

### Seletores públicos e votações

Para perguntas que devem permanecer no canal, use `bot.createSelector(serverId, definição)`. Diferentemente de uma invocação privada, o seletor é persistido no servidor e continua existindo após desconexões. Botões respondem ao clicar; dropdowns exigem confirmação.

```ts
const selector = await bot.createSelector(serverId, {
  channelId,
  title: 'Qual atividade devemos organizar?',
  choices: [
    { label: 'Campeonato', value: 'tournament' },
    { label: 'Sessão de conversa', value: 'chat' },
  ],
  presentation: 'buttons',
  responder: 'any',
  allowChange: true,
  expiresAt: Date.now() + 60 * 60 * 1000,
  maxResponders: 50,
});
```

`responder: 'any'` aceita membros humanos com acesso e permissão no canal. Para restringir a uma pessoa, use `'invoker'` com seu `invokerId`. Cada pessoa tem uma resposta; `allowChange` permite substituí-la sem aumentar o total de participantes. `maxResponders: 1` encerra na primeira resposta válida. Informe duração (`expiresAt`), limite de participantes (`maxResponders`) ou ambos; o primeiro limite atingido encerra a interação. A duração máxima é de 30 dias e o limite máximo é de 10.000 participantes.

O evento `selectorUpdate` entrega `{ serverId, selector }` ao bot proprietário, com as respostas por ID de usuário. Os demais clientes recebem somente totais e a própria escolha. Registre o listener uma vez no ciclo de vida do bot e remova-o ao encerrar. Use `bot.listSelectors(serverId)` após conectar para recuperar os estados, `updateSelector(serverId, id, patch)` para ajustar título/limites e `closeSelector(serverId, id)` para encerrar manualmente.

Dentro de um comando, prefira `ctx.createSelector(definição)` — não é necessário informar `channelId` nem `invokerId`. O servidor vincula a criação à invocação real, permitindo enquetes também em canais privados aos quais a pessoa tem acesso. Esse vínculo vale somente para o seletor e seu canal; não concede ao bot acesso geral às mensagens ou reações privadas. Operações posteriores e recuperação revalidam as permissões atuais de quem criou a enquete. Se essa pessoa perder acesso, o bot deixa de receber as respostas e não pode publicar resultados até recuperar a autorização. A API avulsa `bot.createSelector()` continua exigindo acesso do próprio bot ao canal.

Após o encerramento, `await bot.finalizeSelector(serverId, id, conteúdo)` publica o resultado no canal de forma idempotente: repetir a finalização não cria outra mensagem. Isso permite recuperar o processamento depois de uma queda do bot. Não mantenha um handler privado aberto enquanto aguarda uma votação longa.

O `/enquete` do MonkyBot usa esse mecanismo: exige de 2 a 10 opções e pelo menos uma condição de encerramento (1 minuto a 30 dias, em minutos/horas/dias; ou 1 a 10.000 votantes). Publica imediatamente após o formulário, aceita troca de voto e encerra no primeiro limite atingido. O resultado mostra contagens, percentuais, vencedor/empate ou ausência de votos. Enquetes e resultados pendentes são recuperados após reinícios.

### Reações e respostas por emoji

Mensagens persistidas dos canais de texto aceitam reações pelo seletor de emojis. Cada pessoa pode adicionar emojis diferentes, mas somente uma reação por emoji; clicar novamente remove a própria reação. Os totais e os nomes de quem reagiu ficam disponíveis no chat e sobrevivem ao carregamento do histórico. Mensagens privadas temporárias de comandos não recebem reações públicas.

No SDK, `bot.sendMessage(serverId, channelId, texto)` aguarda a publicação e retorna a mensagem com seu `id`. `addReaction(serverId, channelId, messageId, emoji)` e `removeReaction(...)` alteram somente a reação do próprio bot. Os eventos `reactionAdded` e `reactionRemoved` fornecem os IDs do canal, mensagem e usuário, seu apelido e o emoji, com `{ serverId }` como segundo argumento. Os helpers tipados `onReactionAdded` e `onReactionRemoved` retornam uma função para remover o listener.

Para responder publicamente a uma mensagem persistida, use `bot.sendMessage(serverId, channelId, texto, { replyToMessageId: id })`. O quarto argumento é opcional; chamadas existentes continuam funcionando. O servidor exige uma mensagem original não apagada no mesmo canal acessível e devolve `message.reply` com a referência resolvida. Isso é diferente de `ctx.reply()`, que continua sendo uma resposta privada a um comando.

Uma pergunta pode continuar o comando após uma reação válida, sem confundir respostas de outros canais ou usuários:

```ts
bot.command({
  name: 'confirmar',
  description: 'Responde a uma pergunta com emoji',
  handler: async (ctx) => {
    const message = await bot.sendMessage(ctx.serverId, ctx.channelId, 'Continuar? Reaja com 👍 ou 👎.');
    const answer = await new Promise<string | null>((resolve) => {
      const finish = (value: string | null) => {
        detach();
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(null);
      const detach = bot.onReactionAdded((reaction, { serverId }) => {
        if (serverId === ctx.serverId && reaction.channelId === ctx.channelId &&
            reaction.messageId === message.id && reaction.userId === ctx.invokerId &&
            ['👍', '👎'].includes(reaction.emoji)) finish(reaction.emoji);
      });
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal.aborted) finish(null);
    });
    if (answer !== null) ctx.reply(answer === '👍' ? 'Vamos continuar!' : 'Tudo bem, paramos aqui.');
  },
});
```

O exemplo aceita somente a primeira reação válida de quem executou o comando e remove o listener ao responder, cancelar, desconectar ou expirar. Reações normais continuam independentes desse fluxo.

### Configurações por bot e servidor

Use **botão direito no bot → Configurações do bot**, inclusive no nome/foto de mensagens e cards privados. O menu do servidor também oferece **Bots deste servidor**, disponível a qualquer membro e incluindo bots offline. O servidor precisa estar conectado; desligar o bot não apaga suas declarações ou configurações.

| Escopo | Quem altera | Onde fica |
|---|---|---|
| **Comportamento neste servidor** | Administradores/proprietário ou cargo com **Configurar comportamento dos bots** (`CONFIGURE_BOTS`) | Banco desse servidor; afeta todos que usam esse bot nele |
| **Minhas preferências** | A própria pessoa | Perfil local, separado por endereço, servidor, identidade e bot; não sincroniza entre dispositivos |

`CONFIGURE_BOTS` é independente de `MANAGE_BOTS`, que continua controlando cadastro, perfil e remoção. Quem não pode configurar não recebe os valores nem o formulário compartilhado. O SDK declara campos reutilizáveis; não injeta HTML nem cria uma aba global nas configurações do app. Se o bot não declarar opções compartilhadas, essa seção não aparece.

Declare antes de conectar/servir, reutilizando os tipos de campo de `BotForm`:

```ts
bot.settings({
  server: {
    title: 'Comportamento',
    fields: [
      { name: 'enabled', label: 'Ativado neste servidor', type: 'boolean', required: true, defaultValue: true },
      { name: 'limit', label: 'Quantidade máxima', type: 'integer', required: true, min: 1, max: 10, defaultValue: 5 },
    ],
  },
  user: {
    title: 'Minhas preferências',
    fields: [
      { name: 'compact', label: 'Respostas compactas', type: 'boolean', required: true, defaultValue: false },
    ],
  },
});

bot.command({
  name: 'preferencias',
  description: 'Mostra as configurações desta interação',
  handler: async (ctx) => {
    const { server, user } = ctx.settings;
    if (server.enabled === false) {
      ctx.reply('Este recurso está desativado neste servidor.');
      return;
    }
    ctx.reply(user.compact === true ? 'Modo compacto.' : `Limite deste servidor: ${server.limit}.`);
  },
});

const detach = bot.onSettingsChanged((settings, { serverId }) => {
  console.log(serverId, settings.revision);
});
const current = bot.getServerSettings('meu-servidor'); // undefined antes de registrar ou após desconectar
// detach() remove o listener quando ele não for mais necessário.
```

Campos obrigatórios de configurações precisam de defaults válidos; essa regra não muda os formulários de perguntas durante comandos. `false` e `0` são preservados. Textos, inteiros, switches, listas, escolhas e escolhas com prévia usam os mesmos controles, com **Salvar** explícito inclusive em escolhas apresentadas como botões. **Restaurar padrões** prepara a alteração, mas só persiste ao salvar.

`ctx.settings` é um snapshot validado pelo servidor, com `server`, `user`, `schemaRevision` e `serverRevision`. Invocações, autocomplete e respostas a seletores independentes recebem as preferências de quem iniciou aquela ação. Perguntas privadas do mesmo comando conservam o snapshot original; alterações posteriores valem para novas ações. `onSelectorResponse` entrega preferências somente ao bot proprietário, sem incluí-las no histórico público do seletor. Mensagens ou reações genéricas não transmitem preferências a todos os bots.

O cache de `getServerSettings()` e os eventos de configuração são separados por conexão/servidor do SDK. Reconexões idênticas preservam overrides. Escritas compartilhadas usam revisão otimista: alterações concorrentes ou declarações desatualizadas exigem recarregar, sem sobrescrever silenciosamente outra edição. Overrides compartilhados incompatíveis impedem a substituição da declaração; restaure esses campos na configuração antiga antes de registrar a nova versão. Preferências individuais incompatíveis são mostradas para revisão/reset, não descartadas silenciosamente. As declarações têm limite agregado de 64 KiB; os valores, 16 KiB por escopo, além dos limites usuais dos formulários.

**Decisões locais do host não são configurações do bot.** A confirmação/nome do download é uma preferência local oferecida automaticamente para bots com comandos `downloadsSound`. Ela nunca aparece em `ctx.settings`, não pode ser alterada por administrador ou bot e não concede acesso geral a arquivos. A pasta continua em Soundboard. Um bot como o Myinstants não precisa chamar `settings()` para oferecer essa preferência.

### Fotos dos bots

Na gestão de bots, é possível escolher ou trocar a foto. Um bot também pode sincronizar seu próprio perfil pelo SDK:

```ts
import { readFileSync } from 'node:fs';
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  publicKey: 'SUA_CHAVE_ED25519_HEX',
  name: 'Meu Bot',
  avatarBase64: `data:image/png;base64,${readFileSync('bot.png').toString('base64')}`,
});
```

No modo marketplace, `serve({ name, icon, ... })` aceita a mesma imagem em `icon`. Informe **base64 ou data URI**, não uma URL de imagem. O servidor valida formato e tamanho e hospeda a foto. O perfil do SDK é reaplicado ao conectar, inclusive em bots já adicionados; se ele definir a foto, ela substitui uma alteração manual no próximo reconnect. O MonkyBot oficial já inclui a logo do Monky no pacote.

## Modo Marketplace (multi-servidor)

Se você quer distribuir seu bot para que qualquer servidor Monky possa adicioná-lo, use o modo `serve()`:

```ts
import path from 'node:path';
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  publicKey: 'SUA_CHAVE_ED25519_HEX',
  registrationFile: path.join(process.cwd(), '.keys', 'registrations.json'),
});

bot.command({
  name: 'ping',
  description: 'Pong!',
  handler: (ctx) => ctx.reply('🏓'),
});

// Inicia o servidor HTTP do manifest
bot.serve({
  name: 'Meu Bot',
  description: 'Um bot incrível',
  port: 7780,
  publicHost: 'meubot.example.com', // IP/domínio público acessível
});
```

Isso expõe:
- `GET /manifest` — retorna o manifest do bot (nome, descrição, URL de registro)
- `POST /register` — recebe o token de cada servidor que adiciona o bot

Cada servidor que adicionar o bot cria uma **conexão WebSocket independente**. O bot gerencia todas automaticamente, com reconexão.

### Persistência dos vínculos

Configure `registrationFile` para recuperar as conexões depois de reiniciar o processo.
Sem essa opção, os vínculos só existem durante a execução. Com `serverUrl` no registro,
o SDK confirma o `POST /register` após autenticar no servidor e salvar o vínculo;
credenciais rejeitadas não substituem um vínculo válido. O servidor desfaz a criação
se o callback recusar o registro ou não confirmar uma chave válida.
Um `serverId` conhecido só aceita o mesmo token e URL; um callback público não pode
redirecionar esse vínculo para outro destino.

O arquivo contém tokens e deve ficar fora do código-fonte, com acesso restrito.
As gravações são atômicas e usam permissão `0600` em sistemas POSIX. Faça backup
dele junto com a identidade Ed25519; não gere novas chaves ao atualizar.
Há limites de 1.000 vínculos e 4 MiB por arquivo. Não compartilhe o mesmo arquivo
entre processos de bot simultâneos. Arquivos inválidos interrompem o início sem
ser sobrescritos. `disconnect()` e `close()` não apagam os vínculos salvos.

Vínculos perdidos por versões que só guardavam os dados em memória precisam de
nova autorização: o servidor não consegue recuperar um token a partir de seu hash.
No MonkyBot, após atualizar, revogue o cadastro antigo e adicione pela URL uma vez,
reaplicando eventuais ajustes do cadastro. Não apague as chaves.

Erros de autenticação são emitidos em `error`, além de `auth_failed`.
Incompatibilidade de protocolo permite novas tentativas com `autoReconnect`;
token inválido não fica em um ciclo de tentativas. Rejeitar uma atualização de
foto não desconecta o bot nem impede o registro de comandos.

### Requisitos de rede

Para que servidores Monky consigam acessar o manifest e registrar o bot, a porta configurada (padrão `7780`) precisa estar **acessível externamente**:

```bash
# Execute da máquina do servidor Monky, não apenas da máquina do bot
curl --fail --max-time 10 http://SEU-IP:7780/manifest

# Se usar iptables (Linux):
sudo iptables -A INPUT -p tcp --dport 7780 -j ACCEPT

# Se usar ufw (Ubuntu):
sudo ufw allow 7780/tcp

# Se estiver em cloud (AWS, GCP, Azure, etc.):
# Libere a porta 7780 TCP no Security Group / Firewall Rules
```

Além disso, o `publicHost` deve ser o **IP ou domínio público** da máquina — `localhost` só funciona se bot e servidor estiverem na mesma máquina.

O teste precisa retornar o JSON do manifest. Se `monkybot status` indicar `errored`, corrija primeiro o erro em `monkybot logs`: abrir portas não inicia um processo que está falhando. Regras de `iptables` devem preceder regras de bloqueio e ser persistidas conforme a distribuição; em redes com NAT, configure também o encaminhamento da porta.

### Propriedades úteis

```ts
bot.serverCount;  // Número de servidores conectados
bot.serverIds;    // Lista de IDs dos servidores
bot.registeredServerCount; // Vínculos autenticados conhecidos, inclusive offline
```

### Eventos

```ts
bot.on('connected', ({ serverId }) => console.log(`Conectado a ${serverId}`));
bot.on('disconnected', ({ serverId }) => console.log(`Desconectado de ${serverId}`));
bot.on('registered', ({ serverId, serverName }) => console.log(`Registrado em ${serverName}`));
bot.on('error', (err) => console.error(err));
bot.on('serving', ({ port, manifest }) => console.log(`Manifest em :${port}/manifest`));
```

## Segurança: TOFU (Trust On First Use)

Na primeira conexão, o bot apresenta sua **chave pública Ed25519**. O servidor a vincula permanentemente ao bot (TOFU binding). Conexões futuras exigem a mesma chave — se alguém tentar usar o token com uma chave diferente, é rejeitado.

No modo marketplace, o TOFU binding acontece automaticamente durante a instalação.

> 💡 O [Monky Bot](https://github.com/MonkyOrg/MonkyBot) gera o par Ed25519 automaticamente e o reutiliza. Ao criar seu próprio bot com o SDK, gere e persista sua chave com as APIs de criptografia do Node.js e passe a chave pública em `publicKey`; não gere uma identidade nova a cada reinício.

## Monky Bot (bot oficial)

O [**Monky Bot**](https://github.com/MonkyOrg/MonkyBot) é o bot de referência mantido pela organização. Ele serve como exemplo prático e inclui comandos utilitários:

| Comando | Descrição |
|---------|-----------|
| `/ping` | Latência do bot |
| `/dado [lados]` | Rola um dado (2-100 lados) |
| `/moeda` | Cara ou coroa |
| `/8ball <pergunta>` | Bola mágica; a pergunta é obrigatória |
| `/enquete` | Formulário privado; publica a votação no canal sem revisão e encerra por tempo e/ou total de votantes |
| `/ajuda` | Lista todos os comandos |

Consulte o [repositório do Monky Bot](https://github.com/MonkyOrg/MonkyBot) para instruções de instalação e uso.

## Referência rápida da API

### `BotClient`

| Método | Descrição |
|--------|-----------|
| `new BotClient(options)` | Cria uma instância do bot |
| `bot.command(def)` | Registra um slash command |
| `bot.connect(overrides?)` | Conecta a um servidor (modo manual) |
| `bot.disconnect(serverId?)` | Desconecta de um ou todos os servidores |
| `bot.close()` | Encerra conexões e servidores HTTP do bot |
| `bot.serve(options)` | Inicia servidor HTTP para marketplace |
| `bot.serverCount` | Número de servidores conectados |
| `bot.serverIds` | IDs dos servidores conectados |
| `bot.registeredServerCount` | Quantidade de vínculos autenticados conhecidos, inclusive offline |

### `BotOptions`

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `publicKey` | `string` | ✅ | Chave pública Ed25519 em hex |
| `serverUrl` | `string` | Modo manual | URL WebSocket do servidor |
| `token` | `string` | Modo manual | Token do bot |
| `autoReconnect` | `boolean` | — | Reconectar automaticamente (padrão: `true`) |
| `name` | `string` | — | Nome a sincronizar no perfil |
| `avatarBase64` | `string` | — | Foto em base64 ou data URI, sincronizada ao conectar |
| `registrationFile` | `string` | — | Arquivo privado dos vínculos Marketplace, restaurado por `serve()` |

### `ServeOptions`

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `name` | `string` | ✅ | Nome exibido no manifest |
| `description` | `string` | — | Descrição do bot |
| `icon` | `string` | — | Foto em base64 ou data URI (não aceita URL) |
| `port` | `number` | — | Porta HTTP (padrão: `7780`) |
| `host` | `string` | — | Endereço de bind (padrão: `0.0.0.0`) |
| `publicHost` | `string` | — | Hostname público para o registro |
