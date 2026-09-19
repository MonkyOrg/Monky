# Empacotar e distribuir

Este guia é para o autor e para o operador de um bot que usa o **CLI fornecido
pelo SDK**. Ele não é o [CLI do servidor Monky](/cli), e um bot com CLI próprio
não recebe estes comandos automaticamente.

Complete [Seu primeiro bot](/bots-desenvolvimento) antes de empacotar.
**Referência:** [BotPackageDefinition](/bots-api-ferramentas#botpackagedefinition),
[BotUpdateSource](/bots-api-ferramentas#botupdatesource) e
[buildBotPackage](/bots-api-ferramentas#buildbotpackage).

## CLI e pacote automático do bot

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

Execute `meu-bot` sem comando em um terminal para abrir o **menu por setas**,
ou use `meu-bot menu`. Enter confirma e Esc cancela; o item **Sair do menu**
não para o processo. **Configuração > Atualizações** reúne origem, token GitHub,
consulta/instalação de versões e agendamento. `meu-bot config` abre a configuração
interativa; `meu-bot config show` sempre imprime a versão com segredos ocultos.
Sem TTY ou em CI, executar sem comando continua mostrando ajuda, sem perguntas.
Comandos e flags de automação continuam disponíveis.

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

## Atualizações opcionais do CLI

`update` e a ativação de `autoupdate` exigem uma origem explícita. O autor pode
definir o padrão no `package.json` usado no build; o operador pode substituí-lo
depois da instalação, sem editar o pacote ou refazer o setup.
**GitHub Releases é a opção recomendada**: permite manter histórico de versões
e selecionar stable/beta no formato de pacote atual.

```text
meu-bot config update-source
meu-bot config update-source github https://github.com/minha-org/meu-bot/releases
meu-bot config update-source github https://github.com/minha-org/meu-bot/releases --asset-name meu-bot-{version}.tgz --token-env GH_TOKEN
meu-bot config update-source https https://downloads.example.com/meu-bot.tgz
meu-bot config update-source file "C:\atualizacoes\meu-bot.tgz"
meu-bot config update-source reset
meu-bot update --check
```

A escolha fica em `~/.<cliName>/update-source.json`, fora da instalação, e vale
para `update` e para as próximas verificações de `autoupdate`. Sobrevive à
substituição do pacote; não altera o canal, a conexão, as chaves nem os vínculos.
Sem argumentos, o comando mostra a origem efetiva; `reset` remove a escolha e
volta ao padrão atual do pacote. Uma configuração salva inválida interrompe a
atualização, sem recorrer silenciosamente a outra origem.

No comando `file`, um caminho relativo é convertido em absoluto a partir do
terminal ao salvar. Use o caminho nativo da máquina do bot. HTTPS aceita
`--token-env`; GitHub também aceita `--asset-name`. Salve somente o nome da
variável, nunca o token. A mudança valida a configuração; `update --check`
verifica a disponibilidade na origem escolhida.

### Repositório privado no GitHub

Crie um [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)
com o dono correto do repositório, somente o repositório necessário e
**Contents: Read-only**. Uma organização pode exigir aprovação antes de ele
funcionar. Use uma validade limitada e renove o segredo quando necessário.

`--token-env GH_TOKEN` recebe o **nome da variável**, não o segredo.
Disponibilize o valor no ambiente do processo que verifica/baixa a atualização.
Em PowerShell 7, por exemplo:

```powershell
$env:GH_TOKEN = Read-Host 'GitHub token' -MaskInput
meu-bot config update-source github https://github.com/minha-org/meu-bot/releases --token-env GH_TOKEN
meu-bot update --check
```

Não coloque o token na URL, no `package.json`, no código, em logs ou em uma issue.
Para atualização automática, prepare também o ambiente do serviço: uma variável
criada em um terminal não é, por si só, uma configuração persistente do serviço.
Esse token de download é diferente do token que vincula o bot ao servidor Monky.

Também é possível colar o token em **Configuração > Atualizações > Token GitHub
privado (entrada oculta)**, ou executar:

```text
meu-bot config update-token
meu-bot config update-token --status
meu-bot config update-token --clear
meu-bot config update-token --from-env GH_TOKEN
```

O CLI mostra o link de criação e explica a permissão antes de pedir o segredo.
Não exige que o token tenha a sintaxe de um nome de variável: aceita os formatos
de PAT como valores de autenticação e recusa espaços, controles e quebras de linha.
**Salvar não confirma acesso**; execute `update --check` para validar o repositório
e suas permissões.

A credencial fica em `~/.<cliName>/update-credentials.json`, fora do pacote, com
permissões `600`/`700` no Linux. É limitada ao repositório GitHub escolhido e
não é reutilizada ao trocar para outro repositório ou uma origem HTTPS/arquivo.
Variáveis explícitas do ambiente têm prioridade. O auto-update lê a mesma
credencial nas próximas execuções, sem copiá-la para o ambiente do bot; apagar
com `--clear` não altera variáveis externas. Não passe o segredo como argumento.

### Padrão fornecido no pacote

Para definir o padrão distribuído pelo autor:

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

Nesse padrão do pacote, o caminho relativo é resolvido a partir do `package.json` **instalado**, nunca
do diretório atual do terminal ou do PM2. Use caminhos relativos portáveis ao
empacotar para plataformas diferentes; caminhos absolutos precisam ser nativos
do ambiente. Não há expansão de `~` nem de variáveis de ambiente. O arquivo
precisa ser regular, legível e não pode ser um link simbólico. O CLI copia um
snapshot antes de inspecionar e instalar, sem reabrir um arquivo que possa mudar.

O padrão do pacote aceita **somente uma origem**: `releases` ou `updateSource`.
Sem padrão nem escolha do operador, o SDK não deduz uma origem de `repository`,
de `git origin`, do repositório do SDK ou do registro npm.
Um link inválido gera erro, não habilita uma origem alternativa.

`update --check` não instala nem reinicia. No GitHub, consulta apenas metadados;
para HTTPS/arquivo local, baixa ou copia o pacote para ler sua versão e descarta
a cópia ao terminar. `update` usa stable e `update --beta` inclui
pré-releases. A seleção respeita a versão semântica, sem downgrade ou reinstalação
de versão igual. O auto-update também usa stable, inclusive numa instalação beta;
pré-releases exigem `autoupdate on [HH:MM] --beta`. Após atualizar um CLI antigo,
repita `autoupdate on` com o horário e canal desejados para renovar o processo.
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
