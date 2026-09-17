# Bots

O Monky possui um sistema completo de bots que permite automatizar tarefas, adicionar comandos personalizados e integrar serviços externos ao seu servidor.

## O que é um bot?

Um bot é um **processo externo** que se conecta ao servidor Monky via WebSocket, como qualquer outro usuário. A diferença é que bots:

- Autenticam com **token** em vez de senha
- Podem registrar **slash commands** (`/ping`, `/dado`, etc.)
- Aparecem com badge **BOT** na lista de membros
- Usam seu próprio nome e foto nas mensagens e nos formulários do chat
- Não contam no limite de usuários (têm limite próprio: `maxBots`)

O bot roda na **máquina dele** (VPS, nuvem, seu PC), não no servidor Monky. Por padrão, ele processa os comandos e o servidor roteia as mensagens. Capacidades de execução local permitem solicitar operações específicas no cliente de quem chamou o comando, com autorização daquela pessoa; isso não permite enviar programas ou scripts arbitrários.

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

### 1. Via URL (recomendado)

É o fluxo padrão, inclusive para bots privados. O endpoint precisa ser acessível
pelo servidor Monky, mas não precisa estar publicado em um catálogo.

1. O bot fornece um **manifest HTTP** com sua identidade, descrição, capacidades solicitadas e URL de registro
2. No client, vá em **Configurações do Servidor → Bots**
3. Cole a URL do manifest em **Vincular bot por URL** e abra a revisão
4. Revise cada switch; todos começam desligados. **Permitir todas as capacidades solicitadas** seleciona somente o que o bot pediu
5. Confirme a instalação. O servidor verifica novamente o manifest e registra o vínculo; só após validar o registro libera o subconjunto aprovado

### 2. Manual por token (avançado)

Use quando o bot só pode abrir conexões de saída e não tem um endpoint HTTP
acessível ao servidor Monky.

1. No client, vá em **Configurações do Servidor → Bots → Mostrar opção avançada**
2. Gere um vínculo manual, sem informar nome ou avatar, e confirme o aviso de que o token não autoriza ações
3. Copie o token (exibido **uma única vez**) e informe-o no setup/código do bot
4. O vínculo aguarda a conexão; o bot publica sua identidade e declara as capacidades pelo SDK, ainda sem autorização para executar ações
5. Abra **Configurações do bot → Permissões no servidor**, escolha os switches e salve. O bot pode reconectar após a revisão

**Nome e avatar são controlados exclusivamente pelo bot.** O cliente permite
vincular, configurar comportamento e desvincular, não editar essa identidade.
Vínculos e perfis anteriores são preservados; a atualização não recria contas,
troca tokens/chaves nem apaga nomes e fotos existentes.

## Criando seu próprio bot

### Permissões e canais

Em **Configurações do Servidor → Cargos**, **Adicionar e gerenciar bots** (`MANAGE_BOTS`) controla quem pode vincular, desvincular e revisar as capacidades dos bots; **Configurar bots** (`CONFIGURE_BOTS`) controla apenas as opções compartilhadas de comportamento. Nenhuma dessas permissões autoriza alterar nome ou avatar. **Executar comandos de bots** controla quem pode usar seus comandos e interações, e é habilitada inicialmente para membros e cargos existentes.

Ao criar ou editar um canal de texto, o switch **Permitir comandos de bots** vem ativado. Desativá-lo bloqueia comandos e respostas a formulários e seletores nesse canal, **inclusive para administradores**. Digitar `/` mostra o motivo do bloqueio. Alterações de permissões também afetam interações já abertas; mensagens e reações comuns continuam seguindo suas próprias permissões.

### Capacidades solicitadas e consentimento

`BotOptions.requestedCapabilities` é obrigatório. Declare somente as categorias realmente usadas; o SDK publica a mesma lista no manifest e em `COMMAND_REGISTER`. A declaração é um pedido, nunca uma autorização:

| Capacidade | Acesso controlado pelo servidor |
|------------|--------------------------------|
| `commands` | Entradas fornecidas ao invocar comandos, autocomplete, prévias, respostas privadas e formulários |
| `read_messages` | Mensagens, histórico e reações nos canais acessíveis; também necessário para citar outra mensagem |
| `send_messages` | Mensagens, respostas, reações e resultados públicos de comandos |
| `publish_voice` | Publicação de áudio em salas permitidas, sem receber mídia dos participantes |
| `local_execution` | Solicitação de tarefas e preparação de ferramentas no cliente; pode receber mídia produzida pela tarefa autorizada |
| `sound_download` | Solicitação de salvar áudio no Soundboard de quem chamou, sem acesso geral a arquivos |
| `selectors` | Controles públicos persistentes de escolha e suas respostas; publicar também exige `send_messages` |
| `miniapps` | Miniapps compartilhados nas salas de voz, incluindo ações de participantes autorizados |

Registrar comandos exige `commands`; comandos com `downloadsSound` também declaram `sound_download`, e aqueles com `localCapabilities` declaram `local_execution`. Respostas públicas exigem `send_messages`; a resposta privada padrão exige apenas `commands`. As permissões dos cargos, dos canais e de quem iniciou a ação continuam valendo.

**Recepção de voz não está disponível.** Pedidos como `receive_voice` são rejeitados. O servidor recusa consumo SFU por bots e negociações P2P que receberiam microfone, câmera ou compartilhamento; clientes não publicam essas trilhas para bots. Áudio de tarefas locais consentidas é uma rota separada, não escuta dos canais.

**Consentimento no computador é separado.** Permitir `local_execution` ou `sound_download` no servidor não instala ferramentas nem autoriza o dispositivo. A pessoa ainda controla os pedidos locais e pode recusá-los/revogá-los nas configurações de ferramentas locais. Preferências pessoais, idioma do bot e confirmação de nomes de arquivos não viram permissões administrativas.

**Edição e migração segura.** As configurações do bot usam a mesma barra lateral e navegação por seções das configurações do app/servidor. Em **Permissões no servidor**, quem tem `MANAGE_BOTS` pode revisar os switches a qualquer momento. Salvar invalida a conexão anterior, encerra voz, tarefas locais, referências de fontes, prévias, interações e miniapps, e fecha seletores persistentes; o SDK pode reconectar. Trabalho assíncrono antigo não recupera acesso se uma permissão for reativada rapidamente.

A migração `026_bot_capability_consent.sql` preserva bots, tokens, identidades e configurações, mas **não inventa aprovação para bots existentes**: todos começam sem concessões e precisam declarar capacidades pelo SDK atualizado e passar pela revisão. Uma declaração alterada conserva somente concessões anteriores ainda solicitadas; capacidades novas permanecem desligadas. A revisão usa uma versão otimista, então mudanças concorrentes exigem recarregar.

Na instalação por URL, a prévia dura cinco minutos, pertence à sessão/dispositivo do administrador e só pode ser consumida uma vez. `BOT_INSTALL_PREVIEW { manifestUrl }` retorna `{ previewId, expiresAt, manifest }`; `BOT_INSTALL { previewId, grantedCapabilities }` verifica novamente o conteúdo. Mudança no manifest, na declaração durante o registro ou na autorização de quem instala cancela o fluxo sem deixar um bot aprovado. Vínculos provisórios podem publicar identidade e declaração, não executar ações.

O SDK expõe `bot.getPermissions(serverId)` e o evento `permissionsChanged(permissions, { serverId })`, com `requested`, `granted`, `revision`, `reviewRequired`, `reviewedBy` e `reviewedAt`. São snapshots informativos por servidor, não uma forma de conceder permissões; a autoridade permanece no servidor.

### Pré-requisitos

- **Node.js 18+**
- Cliente, servidor e SDK compatíveis com o **protocolo 20**
- O pacote `@monky/bot-sdk` da release correspondente

::: warning Atualização conjunta
O protocolo 20 exige declarações explícitas e consentimento administrativo por bot, incluindo a revisão prévia de instalações. Preserva execução local, sinalização privada, prévias, paginação e nomes locais de comandos. Atualize **cliente, servidor e bot** juntos; versões com protocolos diferentes não se conectam. Essa mudança exige uma release major, inclusive na linha beta. Atualizar o SDK não aprova automaticamente os bots existentes.

As regras de vínculo do protocolo 14 são mantidas: `BOT_CREATE` recebe somente `{}` e a administração recebe `profilePending` para indicar uma identidade ainda não anunciada. O banco preserva as identidades existentes, e somente o próprio bot pode publicar alterações de perfil. `ctx.args` contém valores tipados e `ctx.reply()` é privado; use `ctx.publish()` somente para resultados que devem aparecer para o canal.
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

