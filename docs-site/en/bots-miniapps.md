# Shared miniapps

Use a screen when several participants need to follow the same state.
For an individual question, prefer [private forms](/en/bots-interacoes).
This example extends the [tutorial](/en/bots-desenvolvimento) and requires
`commands` and `miniapps`; it does not require `publish_voice`.

**Reference:** [BotScreen](/en/bots-api-midia#botscreen),
[BotScreenCreate](/en/bots-api-midia#botscreencreate),
[BotScreenPatch](/en/bots-api-midia#botscreenpatch) and
[BotScreenActionEvent](/en/bots-api-midia#botscreenactionevent).

<AppScreenshot src="/screenshots/miniapp-en.png" alt="A demo miniapp focused in Monky's voice stage." caption="The client hosts the isolated view; the bot remains responsible for state and rules." />

## Shared programmable screens

A screen is an HTML/CSS/JavaScript miniapp displayed **on the voice stage**. People in the room receive an invitation in the same corner as screen-sharing notices and choose whether to view it. There is no miniapp chat card or automatic opening. Unlike private `ctx.prompt()` forms, it accepts multiple participants and remains active after its command handler finishes. MonkyBot's `/jogo-da-velha` demonstrates two players and spectators; its rules remain in the bot, not in a viewer's JavaScript.

The tile stays on the stage alongside cameras and screen shares, even when its view is closed. **Open miniapp** starts local viewing; **Leave miniapp** ends it and returns the tile to its closed state without closing the miniapp for anyone else. Focusing or returning to the grid only changes the layout: it does not reload the screen or change player seats. Opening a screen to watch is not the same as joining its game.

**End miniapp** is a separate action: it removes the instance, tile, and
invitations for everyone and closes all open views. It is available only to the
person who invoked the creating command or an administrator (`ADMINISTRATOR`,
including the server owner). The server enforces the same authorization and
this connection's presence in the room; hiding a button is not the protection.
The creator is the authenticated `creatorUserId`, preserved when rejoining or
using another device, not the bot's identity or a caller-supplied field.
Screens created without an invocation have no human creator; only
administrators can end them from the client.

Other open views display a temporary notice with the miniapp's name, in the
client's language. People who only received an invitation or already left
the view do not receive this notice.

Inside a command, `ctx.createScreen()` queries the caller's current voice room and binds the miniapp to that room and invocation, including authorized private rooms. `screen.channelId` always identifies a **voice channel**, not `ctx.channelId` (the command's text channel). Creation without voice membership is rejected. The bot does not need an audio connection to host a miniapp. Standalone `bot.createScreen(serverId, input)` requires the bot's own access; supplying `invocationId` enables invocation-scoped authorization. This does not grant general access to private messages.

```ts
bot.command({
  name: 'screen',
  description: 'Open a shared screen',
  voiceRequirement: 'joined',
  handler: async (ctx) => {
    await ctx.createScreen({
      title: ctx.locale === 'en' ? 'Shared screen' : 'Tela compartilhada',
      html: `<main id="message"></main><script>
        window.monkyScreen.onState(state => {
          document.getElementById('message').textContent = state.message;
        });
      </script>`,
      state: { message: ctx.locale === 'en' ? 'Hello, everyone!' : 'Olá, pessoal!' },
    });
  },
});
```

Inside the isolated document, the `window.monkyScreen` bridge provides:

| Screen API | Behavior |
|------------|----------|
| `viewer` | Frozen local context with `id`, `nickname`, and `locale` (`pt-BR` or `en`) for the person opening the screen |
| `onState((state, revision) => ...)` | Delivers initial state and updates; returns an unsubscribe function |
| `sendAction(action, payload)` | Sends an intent bound to the current revision; returns whether the bridge accepted sending it, not whether the bot accepted the action |

Read `window.monkyScreen.viewer.locale` inside the `onState()` callback to translate each person's controls. Changing the app language also triggers this callback without changing shared state/revision or recreating the iframe. Do not derive the controls' language from public state or the screen creator's language.

The SDK's `screenAction` event delivers `{ serverId, screenId, instanceId, channelId, userId, userNickname, action, payload, revision, actionId }`. Use the authenticated identity in this envelope, never a player/user supplied in `payload`. Validate the action and game rules in the bot before calling `await bot.updateScreen(serverId, screen, { state, expectedRevision })`. Pass the returned snapshot, or a `BotScreenRef` containing `{ id, instanceId }`, not just a string ID. An accepted update increments `revision` and reaches participants; an old revision is rejected rather than overwriting a concurrent change. HTML remains unchanged during state updates.

Use `listScreens(serverId, channelId)` with the voice room's ID to obtain current
snapshots and `closeScreen(serverId, screen)` for bot-initiated termination.
The server generates `instanceId`: even if `id` is reused, the replacement gets
a different instance. Old updates, actions, terminations, and events cannot
affect it. Human END is independent of the latest state revision; a concurrent
update cannot prevent ending the correct instance.

The `screenRemoved` event delivers `{ serverId, id, instanceId, channelId, reason }`.
For `reason === 'ended'`, it also includes the server-authenticated
`endedByUserId`. Other reasons are `closed`, `access_revoked`, `bot_disconnected`,
and `view_revoked` (revocation of one local view, not global termination).
Delete the corresponding bot state after comparing **server, ID, and instance**:
cancel timers/expiry, abort pending work, and release game seats. If the
instance owns music playback, stop its source/queue and release its resources
too; the SDK cannot infer a bot's domain rules. Never treat an instance-not-found
error as an instruction to recreate it.

After END, the still-running creating invocation is cancelled, including its
prompts and pending work; it cannot create another screen. A fresh command is
required. Completed/expired invocations remain invalid for
creation. The SDK rejects reads/updates whose responses were overtaken by a
removal rather than returning an apparently live snapshot. After every
`await`, check that the game session is still the same before storing results.
`ctx.signal` is aborted if the invocation is still active, but does not follow
the screen after its handler finishes: use `screenRemoved` for miniapp teardown.

Register listeners once and remove them on shutdown. The client restores
active miniapps when joining their room; leaving, moving or disconnecting
closes local viewing and revokes actions. **Leave miniapp** does not send END,
erase shared state, or automatically release a player seat.

**Shared state, no secrets:** authorized participants currently in that voice room receive the HTML and JSON state. The server also checks room membership when listing screens or acting; another channel or another device in voice does not authorize this connection. Actions require `USE_BOT_COMMANDS`. Never include tokens, local paths, or a player's secret information. Screens receive no Node.js, preload, IPC, access to the client's DOM, or permission for networking, navigation, popups, and downloads. Embed visual resources in the document instead of relying on CDNs or external requests.

Limits are 128 KiB of HTML, 64 KiB of state, and 8 KiB per action; JSON allows up to 12 levels and 8,192 nodes. There may be up to four miniapps per voice room, 16 per bot, and 64 per server, with rate limits and action deduplication. They live in memory and are removed on bot restart/disconnection, loss of room authorization, or authorized termination. Leaving the room, even emptying it, does not automatically delete state. Game expiry belongs to the bot. If you persist games, persist their terminal status too: a bot restart must not restore an explicitly ended game.
