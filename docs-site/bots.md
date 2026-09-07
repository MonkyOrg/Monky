# Bots

O Monky possui um sistema completo de bots que permite automatizar tarefas, adicionar comandos personalizados e integrar serviços externos ao seu servidor.

## O que é um bot?

Um bot é um **processo externo** que se conecta ao servidor Monky via WebSocket, como qualquer outro usuário. A diferença é que bots:

- Autenticam com **token** em vez de senha
- Podem registrar **slash commands** (`/ping`, `/dado`, etc.)
- Aparecem com badge **BOT** na lista de membros
- Não contam no limite de usuários (têm limite próprio: `maxBots`)

O bot roda na **máquina dele** (VPS, nuvem, seu PC), não no servidor Monky. O servidor apenas roteia mensagens — todo o processamento fica no bot.

```
Usuário digita /ping
        ↓
Servidor Monky (roteia)
        ↓
Bot (processa) → ctx.reply('🏓 Pong!')
        ↓
Servidor Monky (entrega no canal)
        ↓
Usuário vê a resposta
```

## Duas formas de adicionar um bot

### 1. Manual (token)

Ideal para bots internos de um servidor específico.

1. No client, vá em **Configurações do Servidor → Bots**
2. Digite um nome e clique **Criar**
3. Copie o token (exibido **uma única vez**)
4. Use o token no código do bot para conectar

### 2. Via URL (Marketplace)

Ideal para bots distribuídos que servem múltiplos servidores.

1. O desenvolvedor do bot publica um **manifest HTTP** (nome, descrição, URL de registro)
2. No client, vá em **Configurações do Servidor → Bots**
3. Cole a URL do manifest no campo "Instalar Bot via URL" e clique **Instalar**
4. O servidor busca o manifest, cria o bot, e envia o token automaticamente
5. O bot auto-conecta e registra seus comandos

## Criando seu próprio bot

### Pré-requisitos

- **Node.js 18+**
- Um servidor Monky rodando (v9.0.0+)
- O pacote `@monky/bot-sdk`

### Instalação do SDK

```bash
npm install @monky/bot-sdk
```

### Exemplo básico

```ts
import { MonkyBot } from '@monky/bot-sdk';

const bot = new MonkyBot({
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
    { name: 'lados', description: 'Número de lados', type: 'string', required: false },
  ],
  handler: (ctx) => {
    const sides = parseInt(ctx.args.lados, 10) || 6;
    const result = Math.floor(Math.random() * sides) + 1;
    ctx.reply(`🎲 Resultado: **${result}**`);
  },
});

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
    // ctx.args       — argumentos { nome: valor }
    // ctx.reply()    — responde no canal (visível a todos)
    // ctx.replyEphemeral() — responde só para o invocador
  },
});
```

### Respostas efêmeras

Use `ctx.replyEphemeral()` para mensagens que só o invocador vê:

```ts
bot.command({
  name: 'segredo',
  description: 'Conta um segredo só pra você',
  handler: (ctx) => {
    ctx.replyEphemeral('🤫 Só você está vendo isso!');
  },
});
```

## Modo Marketplace (multi-servidor)

Se você quer distribuir seu bot para que qualquer servidor Monky possa instalar, use o modo `serve()`:

```ts
import { MonkyBot } from '@monky/bot-sdk';

const bot = new MonkyBot({
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
- `POST /register` — recebe o token de cada servidor que instala o bot

Cada servidor que instalar cria uma **conexão WebSocket independente**. O bot gerencia todas automaticamente, com reconexão.

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

## Monky Bot (bot oficial)

O [**Monky Bot**](https://github.com/MonkyOrg/MonkyBot) é o bot de referência mantido pela organização. Ele serve como exemplo prático e inclui comandos utilitários:

| Comando | Descrição |
|---------|-----------|
| `/ping` | Latência do bot |
| `/dado [lados]` | Rola um dado (2-100 lados) |
| `/moeda` | Cara ou coroa |
| `/8ball <pergunta>` | Bola mágica |
| `/enquete <pergunta> [opções]` | Enquete rápida |
| `/ajuda` | Lista todos os comandos |

Consulte o [repositório do Monky Bot](https://github.com/MonkyOrg/MonkyBot) para instruções de instalação e uso.

## Referência rápida da API

### `MonkyBot`

| Método | Descrição |
|--------|-----------|
| `new MonkyBot(options)` | Cria uma instância do bot |
| `bot.command(def)` | Registra um slash command |
| `bot.connect(overrides?)` | Conecta a um servidor (modo manual) |
| `bot.disconnect(serverId?)` | Desconecta de um ou todos os servidores |
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

### `ServeOptions`

| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `name` | `string` | ✅ | Nome exibido no manifest |
| `description` | `string` | — | Descrição do bot |
| `icon` | `string` | — | Ícone (URL ou base64) |
| `port` | `number` | — | Porta HTTP (padrão: `7780`) |
| `host` | `string` | — | Endereço de bind (padrão: `0.0.0.0`) |
| `publicHost` | `string` | — | Hostname público para o registro |