No primeiro acesso em um terminal interativo, o CLI pede **Português (Brasil)**
ou **English** e salva a escolha em `~/.<cliName>/preferences.json`.
`language en` ou `language pt-BR` altera a preferência; `--locale en` vale somente
para aquela execução. `en-US` é aceito e normalizado para `en`.
`--version`, `--help`, entrada/saída redirecionadas, `--non-interactive`, `--yes`,
`--check` e ambientes de CI não abrem essa pergunta nem criam uma preferência
automaticamente. `MONKY_BOT_LOCALE` pode definir o idioma de uma automação;
na ausência dela, o CLI aceita `MONKY_LANG`, como o CLI do servidor. A opção
`--locale` prevalece sobre ambas, sem ler nem alterar a preferência salva.
Tags regionais/POSIX como `en_GB.UTF-8` e `pt_PT` são normalizadas para `en` e
`pt-BR`. A gravação é atômica; preferências inválidas geram um diagnóstico,
sem impedir ajuda ou automação, e podem ser substituídas com `language en`
ou `language pt-BR`. `--version` nem sequer lê esse arquivo.
O CLI passa o idioma efetivo ao processo do bot nessa mesma variável, sem mudar
identificadores como `setup`, `start`, `mode` ou nomes de variáveis.

O setup segue o fluxo do MonkyBot: modo, diretório de trabalho, dados do modo
e nome do bot. Em bots que suportam os dois modos, **instalação por URL é o padrão**
e a conexão manual é apresentada como **avançada**. Refazer o setup mantém o modo
anterior por padrão. No modo manual, pede servidor e **token do bot**. Aceita `IP:porta`
(normalizado para `ws://`), `ws://...` e `wss://...`; valores inválidos são
solicitados novamente sem reiniciar o assistente. A entrada do token é oculta,
não fica no histórico de perguntas e é salva apenas na configuração local
(arquivo `600`, diretório `700` no Linux). `config` e `status` ocultam o segredo.

Para automação, continua disponível
`setup --non-interactive --mode manual --server-url localhost:3000 --token-env MONKY_BOT_TOKEN`.
Nesse fluxo, somente o nome da variável é salvo; disponibilize seu valor no
ambiente do operador/serviço antes de `start` e `restart`. Perfis antigos com
`tokenEnv` continuam funcionando. `config set botToken` e `config set tokenEnv`
trocam a origem do token, sem manter os dois ao mesmo tempo; prefira o setup
para não registrar o token no histórico do shell.

No modo Marketplace, o setup pede porta do manifest e IP/domínio público, sem
token manual. Para automação:
`setup --non-interactive --mode marketplace --public-host bot.example.com --serve-port 7781`.
O host e a porta precisam ser acessíveis pelos servidores Monky que vão instalar
o bot. `localhost` só atende servidores na mesma máquina. Declare ambos os modos
em `monkyBot.modes` para oferecer a escolha.

Cada bot na mesma máquina precisa de uma **porta exclusiva**, por exemplo `7780`
e `7781`. `/manifest` é um endpoint de cada processo, não um arquivo compartilhado.
O CLI verifica se consegue usar a porta local antes de salvar; se outro bot ou
serviço já a ocupa, o setup explica o conflito e pede outra, sem trocar a porta
automaticamente. O setup não interativo e alterações de porta por `config set`
falham sem sobrescrever a configuração anterior.

Se o próprio bot estiver usando a porta, execute `meu-bot stop` antes de refazer
o setup; a configuração e as chaves são preservadas. `start` também verifica a
porta antes de iniciar um processo parado; `restart` libera apenas seu processo
gerenciado antes da checagem, inclusive após atualizações. Essa checagem local
não verifica regras de firewall e não reserva a porta até o próximo `start`.

Configuração e identidade ficam em `~/.<cliName>`, fora do pacote;
`MONKY_BOT_CLI_HOME` muda a pasta-base, preservando o subdiretório de cada bot.
Refazer o setup preserva o diretório de trabalho e a identidade existentes.
Os aliases `botName`, `botDir`, `serverUrl`, `botToken`, `servePort` e `publicHost`
de `config set` seguem o MonkyBot; `restart --fresh` recria o processo sem apagar
o perfil.

O CLI gera/reutiliza a identidade e fornece `MONKY_BOT_PUBLIC_KEY`,
`MONKY_SERVER_URL`, `MONKY_BOT_TOKEN` e `MONKY_BOT_NAME` ao processo. A entrada do
bot deve consumir essas variáveis. Declare `marketplace` em `modes` somente se
essa entrada também implementar o fluxo `MONKY_SERVE`/`bot.serve()`. Nesse modo,
o runner fornece `MONKY_SERVE_PORT`, `MONKY_SERVE_PUBLIC_HOST` e
`MONKY_BOT_REGISTRATION_FILE`: passe o último como `registrationFile` ao criar
`BotClient` para restaurar vínculos após reiniciar. Preserve a pasta `.keys`
inteira, pois contém chaves e tokens dos servidores vinculados.
`validateBotServerUrl`, `validateBotServePort` e `validateBotPublicHost`, exportados
pelo SDK, permitem à entrada reutilizar as validações do CLI.

### Atualizações opcionais do CLI

`update` e a ativação de `autoupdate` **só funcionam quando o autor do bot configura
explicitamente uma origem** no `package.json` usado no build. O operador não
escolhe essa origem no setup. **GitHub Releases é a opção recomendada**: permite
manter histórico de versões e selecionar stable/beta no formato de pacote atual.

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

Esse trecho complementa a configuração anterior. O SDK também suporta uma
**URL HTTPS direta de `.tgz`**, substituindo `releases` por:

```json
{
  "monkyBot": {
    "updateSource": {
      "type": "https",
      "url": "https://downloads.example.com/meu-bot.tgz",
      "tokenEnv": "BOT_UPDATE_TOKEN"
    }
  }
}
```

`tokenEnv` é opcional nessa origem. Se declarado, a variável precisa existir
no ambiente e seu valor é enviado como token Bearer. Não coloque credenciais,
query strings ou fragmentos na URL configurada. Redirecionamentos ficam
limitados à mesma origem HTTPS (host e porta), sem enviar o token a outro host.
O autor precisa manter o arquivo dessa URL atualizado.

Outra alternativa é um **arquivo `.tgz` local**, obtido pelo mecanismo de
distribuição do autor:

```json
{
  "monkyBot": {
    "updateSource": {
      "type": "file",
      "path": "../bot-updates/meu-bot.tgz"
    }
  }
}
```

O caminho relativo é resolvido a partir do `package.json` **instalado**, nunca
do diretório atual do terminal ou do PM2. Use caminhos relativos portáveis ao
empacotar para plataformas diferentes; caminhos absolutos precisam ser nativos
do ambiente. Não há expansão de `~` nem de variáveis de ambiente. O arquivo
precisa ser regular, legível e não pode ser um link simbólico. O CLI copia um
snapshot antes de inspecionar e instalar, sem reabrir um arquivo que possa mudar.

Configure **somente uma origem**: `releases` ou `updateSource`. Sem ambas, o SDK não
deduz uma origem de `repository`, de `git origin`, do repositório do SDK ou do
registro npm. Um link inválido gera erro, não habilita uma origem alternativa.

`update --check` não instala nem reinicia. No GitHub, consulta apenas metadados;
para HTTPS/arquivo local, baixa ou copia o pacote para ler sua versão e descarta
a cópia ao terminar. `update` usa stable e `update --beta` inclui
pré-releases. A seleção respeita a versão semântica, sem downgrade ou reinstalação
de versão igual. O auto-update segue o canal instalado, salvo `--beta` explícito.
Uma origem de arquivo único oferece apenas a versão contida naquele arquivo;
se for beta, o canal stable não a instala. O pacote deve ser o `.tgz` autocontido
gerado por `monky-bot-sdk build`, não o ZIP de código-fonte do GitHub.
Nenhum desses comandos publica ou promove releases.

Uma instalação de atualização só é permitida pelo CLI instalado globalmente no
prefixo npm atual; checkouts e instalações locais permitem apenas `--check`.
O SDK valida nome, versão e CLI do arquivo recebido e instala o pacote autocontido
offline, sem executar scripts de instalação. Use `update --yes` sem terminal
interativo. Arquivos de configuração e identidade permanecem fora da instalação.
Se o diretório de configuração ou de dados estiver dentro do pacote instalado,
a atualização é bloqueada para não apagá-los; mova o perfil para fora do pacote
antes de atualizar. O limite de transferência é 200 MiB e 60 segundos.

O CLI mostra bytes realmente transferidos e porcentagem quando a origem informa
um tamanho válido. Sem tamanho, informa os bytes recebidos sem inventar uma
porcentagem. Consulta, verificação, instalação e reinício são etapas sem progresso
numérico; logs redirecionados usam linhas legíveis. Se o bot estava em execução,
o reinício passa pelo **CLI recém-instalado**, não pelo SDK antigo ainda carregado
na memória do atualizador. Perfil, chaves e agendamento são preservados.
No modo manual com `tokenEnv`, se a variável não existir no shell atual, somente
essa credencial é recuperada do ambiente do processo PM2 gerenciado. Um valor
explícito no shell tem prioridade; o token não é gravado na configuração nem
colocado em argumentos ou logs.

