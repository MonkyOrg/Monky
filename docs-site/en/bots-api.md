# Bot SDK reference {#bot-api-reference}

Look up the public **Monky bot SDK** (`@monky/bot-sdk`) contract here.
It is for building bots that connect to Monky servers. For a runnable project,
start with the [tutorial](/en/bots-desenvolvimento). For recipes and
implementation decisions, use the individual feature guides.

## Complete signatures and types

| Reference | Contents |
| --- | --- |
| [BotClient and contexts](/en/bots-api-cliente) | Constructor, every public property and method, connection options and callback contexts |
| [Commands and interactions](/en/bots-api-interacoes) | Parameters, forms, selectors, messages, preferences, translations and validators |
| [Media and local execution](/en/bots-api-midia) | Voice, miniapps, tasks, sources, streams and typed errors |
| [CLI, utilities and constants](/en/bots-api-ferramentas) | Packaging, update sources, configuration validation, tools and limits |

Signature pages are generated from the SDK's **public exports**
and include every discriminated type variant, not just example fields. Also
check **Source and validation**: a `string` can have size, format and
authorization constraints that TypeScript alone cannot express.

## Construction and connection

```ts
import { BotClient } from '@monky/bot-sdk';
import type { BotOptions } from '@monky/bot-sdk';

function createBot(options: BotOptions): BotClient {
  return new BotClient(options);
}
```

`publicKey` and `requestedCapabilities` are required. `autoReconnect` defaults
to `true`. `name` and `avatarBase64` are optional: omitting the photo preserves
it; `null` removes it. `registrationFile` persists Marketplace registrations
only; it does not replace the bot's identity.

| Method/property | Return value and effect |
| --- | --- |
| `command(definition)` | Returns `this`; registers or replaces a definition by canonical name, validating capabilities and collisions |
| `settings(definition)` | Returns `this`; declares forms before connecting/serving |
| `connect(overrides?)` | Returns `void`; starts a connection without waiting for authentication |
| `serve(options)` | `Promise<http.Server>`; opens manifest/registration endpoints and restores saved registrations |
| `disconnect(serverId?)` | Returns `void`; disconnects one or all connections without deleting persisted registrations |
| `close()` | `Promise<void>`; shuts down connections, media, tasks and HTTP and awaits persistence |
| `serverIds` | `string[]` of active authenticated connections |
| `serverCount` | Number of those connections; does not imply capability approval |
| `registeredServerCount` | Known persistent registrations, including offline ones |
| `getPermissions(serverId)` | `BotPermissions` snapshot or `undefined` while unavailable |

Use IDs received in `ctx.serverId` or SDK events. An ID identifies the SDK
connection/registration, not the server's name or necessarily the internal
ID displayed by Monky's server monitor.

`BotClient` extends `EventEmitter`: register listeners with `on`/`once` and
remove them with `off`, passing the same function. Install an `error` listener
before connecting. Do not register the same listeners on every command or
reconnection.

## Command context

