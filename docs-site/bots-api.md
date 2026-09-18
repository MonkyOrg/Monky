# Referência do SDK de bots {#referencia-da-api-de-bots}

Consulte aqui o contrato público do **SDK de bots do Monky** (`@monky/bot-sdk`).
Ele serve para desenvolver bots que se conectam a servidores Monky. Para um projeto
executável, comece pelo [tutorial](/bots-desenvolvimento). Para receitas e
decisões de implementação, use os guias de cada recurso.

## Assinaturas e tipos completos

| Referência | Conteúdo |
| --- | --- |
| [BotClient e contextos](/bots-api-cliente) | Construtor, todas as propriedades e métodos públicos, opções de conexão e contextos de callbacks |
| [Comandos e interações](/bots-api-interacoes) | Parâmetros, formulários, seletores, mensagens, preferências, traduções e validadores |
| [Mídia e execução local](/bots-api-midia) | Voz, miniapps, tarefas, fontes, streams e erros tipados |
| [CLI, utilitários e constantes](/bots-api-ferramentas) | Empacotamento, origens de atualização, validação de configuração, ferramentas e limites |

As páginas de assinatura são geradas dos **exports públicos** do SDK
e incluem todas as variantes dos tipos discriminados, não apenas exemplos
de campos. Consulte também o link **Origem e validação**: um `string` pode ter
restrições de tamanho, formato e autorização que TypeScript sozinho não expressa.

## Construção e conexão

```ts
import { BotClient } from '@monky/bot-sdk';
import type { BotOptions } from '@monky/bot-sdk';

function createBot(options: BotOptions): BotClient {
  return new BotClient(options);
}
```

`publicKey` e `requestedCapabilities` são obrigatórios. `autoReconnect` é
`true` por padrão. `name` e `avatarBase64` são opcionais: omitir a foto a
preserva; `null` a remove. `registrationFile` só persiste os vínculos
Marketplace, não substitui a identidade do bot.

| Método/propriedade | Retorno e efeito |
| --- | --- |
| `command(definition)` | Retorna `this`; registra ou substitui a definição pelo nome canônico, validando capacidades e colisões |
| `settings(definition)` | Retorna `this`; declara os formulários antes de conectar/servir |
| `connect(overrides?)` | Retorna `void`; inicia a conexão, não espera a autenticação |
| `serve(options)` | `Promise<http.Server>`; abre manifest/registro e restaura vínculos salvos |
| `disconnect(serverId?)` | Retorna `void`; desconecta uma conexão ou todas, sem apagar vínculos persistidos |
| `close()` | `Promise<void>`; encerra conexões, mídia, tarefas e HTTP e aguarda a persistência |
| `serverIds` | `string[]` com as conexões autenticadas ativas |
| `serverCount` | Número dessas conexões; não significa que capacidades foram aprovadas |
| `registeredServerCount` | Vínculos persistentes conhecidos, inclusive offline |
| `getPermissions(serverId)` | Snapshot de `BotPermissions` ou `undefined` enquanto não estiver disponível |

Use os IDs recebidos em `ctx.serverId` ou nos eventos do SDK. Um ID identifica
a conexão/vínculo do SDK, não é o nome do servidor nem necessariamente o ID
interno exibido no monitor do Monky.

`BotClient` herda `EventEmitter`: registre listeners com `on`/`once` e remova-os
com `off` usando a mesma função. Instale um listener de `error` antes de conectar.
Não registre os mesmos listeners a cada comando ou reconexão.

## Contexto de um comando

