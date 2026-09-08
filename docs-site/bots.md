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

### Pré-requisitos

- **Node.js 18+**
- Cliente, servidor e SDK compatíveis com o **protocolo 8**
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
    // ctx.signal     — aborta ao cancelar, desconectar, expirar ou concluir
  },
});
```

### Parâmetros guiados no chat

Ao digitar `/`, o menu mostra os comandos utilizados com mais frequência e os agrupa por bot. Cada item identifica o comando, sua descrição e o bot responsável. Ao navegar, os parâmetros obrigatórios e a quantidade de opcionais ajudam a escolher o comando.

Ao selecionar um comando, o compositor compacto identifica **qual bot e comando** estão selecionados e apresenta campos nomeados com descrição e placeholder. Parâmetros opcionais podem ser adicionados quando necessários. O envio usa os nomes declarados em `options`; não é necessário juntar valores com vírgulas. Selecionar um comando não o executa.

A frequência de uso é local e separada por servidor e identidade. Apenas contagens e recência são guardadas, nunca os valores preenchidos nos parâmetros.

| Tipo | Controle | Valor em `ctx.args` |
|------|----------|--------------------|
| `string` | Texto; com `choices`, seleção de uma opção | `string` |
| `integer` | Número inteiro, com limites opcionais `min` e `max` | `number` |
| `boolean` | Switch | `boolean` |
| `user` | Seleção de membro | ID do membro (`string`) |

`required: true` impede enviar sem preencher. Um parâmetro opcional não preenchido é omitido; valores válidos como `false` e `0` não são descartados. O servidor valida os parâmetros novamente antes de chamar o bot. Dois bots podem ter um comando com o mesmo nome: a seleção no chat mantém o bot escolhido.

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

Para compartilhar um resultado deliberadamente, use `ctx.publish('Resultado para o canal')`. A publicação respeita a visibilidade do canal; os formulários e suas respostas continuam privados. Respostas de comandos são temporárias e não fazem parte do histórico persistido do canal.

### Formulários e conversas em etapas

O bot pode aguardar entradas do usuário sem abrir um modal e sem pedir mensagens formatadas manualmente. Cada `await ctx.prompt(...)` cria um formulário **dentro do chat de quem chamou**. As respostas de usuários, dispositivos e servidores diferentes ficam isoladas.

```ts
bot.command({
  name: 'enquete',
  description: 'Cria uma enquete por formulário',
  handler: async (ctx) => {
    const result = await ctx.prompt({
      title: 'Nova enquete',
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
      throw new Error('Resposta de enquete inesperada');
    }
    const text = `**${result.pergunta}**\n${result.opcoes.map((option, i) => `${i + 1}. ${option}`).join('\n')}`;
    ctx.reply(text);

    const confirmation = await ctx.prompt({
      title: 'Compartilhar a enquete?',
      fields: [{
        name: 'visibilidade', label: 'Quem pode ver o resultado?', type: 'select',
        required: true, defaultValue: 'privado',
        choices: [
          { label: 'Somente eu', value: 'privado' },
          { label: 'Publicar neste canal', value: 'canal' },
        ],
      }],
    });
    if (!confirmation) return;
    if (confirmation.visibilidade === 'canal') ctx.publish(text);
  },
});
```

Os tipos de campo disponíveis são `text` (com `multiline` opcional), `integer`, `select`, `boolean` e `string-list`. Todos aceitam `name`, `label`, `description`, `required` e um `defaultValue` compatível com seu tipo. Use `defaultValue` para permitir editar uma etapa anterior, e `submitLabel` no formulário para personalizar o botão de envio.

`prompt()` retorna `null` se a conversa for cancelada, expirar ou perder a conexão. Retorne do handler nesse caso; use `ctx.signal` para cancelar operações externas. Só pode existir um formulário pendente por invocação: aguarde um antes de abrir o próximo. Há até 10 campos, 20 opções por seleção/lista e cinco comandos simultâneos por conexão. Cada invocação dura no máximo cinco minutos e 100 etapas; abrir outro formulário não reinicia esse prazo. O bot não pode enviar respostas depois de encerrar o handler.

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
import { BotClient } from '@monky/bot-sdk';

const bot = new BotClient({
  publicKey: 'SUA_CHAVE_ED25519_HEX',
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
| `/8ball [pergunta]` | Bola mágica; pede a pergunta no chat quando omitida |
| `/enquete` | Formulário de pergunta e opções, revisão e confirmação de compartilhamento |
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

### `BotOptions`

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `publicKey` | `string` | ✅ | Chave pública Ed25519 em hex |
| `serverUrl` | `string` | Modo manual | URL WebSocket do servidor |
| `token` | `string` | Modo manual | Token do bot |
| `autoReconnect` | `boolean` | — | Reconectar automaticamente (padrão: `true`) |
| `name` | `string` | — | Nome a sincronizar no perfil |
| `avatarBase64` | `string` | — | Foto em base64 ou data URI, sincronizada ao conectar |

### `ServeOptions`

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `name` | `string` | ✅ | Nome exibido no manifest |
| `description` | `string` | — | Descrição do bot |
| `icon` | `string` | — | Foto em base64 ou data URI (não aceita URL) |
| `port` | `number` | — | Porta HTTP (padrão: `7780`) |
| `host` | `string` | — | Endereço de bind (padrão: `0.0.0.0`) |
| `publicHost` | `string` | — | Hostname público para o registro |