Para um repositório privado, disponibilize o token de leitura na variável de
ambiente indicada, nunca dentro do pacote ou da URL. `autoupdate off` e `status`
continuam disponíveis para administrar um agendamento antigo mesmo se a origem
for removida de uma versão posterior.

### Exemplo básico

```ts
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  requestedCapabilities: ['commands'],
  serverUrl: 'ws://seu-servidor:3000',
  token: 'TOKEN_DO_BOT',
  publicKey: 'SUA_CHAVE_ED25519_HEX',
  name: 'Meu Bot',
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
    // ctx.invokerSessionId — conexão/dispositivo que iniciou o comando
    // ctx.invokerVoiceChannelId — sala de voz inicial, não um estado vivo
    // ctx.getVoiceChannel() — consulta a sala atual da conexão original no servidor
    // ctx.serverId   — ID do servidor (útil em modo multi-servidor)
    // ctx.args       — argumentos { nome: string | number | boolean }
    // ctx.locale     — idioma preferido para este bot ('pt-BR' ou 'en')
    // ctx.reply()    — responde só para quem chamou, dentro do chat
    // ctx.publish()  — publica explicitamente um resultado no canal
    // ctx.prompt()   — aguarda um formulário privado; pode ser chamado em etapas
    // ctx.choose()   — aguarda uma opção privada, por botões ou dropdown
    // ctx.createScreen() — cria uma tela compartilhada independente do handler
    // ctx.downloadSound() — aguarda um download local autorizado de soundboard
    // ctx.signal     — aborta ao cancelar, desconectar, expirar ou concluir
  },
});
```

### Idioma dos comandos e preferências

Cada pessoa pode escolher **Configurações do bot > Minhas preferências > Idioma
do bot**, inclusive para bots sem formulário de configuração próprio.
**Seguir o Monky** usa o idioma do aplicativo; a escolha explícita vale somente
para aquele bot, servidor/endereço e identidade no perfil local. Restaurar os
padrões volta a seguir o Monky. O idioma efetivo chega em `ctx.locale` também no
autocomplete e na prévia de áudio. Interações já iniciadas mantêm o idioma
capturado; o corpo de mensagens antigas não é traduzido retroativamente. O nome
do comando no cabeçalho de uma resposta acompanha o idioma de quem a lê, usando
os metadados disponíveis; sem eles, aparece o nome canônico.

Declare `localizations` para nomes locais, aliases e textos de descoberta e preenchimento:

```ts
bot.command({
  name: 'play',
  description: 'Choose playback order',
  options: [{
    name: 'mode', label: 'Mode', description: 'Playback order', type: 'string',
    choices: [{ label: 'Shuffle', value: 'shuffle' }],
  }],
  localizations: {
    'pt-BR': {
      name: 'tocar',
      aliases: ['musica'],
      description: 'Escolha a ordem de reprodução',
      options: {
        mode: {
          label: 'Modo', description: 'Ordem de reprodução', placeholder: 'Escolha',
          choices: { shuffle: { label: 'Aleatório' } },
        },
      },
    },
  },
  handler: (ctx) => { ctx.reply(ctx.locale === 'en' ? 'Ready.' : 'Pronto.'); },
});
```

O `name` principal continua sendo o identificador canônico: o usuário em
português vê `/tocar` e pode digitar `/tocar`, `/musica` ou `/play`, mas o servidor
e `ctx.commandName` recebem `play`. A preferência é **apenas para aquela pessoa**,
nunca uma renomeação global. Nomes de argumentos, `ctx.args.mode` e
`choices[].value` não são traduzidos. Descrições, `label`, `placeholder` e
rótulos/descrições de escolhas continuam traduzíveis; campos ou escolhas não
declarados são rejeitados. Texto ausente usa a declaração original.

Nomes locais e aliases usam slugs ASCII minúsculos de 1 a 32 caracteres:
começam com letra ou número e aceitam letras, números, `_` e `-`. Cada idioma
aceita até oito aliases únicos. A declaração do bot rejeita colisões entre
comandos, inclusive um alias que esconda o nome canônico de outro comando.
Colisões entre bots continuam oferecendo a escolha do bot; o cliente não
executa o primeiro resultado por acidente. Só os aliases do idioma efetivo e
os nomes canônicos são aceitos. Trocar o idioma durante o preenchimento atualiza
nomes e rótulos, preservando o bot, comando canônico, valores e cursor.

O SDK exporta `BotLocale`, `normalizeBotLocale`, `resolveBotLocale` e
`localizeCommand`, além de `getCommandPresentation` e do tipo
`CommandPresentation`. `normalizeBotLocale('en-US')` resulta em `en`; mantenha
`pt-BR` e `en` como chaves de `localizations`. `resolveBotLocale` pode receber a
lista de idiomas suportados pelo bot e um idioma padrão. `localizeCommand`
produz metadados de exibição sem modificar a declaração ou os identificadores.
`getCommandPresentation(definicao, ctx.locale)` retorna
`{ canonicalName, displayName, inputNames }`. Use `displayName` em ajuda privada;
jamais o envie como `commandName` no protocolo. Por exemplo, usando o mesmo
array `commandDefinitions` registrado com `bot.command()`:

```ts
import { getCommandPresentation, localizeCommand } from '@monky/bot-sdk';

bot.command({
  name: 'help',
  description: 'Help',
  localizations: { 'pt-BR': { name: 'ajuda' } },
  handler: (ctx) => ctx.reply(commandDefinitions.map(command =>
    `/${getCommandPresentation(command, ctx.locale).displayName} — ${
      localizeCommand(command, ctx.locale).description
    }`
  ).join('\n')),
});
```

Formulários e corpos das respostas ainda são responsabilidade do handler e
devem usar `ctx.locale`, não `ctx.settings.user.locale`. `ctx.reply()` mantém a
ajuda privada; publicar uma ajuda traduzida no canal não a torna individual.

### Parâmetros guiados no chat

Ao digitar `/`, o menu mostra os comandos utilizados com mais frequência e os agrupa por bot. Cada item identifica o comando, sua descrição e o bot responsável. Ao navegar, os parâmetros obrigatórios e a quantidade de opcionais ajudam a escolher o comando. Pressionar **Espaço** seleciona o comando destacado no menu e abre seu compositor, sem executá-lo. Espaços no texto comum ou nos parâmetros continuam sendo texto.

Ao selecionar um comando com parâmetros, o compositor compacto identifica **qual bot e comando** estão selecionados e apresenta campos nomeados com descrição e placeholder. Parâmetros opcionais podem ser adicionados quando necessários. O envio usa os nomes declarados em `options`; não é necessário juntar valores com vírgulas. Comandos sem parâmetros que não solicitam download local, como `/ping` e `/enquete`, iniciam a interação imediatamente ao serem selecionados por clique, Enter ou Tab; a seleção com Espaço aguarda uma confirmação de envio.

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

O callback recebe `{ query, page, cursor, optionName, args, locale, serverId, signal, settings }` e pode retornar uma lista de `SelectionChoice` (`{ label, value, description?, audio? }`) ou uma página `{ choices, hasMore?, nextCursor? }`, diretamente ou por `Promise`. `page` começa em zero; `cursor` é opcional. `args` contém somente as outras opções já preenchidas e válidas; obrigatórios ainda ausentes são permitidos nessa etapa. `query` contém o texto da opção editada. `settings` é um snapshot imutável das configurações do servidor e preferências dessa pessoa.

No exemplo, o catálogo é local ao bot. Para uma fonte externa, substitua a filtragem por uma busca de **metadados**, passe `signal` ao `fetch` e valide o retorno. O callback não recebe uma invocação nem métodos de resposta/download. As consultas são enviadas ao bot selecionado enquanto a pessoa digita; não são publicadas no canal nem persistidas no histórico.

O cliente espera **700 ms sem digitação** e espaça os envios reais em pelo menos **1 segundo** por conexão, inclusive entre páginas e ao reabrir o menu. A preparação local acontece antes de reservar esse intervalo e antes de iniciar o prazo da resposta. O servidor continua limitando a uma consulta por usuário a cada 500 ms, somando os dispositivos, com prazo de 15 segundos por página. Retorne no máximo **20 choices por resposta**, com valores únicos: `label` até 100 caracteres, `value` até 2.000 e `description` até 500. **Não há corte no total acumulado no menu.** `query` aceita até 200 caracteres; o bot pode impor um limite menor.