O [`CommandContext`](/bots-api-cliente#commandcontext) contém os argumentos
tipados, o idioma, o snapshot imutável de preferências e os IDs autenticados
da pessoa, dispositivo, canal, bot e conexão.

| Membro | Contrato |
| --- | --- |
| `args` | Valores nomeados `string`, `number` ou `boolean`; opcionais vazios são omitidos |
| `locale` | `pt-BR` ou `en`, capturado para a interação |
| `settings` | Valores `server` e `user` e suas revisões; não concedem permissão |
| `signal` | Abortado ao concluir, cancelar, expirar ou desconectar a invocação |
| `invokerVoiceChannelId` | Sala no início da invocação, ou `null`; não é um estado vivo |
| `getVoiceChannel()` | `Promise<string \| null>`; revalida a sala atual da conexão humana original |
| `reply(content)` / `replyEphemeral(content)` | `void`; resposta privada e temporária no chat de quem chamou |
| `publish(content)` | `void`; resultado público persistido, exige `send_messages` |
| `prompt(form)` | `Promise<BotFormValues \| null>`; aguarda um formulário privado |
| `choose(choice)` | `Promise<string \| null>`; aguarda uma escolha privada |
| `downloadSound(request)` | `Promise<SoundDownloadResult \| null>`; um download local autorizado |
| `createSelector(input)` | `Promise<BotSelector>`; controle público que sobrevive à invocação |
| `createScreen(input)` | `Promise<BotScreen>`; miniapp na sala de voz atual |

`null` de um prompt ou download pode indicar o fim da própria invocação.
Retorne do handler; não tente publicar uma resposta em um contexto encerrado.
Erros de validação e operações rejeitadas continuam sendo erros, não um
resultado de sucesso vazio.

Os callbacks de autocomplete e prévia recebem contextos próprios:
[`CommandAutocompleteContext`](/bots-api-cliente#commandautocompletecontext) e
[`CommandAudioPreviewContext`](/bots-api-cliente#commandaudiopreviewcontext).
Eles **não** recebem os métodos de resposta do comando.

## Mensagens, preferências e controles persistentes

| Método | Retorno e uso |
| --- | --- |
| `sendMessage(serverId, channelId, content, options?)` | `Promise<ChatMessage>` após confirmação; `options.replyToMessageId` referencia uma mensagem do mesmo canal |
| `addReaction(...)` / `removeReaction(...)` | `void`; alteram somente a reação do próprio bot |
| `onReactionAdded(listener)` / `onReactionRemoved(listener)` | Retornam uma função de remoção do listener |
| `getServerSettings(serverId)` | `BotServerSettingsSnapshot \| undefined`; somente valores compartilhados, nunca preferências pessoais |
| `onSettingsChanged(listener)` | Retorna uma função de remoção; informa snapshot e contexto de servidor |
| `createSelector(serverId, input)` | `Promise<BotSelector>`; cria um controle durável |
| `listSelectors(serverId)` | `Promise<BotSelector[]>`; recupera seletores após reconexão |
| `updateSelector(serverId, id, patch)` | `Promise<BotSelector>`; altera título/limites permitidos |
| `closeSelector(serverId, id)` | `Promise<BotSelector>`; encerra a coleta |
| `finalizeSelector(serverId, id, content)` | `Promise<BotSelector>`; publica o resultado uma única vez |
| `onSelectorResponse(listener)` | Retorna uma função de remoção; entrega as preferências privadas de quem respondeu |

O acesso é revalidado pelo servidor em cada operação. Em canais privados,
prefira `ctx.createSelector()` para vincular a autorização ao comando humano
real. Não mantenha o handler aberto durante uma votação longa.

## Voz, miniapps e execução local

| Método | Retorno e uso |
| --- | --- |
| `joinVoice(serverId, channelId, options?)` | `Promise<BotVoiceConnection>`; `options.invocationId` vincula a entrada ao chamador |
| `getVoiceConnection(serverId)` | `BotVoiceConnection \| undefined` |
| `leaveVoice(serverId)` | `Promise<void>`; libera a conexão de voz |
| `createScreen(serverId, input)` | `Promise<BotScreen>`; cria um miniapp |
| `updateScreen(serverId, ref, patch)` | `Promise<BotScreen>`; exige instância e revisão esperada |
| `listScreens(serverId, channelId)` | `Promise<BotScreen[]>`; lista miniapps da sala de voz |
| `closeScreen(serverId, ref)` | `Promise<void>`; encerra a instância para todos |
| `localExecution(serverId)` | `LocalExecutionClient`; executores e fontes autorizadas daquele servidor |

Um `BotScreenRef` inclui **`id` e `instanceId`**. Um stream Opus não é um
arquivo de áudio nem uma autorização para receber a voz dos participantes.
Consulte os guias de [voz](/bots-voz), [miniapps](/bots-miniapps) e
[execução local](/bots-execucao-local) antes de implementar o ciclo de vida.

## Eventos

Os nomes abaixo são os eventos emitidos por `BotClient`. O contexto extra
`{ serverId }`, quando indicado, é um **segundo argumento**, não parte do
primeiro payload.

| Evento | Argumentos e significado |
| --- | --- |
| `connected` | `{ serverId }`; autenticação concluída, não aprovação administrativa |
| `disconnected` | `{ serverId }`; conexão perdida/encerrada |
| `auth_failed` | Payload de rejeição, `{ serverId }`; diferencie credencial inválida de protocolo incompatível |
| `error` | `Error`, contexto opcional `{ serverId }`; falha de conexão ou operação |
| `serving` | `{ port, host, manifest }`; listener HTTP pronto |
| `registered` | Dados do vínculo confirmado por HTTP, incluindo `serverId` e `serverName`; **não registre o objeto inteiro, que pode conter credenciais** |
| `permissionsChanged` | `BotPermissions`, `{ serverId }`; declaração, concessões e revisão |
| `settingsChanged` | `BotServerSettingsSnapshot`, `{ serverId }`; comportamento compartilhado atualizado |
| `message` | Envelope de protocolo, `{ serverId }`; eventos gerais sem helper específico |
| `reactionAdded` / `reactionRemoved` | `ChatReactionEventPayload`, `{ serverId }` |
| `selectorUpdate` | `{ serverId, selector }`; estado do seletor, inclusive encerramento |
| `selectorResponse` | `BotSelectorResponseEvent`, `BotSelectorResponseContext`; resposta e preferências privadas |
| `screenAction` | `BotScreenActionEvent` com `serverId`; intenção autenticada de um participante |
| `screenRemoved` | `BotScreenRemoved` com `serverId`; remova timers e estado da instância correta |
| `voiceParticipantsChanged` | `{ serverId, channelId, humanParticipantCount }` |
| `voiceDisconnected` | `{ serverId, channelId, reason }` |
| `closed` | Sem argumentos; encerramento final da instância |

## Duração e limpeza

| Recurso | Como termina |
| --- | --- |
| Invocação privada | Retorno do handler, cancelamento, expiração ou perda de autorização/conexão |
| Autocomplete e prévia | Novo contexto, cancelamento, prazo ou encerramento; respeite `signal` |
| Seletor público | Prazo/limite, fechamento explícito ou revogação; pode ser recuperado do servidor |
| Miniapp | Fechamento, desconexão do bot ou perda de acesso; não é persistido pelo servidor |
| Conexão de voz | `leaveVoice()`, desconexão ou revogação; a aplicação também encerra sua fonte |
| Fonte local retida | `releaseSource()`; não confunda a referência com uma tarefa em execução |
| Stream local | Aguarde `closed` e faça `close()` quando necessário; só encerre a referência depois da drenagem/limpeza |

Separe tarefas curtas do handler de recursos que duram mais que o comando.
Revogar e conceder acesso de novo não revalida trabalho antigo.

## Atualizar a referência

Para quem mantém esta documentação, a partir da raiz do repositório:

```powershell
node docs-site\scripts\generate-bot-reference.mjs
node docs-site\scripts\generate-bot-reference.mjs --check
npm run docs:build
```

O gerador percorre os exports reais e falha ao encontrar uma declaração que
não consegue representar. Edite as explicações e os exemplos nos guias;
regenere as quatro referências de assinatura em PT/EN ao alterar a API.
