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

## Segurança: TOFU (Trust On First Use)

Na primeira conexão, o bot apresenta sua **chave pública Ed25519**. O servidor a vincula permanentemente ao bot (TOFU binding). Conexões futuras exigem a mesma chave — se alguém tentar usar o token com uma chave diferente, é rejeitado.

No modo marketplace, o TOFU binding acontece automaticamente durante a instalação.

> 💡 O [Monky Bot](https://github.com/MonkyOrg/MonkyBot) gera o par Ed25519 automaticamente e o reutiliza. Ao criar seu próprio bot com o SDK, gere e persista sua chave com as APIs de criptografia do Node.js e passe a chave pública em `publicKey`; não gere uma identidade nova a cada reinício.

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
