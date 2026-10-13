# Empacotar e distribuir

Este guia é para o autor e para o operador de um bot que usa o **CLI fornecido
pelo SDK**. Ele não é o [CLI do servidor Monky](/cli), e um bot com CLI próprio
não recebe estes comandos automaticamente.

Complete [Seu primeiro bot](/bots-desenvolvimento) antes de empacotar.
**Referência:** [BotPackageDefinition](/bots-api-ferramentas#botpackagedefinition),
[BotRequirements](/bots-api-ferramentas#botrequirements),
[handleReachabilityProbe](/bots-api-ferramentas#handlereachabilityprobe),
[BotUpdateSource](/bots-api-ferramentas#botupdatesource) e
[buildBotPackage](/bots-api-ferramentas#buildbotpackage).

## CLI e pacote automático do bot

O SDK fornece o [assistente de desenvolvimento](/bots-desenvolvimento)
`monky-bot-sdk`; seu comando `build` gera um `.tgz`
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

O empacotador declara também as dependências transitivas que ficam em um
`node_modules` superior (hoisting), preservando versões e aliases. Isso permite
atualizar offline com cache npm vazio mesmo quando a disposição das dependências
muda entre releases; uma instalação limpa, sozinha, não valida esse cenário.

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

O CLI oferece `setup`, `start`, `stop`, `restart`, `status`, `logs`, `config`,
`requirements`, `doctor` e `consent`, com um processo PM2 e configuração isolados
por nome do bot. `start --foreground` roda sem PM2 para desenvolvimento.
`npm run cli -- setup` usa o mesmo CLI no checkout local, depois de compilar.

Execute `meu-bot` sem comando em um terminal para abrir o **menu por setas**,
ou use `meu-bot menu`. Enter confirma e Esc cancela; o item **Sair do menu**
não para o processo. **Configuração > Atualizações** reúne origem, token GitHub,
consulta/instalação de versões e agendamento. `meu-bot config` abre a configuração
interativa; `meu-bot config show` sempre imprime a versão com segredos ocultos.
Sem TTY ou em CI, executar sem comando continua mostrando ajuda, sem perguntas.
Comandos e flags de automação continuam disponíveis.

No primeiro acesso em um terminal interativo, o CLI pede **Português (Brasil)**
ou **English (US)** e salva a escolha em `~/.<cliName>/preferences.json`.
Depois, use **Configuração → Idioma / Language** ou
`meu-bot config language pt-BR` / `meu-bot config language en-US`.
A alteração aparece no próximo menu, mesmo sem setup, sem modificar identidade,
conexão ou token. `language` continua como alias; `--locale en-US` vale somente
para aquela execução. `en-US` é normalizado internamente para `en`.
Essa preferência é independente do idioma do assistente de desenvolvimento.
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

O setup segue o fluxo do MonkyBot: modo, diretório de trabalho, dados do modo,
[portas declaradas pelo bot](#escolher-as-portas) e nome do bot. No fim, mostra o [aviso de acessos](#consentimento-de-quem-hospeda)
e pede autorização antes de salvar; recusar não altera nada. Em seguida lista
as [portas e configurações](#portas-configuracoes-e-verificacao) do bot. Em bots que suportam os dois modos, **instalação por URL é o padrão**
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
e `7781`, e isso vale também para as portas declaradas por cada bot.
`/manifest` é um endpoint de cada processo, não um arquivo compartilhado.
O CLI verifica se consegue usar a porta local antes de salvar; se outro bot ou
serviço já a ocupa, o setup explica o conflito e pede outra, sem trocar a porta
automaticamente. O setup não interativo e alterações de porta por `config set`
falham sem sobrescrever a configuração anterior.

Se a porta estiver em uso pelo próprio bot em execução, o setup confirma a
identidade com o mesmo desafio assinado do `doctor`, aceita a porta e lembra de
rodar `meu-bot restart` no fim. Quando não dá para confirmar (porta UDP ou
listener que não encaminha o desafio), execute `meu-bot stop` antes de refazer
o setup; a configuração e as chaves são preservadas. `start` também verifica a
porta antes de iniciar um processo parado; `restart` libera apenas seu processo
gerenciado antes da checagem, inclusive após atualizações. Essa checagem local
não verifica regras de firewall e não reserva a porta até o próximo `start`.

Depois de `start` e `restart`, o CLI só anuncia sucesso quando o PM2 confirma o
processo online e, no modo Marketplace, quando `/manifest` responde nesta
máquina com um manifest válido, a URL de registro do host e da porta
configurados e a chave pública do bot (cabeçalho `X-Monky-Bot-Public-Key`,
enviado por `bot.serve()`). Só então o estado do PM2 é salvo. Se `start`
encontrar o processo online com o manifest quebrado, recria apenas o processo
desse perfil. A verificação acontece nesta máquina: firewall e NAT só se
comprovam de fora, com `meu-bot doctor`.

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

## Portas, configurações e verificação {#portas-configuracoes-e-verificacao}

### Declarar o que o bot precisa

Declare em `monkyBot.requirements` as portas de entrada e as configurações que o
bot lê do ambiente. A porta do manifest do modo Marketplace já é conhecida pelo
SDK e não deve ser declarada. Exemplo com uma porta de jogos aberta sob demanda
e uma chave de API:

```json
{
  "monkyBot": {
    "requirements": {
      "notice": {
        "pt-BR": "Busca músicas no YouTube.",
        "en": "Searches music on YouTube."
      },
      "ports": [{
        "id": "games",
        "description": { "pt-BR": "Assets e multiplayer dos jogos", "en": "Game assets and multiplayer" },
        "protocol": "tcp",
        "portEnv": "MEU_BOT_GAMES_PORT",
        "defaultPort": 7781,
        "hostEnv": "MEU_BOT_GAMES_HOST",
        "publicUrlEnv": "MEU_BOT_GAMES_PUBLIC_URL",
        "exposure": "public",
        "when": "on-demand"
      }],
      "settings": [{
        "env": "MEU_BOT_API_KEY",
        "description": { "pt-BR": "Chave da API de músicas", "en": "Music API key" },
        "required": true,
        "secret": true
      }]
    }
  }
}
```

| Campo | Significado |
|---|---|
| `ports[].id` | Nome curto (`a-z`, `0-9`, `-`); `manifest` é reservado |
| `protocol` | `tcp` (padrão) ou `udp` |
| `portEnv` / `defaultPort` | Variável que o bot lê para a porta e o valor usado sem ela |
| `hostEnv` | Variável do endereço de escuta (padrão `0.0.0.0`) |
| `publicUrlEnv` | Variável com a origem pública `http(s)://host[:porta]`, por exemplo atrás de um proxy HTTPS. No modo Marketplace, sem ela, o CLI usa o host público configurado e a porta |
| `exposure` | `public` (padrão): outras máquinas precisam acessar; `local`: só esta máquina usa |
| `when` | `always` (padrão) ou `on-demand`, quando o bot só abre o listener ao usar o recurso |
| `modes` | Modos em que a porta ou configuração se aplica; padrão: todos de `monkyBot.modes` |
| `settings[].required` / `secret` | Obrigatória para operar / valor nunca exibido nem aceito como argumento |
| `notice` | Acessos próprios do bot (serviços externos, ferramentas), exibidos no consentimento |

Os textos têm `pt-BR` e `en`. Há no máximo 8 portas e 32 configurações; cada
variável aparece uma vez, e nomes usados pelo CLI ou pelo sistema
(`MONKY_SERVE_*`, `MONKY_BOT_*`, `MONKY_HOST_CONSENT`, `PATH`, `NODE_OPTIONS`,
`PM2_*`, entre outros) são recusados. O `build` publica a declaração no pacote.

### O que o operador abre e configura

`meu-bot requirements` lista as portas a liberar no firewall ou roteador e as
configurações, mesmo antes do setup. O mesmo resumo aparece no fim do `setup` e
no `status`. As configurações declaradas podem vir do ambiente do processo ou
ser salvas no perfil:

```text
meu-bot config env
meu-bot config env set MEU_BOT_GAMES_PORT 7790
meu-bot config env set MEU_BOT_GAMES_PUBLIC_URL https://games.example.com
meu-bot config env set MEU_BOT_API_KEY
meu-bot config env set MEU_BOT_API_KEY --from-env OUTRA_VARIAVEL
meu-bot config env unset MEU_BOT_API_KEY
```

Segredos são pedidos com entrada oculta (ou `--from-env`) e nunca passados como
argumento. Os valores ficam em `~/.<cliName>/environment.json` (`600`/`700` no
Linux), fora do pacote, e são validados pelo tipo: porta, endereço de escuta ou
URL pública sem caminho. **O ambiente do processo prevalece**: o runner só
injeta o valor salvo quando a variável não existe no ambiente, o que mantém
Docker, systemd e compose funcionando. O `doctor` avisa quando os dois valores
diferem e diz qual está em uso. No reinício feito pela atualização, o CLI
descarta as cópias dessas variáveis guardadas no ambiente do atualizador e
repassa os valores com que o processo do bot estava rodando. Reinicie o bot
depois de mudar uma configuração.

### Escolher as portas {#escolher-as-portas}

O setup pergunta cada porta declarada que se aplica ao modo escolhido, sugerindo
o valor salvo no perfil ou o `defaultPort`, e testa a resposta como faz com a
porta do manifest: TCP ou UDP, conforme o declarado, no endereço de `hostEnv`
(padrão `0.0.0.0`). Uma porta que já pertence a outra porta do próprio bot
(manifest ou outra declarada, com o mesmo protocolo) ou que está ocupada por
outro processo é pedida de novo, sem refazer as outras respostas; nada é salvo
sem uma porta válida. Só portas diferentes do padrão ficam em `environment.json`:
escolher o padrão remove o valor salvo. Se a declaração tiver `publicUrlEnv`, o
setup lembra que a URL pública não muda junto com a porta.

Quando a variável da porta vem do ambiente, o setup mostra o valor e avisa sobre
conflitos, mas não pergunta nem salva nada, porque o ambiente prevalece; corrija
o ambiente do serviço. No setup não interativo, informe as portas com
`--port <id>=<porta>`, uma vez para cada porta:

```text
meu-bot setup --non-interactive --mode marketplace --public-host bot.example.com --serve-port 7780 --port games=7790
```

As portas informadas, inclusive a do manifest, precisam estar livres e não
colidir com outra porta do bot; caso contrário, nada é salvo. As demais (do
perfil, do padrão ou do ambiente) só geram avisos, para não interromper uma
automação que já funcionava. `--port` é recusado quando a variável vem do
ambiente.

`meu-bot config env set` faz o mesmo teste quando a variável é a porta de uma
declaração do modo atual, e `config set servePort` recusa uma porta já usada por
outra porta do bot. O teste só enxerga portas abertas no momento: a porta sob
demanda de **outro bot** parado, ou que ainda não abriu o recurso, não aparece.
Confira o `requirements` de cada bot da máquina antes de escolher.

### Consentimento de quem hospeda {#consentimento-de-quem-hospeda}

Antes de rodar o bot, quem hospeda confirma os acessos: o processo usa as
permissões da conta do sistema (sem sandbox), lê o próprio programa, grava a
identidade e os vínculos em `<botDir>/.keys`, conecta-se a servidores Monky, abre
as portas declaradas e é gerenciado pelo PM2 do perfil. O aviso inclui as
configurações e o `notice` do bot. Os administradores de cada servidor continuam
decidindo quais capacidades o bot pode usar.

A confirmação vale para o diretório de trabalho e para uma **impressão digital**
calculada a partir das portas, configurações, `notice` e modos declarados.
`start`, `start --foreground`, `restart` e o runner recusam iniciar sem ela.

```text
meu-bot consent
meu-bot consent --accept <impressão digital>
meu-bot consent --revoke
```

O setup interativo pede a confirmação; o `--non-interactive` deixa o perfil
pendente e mostra a impressão digital. Em automação, leia os acessos e defina
`MONKY_HOST_CONSENT=<impressão digital>` no ambiente do serviço. Perfis criados
antes do consentimento existir herdam os acessos atuais e continuam rodando; o
`status` e o `doctor` lembram de revisá-los. Se uma versão nova mudar os acessos
declarados, `update` mostra o novo aviso e pergunta antes de instalar; o
`update --yes` e o auto-update pulam essa versão e mantêm o bot atual rodando
até a aprovação (ou até `MONKY_HOST_CONSENT` corresponder à nova impressão
digital). Mudar `botDir` também exige nova confirmação.

### Verificar se o bot pode operar (`doctor`)

`meu-bot doctor` (também no menu) diz o que está pronto e o que falta, com
`[OK]`, `[AVISO]`, `[FALHA]` ou `[PULADO]`, e termina com erro se houver alguma
falha. Ele confere:

- Node.js, entrada compilada, perfil, identidade em `.keys` e consentimento;
- o processo no PM2 do perfil e um processo homônimo no PM2 padrão da conta
  (por exemplo, de um CLI próprio anterior), que pode ocupar as portas;
- token do modo manual e configurações obrigatórias, no ambiente do processo em
  execução ou deste terminal;
- cada porta: se coincide com outra porta do próprio bot, se está livre ou em
  uso, e, quando em uso, se responde **como este
  bot** a um desafio assinado com a chave Ed25519; no modo Marketplace, também a
  validade do manifest;
- a URL pública a partir desta máquina — roteadores sem *hairpin NAT* podem
  falhar aqui sem que haja problema;
- com o servidor Monky: alcance da URL, token, vínculo da chave e compatibilidade
  de protocolo, e um **teste externo** das portas públicas TCP feito pelo próprio
  servidor.

No modo manual, o teste usa o servidor e o token configurados. No Marketplace,
usa até três servidores salvos em `.keys/registrations.json`; sem nenhum
vínculo, o teste externo é pulado. Ele usa uma conexão separada, sem
autenticação de sessão, então não derruba o bot em execução nem vincula a chave
antes do primeiro `start`. Portas livres recebem, durante o teste, um
respondedor temporário do próprio `doctor`; por isso dá para testar o firewall
com o bot parado ou antes de alguém usar um recurso sob demanda. Nesse intervalo
(alguns segundos), a porta fica ocupada. `meu-bot doctor --local` pula toda
comunicação com servidores.

O teste externo diz se **aquele servidor** consegue acessar a porta pela rede
dele; outras redes podem ter regras diferentes. Para não servir de scanner, o
servidor só aceita token válido, no máximo 8 alvos, portas 80, 443 e
1024–65535, e endereços públicos ou o próprio IP de origem do pedido. Ele resolve
o DNS uma vez, não segue redirecionamentos e só responde "acessível" quando o
endpoint assina um desafio novo com a chave do bot; porta fechada, filtrada ou
outro serviço aparecem igualmente como "não acessível", sempre após o mesmo
intervalo e com limites por IP, por bot e de concorrência. Servidores
anteriores ao protocolo 37 não oferecem o teste, e o `doctor` pede para
atualizá-los.

Listeners próprios do bot, como o servidor de um miniapp, precisam encaminhar o
desafio para serem verificados enquanto estão ativos:

```ts
import http from 'node:http';
import { handleReachabilityProbe } from '@monky/bot-sdk';

const server = http.createServer((request, response) => {
  if (handleReachabilityProbe(request, response)) return;
  // ...rotas do bot
});
```

`handleReachabilityProbe` atende somente `GET /.well-known/monky-bot-reachability`
e assina com a identidade que o runner do CLI registra no processo; fora do CLI,
responde 404. `bot.serve()` já faz isso na porta do manifest.

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

Se um pacote antigo falhar com `ENOTCACHED` ao atualizar, apesar de instalar
offline em uma pasta vazia, o autor deve gerar uma nova release com o empacotador
corrigido. Atualizar apenas o SDK da máquina do operador não corrige os metadados
do `.tgz` já publicado. Não remova `--offline` nem habilite scripts como solução.

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
