# Seu primeiro bot

Crie um bot TypeScript que aparece no Monky e responde a `/ping`. Este é o
caminho para **quem desenvolve**; se você só quer adicionar ou usar um bot
pronto, vá para [Usar bots](/bots).

O **SDK de bots do Monky** (`@monky/bot-sdk`) conecta o processo do seu bot ao
servidor. Você escreve a lógica; o Monky
apresenta comandos, formulários e controles nativos, valida permissões e
encaminha as respostas.

## Antes de começar

- Use **Node.js 22 ou 24** e npm.
- Tenha um servidor Monky de teste e acesso para gerenciar seus bots.
- Cliente, servidor e SDK de bots precisam usar o mesmo `PROTOCOL_VERSION`.
- Confira `monky-compatibility-<versão>.json` na release escolhida antes de
  conectar. O assistente não muda o protocolo nem atualiza seu servidor.

::: info Por que o primeiro exemplo usa token?
O modo manual permite testar sem abrir uma porta HTTP para o bot. Ele não
aprova permissões automaticamente. Para distribuir seu bot por uma URL de
manifest, continue em [Conexão e identidade](/bots-conexao).
:::

## Instale as ferramentas uma vez

Não é necessário procurar a URL do `.tgz`, escolher uma tag à mão ou preparar
`package.json` e TypeScript. O instalador encontra o SDK na release oficial,
verifica SHA-256 e instala o comando `monky-bot-sdk` **por usuário, sem
administrador**, em uma pasta exclusiva.

::: warning Canal beta explícito
Os exemplos abaixo incluem `--beta` para oferecer o novo assistente enquanto
ele estiver disponível apenas nas betas. Sem essa opção, o instalador escolhe
stable. Se a release ainda não oferecer o assistente, a instalação é recusada
sem substituir uma instalação anterior; não há troca silenciosa de canal.
:::

::: code-group

```powershell [Windows — PowerShell]
& ([scriptblock]::Create((Invoke-RestMethod https://monkyorg.github.io/Monky/install-bot-sdk.ps1))) --beta --locale pt-BR
```

```bash [Linux e macOS — Bash]
curl -fsSL https://monkyorg.github.io/Monky/install-bot-sdk.sh | bash -s -- --beta --locale pt-BR
```

:::

Abra um **novo terminal** e execute:

```text
monky-bot-sdk
```

Na primeira utilização interativa, escolha **Português (Brasil)** ou
**English (US)**. O menu oferece criação/abertura de projetos e configurações.
Dentro da pasta de um bot, também oferece adicionar funcionalidades, compilar,
verificar, empacotar e abrir o gerenciador operacional.

O instalador exige Node.js 22+ e npm; no Linux/macOS, também Bash e curl,
sem GNU grep. Usa `%LOCALAPPDATA%\Monky\BotSdk` no Windows e
`~/.local/share/monky-bot-sdk` no Linux/macOS. Adiciona a instalação ao PATH do
usuário no Windows ou aos perfis Bash/Zsh/POSIX apropriados, preservando o
conteúdo existente. `--prefix PASTA` escolhe outro destino exclusivo;
`--no-path` não altera PATH nem perfis e imprime o comando completo.

Reexecute o instalador para atualizar a ferramenta. `--version VERSAO` escolhe
uma release específica sem montar URLs. **Atualizar o CLI não atualiza o SDK dos
projetos existentes.** Cada projeto mantém sua cópia em `vendor/` e seu lockfile;
os comandos de projeto usam o SDK instalado naquele projeto.

## 1. Crie o projeto

Escolha **Criar novo bot** no assistente ou execute:

```text
monky-bot-sdk create meu-bot
cd meu-bot
```

O assistente pede pasta, nome do pacote/comando CLI, nome exibido no Monky e
funcionalidades iniciais. Use setas/Enter para escolher e Esc para cancelar.
Por padrão, instala as dependências e compila. Tudo já vem preparado:

```text
meu-bot/
  package.json
  package-lock.json
  tsconfig.json
  README.md
  .gitignore
  vendor/
  src/
    index.ts
    bot.generated.ts
    commands/
      ping.ts
```

