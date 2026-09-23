# Publish and receive voice

Use this guide to transmit and receive audio your bot is authorized to use.
Start with the [tutorial](/en/bots-desenvolvimento) and request `commands`
and the capabilities you need: `publish_voice`, `receive_voice` or both.
[Client-side execution consent](/en/bots-execucao-local) is an additional
authorization, not a consequence of joining voice.

**Reference:** [BotVoiceConnection](/en/bots-api-midia#botvoiceconnection),
[BotVoiceJoinOptions](/en/bots-api-midia#botvoicejoinoptions) and
[lifecycle](/en/bots-api#lifetimes-and-cleanup).

## Bot voice

The SDK separates the voice connection from the audio source. `bot.joinVoice(serverId, channelId, options?)` creates the server's appropriate P2P or SFU connection; the bot maintains the queue and publication clock. Decoding may belong to its own local source or an authorized capability on a participant's client. Text-only bots do not need to start media connections.

The bot joins with its personal mute and deafen states off; existing administrative restrictions still apply. Receiving microphones requires independent approval of `receive_voice` and joining with `receiveAudio: true`. The default remains publishing without listening; missing permission is not confused with personal deafen.

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

## Receive microphones

Request `receive_voice` in `requestedCapabilities` and obtain approval in
**Bot settings → Server permissions**. Join using
`await bot.joinVoice(serverId, channelId, { receiveAudio: true, invocationId })`
and call `connection.receiveAudio({ signal })`. There is one iterator per
connection; nothing is delivered to the application before creating it.
Changing the opt-in requires leaving and joining again, but pausing and
resuming reception does not require rejoining.

Each [BotVoicePacket](/en/bots-api-midia#botvoicepacket) contains:

| Field | Meaning |
| --- | --- |
| `channelId`, `userId`, `sessionId` | Authenticated room, identity and source connection; two devices on the same account have different sessions |
| `opus` | An owned copy of a raw Opus packet, without RTP, Ogg or participant mixing; not PCM |
| `codec`, `clockRate`, `channels` | `opus`, a `48000` Hz RTP clock and a negotiated `2`-channel format |
| `sequenceNumber`, `timestamp`, `ssrc` | 16-bit RTP sequence, 32-bit RTP timestamp and source identifier; they may restart for a new source and counters wrap |
| `receivedAt` | Monotonic milliseconds in the bot process, not wall-clock or RTP time |

Reception accepts the actual Opus packet duration; the **20 ms** restriction
belongs to publication through `writeOpus()`. Delivery is live, without
guaranteed retransmission, ordering or loss-free audio. The queue holds
**100 packets in total**; when the application falls behind, it drops the
oldest and increments `receiver.droppedPackets`. Do not create another
unbounded queue, and await each `next()` before requesting another.

The transport delivers only human microphones from the same room in P2P
and SFU. Other bots, cameras, screens, screen audio, Soundboard and private
previews are excluded. Muting a source also discards its pending packets.
In SFU mode, the server pauses microphone producers.

### Minimal example: receive and respond

In the CLI-created project, declare
`requestedCapabilities: ['commands', 'receive_voice', 'publish_voice']`
and register the command below. **Use headphones in a test room**: it echoes
up to one second of the caller's microphone without AI, paid services or
files. This roundtrip demo uses the Monky client's **20 ms** packets;
other durations produce an explicit publication error and require
decoding/re-encoding to the output format, not concatenating packets.

```ts
bot.command({
  name: 'voice-demo',
  description: 'Voice roundtrip demo',
  voiceRequirement: 'same-bot-channel',
  handler: async (ctx) => {
    const channelId = await ctx.getVoiceChannel();
    if (channelId === null) {
      ctx.reply(ctx.locale === 'en' ? 'Join a voice room first.' : 'Entre em uma sala de voz primeiro.');
      return;
    }
    const voice = await bot.joinVoice(ctx.serverId, channelId, {
      invocationId: ctx.invocationId, receiveAudio: true,
    });
    try {
      const receiver = voice.receiveAudio({ signal: AbortSignal.timeout(10_000) });
      let replied = 0;
      for await (const packet of receiver) {
        if (packet.sessionId !== ctx.invokerSessionId) continue;
        await voice.writeOpus(packet.opus);
        if (++replied === 50) break;
      }
      ctx.reply(ctx.locale === 'en' ? 'Voice demo finished.' : 'Teste de voz encerrado.');
    } finally {
      await voice.close();
    }
  },
});
```

In a real bot, the response can come from another authorized Opus source,
paced at 20 ms. Reception and publication work simultaneously on the same
connection; the SDK does not interpret, mix or record the packets.

### Optional PCM

To obtain PCM, add a decoder **to your bot project**, not the Monky client:
`npm install opus-decoder`. This optional library runs libopus in
WebAssembly without an external service. For one selected session:

```ts
import { OpusDecoder } from 'opus-decoder';
import type { BotVoiceConnection } from '@monky/bot-sdk';

async function inspectPcm(voice: BotVoiceConnection, sessionId: string) {
  const decoder = new OpusDecoder({ sampleRate: 48000, channels: 2 });
  try {
    await decoder.ready;
    let previousSsrc: number | undefined;
    for await (const packet of voice.receiveAudio({ signal: AbortSignal.timeout(10_000) })) {
      if (packet.sessionId !== sessionId) continue;
      if (previousSsrc !== undefined && previousSsrc !== packet.ssrc) await decoder.reset();
      previousSsrc = packet.ssrc;
      const pcm = decoder.decodeFrame(packet.opus);
      if (pcm.errors.length) throw new Error(pcm.errors.map(error => error.message).join('; '));
      console.info({ sampleRate: pcm.sampleRate, samples: pcm.samplesDecoded, channels: pcm.channelData.length });
      // pcm.channelData contains one non-interleaved Float32Array per channel.
    }
  } finally {
    decoder.free();
  }
}
```

Use a separate decoder per `(sessionId, ssrc)` source when consuming multiple
people, and free each decoder when its source ends. The example prints only
metadata, not audio samples. Concatenated Opus bytes are not an Ogg/WAV file
or PCM input for FFmpeg.

### Pause, cancellation and privacy

`await voice.setMuted(true)` controls transmission without stopping reception.
`await voice.setDeafened(true)` stops reception and clears the queue;
`setDeafened(false)` restores it, subject to administrative restrictions.
Deafen also suppresses transmission, as elsewhere in Monky.
These changes do not recreate the SFU publication transport.

`break`, `receiver.return()` or aborting `signal` ends the iterator and
deafens the bot without leaving the room. To create another iterator, await
`receiver.return()`, call `setDeafened(false)` and then `receiveAudio()`.
`voice.close()`, departure, removal, revocation, a channel/mode change or
disconnection ends reception and releases resources. Transport failures
are reported through the bot's `error` event; also shut down your own
sources, decoders and listeners.

`receivesAudio` reports the connection's opt-in; `isReceivingAudio` reports
whether reception is currently enabled, not whether someone is speaking.
The UI shows **Listening to voices** in that state and uses block icons
when a direction was requested but not granted. An unrequested publishing
or receiving capability does not show a block icon. Administrative
mute/deafen still shows the block even with the capability granted;
lifting the restriction does not change the bot's permission. Muting a bot
only in local playback does not revoke its listening authorization.

The SDK does not persist, transcribe or send audio to AI providers.
Operators must disclose any processing and retention they add and comply
with applicable consent and privacy requirements.

**Compatibility:** this API requires protocol **22**. Client, server and
bots must be updated together; the change requires a major release.
Existing bots are never granted listening permission automatically.
