---
description: "Conecte um bot do Monky manualmente ou pelo modo Marketplace e preserve a identidade dele entre atualizações."
---

# Conexão e identidade

Use uma conexão manual para desenvolvimento e o modo Marketplace para
permitir vínculos por URL. A identidade precisa sobreviver às atualizações,
independentemente do modo escolhido.

**Referência:** [BotOptions](/bots-api-cliente#botoptions),
[ServeOptions](/bots-api-cliente#serveoptions) e
[métodos e eventos](/bots-api#construcao-e-conexao).

## Modo Marketplace (multi-servidor)

Se você quer distribuir seu bot por manifest, use `serve()`. No projeto do
[tutorial](/bots-desenvolvimento), altere `monkyBot.modes` para `["manual", "marketplace"]`,
use a entrada abaixo, compile e refaça `npm run cli -- setup` nesse modo.
Escolha a instalação por URL no assistente. O CLI fornece a identidade, o
caminho dos vínculos, a porta e o host configurados; a entrada também preserva
o modo manual.

```ts
import {
  BotClient, validateBotPublicHost, validateBotServePort,
  validateBotServerUrl, validateBotToken,
} from '@monky/bot-sdk';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

const marketplace = process.env.MONKY_SERVE === 'true';
const bot = new BotClient({
  requestedCapabilities: ['commands'],
  publicKey: requiredEnvironment('MONKY_BOT_PUBLIC_KEY'),
  registrationFile: marketplace ? requiredEnvironment('MONKY_BOT_REGISTRATION_FILE') : undefined,
  name: process.env.MONKY_BOT_NAME ?? 'Meu Bot',
});

bot.command({
  name: 'ping',
  description: 'Check whether the bot is online',
  localizations: { 'pt-BR': { description: 'Verifica se o bot está respondendo' } },
  handler: (ctx) => ctx.reply(ctx.locale === 'en' ? 'Pong! I am online.' : 'Pong! Estou online.'),
});
bot.on('error', (error: Error) => console.error('[bot]', error.message));
const shutdown = () => {
  void bot.close().catch((error: unknown) => {
    console.error('[shutdown]', error);
    process.exitCode = 1;
  });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

if (marketplace) {
  await bot.serve({
    name: process.env.MONKY_BOT_NAME ?? 'Meu Bot',
    description: 'Example bot / Bot de exemplo',
    port: validateBotServePort(requiredEnvironment('MONKY_SERVE_PORT')),
    publicHost: validateBotPublicHost(requiredEnvironment('MONKY_SERVE_PUBLIC_HOST')),
    // Só existe quando o perfil tem uma URL pública (proxy com TLS).
    publicUrl: process.env.MONKY_SERVE_PUBLIC_URL || undefined,
  });
} else {
  bot.connect({
    serverUrl: validateBotServerUrl(requiredEnvironment('MONKY_SERVER_URL')),
    token: validateBotToken(requiredEnvironment('MONKY_BOT_TOKEN')),
  });
}
```

Depois do setup, use `npm run cli -- start --foreground`. O teste
`process.env.MONKY_SERVE === 'true'` é explícito: a string `'false'` também é
truthy em JavaScript. Só declare em `modes` os caminhos realmente implementados.

Isso expõe:
- `GET /manifest` — retorna o manifest do bot (nome, descrição, capacidades solicitadas, URL de registro)
- `POST /register` — recebe o token de cada servidor que adiciona o bot

Só servidores Monky conversam com essas rotas, nunca páginas web, então elas não
respondem a CORS. O `POST /register` só aceita `Content-Type: application/json`,
com corpo de até 16 KiB. Cada endereço de origem pode fazer 10 tentativas de
registro por minuto, e no máximo 4 registros são concluídos ao mesmo tempo; acima
disso, o bot responde `429`. Atrás de um proxy, o endereço contado é o do proxy.

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
sudo iptables -I INPUT 1 -p tcp --dport 7780 -j ACCEPT

# Se usar ufw (Ubuntu):
sudo ufw allow 7780/tcp

# Se estiver em cloud (AWS, GCP, Azure, etc.):
# Libere a porta 7780 TCP no Security Group / Firewall Rules
```

Além disso, o `publicHost` deve ser o **IP ou domínio público** da máquina — `localhost` só funciona se bot e servidor estiverem na mesma máquina.

### HTTPS com proxy reverso {#https-com-proxy-reverso}

Sem `publicUrl`, o manifest anuncia `http://<publicHost>:<port>/register`, e o
servidor Monky envia o token do bot para esse endereço **sem criptografia**. Para
o token viajar protegido, coloque o bot atrás de um proxy reverso com TLS (Caddy,
nginx etc.) e informe a origem pública em `publicUrl`:

```ts
await bot.serve({
  name: 'Meu Bot',
  port: 7780,
  host: '127.0.0.1', // só o proxy, na mesma máquina, acessa a porta
  publicUrl: 'https://bot.exemplo.com',
});
```

O manifest passa a anunciar `https://bot.exemplo.com/register`, e o servidor
Monky instala o bot pela URL `https://bot.exemplo.com/manifest`. No manifest,
`publicUrl` tem precedência sobre `publicHost` e `port`. Informe só a origem,
sem caminho, usuário, senha, query ou fragmento: o proxy encaminha a raiz do
domínio para o bot, e é nela que o `doctor` e o servidor comprovam o acesso.
Ao instalar, use a URL final do manifest: o servidor não segue
redirecionamentos, como o de `http://` para `https://` que o proxy costuma fazer.

Com o CLI do bot, salve a URL no perfil em vez de fixá-la no código:
`npm run cli -- config set publicUrl https://bot.exemplo.com`, ou
`--public-url https://bot.exemplo.com` no `setup --non-interactive`. O runner
entrega o valor em `MONKY_SERVE_PUBLIC_URL`, que a entrada do exemplo acima
repassa a `serve()`, e `start` e `doctor` passam a conferir o manifest por essa
URL. `config set publicUrl clear` volta a anunciar o host e a porta.

O acesso também precisa funcionar **do bot para o servidor Monky**. O vínculo
envia a URL WebSocket usada pelo cliente para entrar no servidor, preservando
host, porta e caminho; ele não transforma um listener `0.0.0.0` em `localhost`.
Se o bot estiver em uma VPS e o servidor no seu computador, entre no Monky pelo
IP ou domínio alcançável a partir dessa VPS. Firewall, encaminhamento de portas
ou um proxy precisam permitir a conexão de retorno; conseguir abrir o manifest
do bot não comprova esse segundo caminho.

Um servidor anunciado por loopback só aceita instalação quando as URLs do
manifest e do registro também são de loopback. Caso contrário, a prévia é
recusada antes de criar uma conta ou enviar um token, com uma orientação sobre
o endereço necessário. Para bot e servidor na mesma máquina, use URLs locais
nos dois lados, ou entre no servidor pelo endereço externo. Proxies devem
preservar o `Host` original e informar `X-Forwarded-Proto: https` quando terminam
TLS; o callback usa `wss` nesse caso. Esse ajuste não exige apagar identidades
nem vínculos válidos.

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

## Segurança: token e identidade {#seguranca-tofu-trust-on-first-use}

O **token** é o segredo do bot: quem tiver o token de um vínculo se conecta como
o bot naquele servidor. Trate-o como uma senha. Guarde o `registrationFile` com
acesso restrito, não registre o token em logs (o evento `registered` não o
inclui) e, no modo Marketplace, use HTTPS com `publicUrl`. Para falar com o
servidor, prefira `wss://`.

A **chave pública Ed25519** identifica o bot. Na primeira conexão, o servidor
vincula ao bot a chave apresentada (TOFU, *Trust On First Use*) e passa a recusar
conexões com outra chave. No modo Marketplace, o vínculo acontece durante a
instalação.

A chave pública não é segredo (vai no manifest e nos comandos), então o que
protege um token vazado é a **prova de posse da chave privada**. Quando o bot tem
a chave privada, o SDK oferece o recurso `bot-key-proof`: o servidor manda um
desafio, e o bot o assina com a chave privada, amarrado ao token daquela conexão.
Na primeira prova válida, o servidor passa a exigi-la daquele bot em toda
conexão. A partir daí, quem tiver só o token e a chave pública é recusado
(`FEATURE_REQUIRES_UPDATE`) sem derrubar o bot verdadeiro. Rodando pelo CLI do
bot, isso já vem ligado; no código, informe a chave em `privateKey`:

```ts
const bot = new BotClient({
  requestedCapabilities: [],
  publicKey: 'SUA_CHAVE_ED25519_HEX',
  privateKey: readFileSync('.keys/private.pem', 'utf8'), // PEM ou KeyObject
});
```

Bots e servidores antigos, sem o recurso, continuam se conectando só com o token.
Por isso, um bot que nunca provou a chave segue protegido apenas pelo token.
Cada tentativa recusada (token inválido, assinatura errada ou prova ausente)
gasta a cota de tentativas de conexão do endereço, como uma senha errada.

Se um token vazar, revogue o bot no servidor e adicione-o de novo. O vínculo novo
recebe outro token, e o bot mantém a mesma identidade.

> 💡 O [Monky Bot](https://github.com/MonkyOrg/MonkyBot) gera o par Ed25519 automaticamente e o reutiliza. Ao criar seu próprio bot com o SDK, gere e persista sua chave com as APIs de criptografia do Node.js e passe a chave pública em `publicKey` e a privada em `privateKey`; não gere uma identidade nova a cada reinício.

## Fotos dos bots

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