`src/index.ts` cuida da conexão e do encerramento; `/ping` fica em um módulo
editável e responde em PT-BR/EN por leitor. `src/bot.generated.ts` conecta
comandos, configurações e capacidades. **Edite os módulos, não esse registro.**
Versione os fontes, `vendor/`, `package.json` e `package-lock.json`.

A pasta de destino deve ser nova; nem uma pasta vazia existente é sobrescrita.
`--no-install` gera somente os arquivos, sem lockfile; depois execute
`npm install` e `npm run build`. Cancelar as perguntas não cria o projeto.
Se a instalação/compilação falhar, os arquivos ficam disponíveis para corrigir
a causa, sem mensagem de sucesso.

Para automação, sem perguntas:

```text
monky-bot-sdk create meu-bot --name meu-bot --display-name "Meu Bot" --non-interactive
```

## 2. Adicione funcionalidades

Execute `monky-bot-sdk add` para escolher tudo no assistente ou informe o tipo
e o nome. Os arquivos são **integrados ao projeto**, não apenas copiados:

| Comando | O que gera |
| --- | --- |
| `monky-bot-sdk add command saudacao` | Um comando editável com respostas PT-BR/EN |
| `monky-bot-sdk add form cadastro` | Um comando que abre formulário privado, com campos escolhidos no assistente |
| `monky-bot-sdk add selector escolha` | Uma seleção privada ou pública, com opções escolhidas no assistente |
| `monky-bot-sdk add settings` | Uma declaração única de configurações por servidor e por usuário |
| `monky-bot-sdk add screen painel` | Um miniapp no palco de voz, traduzido pelo idioma de cada espectador |

Sem interação, os parâmetros também podem ser explícitos:

```text
monky-bot-sdk add form cadastro --field nome:text --field idade:integer --field avisos:boolean --field "perfil:select:Leitor,Editor" --non-interactive
monky-bot-sdk add selector votacao --public --choice "Opção A" --choice "Opção B" --non-interactive
```

Os campos aceitam `text`, `integer`, `boolean`, `string-list` e
`select:EscolhaA,EscolhaB`. O formulário de exemplo apenas confirma o envio;
implemente sua regra usando `values`. Traduza os títulos e rótulos escritos
por você no módulo, conforme `ctx.locale`; o gerador não inventa traduções.
O módulo de configurações declara as opções e seus valores padrão; implemente
os efeitos nos handlers usando `ctx.settings.server` e `ctx.settings.user`.

O seletor é privado por padrão em automações; `--public` cria uma votação
pública com cinco minutos de duração, até 50 participantes e alteração de voto.
O exemplo não aguarda a votação inteira dentro do handler. O miniapp exige
presença em voz, usa `commands`/`miniapps`, não `publish_voice`, e não inclui
CDNs, acesso à máquina ou estado secreto.

O gerador recusa nomes/arquivos em conflito, múltiplos módulos de configurações,
links em caminhos gerenciados e alterações manuais no registro. Metadados ficam
em `package.json.monkyBotDevelopment`. Projetos anteriores ou montados à mão
continuam usando `build`, `doctor` e `cli`, mas não são migrados por `add`;
ele exige a estrutura gerenciada criada por esta versão.

Depois de editar:

```text
npm run build
monky-bot-sdk doctor
npm run package
```

`doctor` verifica Node/npm, dependências, protocolo, entrada compilada e tipos,
sem iniciar o bot, criar identidade ou conectar ao servidor. `build` gera o
pacote autocontido descrito em [Distribuição](/bots-distribuicao).
`--root PASTA` funciona com `add`, `doctor` e `build`; não existe comando `dev`.

## 3. Crie o vínculo e inicie

1. No Monky, abra **nome do servidor → Configurações do Servidor → Bots**.
2. Abra **Mostrar opção avançada** e gere um vínculo manual.
3. Copie o token exibido uma única vez.

No terminal do projeto:

```text
npm run build
npm run cli -- setup
npm run cli -- start --foreground
```