Para habilitar rolagem com carregamento sob demanda, retorne `hasMore: true` enquanto houver outra página. O cliente incrementa `page` ao se aproximar do fim da lista, mantém as escolhas anteriores e remove duplicatas por `value`. Se a fonte usa cursores ou uma página precisa ser dividida em vários lotes, retorne também `nextCursor` (string opaca de até 512 caracteres); o cliente o devolve em `cursor`. Valide esse cursor no provider: ele não é uma autorização nem deve ser tratado como URL confiável. Não busque todas as páginas antecipadamente.

```ts
autocomplete: ({ query, page }) => {
  const matches = catalog.filter((choice) => choice.label.toLowerCase().includes(query.toLowerCase()));
  const offset = page * 20;
  return { choices: matches.slice(offset, offset + 20), hasMore: offset + 20 < matches.length };
},
```

Sem `hasMore` (inclusive no retorno antigo em array), a resposta continua sendo uma lista única. Use `hasMore: false` na última página e omita `nextCursor`; uma lista vazia encerra uma busca sem continuação. Falhas ao carregar mais mantêm os resultados e permitem tentar a mesma página novamente. Fechar o compositor, alterar a busca, cancelar, perder acesso ou desconectar invalida o contexto; respostas atrasadas são descartadas. As prévias sob demanda de cada página mantêm sua própria autorização e expiração, sem serem invalidadas apenas por carregar a página seguinte. SDK, servidor e cliente no protocolo 20 são necessários; callbacks antigos em array não precisam mudar após atualizar o SDK e declarar as capacidades utilizadas.

Setas apenas navegam. Enter ou clique confirmam uma sugestão. **Sem parâmetros opcionais, se todos os obrigatórios estiverem válidos, esse mesmo gesto executa o comando uma única vez.** Se houver opcionais, a escolha apenas preenche o campo: o compositor fica aberto para usar `+N` e o envio acontece com um Enter posterior ou pelo botão de executar. Se faltar algum obrigatório, ele precisa ser preenchido antes de executar. Texto digitado sem uma escolha válida não executa o comando. Alterar o texto invalida a escolha anterior. `value` é um identificador opaco, não uma autorização: o handler deve validá-lo novamente antes de resolver os metadados do resultado.

### Seleção com prévia de áudio

Qualquer plugin pode acrescentar `audio` a uma `SelectionChoice`. A variante `audio.url` funciona em escolhas estáticas de comandos, respostas de autocomplete, campos `select` de `ctx.prompt()`, `ctx.choose()` e seletores persistentes de `createSelector()`. A variante sob demanda, `audio.resourceId`, é destinada às escolhas do autocomplete atual. Sem `audio`, a opção continua sendo uma seleção comum; não é preciso criar um componente específico para cada bot.

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

Na variante acima, `audio.url` é obrigatório; `fileName` e `durationMs` são opcionais. A prévia usa HTTPS público e os mesmos formatos e limite de 3 MiB do download. O cliente carrega os bytes em memória pelo processo nativo, validando DNS, redirecionamentos, MIME e estrutura do áudio; não usa a URL externa diretamente no player do renderer. Essa variante continua funcionando sem mudanças, inclusive para fontes como MyInstants.

As opções podem ter descrição, botão de prévia e barra de progresso com tempo decorrido/duração. Há **um controle de volume compartilhado (0–100%) por comando**, mantido ao trocar resultados ou parâmetros, com porcentagem visível. Formulários com vários campos de áudio também usam um único controle; seletores persistentes têm seu próprio volume. Ouvir ou ajustar o volume **não seleciona, envia nem baixa o arquivo para a biblioteca**. Só uma prévia toca por vez, localmente, na saída de mídia do chat (ou na saída geral quando não há configuração avançada específica); mudanças dessa saída também se aplicam à prévia em andamento, e nada é transmitido ao canal de voz. Fechar ou trocar o seletor interrompe carregamento/reprodução e libera os recursos. A prévia não exige pasta configurada. Sugestões aparecem num painel rolável acima do compositor; os campos abaixo se ajustam ao placeholder/conteúdo, respeitam a largura disponível e destacam foco ou valores inválidos. Parâmetros opcionais podem ser removidos pelo **×**, sem perder o rascunho.

#### Áudio gerado somente ao ouvir

Quando a fonte não oferece um pequeno arquivo HTTPS público, retorne `audio: { resourceId, fileName?, durationMs? }` no autocomplete e declare `audioPreview` no comando. **Nunca combine `url` e `resourceId`.** `resourceId` tem até 128 caracteres; ele identifica um recurso do provider, não uma URL para o cliente buscar.

O exemplo lê um arquivo **autoral, com no máximo 10 segundos e 256 KiB**, que você deve fornecer em `audio/bell.ogg` ao lado do módulo. Para gerar clipes dinamicamente, substitua somente o corpo de `loadPreview`: obtenção dos bytes, resolução da mídia e conversão devem acontecer no processo do bot, respeitando o `signal`, nunca durante o autocomplete. A busca de metadados continua no callback `autocomplete`.

```ts
import { readFile } from 'node:fs/promises';
import type { CommandAudioPreviewContext, CommandAudioPreviewData } from '@monky/bot-sdk';

const previews = new Map([
  ['bell', { label: 'Bell', file: new URL('./audio/bell.ogg', import.meta.url) }],
]);

async function loadPreview(ctx: CommandAudioPreviewContext): Promise<CommandAudioPreviewData> {
  const source = previews.get(ctx.resourceId);
  if (!source) throw new Error('Unknown preview resource');
  return { bytes: await readFile(source.file, { signal: ctx.signal }), mimeType: 'audio/ogg' };
}

bot.command({
  name: 'preview-sample',
  description: 'Choose an audio sample',
  options: [{ name: 'sound', description: 'Sound', type: 'string', required: true, autocomplete: true }],
  autocomplete: ({ query }) => [...previews].filter(([, source]) =>
    source.label.toLowerCase().includes(query.toLowerCase())
  ).map(([id, source]) => ({
    label: source.label, value: id,
    audio: { resourceId: id, fileName: `${id}.ogg`, durationMs: 10_000 },
  })),
  audioPreview: loadPreview,
  handler: (ctx) => {
    if (typeof ctx.args.sound !== 'string' || !previews.has(ctx.args.sound)) throw new Error('Unknown sample');
    ctx.reply(`Selected: ${ctx.args.sound}`);
  },
});
```

`CommandDefinition.audioPreview` aceita um retorno direto ou uma `Promise<CommandAudioPreviewData>`. O contexto exportado `CommandAudioPreviewContext` contém `resourceId`, `serverId`, `optionName`, `locale` (`'pt-BR' | 'en'`), `signal` e `settings` imutável, capturado na mesma busca. Não contém invocação, fila, métodos de publicação ou download. `CommandAudioPreviewData` contém apenas `bytes: Uint8Array` (um `Buffer` também serve) e `mimeType: 'audio/ogg' | 'audio/mpeg' | 'audio/wav'`.

- Só o botão de ouvir chama o provider. Digitar, navegar ou selecionar não gera o clipe; ouvir não executa o comando nem modifica a fila.
- O transporte usa o **WebSocket já autenticado**, pessoa → servidor → bot → pessoa. Não exige `serve()`, hospedagem pública, URL assinada ou porta adicional. O servidor troca os IDs do provider por tokens efêmeros vinculados à mesma pessoa, dispositivo, canal, bot, comando, opção e busca; apenas escolhas anunciadas e ainda válidas podem ser ouvidas.
- O prazo de geração é **30 segundos**; o limite é **256 KiB de bytes** (base64 somente no transporte) e **10 segundos de reprodução**. O processo nativo valida MIME, tamanho e estrutura antes de criar a fonte local do player. Isso não relaxa as proteções HTTPS/DNS/redirecionamento da variante URL.
- As escolhas lazy expiram após **60 segundos**, ou antes ao mudar a consulta/opção/comando, fechar, perder acesso, alterar configurações ou desconectar. Trocar de prévia cancela a anterior. Propague `signal` também para subprocessos e libere seus recursos.
- Há até **4 providers simultâneos por `BotClient`** e 100 solicitações pendentes por servidor. Um provider que ignora o abort continua ocupando sua vaga até concluir. Erros, timeout, bytes vazios, MIME inválido e excesso de tamanho retornam falha explícita; erros lançados pelo provider também chegam ao evento `error` do SDK.

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

Use **botão direito no bot → Configurações do bot**, inclusive no nome/foto de mensagens e cards privados. Quem tem acesso à aba **Configurações do servidor → Bots** também pode abrir as preferências de cada bot por ela, inclusive de bots offline. As preferências pessoais continuam disponíveis pelos pontos de entrada do próprio bot, sem um item duplicado no menu do servidor. O servidor precisa estar conectado; desligar o bot não apaga suas declarações ou configurações.

Reservas manuais ainda sem identidade aparecem apenas na administração de bots,
aguardando conexão; suas configurações ficam indisponíveis até o bot anunciar
a própria identidade.

