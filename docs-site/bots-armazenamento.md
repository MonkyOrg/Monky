---
description: "Guarde dados de um bot do Monky no servidor ou nos computadores dos participantes, com aprovação do administrador."
---

# Armazenamento do bot

Um bot pode guardar dados em dois lugares, cada um com a sua capacidade. Os
dois começam desligados e dependem da aprovação de quem administra o servidor.

| Onde | Capacidade | Quem lê e grava | Quem decide |
|------|------------|-----------------|-------------|
| No servidor Monky | `server_storage` | Só o bot, pelo SDK: `bot.storage(serverId)` | O administrador, na revisão de permissões |
| No computador de quem abre um miniapp | `device_storage` | Só os miniapps do bot: `window.monkyScreen.storage` | O administrador permite **pedir**; cada pessoa decide no próprio computador |

**Referência:** [BotStorage](/bots-api-cliente#botstorage),
[BotStoredObject](/bots-api-cliente#botstoredobject),
[BotStorageUsage](/bots-api-cliente#botstorageusage),
[BotRequestError](/bots-api-cliente#botrequesterror),
[BOT_STORAGE_LIMITS](/bots-api-ferramentas#bot_storage_limits) e, nos miniapps,
[BotScreenStorage](/bots-api-midia#botscreenstorage).

Saves de jogos são o caso típico: um emulador pode guardar os slots no
servidor, para todos da sala, e os saves automáticos no computador de cada
pessoa, sem obrigar ninguém a baixar arquivos.

## Declarar as capacidades

```ts
const bot = new BotClient({
  requestedCapabilities: ['commands', 'miniapps', 'server_storage', 'device_storage'],
  publicKey,
});
```

Declare só o que usa. Como qualquer capacidade nova, as duas chegam
desligadas na revisão e não são ativadas por uma reconexão. Servidores
anteriores ao armazenamento de bots não conhecem esses nomes: o SDK os omite
do registro e do manifest enviados a esses servidores, para que o resto do bot
continue funcionando.

## No servidor: `bot.storage(serverId)` {#no-servidor}

Os objetos ficam no servidor e só o próprio bot os lê. Quem pode gerenciar
bots vê quanto espaço ocupam em **Configurações do bot → Armazenamento**; as
demais pessoas não recebem nenhum dado do armazenamento no servidor, só os do
próprio computador.

```ts
const storage = bot.storage(serverId);

await storage.put(`nes/${romId}/slot-1`, state, { contentType: 'application/octet-stream' });
const saved = await storage.get(`nes/${romId}/slot-1`); // BotStoredObject | null
if (saved) emulator.load(saved.data); // Uint8Array

const page = await storage.list({ prefix: `nes/${romId}/`, limit: 50 });
for (const object of page.objects) console.log(object.key, object.sizeBytes, object.updatedAt);
if (page.next) await storage.list({ prefix: `nes/${romId}/`, after: page.next });

await storage.delete(`nes/${romId}/slot-1`); // true se existia
const usage = await storage.usage(); // { usedBytes, maxBytes, objectCount, maxObjects, level }
```

- `put()` aceita `Uint8Array`, `ArrayBuffer` ou texto (gravado em UTF-8) e
  substitui o objeto da mesma chave. A resposta traz `key`, `sizeBytes`,
  `contentType` e `updatedAt`, sem os dados.
- `list()` devolve até 100 objetos por página, em ordem de chave. Continue com
  `after: page.next` até `next` ser `null`.
- Chaves são nomes lógicos, como `nes/<rom>/slot-1`: até 200 caracteres,
  letras, números, `.`, `_`, `-` e `/`, começando por letra ou número, sem
  segmentos vazios, `.` ou `..`. Elas nunca viram caminhos de arquivo no servidor.
- Cada objeto tem até 4 MiB, porque viaja numa única mensagem. O total começa
  em 100 MB por bot, e o administrador pode ajustá-lo de 1 MB a 100 GB. Há até
  10.000 objetos por bot e 20 operações por segundo.

Falhas rejeitam com [`BotRequestError`](/bots-api-cliente#botrequesterror),
cujo `code` é um `ProtocolErrorCode`:

| `code` | Quando |
|--------|--------|
| `STORAGE_FULL` | A gravação não cabe no limite ou no número de objetos |
| `BOT_PERMISSIONS_REQUIRED` | `server_storage` não foi aprovada neste servidor |
| `FEATURE_REQUIRES_UPDATE` | O servidor ainda não tem armazenamento de bots |
| `FEATURE_UNAVAILABLE` | O servidor foi iniciado sem armazenamento de bots; atualizar não resolve |
| `RATE_LIMITED` | Mais de 20 operações por segundo |
| `BAD_REQUEST` | Chave, dados ou listagem inválidos |

`bot.storage()` lança um erro imediatamente se `server_storage` não estiver
em `requestedCapabilities`.

### Saves automáticos

Uma gravação que ninguém pediu não deve interromper a atividade. Com
`{ autosave: true }`, um armazenamento cheio faz `put()` resolver `null` em vez
de rejeitar:

```ts
const saved = await storage.put(`nes/${romId}/autosave`, state, { autosave: true });
if (!saved) {
  // Cheio: o Monky já avisa as pessoas no card do miniapp. Siga jogando.
}
```

Outros erros, como falta de permissão, continuam rejeitando. Para saves que a
pessoa pediu, deixe `autosave` desligado e mostre a falha.

## Nos computadores: `monkyScreen.storage` {#nos-computadores}

Com `device_storage` aprovada, quem abre um miniapp do bot escolhe, no mesmo
aviso de **Continuar e abrir**, se ele pode guardar dados no computador:

- **Não guardar** (padrão): nada é gravado. O miniapp funciona normalmente.
- **Só nesta sessão**: vale até a pessoa sair do miniapp. Na próxima abertura,
  o Monky pergunta de novo.
- **Sempre**: não pergunta mais.

Em **Configurações do bot → Armazenamento → Neste computador**, a pessoa troca
a decisão entre **Perguntar**, **Sempre** e **Nunca**, ajusta o limite (50 MB
por padrão, de 1 MB a 100 GB) e apaga os dados. A mudança vale na hora, também
para um miniapp aberto.

| API | Comportamento |
|-----|---------------|
| `status` | `'granted'`, `'denied'` ou `'unavailable'` |
| `onStatus(callback)` | Chama logo com o status atual e de novo a cada mudança; retorna uma função de unsubscribe |
| `get(key)` | Resolve `string`, `ArrayBuffer` ou `null` |
| `set(key, value, { autosave })` | Grava texto, `ArrayBuffer`, typed array ou `Blob`; resolve `true` |
| `delete(key)` | Resolve `true` se a chave existia |
| `list({ prefix })` | Resolve `[{ key, size, updatedAt }]` em ordem de chave |
| `usage()` | Resolve `{ usedBytes, maxBytes, level }` |

O status começa `unavailable` e muda quando o Monky conecta o miniapp, logo
depois de carregar. Use `onStatus()` em vez de ler `status` uma única vez:

```js
const storage = window.monkyScreen.storage; // ausente em clientes Monky antigos
let autosaveAllowed = false;
storage?.onStatus((status) => {
  autosaveAllowed = status === 'granted';
  if (autosaveAllowed) void restoreAutosave();
});

async function restoreAutosave() {
  const state = await storage.get(`nes/${romId}/autosave`);
  if (state instanceof ArrayBuffer) emulator.load(new Uint8Array(state));
}

async function autosave(state) {
  // Sem permissão, cheio ou grande demais: resolve false e o jogo continua.
  if (autosaveAllowed) await storage.set(`nes/${romId}/autosave`, state, { autosave: true });
}
```

`unavailable` também significa que o administrador não permitiu
`device_storage`, que o servidor é anterior ao recurso ou que o miniapp foi
aberto sem armazenamento. Clientes Monky antigos não têm `monkyScreen.storage`:
confira se ele existe. Ofereça sempre um botão para **baixar** o save, que
funciona sem nenhuma permissão.

Fora do `autosave`, as falhas rejeitam com um erro de nome
`MonkyStorageError` e um `reason`: `denied`, `unavailable`, `quota`,
`too_large`, `invalid`, `busy` ou `failed`. Valores de outros tipos rejeitam
com `TypeError`.

Os dados ficam separados por servidor, conta e bot. O miniapp não escolhe
esse escopo: o Monky associa cada pedido à visualização que ele abriu. Todos os
miniapps do mesmo bot compartilham o espaço da pessoa naquele servidor, então
use prefixos por app nas chaves. Valem as mesmas regras de chave, 4 MiB por
objeto, até 1.000 objetos e 20 operações por segundo em cada visualização.

O armazenamento web da origem do miniapp (`localStorage`, IndexedDB) continua
sendo descartado ao fechar a visualização; use `monkyScreen.storage` para o que
precisa sobreviver.

### Salvar ao fechar {#salvar-ao-fechar}

O `monkyScreen.storage` continua funcionando durante o
[`onClose`](/bots-miniapps#ciclo-de-vida-da-visualizacao), enquanto a
visualização fecha escondida e muda. Uma escolha **Só nesta sessão** também
vale até ele terminar. É o momento de guardar o progresso sem perguntar nada:

```js
window.monkyScreen.onClose?.(async () => {
  await storage?.set(`nes/${romId}/autosave`, emulator.saveState(), { autosave: true });
});
```

O `onClose` tem no máximo 5 segundos: se não terminar, o documento é
descartado. Mantenha também o save automático periódico, porque sair do Monky
ou recarregá-lo não dá tempo a nenhum gancho.

## Avisos de espaço {#avisos}

`usage.level` vale `ok`, `near_full` (a partir de 90% do limite) ou `full`
(limite atingido ou uma gravação acabou de ser recusada por falta de espaço).
Liberar espaço ou aumentar o limite volta o nível ao normal.

Enquanto o armazenamento do bot neste computador estiver quase cheio ou cheio,
o Monky mostra um aviso no canto inferior esquerdo do card do miniapp:
**Armazenamento quase cheio** ou **Armazenamento cheio: saves automáticos
pausados**. Quem pode gerenciar bots também vê esse aviso quando o
armazenamento no servidor enche; as demais pessoas só são avisadas sobre o
próprio computador. O aviso é desenhado pelo Monky, não pelo miniapp, e abre
**Configurações do bot → Armazenamento**. Não reproduza esse aviso no app;
trate `null`, `false` e `STORAGE_FULL` sem travar a atividade.

## Remover o bot, revogar e apagar

- **Desvincular o bot** apaga o que ele guardou no servidor. A confirmação
  mostra quanto será apagado.
- **Revogar `server_storage`** bloqueia o acesso, mas mantém os dados. Quem
  pode gerenciar bots os apaga em **Configurações do bot → Armazenamento → No
  servidor**.
- **Revogar `device_storage`** impede novos pedidos. Os dados já gravados
  continuam nos computadores, e cada pessoa decide se os apaga.
- O Monky nunca apaga dados de um computador remotamente. Em **Configurações →
  Ferramentas de bots → Dados de bots neste computador**, a pessoa vê tudo o
  que miniapps guardaram, inclusive de servidores e bots que não usa mais, e
  apaga o que quiser.

## Compatibilidade

O armazenamento exige servidor e cliente com a versão de protocolo 39
(recurso `bot-storage`). Com um servidor anterior, `bot.storage()` rejeita com
`FEATURE_REQUIRES_UPDATE` e os miniapps não recebem armazenamento. Clientes
anteriores não veem as novas capacidades nem a aba **Armazenamento**.