No setup, informe o endereço do servidor, o token e o nome do bot. Para um
servidor na mesma máquina, `localhost:3000` é um exemplo; use a porta real.
O token é digitado no campo oculto do assistente, não como argumento no shell.
O modo `--foreground` mantém o processo nesse terminal sem criar um daemon PM2.

## 4. Aprove e execute

No cliente, abra **Configurações do bot → Permissões no servidor**, permita
a capacidade de **comandos** e as outras capacidades solicitadas pelas
funcionalidades que você adicionou, e salve. Estar online não substitui essa aprovação.

Em um canal de texto que permita bots, digite `/`, escolha o bot e execute
`/ping`. A resposta deve aparecer **somente para quem chamou**.

<AppScreenshot src="/screenshots/comandos-pt.png" alt="Menu de comandos mostrando o bot responsável e as descrições dos comandos disponíveis." caption="O catálogo é apresentado pelo cliente. O bot do exemplo mínimo registra apenas /ping; o GuiaBot da captura demonstra outros recursos do SDK." />

::: tip Se o bot aparece online, mas /ping não aparece
Confira a aprovação de capacidades, a permissão do seu cargo e o switch
**Permitir comandos de bots** no canal. O [guia de diagnóstico](/bots#quando-algo-nao-funciona)
separa esses casos de falhas de conexão e protocolo.
:::

## Idiomas e configurações

No SDK, abra **Configurações → Idioma / Language** ou execute:

```text
monky-bot-sdk config language pt-BR
monky-bot-sdk config language en-US
```

O idioma muda no próximo menu e fica salvo em
`~/.monky-bot-sdk/preferences.json`. `MONKY_BOT_SDK_HOME` troca apenas esse
perfil para testes. `--locale pt-BR|en-US` vale para uma execução; `en` continua
sendo um alias aceito. Sem TTY ou em CI, menus não são abertos.

O **gerenciador do bot** tem sua própria preferência:

```text
npm run cli -- config
npm run cli -- config language en-US
```

Ele não herda silenciosamente a preferência salva no SDK. Configurar seu idioma
não recria identidade nem altera conexão, token ou permissões. O CLI do servidor
também permite `monky config language pt-BR|en-US`; veja [CLI](/cli).
Essas preferências de terminal não mudam o idioma escolhido pelos participantes
no aplicativo.

## O que você pode criar

| Recurso | Guia com exemplos | Capacidade principal |
| --- | --- | --- |
| Parâmetros tipados, traduções e autocomplete paginado | [Comandos](/bots-comandos) | `commands` |
| Formulários privados e perguntas em etapas | [Interações](/bots-interacoes) | `commands` |
| Mensagens públicas, reações e votações persistentes | [Interações](/bots-interacoes) | `send_messages`, `read_messages` e/ou `selectors`, conforme a operação |
| Preferências pessoais e comportamento por servidor | [Configurações](/bots-configuracao) | Escopos e permissões do servidor |
| Prévia de áudio e download para Soundboard | [Áudio](/bots-audio) | `commands`; download também exige `sound_download` |
| Publicar áudio P2P ou SFU | [Voz](/bots-voz) | `publish_voice` |
| Tarefas autorizadas no computador do usuário | [Execução local](/bots-execucao-local) | `local_execution` |
| Telas HTML compartilhadas na sala de voz | [Miniapps](/bots-miniapps) | `miniapps` |
| CLI, pacote instalável e atualização | [Distribuição](/bots-distribuicao) | Configuração do pacote |

Adicione somente as capacidades necessárias em `requestedCapabilities`.
As concessões dependem de aprovação administrativa; uma funcionalidade nova
não autoriza silenciosamente um bot já instalado.

## Como consultar a documentação

Os guias mostram **quando e como usar** cada recurso. A
[referência do SDK de bots](/bots-api) reúne retornos, eventos e ciclo de vida, com
links para as assinaturas completas de todos os exports públicos.

Os exemplos dos guias de recursos complementam a instância `bot` deste
tutorial. Declare os comandos e as configurações **antes de conectar**.
Ao usar uma variável de exemplo como `serverId`, obtenha-a do contexto do SDK
ou de seus eventos — não invente um ID nem use o nome do servidor.