| Escopo | Quem altera | Onde fica |
|---|---|---|
| **Comportamento neste servidor** | Administradores/proprietário ou cargo com **Configurar comportamento dos bots** (`CONFIGURE_BOTS`) | Banco desse servidor; afeta todos que usam esse bot nele |
| **Minhas preferências** | A própria pessoa | Perfil local, separado por endereço, servidor, identidade e bot; não sincroniza entre dispositivos |

`CONFIGURE_BOTS` é independente de `MANAGE_BOTS`, que controla vínculo e desvínculo, não a identidade. Nome e avatar só podem ser atualizados pelo bot autenticado. Quem não pode configurar não recebe os valores nem o formulário compartilhado. O SDK declara campos reutilizáveis; não injeta HTML nem cria uma aba global nas configurações do app. Se o bot não declarar opções compartilhadas, essa seção não aparece.

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
  localizations: {
    en: {
      server: {
        title: 'Behavior',
        fields: { enabled: { label: 'Enabled on this server' }, limit: { label: 'Maximum results' } },
      },
      user: { title: 'My preferences', fields: { compact: { label: 'Compact replies' } } },
    },
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

`localizations` é opcional e aceita `pt-BR` e `en`, seguindo a preferência individual de idioma para o bot (por padrão, o Monky). Cada escopo pode traduzir `title`, `description`, `submitLabel` e, em `fields`, `label`, `description`, `placeholder` e `choices: { valor: { label, description } }` de campos/escolhas já declarados. As traduções não alteram nomes, tipos, valores padrão ou validação; textos não traduzidos usam a declaração original. O formulário compartilhado e suas traduções só são enviados a quem pode configurá-lo.

No MonkyBot, **Comportamento neste servidor → Música → Tempo de inatividade (segundos)** controla a saída por fila ociosa ou sala vazia: padrão de 60 segundos, de 1 a 600, salvo por servidor. Alterar durante uma espera considera o tempo já decorrido. A variável de ambiente `MONKY_MUSIC_GRACE_SECONDS` apenas define o padrão do host; não substitui a configuração compartilhada.

`ctx.settings` é um snapshot validado pelo servidor, com `server`, `user`, `schemaRevision` e `serverRevision`. Invocações, autocomplete e respostas a seletores independentes recebem as preferências de quem iniciou aquela ação. Perguntas privadas do mesmo comando conservam o snapshot original; alterações posteriores valem para novas ações. `onSelectorResponse` entrega preferências somente ao bot proprietário, sem incluí-las no histórico público do seletor. Mensagens ou reações genéricas não transmitem preferências a todos os bots.

O cache de `getServerSettings()` e os eventos de configuração são separados por conexão/servidor do SDK. Reconexões idênticas preservam overrides. Escritas compartilhadas usam revisão otimista: alterações concorrentes ou declarações desatualizadas exigem recarregar, sem sobrescrever silenciosamente outra edição. Overrides compartilhados incompatíveis impedem a substituição da declaração; restaure esses campos na configuração antiga antes de registrar a nova versão. Preferências individuais incompatíveis são mostradas para revisão/reset, não descartadas silenciosamente. As declarações têm limite agregado de 64 KiB; os valores, 16 KiB por escopo, além dos limites usuais dos formulários.

**Decisões locais do host não são configurações do bot.** A confirmação/nome do download é uma preferência local oferecida automaticamente para bots com comandos `downloadsSound`. Ela nunca aparece em `ctx.settings`, não pode ser alterada por administrador ou bot e não concede acesso geral a arquivos. A pasta continua em Soundboard. Um bot como o Myinstants não precisa chamar `settings()` para oferecer essa preferência.

### Fotos dos bots

Nome e foto são definidos pelo processo do bot, não pela gestão no cliente.
O operador pode configurar o nome no CLI do bot (`botName`), e o código publica
essa identidade pelo SDK:

```ts
import { readFileSync } from 'node:fs';
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  requestedCapabilities: [],
  publicKey: 'SUA_CHAVE_ED25519_HEX',
  name: 'Meu Bot',
  avatarBase64: `data:image/png;base64,${readFileSync('bot.png').toString('base64')}`,
});
```

No modo marketplace, `serve({ name, icon, ... })` aceita a mesma imagem em `icon`.
Informe **base64 ou data URI**, não uma URL de imagem. O servidor valida formato
e tamanho e hospeda a foto. `avatarBase64: null` remove explicitamente a foto
anterior; omitir o campo preserva a foto existente. O SDK anuncia o nome na
autenticação inicial e reaplica o perfil ao conectar, inclusive em vínculos já
existentes. Uma falha ao aplicar a foto é informada sem ocultar os comandos.
Administradores não podem sobrescrever a identidade pelo cliente nem pela API
de perfil. O MonkyBot oficial já inclui a logo do Monky no pacote.

## Modo Marketplace (multi-servidor)

Se você quer distribuir seu bot para que qualquer servidor Monky possa adicioná-lo, use o modo `serve()`:

```ts
import path from 'node:path';
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  requestedCapabilities: ['commands'],
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
- `GET /manifest` — retorna o manifest do bot (nome, descrição, capacidades solicitadas, URL de registro)
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

O [**Monky Bot**](https://github.com/MonkyOrg/MonkyBot) é o bot de referência mantido pela organização. Ele serve como exemplo prático e inclui comandos utilitários e de música:

| Comando | Descrição |
|---------|-----------|
| `/ping` | Latência do bot |
| `/dado [lados]` | Rola um dado (2-100 lados) |
| `/moeda` | Cara ou coroa |
| `/8ball <pergunta>` | Bola mágica; a pergunta é obrigatória |
| `/enquete` | Formulário privado; publica a votação no canal sem revisão e encerra por tempo e/ou total de votantes |
| `/play <nome ou URL>` | Autocomplete de músicas por nome ou link de vídeo individual do YouTube, com prévia local sob demanda e seleção para adicionar à fila |
| `/queue` | Mostra a fila |
| `/nowplaying` | Mostra a música atual |
| `/pause` e `/resume` | Pausa e continua a reprodução, sem reiniciar a faixa |
| `/skip` | Passa para a próxima faixa |
| `/remove <posição>` | Remove uma faixa da fila |
| `/clear` | Limpa as próximas faixas sem interromper a atual |
| `/stop` | Interrompe a reprodução e limpa a fila |
| `/leave` | Interrompe, limpa a fila e desconecta da voz |
| `/jogo-da-velha` | Abre uma partida compartilhada, com dois jogadores e espectadores |
| `/ajuda` | Lista todos os comandos |

Há uma fila independente por servidor e um canal de voz ativo para cada fila. Todos os comandos de música, a busca e a prévia privada exigem estar em voz, inclusive `/queue` e `/nowplaying`. O primeiro `/play` leva o bot à sala de quem pediu; se ele já estiver em outra sala, o pedido é recusado com uma orientação para entrar nela. Não há cargo de DJ, mas as permissões gerais de comandos do Monky continuam valendo. A reprodução não pertence ao handler de `/play`: concluir ou expirar aquele comando não encerra as músicas já adicionadas.

A música usa somente `/play`, não um `/query` separado. A busca espera 700 ms sem digitação e reutiliza o espaçamento de envios do autocomplete; a preparação e a autorização locais acontecem antes de iniciar o prazo da busca. O botão de ouvir gera até 10 segundos apenas para essa pessoa, sem adicionar à fila. Selecionar o resultado e executar `/play` é a ação que adiciona a música.

No modo `youtube-local`, a busca, a resolução das fontes e a conversão do áudio pertencem ao **cliente de quem fez o pedido**, em um processo Node isolado e com ferramentas gerenciadas pelo Monky. O MonkyBot mantém a fila, os controles e a publicação na sala, podendo continuar hospedado em uma VPS. Não há execução alternativa na VPS nem transferência automática para outro participante ou dispositivo. `ctx.downloadSound()` continua sendo uma operação diferente: um download autorizado para a soundboard, não uma fonte contínua de música.

Se o solicitante da faixa atual sair da sala ou desconectar o cliente, o bot interrompe essa faixa, avisa no chat e a pula. As próximas faixas daquela sessão ficam preservadas enquanto ela estiver indisponível; pedidos elegíveis de outras pessoas podem continuar. Outra sessão da mesma conta não substitui a original. Uma fila sem faixas elegíveis continua sujeita à configuração de saída por inatividade, e encerrar a fila libera suas referências.

Nesta primeira versão, Spotify, playlists, álbuns e transmissões ao vivo não são suportados. A integração de YouTube por extração não é uma API oficial de áudio para bots e pode deixar de funcionar por restrições ou mudanças da plataforma. Use somente conteúdo cuja reprodução você esteja autorizado a realizar e respeite os [termos e políticas do YouTube](https://developers.google.com/youtube/terms/developer-policies). Os pré-requisitos de mídia e as mensagens de indisponibilidade estão documentados no repositório do bot.

Consulte o [repositório do Monky Bot](https://github.com/MonkyOrg/MonkyBot) para instruções de instalação e uso.

## Execução local de capacidades

Essa infraestrutura pertence ao SDK e ao cliente, não exclusivamente ao MonkyBot. Um comando declara `localCapabilities: ['youtube-audio']` somente quando precisa de processamento local. Comandos de controle ou consulta de fila não devem pedir instalação apenas para poder executar.

Ao **selecionar o comando**, por clique ou teclado, o Monky inicia seus pré-requisitos antes de preencher parâmetros, pesquisar ou executar. Quando necessária, a autorização é solicitada **por bot, servidor, instalação e chave pública**, neste dispositivo. É possível negar, permitir até encerrar a conexão com o servidor ou manter a autorização até revogá-la. Nomes iguais não compartilham permissão. Apenas navegar pela lista não pede autorização. Fechar o comando ou trocar de canal cancela sua preparação; uma conclusão atrasada não executa o comando.

O pedido usa um modal com o visual do Monky, controlado pelo Main. Antes de permitir, ele descreve Node.js, yt-dlp e FFmpeg, a finalidade de cada ferramenta e o limite conservador de espaço adicional, separando arquivos já instalados de novos downloads. Após a aprovação, o **mesmo modal** acompanha a instalação: o download mostra bytes reais e uma barra; consulta, verificação e extração usam uma animação sem percentual inventado. Opções e progresso permanecem visíveis mesmo quando a descrição precisa rolar. O comando só é liberado após a preparação e a autorização serem concluídas.

Uma preparação concluída é reutilizada na mesma conexão, inclusive ao selecionar novamente o comando. Ao editar a busca, o compositor mostra o carregamento da pesquisa, não um novo aviso de instalação. Se a instalação falhar, **Tentar novamente** repete a preparação no mesmo modal, preservando a duração escolhida e reutilizando as ferramentas concluídas. Se uma limpeza anterior falhou, essa ação tenta limpar os arquivos retidos antes de instalar novamente, somente após confirmar que os processos nativos foram encerrados. Uma ferramenta inválida ou um bloqueio persistente continua impedindo a instalação; o erro e o número da tentativa ficam visíveis. Cancelar durante a instalação aguarda o encerramento e a limpeza; uma preparação que falha não grava uma nova permissão.

As tarefas continuam verificando a integridade dos executáveis antes do uso. O cliente reutiliza apenas o resultado do teste nativo de versão de uma geração já verificada neste processo; substituir arquivos, remover a ferramenta ou reiniciar o cliente exige um novo teste. Na música, o streaming local já consulta uma fonte atualizada e revalida o solicitante, então a fila não cria outra tarefa de consulta imediatamente antes dele. Pedidos de adicionar e pular recebem confirmação de processamento, e cada início de faixa tem um aviso de preparação antes de **Tocando**; o aviso de reprodução só aparece após o primeiro quadro enviado à voz.

Esperas de pesquisa, prévia, início do comando, resposta do bot, envio de formulários/seletores, download e cancelamento têm indicadores animados, preservando o texto localizado e os controles de cancelamento disponíveis. Os indicadores param ao concluir ou falhar e respeitam a preferência de movimento reduzido do sistema.

Em **Configurações → Ferramentas de bots**, a pessoa pode consultar ferramentas instaladas, versões, armazenamento, cache, permissões e tarefas. O atalho **Gerenciar permissões e ferramentas locais** nas configurações do bot abre essa seção pessoal, não uma permissão administrativa do servidor.

**Remover ferramenta** e **Limpar cache** também usam uma confirmação com o visual do Monky, sem diálogo nativo do sistema. O mesmo modal mostra o andamento, permite tentar novamente em caso de falha e só fecha após a operação terminar. É possível desistir antes de confirmar; após confirmar, a limpeza precisa concluir o encerramento das tarefas. A aba libera as demais ações assim que a operação termina, sem ficar presa à atualização do inventário; leituras sem resposta exibem um erro que permite atualizar novamente.

- **Ferramentas:** Node.js, yt-dlp e FFmpeg portáteis são obtidos de receitas conhecidas pelo Monky, com verificação de integridade. Não é uma instalação global nem uma alteração do `PATH` da pessoa.
- **Compartilhamento:** bots podem reutilizar os mesmos arquivos instalados; suas autorizações continuam separadas.
- **Revogação e remoção:** interrompem o trabalho afetado. Remover uma ferramenta revoga as capacidades que dependem dela; o bot não pode reinstalá-la silenciosamente.
- **Limpar cache:** interrompe as tarefas locais, mas mantém ferramentas e permissões. O espaço exibido é o armazenamento efetivamente retido, não o total de áudio já transmitido.

::: warning Limites de confiança e conectividade
O processo separado melhora o isolamento de ciclo de vida, mas **não é uma sandbox do sistema operacional**. O SDK solicita operações fixas; não recebe uma API de shell, caminhos executáveis ou scripts enviados pelo bot. O consentimento é validado no Main do Electron, não concedido por uma preferência do renderer.

A transmissão precisa de um canal WebRTC privado entre cliente e bot, mesmo quando a sala usa SFU. Uma chamada SFU funcionando não comprova que esse caminho privado está acessível. A configuração ICE autorizada pelo servidor é reutilizada; não há ativação automática de TURN, áudio por WebSocket ou substituição do executor se a conexão falhar.
:::

### Contratos do SDK

`BotClient` implementa `LocalExecutionProvider`: obtenha o cliente de execução com `const client = bot.localExecution(serverId)`. Os contratos públicos `LocalExecutionClient`, `LocalExecutor` e `LocalOpusStream` separam a origem autorizada, cada tarefa e o relógio de reprodução:

| Operação | Responsabilidade |
|----------|------------------|
| `bot.localExecution(serverId)` | Seleciona a conexão do servidor, sem selecionar outro usuário |
| `client.executor(context)` | Usa uma invocação, autocomplete, prévia ou referência de fonte autorizada |
| `executor.execute(spec, { signal })` | Executa `youtube.search`, `youtube.resolve` ou `youtube.preview` |
| `client.retainSource(invocationId, url, { signal })` | Retém a origem e a URL canônica de um item a partir de uma invocação real |
| `client.checkSourceAvailability(sourceContextId, voiceChannelId, { signal })` | Confirma a presença e o acesso da conexão original, sem iniciar uma tarefa no cliente |
| `executor.stream(spec, { voiceChannelId, signal })` | Abre uma nova tarefa `youtube.stream` para a sala atual |
| `client.releaseSource(sourceContextId)` | Libera a referência de um item removido ou concluído |

Nos contextos de autocomplete e prévia, `requestId` é o identificador remapeado pelo servidor entregue ao callback do SDK. A prévia retornada pode conter outro `requestId`, da solicitação original do cliente: devolva o `LocalWirePreviewResult` sem reescrever seus campos. Ele contém somente referências; o Ogg permanece no cliente de origem. Metadados `LocalMediaTrack` não têm `audioUrl`, e o token de autorização do Main nunca faz parte das mensagens de comando.

Uma referência retida não é uma tarefa ativa. Não mantenha o `AbortSignal` da invocação como duração da reprodução, nem use outra sessão da mesma conta após uma desconexão. Cada reprodução abre uma tarefa nova, sujeita à autorização e à presença atuais.

Para retomar entradas aguardando o solicitante, use `checkSourceAvailability()`: o servidor verifica a fonte retida, a conexão física original, a sala e o acesso atual. O sucesso não instala ferramentas, não abre transporte e não substitui o consentimento ou a admissão do próximo stream. Uma saída e volta à voz na mesma conexão pode tornar a fonte disponível; reconectar o cliente não reativa referências da conexão encerrada, mesmo reutilizando o mesmo `invokerSessionId`. Eventos `voiceParticipantsChanged` podem disparar consultas sequenciais e agrupadas, mas a contagem de pessoas, um comando recente ou outra sessão nunca são autorização.

O stream fornece pacotes Opus em `frames`. O bot mantém a cadência de 20 ms e chama `markFrameAdvanced()` **uma vez por quadro consumido pelo seu relógio**, depois de `writeOpus()`. Prefetch, crédito de recepção e chegada de bytes não são avanço de reprodução. Aguarde `setPaused()` e observe `stream.signal` também enquanto a fila estiver pausada. `LocalExecutionError.event` distingue falha, saída da voz, desconexão e revogação; decidir avisos e mudanças na fila continua sendo responsabilidade do bot.

Uma recusa antes da admissão da tarefa, ou em uma operação de referência/controle, usa `LocalExecutionRpcError`. Consulte `code` e, quando presentes, `reason` ou `cancellationCause`; esse erro não inventa um evento de tarefa. Não trate uma recusa de consentimento ou uma falha de transporte como erro de autenticação do provedor.

O fim do decoder não significa que o último quadro já foi consumido. Preserve a cauda até as confirmações finais: `stream.closed` resolve somente após a drenagem de reprodução e a conclusão confirmada pelo servidor, e rejeita em falha ou cancelamento. Aguarde `stream.close()` para cancelar trabalho ativo ou aguardar a conclusão de um stream já drenado; a rejeição de `closed` por si só não substitui o encerramento. Encerrar um stream não libera automaticamente a referência de sua fonte. No cliente, o processo nativo pode terminar antes das confirmações de reprodução, sem perder a possibilidade de cancelar ou revogar a tarefa restante.

Usar o computador do solicitante não garante que o provedor aceite uma requisição. A capacidade inicial aceita somente vídeos públicos individuais elegíveis do YouTube, sem contas, cookies ou contorno de restrições. Recusas do provedor permanecem erros explícitos.

### Validação integrada no checkout

O modal e a indicação de busca têm regressões próprias em `npm run test:local-execution --workspace=@monky/client`. Para exercitar só apresentação, decisões, progresso e cancelamento do modal, use `npm run test:local-preparation --workspace=@monky/client`. Seu preload é um bundle isolado, gerado também pelo build normal, para manter `sandbox: true` sem expor uma API genérica ao documento.

Depois do build do Monky, o teste abaixo inicia servidor, SDK e dois clientes Electron isolados, em salas P2P e SFU reais. Ele mede áudio decodificado no ouvinte e verifica consentimento, mute/PTT, pausa, saída da voz, drenagem final e encerramento dos recursos. Não reutiliza perfis ou servidores pessoais.

```powershell
$env:MONKY_WORKER_TEST_FFMPEG = 'C:\caminho\ffmpeg.exe'
npm run test:local-execution:e2e --workspace=@monky/client
```

Para exercitar também o **registro de comandos de produção do MonkyBot**, faça o build do bot com o SDK compatível instalado e, na raiz do Monky, defina o checkout dele:

```powershell
$env:MONKY_LOCAL_E2E_MUSIC_BOT_ROOT = 'C:\caminho\MonkyBot'
npm run test:local-execution:e2e --workspace=@monky/client
Remove-Item Env:\MONKY_LOCAL_E2E_MUSIC_BOT_ROOT
```

Esse modo carrega o SDK realmente instalado no bot e percorre busca, prévia, `/play`, fila mista, `/pause`, retorno do solicitante e `/skip` pela interface. Ambos os modos usam áudio autoral controlado: não acessam o YouTube nem comprovam que o provedor aceitará uma requisição real.

## Voz para bots

O SDK separa a conexão de voz da fonte de áudio. `bot.joinVoice(serverId, channelId, options?)` cria a conexão P2P ou SFU apropriada ao servidor; o bot mantém a fila e o ritmo de publicação. A decodificação pode pertencer à sua fonte local ou a uma capacidade autorizada no cliente de um participante. Bots de texto não precisam iniciar conexões de mídia.

O bot entra com os estados pessoais de mute e deafen desligados; restrições administrativas existentes continuam valendo. O SDK atual transmite áudio, mas ainda não oferece uma API para receber a voz dos participantes ([#642](https://github.com/MonkyOrg/Monky/issues/642)). Essa limitação não é representada como um deafen escolhido pelo bot.

Declare `voiceRequirement: 'joined'` em comandos que exigem voz ou `'same-bot-channel'` quando também é necessário estar na sala do bot, caso ele já esteja conectado à voz. Sem esse campo, os comandos mantêm o comportamento normal. Cliente e servidor aplicam a regra à execução, ao autocomplete e à prévia; o servidor usa a conexão exata da pessoa, não outro dispositivo da mesma conta. Sair ou mudar de sala cancela o trabalho pendente e invalida escolhas/prévias, sem transferir o pedido para outra sala. Uma fonte independente hospedada no bot não pertence à duração da invocação; um stream delegado ao cliente, porém, depende da presença de seu executor na voz.

O contexto de comando contém `invokerSessionId` e `invokerVoiceChannelId` autenticados pelo servidor. Eles descrevem a execução inicial; o segundo é `null` quando a conexão que chamou o comando não está em voz. **O campo não é um getter vivo.** Depois de uma busca, formulário ou outra espera, use `await ctx.getVoiceChannel()` para consultar novamente a sala da conexão original no servidor. Não procure a sala somente por `invokerId`: a mesma pessoa pode estar conectada em dois dispositivos, em salas diferentes.

```ts
bot.command({
  name: 'join',
  description: 'Entra na sua sala de voz',
  voiceRequirement: 'same-bot-channel',
  handler: async (ctx) => {
    const channelId = await ctx.getVoiceChannel();
    if (channelId === null) {
      ctx.reply(ctx.locale === 'en' ? 'Join a voice room first.' : 'Entre em uma sala de voz primeiro.');
      return;
    }
    await bot.joinVoice(ctx.serverId, channelId, { invocationId: ctx.invocationId });
    ctx.reply(ctx.locale === 'en' ? 'Connected to voice.' : 'Conectado à voz.');
  },
});
```

Passe `invocationId` ao entrar pela solicitação de uma pessoa: o servidor confirma novamente a conexão, a sala atual e a autorização, inclusive para salas privadas. Trocar ou sair de sala entre a consulta e a entrada invalida o pedido. Essa capacidade é específica da voz e não dá acesso geral ao chat privado. A entrada sem invocação continua exigindo o acesso do próprio bot ao canal. Antes de alterar uma fila existente, revalide também a sala de quem solicitou a ação; terminar o comando que iniciou a reprodução não encerra a conexão de voz.

Use `bot.getVoiceConnection(serverId)` para obter a conexão daquele servidor e `await bot.leaveVoice(serverId)` para encerrá-la. Cada conexão expõe `channelId` e `humanParticipantCount`. O evento `voiceParticipantsChanged` entrega `{ serverId, channelId, humanParticipantCount }`; `voiceDisconnected` também informa o motivo em `reason`. Registre listeners uma vez e remova-os ao encerrar o bot.

`await connection.writeOpus(frame)` transmite **um pacote Opus bruto de 20 ms, com relógio de 48 kHz**, não um arquivo Ogg, MP3 ou bytes PCM. A fonte deve extrair os pacotes e enviá-los no ritmo de reprodução, sem descarregar o arquivo inteiro de uma vez. Mantenha a reprodução em uma sessão independente da invocação e interrompa a fonte ao sair da voz ou perder a conexão. `/pause` deve suspender o avanço da fonte; simplesmente parar de transmitir enquanto ela continua lendo perderia a posição.

A transmissão usa o mesmo indicador de fala dos demais participantes. O SDK publica mudanças de atividade, não um evento por pacote, e limpa o indicador quando a transmissão fica ociosa, é silenciada ou termina. Cada pessoa também pode mutar o bot apenas para si: isso não muda o áudio dos demais nem a reprodução ou a fila.

Quando a fonte for pausada ou encerrada, `connection.stopSpeaking()` limpa o indicador imediatamente, sem fechar a conexão nem alterar preferências de mute. Esse método não substitui pausar ou encerrar a própria fonte de áudio.

Mute/deafen administrativo tem outra semântica: enquanto a conexão estiver bloqueada, `writeOpus()` valida e descarta os pacotes, sem enviá-los nem gerar uma falha de mídia. Continue respeitando a cadência de 20 ms. No MonkyBot, a música e a fila avançam normalmente em silêncio; liberar o bloqueio devolve o som na posição atual. Uma pausa manual não é desfeita por essa mudança. Pacotes inválidos, conexões encerradas e falhas reais de transporte continuam produzindo erros.

## Telas programáveis compartilhadas

Uma tela é um miniapp HTML/CSS/JavaScript apresentado **no palco de voz**. Quem está na sala recebe um convite no mesmo canto dos avisos de compartilhamento de tela e escolhe se quer visualizar. Não há card de miniapp no chat nem abertura automática. Diferentemente dos formulários privados de `ctx.prompt()`, ele aceita vários participantes e continua ativo depois que o handler do comando termina. O `/jogo-da-velha` do MonkyBot demonstra dois jogadores e espectadores; as regras continuam no bot, não no JavaScript de quem está vendo a tela.

O cartão permanece no palco junto de câmeras e compartilhamentos, mesmo com a visualização fechada. **Abrir miniapp** inicia a visualização local; **Sair do miniapp** a encerra e devolve o cartão ao estado fechado, sem encerrar o miniapp para os demais. Focar ou voltar à grade só altera o layout: não recarrega a tela nem muda quem ocupa as vagas de jogador. Abrir uma tela para assistir não equivale a entrar na partida.

**Encerrar miniapp** é outra ação: remove a instância, o cartão e os convites
para todos e fecha as visualizações abertas. Só aparece para quem invocou o
comando criador ou para um administrador (`ADMINISTRATOR`, incluindo o dono do
servidor). O servidor verifica a mesma autorização e a presença desta conexão
na sala; ocultar o botão não é a proteção. O criador é a identidade autenticada
`creatorUserId`, preservada ao entrar por outro dispositivo ou reconectar, e não
o ID do bot nem um campo fornecido pelo miniapp. Telas criadas sem invocação não
têm criador humano; somente administradores podem encerrá-las pelo cliente.

As outras visualizações abertas exibem um aviso temporário com o nome do
miniapp, no idioma do cliente. Quem apenas recebeu o convite ou já saiu da
visualização não recebe esse aviso.

Dentro de um comando, `ctx.createScreen()` consulta a sala de voz atual de quem chamou e associa o miniapp àquela sala e à invocação, inclusive em sala privada autorizada. `screen.channelId` é sempre um **canal de voz**, não `ctx.channelId` (o canal de texto do comando). Sem voz, a criação é recusada. O bot não precisa estar conectado ao áudio para oferecer um miniapp. A API avulsa `bot.createScreen(serverId, input)` exige acesso do próprio bot; passar `invocationId` permite a autorização específica da invocação. Isso não concede acesso geral a mensagens privadas.

```ts
bot.command({
  name: 'tela',
  description: 'Abre uma tela compartilhada',
  voiceRequirement: 'joined',
  handler: async (ctx) => {
    await ctx.createScreen({
      title: ctx.locale === 'en' ? 'Shared screen' : 'Tela compartilhada',
      html: `<main id="message"></main><script>
        window.monkyScreen.onState(state => {
          document.getElementById('message').textContent = state.message;
        });
      </script>`,
      state: { message: ctx.locale === 'en' ? 'Hello, everyone!' : 'Olá, pessoal!' },
    });
  },
});
```

No documento isolado, o bridge `window.monkyScreen` fornece:

| API da tela | Comportamento |
|-------------|---------------|
| `viewer` | Contexto local imutável com `id`, `nickname` e `locale` (`pt-BR` ou `en`) da pessoa que abriu a tela |
| `onState((state, revision) => ...)` | Entrega o estado inicial e as atualizações; retorna uma função de unsubscribe |
| `sendAction(action, payload)` | Envia uma intenção vinculada à revisão atual; retorna se o bridge aceitou o envio, não se o bot aceitou a ação |

Leia `window.monkyScreen.viewer.locale` dentro do callback de `onState()` para traduzir os controles de cada pessoa. Trocar o idioma no aplicativo também aciona esse callback, sem mudar o estado/revisão compartilhados nem recriar o iframe. Não escolha o idioma dos controles a partir do estado público ou do idioma de quem criou a tela.

O evento `screenAction` do SDK entrega `{ serverId, screenId, instanceId, channelId, userId, userNickname, action, payload, revision, actionId }`. Use a identidade autenticada desse envelope, nunca um jogador/usuário informado em `payload`. Valide a ação e suas regras no bot antes de chamar `await bot.updateScreen(serverId, screen, { state, expectedRevision })`. Passe o snapshot recebido, ou um `BotScreenRef` com `{ id, instanceId }`, não apenas o ID textual. Uma atualização aceita incrementa `revision` e chega aos participantes; uma revisão antiga é rejeitada em vez de sobrescrever uma alteração concorrente. O HTML permanece o mesmo durante as atualizações de estado.

Use `listScreens(serverId, channelId)` com o ID da sala de voz para obter
snapshots atuais e `closeScreen(serverId, screen)` para o próprio bot encerrar.
O `instanceId` é gerado pelo servidor: mesmo reutilizando `id`, uma nova tela
ganha outra instância. Updates, ações, encerramentos e eventos antigos não
podem atingir a substituta. O END humano não exige a última revisão do estado;
uma atualização concorrente não impede o encerramento da instância correta.

O evento `screenRemoved` entrega `{ serverId, id, instanceId, channelId, reason }`.
Quando `reason === 'ended'`, também inclui `endedByUserId`, autenticado pelo
servidor. Os demais motivos são `closed`, `access_revoked`, `bot_disconnected`
e `view_revoked` (revogação de uma visualização local, não encerramento global).
Remova o estado correspondente no bot comparando **servidor, ID e instância**:
cancele timers/expiração, aborte trabalho pendente e libere as vagas do jogo.
Se a instância controla música, encerre também a fonte/fila que ela possui e
libere seus recursos; o SDK não pode adivinhar a regra de domínio do bot.
Não use um erro de instância inexistente como sinal para recriá-la.

Depois de um END, a invocação criadora ainda em execução é cancelada, incluindo
seus prompts e trabalho pendente; ela não pode criar outra tela. Um novo comando
é necessário. Invocações concluídas/expiradas continuam
inválidas para criação. O SDK rejeita leituras/updates cuja resposta foi
ultrapassada por uma remoção, em vez de devolver um snapshot aparentemente
ativo. Depois de qualquer `await`, confira se a sessão do jogo ainda é a mesma
antes de armazenar o resultado. `ctx.signal` é abortado se a invocação ainda
estiver ativa, mas não acompanha a tela depois que o handler termina: use
`screenRemoved` para o teardown do miniapp.

Registre listeners uma vez e remova-os ao encerrar. O cliente recupera os
miniapps ativos ao entrar na sala; sair, mudar de sala ou desconectar fecha a
visualização local e revoga ações. **Sair do miniapp** não envia END, não apaga
o estado compartilhado e não libera automaticamente uma vaga de jogador.

**Estado compartilhado, sem segredos:** os participantes autorizados que estão naquela sala de voz recebem o HTML e o estado JSON. O servidor também verifica a presença na sala para listar e interagir; estar em outro canal ou em voz em outro dispositivo não autoriza esta conexão. Interações exigem `USE_BOT_COMMANDS`. Não inclua tokens, caminhos locais ou informações secretas de um jogador. A tela não recebe Node.js, preload, IPC, acesso ao DOM do cliente ou autorização para rede, navegação, popups e downloads. Inclua os recursos visuais no documento em vez de depender de CDNs ou requisições externas.

Os limites são 128 KiB de HTML, 64 KiB de estado e 8 KiB por ação; JSON aceita até 12 níveis e 8.192 nós. Há até quatro miniapps por sala de voz, 16 por bot e 64 por servidor, com limites de frequência e deduplicação de ações. Eles vivem em memória e são removidos ao reiniciar/desconectar o bot, perder a autorização de acesso à sala ou receber um encerramento autorizado. Sair da sala, inclusive deixá-la vazia, não apaga automaticamente o estado. A expiração do jogo é responsabilidade do bot. Se persistir partidas, persista também seu encerramento: reiniciar o bot não deve recuperar uma partida explicitamente encerrada.

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
| `bot.getPermissions(serverId)` | Consulta as capacidades solicitadas/concedidas e o estado da revisão; indisponível antes da resposta de registro ou após desconectar |
| `bot.localExecution(serverId)` | Obtém os executores locais e gerencia referências de fontes autorizadas |
| `bot.joinVoice(serverId, channelId, { invocationId }?)` | Conecta à voz, com autorização da invocação quando fornecida |
| `bot.getVoiceConnection(serverId)` | Obtém a conexão de voz ativa daquele servidor |
| `bot.leaveVoice(serverId)` | Encerra a conexão e libera os recursos de mídia |
| `bot.createScreen(serverId, input)` | Cria um miniapp de HTML e estado JSON em uma sala de voz |
| `bot.updateScreen(serverId, screenRef, { state, expectedRevision })` | Atualiza a instância `{ id, instanceId }` sem perder alterações concorrentes |
| `bot.listScreens(serverId, channelId)` | Obtém os miniapps ativos autorizados daquela sala de voz |
| `bot.closeScreen(serverId, screenRef)` | Encerra a instância `{ id, instanceId }` para todos os participantes |
| `bot.serverCount` | Número de servidores conectados |
| `bot.serverIds` | IDs dos servidores conectados |
| `bot.registeredServerCount` | Quantidade de vínculos autenticados conhecidos, inclusive offline |

### `BotOptions`

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `publicKey` | `string` | ✅ | Chave pública Ed25519 em hex |
| `requestedCapabilities` | `BotCapability[]` | ✅ | Categorias solicitadas explicitamente, sem concessão automática; `[]` permite apenas identidade/metadados |
| `serverUrl` | `string` | Modo manual | URL WebSocket do servidor |
| `token` | `string` | Modo manual | Token do bot |
| `autoReconnect` | `boolean` | — | Reconectar automaticamente (padrão: `true`) |
| `name` | `string` | — | Nome publicado pelo bot, inclusive na autenticação inicial |
| `avatarBase64` | `string \| null` | — | Foto em base64/data URI; `null` remove a foto anterior |
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