[`CommandContext`](/en/bots-api-cliente#commandcontext) contains typed
arguments, locale, an immutable preference snapshot and authenticated IDs
for the person, device, channel, bot and connection.

| Member | Contract |
| --- | --- |
| `args` | Named `string`, `number` or `boolean` values; empty optional values are omitted |
| `locale` | `pt-BR` or `en`, captured for the interaction |
| `settings` | `server` and `user` values and their revisions; do not grant permission |
| `signal` | Aborted when the invocation completes, is cancelled, expires or disconnects |
| `invokerVoiceChannelId` | Voice room at invocation start, or `null`; not live state |
| `getVoiceChannel()` | `Promise<string \| null>`; revalidates the original human connection's current room |
| `reply(content)` / `replyEphemeral(content)` | `void`; private, temporary response in the caller's chat |
| `publish(content)` | `void`; persisted public result, requires `send_messages` |
| `prompt(form)` | `Promise<BotFormValues \| null>`; awaits a private form |
| `choose(choice)` | `Promise<string \| null>`; awaits a private choice |
| `downloadSound(request)` | `Promise<SoundDownloadResult \| null>`; one authorized local download |
| `createSelector(input)` | `Promise<BotSelector>`; public control that outlives the invocation |
| `createScreen(input)` | `Promise<BotScreen>`; miniapp in the current voice room |

A `null` prompt/download result can mean the invocation itself has ended.
Return from the handler; do not try to reply through a closed context.
Validation errors and rejected operations remain errors, not empty
success results.

Autocomplete and preview callbacks have their own contexts:
[`CommandAutocompleteContext`](/en/bots-api-cliente#commandautocompletecontext)
and [`CommandAudioPreviewContext`](/en/bots-api-cliente#commandaudiopreviewcontext).
They **do not** receive command reply methods.

## Messages, preferences and persistent controls

| Method | Return value and use |
| --- | --- |
| `sendMessage(serverId, channelId, content, options?)` | `Promise<ChatMessage>` after acknowledgement; `options.replyToMessageId` references a message in the same channel |
| `addReaction(...)` / `removeReaction(...)` | `void`; change only the bot's own reaction |
| `onReactionAdded(listener)` / `onReactionRemoved(listener)` | Return a listener removal function |
| `getServerSettings(serverId)` | `BotServerSettingsSnapshot \| undefined`; shared values only, never personal preferences |
| `onSettingsChanged(listener)` | Returns a removal function; provides a snapshot and server context |
| `createSelector(serverId, input)` | `Promise<BotSelector>`; creates a durable control |
| `listSelectors(serverId)` | `Promise<BotSelector[]>`; restores selectors after reconnection |
| `updateSelector(serverId, id, patch)` | `Promise<BotSelector>`; changes allowed title/limits |
| `closeSelector(serverId, id)` | `Promise<BotSelector>`; ends response collection |
| `finalizeSelector(serverId, id, content)` | `Promise<BotSelector>`; publishes the result once |
| `onSelectorResponse(listener)` | Returns a removal function; provides the responder's private preferences |

The server revalidates access on every operation. In private channels,
prefer `ctx.createSelector()` to bind authorization to the real human command.
Do not keep the handler open throughout a long poll.

## Voice, miniapps and local execution

| Method | Return value and use |
| --- | --- |
| `joinVoice(serverId, channelId, options?)` | `Promise<BotVoiceConnection>`; `options.invocationId` binds admission to the caller |
| `getVoiceConnection(serverId)` | `BotVoiceConnection \| undefined` |
| `leaveVoice(serverId)` | `Promise<void>`; releases the voice connection |
| `createScreen(serverId, input)` | `Promise<BotScreen>`; creates a miniapp |
| `updateScreen(serverId, ref, patch)` | `Promise<BotScreen>`; requires an instance and expected revision |
| `listScreens(serverId, channelId)` | `Promise<BotScreen[]>`; lists voice-room miniapps |
| `closeScreen(serverId, ref)` | `Promise<void>`; ends the instance for everyone |
| `localExecution(serverId)` | `LocalExecutionClient`; authorized executors and sources for that server |

A `BotScreenRef` contains **`id` and `instanceId`**. An Opus stream is not an
audio file or authorization to receive participants' voices. Read the
[voice](/en/bots-voz), [miniapp](/en/bots-miniapps) and
[local execution](/en/bots-execucao-local) guides before implementing lifecycle
management.

## Events

These are the events emitted by `BotClient`. The extra `{ serverId }` context,
where indicated, is a **second argument**, not part of the first payload.

| Event | Arguments and meaning |
| --- | --- |
| `connected` | `{ serverId }`; authentication completed, not administrator approval |
| `disconnected` | `{ serverId }`; connection lost/closed |
| `auth_failed` | Rejection payload, `{ serverId }`; distinguish invalid credentials from protocol incompatibility |
| `error` | `Error`, optional `{ serverId }` context; connection or operation failure |
| `serving` | `{ port, host, manifest }`; HTTP listener ready |
| `registered` | HTTP-confirmed registration data, including `serverId` and `serverName`; **do not log the entire object, which may contain credentials** |
| `permissionsChanged` | `BotPermissions`, `{ serverId }`; declaration, grants and revision |
| `settingsChanged` | `BotServerSettingsSnapshot`, `{ serverId }`; shared behavior updated |
| `message` | Protocol envelope, `{ serverId }`; general events without a dedicated helper |
| `reactionAdded` / `reactionRemoved` | `ChatReactionEventPayload`, `{ serverId }` |
| `selectorUpdate` | `{ serverId, selector }`; selector state, including closure |
| `selectorResponse` | `BotSelectorResponseEvent`, `BotSelectorResponseContext`; response and private preferences |
| `screenAction` | `BotScreenActionEvent` with `serverId`; an authenticated participant intention |
| `screenRemoved` | `BotScreenRemoved` with `serverId`; remove timers and state for the correct instance |
| `voiceParticipantsChanged` | `{ serverId, channelId, humanParticipantCount }` |
| `voiceDisconnected` | `{ serverId, channelId, reason }` |
| `closed` | No arguments; final instance shutdown |

## Lifetimes and cleanup

| Resource | How it ends |
| --- | --- |
| Private invocation | Handler return, cancellation, expiration or authorization/connection loss |
| Autocomplete and preview | New context, cancellation, deadline or shutdown; respect `signal` |
| Public selector | Deadline/limit, explicit closure or revocation; recoverable from the server |
| Miniapp | Closure, bot disconnection or access loss; not persisted by the server |
| Voice connection | `leaveVoice()`, disconnection or revocation; the application also stops its source |
| Retained local source | `releaseSource()`; a reference is not an active task |
| Local stream | Await `closed` and call `close()` when needed; release the source only after drain/cleanup |

Separate short handler tasks from resources that outlive the command.
Revoking and granting access again does not revalidate old work.

## Updating the reference

For documentation maintainers, from the repository root:

```powershell
node docs-site\scripts\generate-bot-reference.mjs
node docs-site\scripts\generate-bot-reference.mjs --check
npm run docs:build
```

The generator walks the real exports and fails on declarations it cannot
represent. Edit explanations and examples in the guides; regenerate all four
PT/EN signature references when the API changes.
