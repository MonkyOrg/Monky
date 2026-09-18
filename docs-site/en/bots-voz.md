# Publish audio to voice

Use this guide to transmit audio your bot is authorized to use. Start with
the [tutorial](/en/bots-desenvolvimento) and request `commands` and
`publish_voice`. [Client-side execution consent](/en/bots-execucao-local)
is an additional authorization, not a consequence of joining voice.

**Reference:** [BotVoiceConnection](/en/bots-api-midia#botvoiceconnection),
[BotVoiceJoinOptions](/en/bots-api-midia#botvoicejoinoptions) and
[lifecycle](/en/bots-api#lifetimes-and-cleanup).

## Bot voice

The SDK separates the voice connection from the audio source. `bot.joinVoice(serverId, channelId, options?)` creates the server's appropriate P2P or SFU connection; the bot maintains the queue and publication clock. Decoding may belong to its own local source or an authorized capability on a participant's client. Text-only bots do not need to start media connections.

The bot joins with its personal mute and deafen states off; existing administrative restrictions still apply. The current SDK transmits audio but does not yet offer an API to receive participants' voices ([#642](https://github.com/MonkyOrg/Monky/issues/642)). That limitation is not represented as the bot choosing to deafen itself.

Declare `voiceRequirement: 'joined'` for commands that require voice, or `'same-bot-channel'` when callers must also share the bot's room if it has already joined voice. Omitting this field preserves ordinary command behavior. Client and server apply the rule to execution, autocomplete and previews; the server checks that exact person's connection, not another device on the same account. Leaving or moving cancels pending work and invalidates choices/previews without retargeting the request to another room. An independent bot-hosted source does not belong to the invocation lifetime; a client-delegated stream, however, depends on its executor's voice presence.

Command contexts contain server-authenticated `invokerSessionId` and `invokerVoiceChannelId`. They describe the initial execution; the latter is `null` when the connection invoking the command is not in voice. **The field is not a live getter.** After a search, form, or other wait, use `await ctx.getVoiceChannel()` to query the original connection's current room from the server. Do not look up the room by `invokerId` alone: the same person may be connected on two devices in different rooms.

```ts
bot.command({
  name: 'join',
  description: 'Join your voice room',
  voiceRequirement: 'same-bot-channel',
  handler: async (ctx) => {
    const channelId = await ctx.getVoiceChannel();
    if (channelId === null) {
      ctx.reply(ctx.locale === 'en' ? 'Join a voice room first.' : 'Entre em uma sala de voz primeiro.');
      return;
    }
    await bot.joinVoice(ctx.serverId, channelId, { invocationId: ctx.invocationId });
    ctx.reply(ctx.locale === 'en' ? 'Connected to voice.' : 'Conectado à voz.');
  },
});
```

Pass `invocationId` when joining at a person's request: the server rechecks the connection, current room, and authorization, including private rooms. Moving or leaving between the query and join invalidates the request. This capability is voice-specific and does not grant general private-chat access. Joining without an invocation still requires the bot's own channel access. Before changing an existing queue, also revalidate the requesting person's room; finishing the command that started playback does not close the voice connection.

Use `bot.getVoiceConnection(serverId)` to obtain that server's connection and `await bot.leaveVoice(serverId)` to close it. Each connection exposes `channelId` and `humanParticipantCount`. The `voiceParticipantsChanged` event provides `{ serverId, channelId, humanParticipantCount }`; `voiceDisconnected` also includes a `reason`. Register listeners once and remove them when shutting down the bot.

`await connection.writeOpus(frame)` sends **one raw 20 ms Opus packet with a 48 kHz clock**, not an Ogg file, MP3, or PCM bytes. The source must extract packets and pace them instead of sending an entire file at once. Keep playback in a session independent of the command invocation and stop the source when leaving voice or losing the connection. `/pause` must suspend the source's progress; stopping transmission while it keeps reading would lose the playback position.

Transmission uses the same speaking indicator as other participants. The SDK publishes activity transitions, not one event per packet, and clears the indicator when transmission becomes idle, is suppressed, or ends. Each person may also mute the bot only for themselves: this does not change anyone else's audio, playback, or the queue.

When the source is paused or stopped, `connection.stopSpeaking()` clears the indicator immediately without closing the connection or changing mute preferences. This method does not replace pausing or stopping the audio source itself.

Administrative mute/deafen has different semantics: while the connection is restricted, `writeOpus()` validates and discards packets without transmitting them or raising a media failure. Continue pacing at 20 ms. In MonkyBot, the track and queue advance normally in silence; lifting the restriction restores sound at the current position. This does not undo a manual pause. Invalid packets, closed connections, and actual transport failures still produce errors.
