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
- O exemplo foi preparado com o **SDK de bots 22.1.0, protocolo 20**.
  O instalador busca a última release estável; se ela for diferente, confira
  o arquivo `monky-compatibility-<versão>.json` dessa release antes de conectar.

::: info Por que o primeiro exemplo usa token?
O modo manual permite testar sem abrir uma porta HTTP para o bot. Ele não
aprova permissões automaticamente. Para distribuir seu bot por uma URL de
manifest, continue em [Conexão e identidade](/bots-conexao).
:::

## 1. Prepare o projeto

Crie uma pasta vazia e salve nela este `package.json`. Ele descreve **o seu
bot** e seus comandos de desenvolvimento. A dependência do SDK de bots será
adicionada pelo instalador; você não precisa copiar a URL de uma release
para este arquivo.

```json
{
  "name": "meu-bot",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "cli": "monky-bot-sdk cli",
    "package": "monky-bot-sdk build"
  },
  "monkyBot": {
    "cliName": "meu-bot",
    "displayName": "Meu Bot",
    "entry": "dist/index.js",
    "files": ["dist"],
    "modes": ["manual"]
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.9.3"
  }
}
```

Na mesma pasta, crie `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": "src",
    "outDir": "dist",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmitOnError": true
  },
  "include": ["src/**/*.ts"]
}
```

### Instale o SDK de bots

Na pasta do projeto, escolha seu terminal. No Linux, o comando usa o
[instalador oficial](https://monkyorg.github.io/install-bot-sdk.sh);
no PowerShell, a consulta à release é feita diretamente, sem depender de Bash:

::: code-group

```powershell [Windows — PowerShell]
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/MonkyOrg/Monky/releases/latest' -ErrorAction Stop
$version = $release.tag_name.TrimStart('v')
$asset = @($release.assets | Where-Object { $_.name -eq "monky-bot-sdk-$version.tgz" })
if ($asset.Count -ne 1) { throw 'SDK de bots não encontrado na release estável.' }
npm install $asset[0].browser_download_url
```

```bash [Linux — Bash]
curl -fsSL https://monkyorg.github.io/install-bot-sdk.sh | bash
```

:::

Ambas as opções consultam a última release estável do Monky, localizam o artefato
`monky-bot-sdk-*.tgz` e executam `npm install` no projeto. Isso instala também
as dependências declaradas acima e atualiza `package.json` e
`package-lock.json`. Versione os dois arquivos para reproduzir a instalação.
A instalação é da biblioteca para o bot, **não do aplicativo Monky**. Ela não
gera o código do bot nem cria o vínculo com um servidor.

No script Bash, para incluir releases beta na escolha, use
`bash -s -- --beta` no lugar de `bash`. Confira antes se o cliente e o servidor
usam o protocolo compatível.

::: info Continue com o exemplo desta página
A mensagem final do instalador Bash ainda mostra um exemplo antigo de código.
Use a etapa seguinte deste guia, que declara as capacidades e recebe a
identidade criada pelo CLI corretamente.
:::

<details>
<summary>macOS, limitações do script Bash ou uma versão específica</summary>

O script Bash atual exige `curl` e GNU `grep` com suporte a `-P`. Essa opção
não existe no `grep` padrão do macOS e pode falhar no Git Bash do Windows;
no Windows, prefira o comando PowerShell acima.

No macOS, ou para escolher uma versão específica, copie a URL do
artefato `monky-bot-sdk-<versão>.tgz` na
[release oficial](https://github.com/MonkyOrg/Monky/releases) e passe-a ao
`npm install`. Exemplo para a versão usada neste guia:

```text
npm install https://github.com/MonkyOrg/Monky/releases/download/v22.1.0/monky-bot-sdk-22.1.0.tgz
```

Execute na pasta do projeto, sem `-g`. O npm grava a dependência no
`package.json`; não é necessário editar esse campo manualmente.

</details>

## 2. Escreva o comando

Crie `src/index.ts`:

```ts
import {
  BotClient,
  validateBotServerUrl,
  validateBotToken,
} from '@monky/bot-sdk';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const bot = new BotClient({
  requestedCapabilities: ['commands'],
  publicKey: requiredEnvironment('MONKY_BOT_PUBLIC_KEY'),
  name: process.env.MONKY_BOT_NAME ?? 'Meu Bot',
});

bot.command({
  name: 'ping',
  description: 'Check whether the bot is online',
  localizations: {
    'pt-BR': { description: 'Verifica se o bot está respondendo' },
  },
  handler: (ctx) => {
    ctx.reply(ctx.locale === 'en' ? 'Pong! I am online.' : 'Pong! Estou online.');
  },
});

bot.on('error', (error: Error) => {
  console.error('[bot]', error.message);
});

const shutdown = () => {
  void bot.close().catch((error: unknown) => {
    console.error('[shutdown]', error);
    process.exitCode = 1;
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

bot.connect({
  serverUrl: validateBotServerUrl(requiredEnvironment('MONKY_SERVER_URL')),
  token: validateBotToken(requiredEnvironment('MONKY_BOT_TOKEN')),
});
```

O CLI do SDK de bots cria/reutiliza a identidade e fornece essas variáveis ao processo.
Não escreva um token no código, não gere uma chave nova a cada inicialização e
não execute `node dist/index.js` sem preparar esse ambiente.

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
a capacidade de **comandos** solicitada e salve. Estar online não substitui
essa aprovação.

Em um canal de texto que permita bots, digite `/`, escolha o bot e execute
`/ping`. A resposta deve aparecer **somente para quem chamou**.

<AppScreenshot src="/screenshots/comandos-pt.png" alt="Menu de comandos mostrando o bot responsável e as descrições dos comandos disponíveis." caption="O catálogo é apresentado pelo cliente. O bot do exemplo mínimo registra apenas /ping; o GuiaBot da captura demonstra outros recursos do SDK." />

::: tip Se o bot aparece online, mas /ping não aparece
Confira a aprovação de capacidades, a permissão do seu cargo e o switch
**Permitir comandos de bots** no canal. O [guia de diagnóstico](/bots#quando-algo-nao-funciona)
separa esses casos de falhas de conexão e protocolo.
:::

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
