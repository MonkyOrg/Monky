import type { BotClient, BotVoiceAudioReceiver, BotVoicePacket } from '../dist/index.js';

export function registerVoiceDemo(bot: BotClient): void {
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
        const receiver: BotVoiceAudioReceiver = voice.receiveAudio({ signal: AbortSignal.timeout(10_000) });
        let replied = 0;
        for await (const packet of receiver) {
          const typed: BotVoicePacket = packet;
          if (typed.sessionId !== ctx.invokerSessionId) continue;
          await voice.writeOpus(typed.opus);
          if (++replied === 50) break;
        }
        ctx.reply(ctx.locale === 'en' ? 'Voice demo finished.' : 'Teste de voz encerrado.');
        await voice.setMuted(true);
        await voice.setDeafened(true);
        // @ts-expect-error Queue accounting is controlled by the SDK.
        receiver.droppedPackets = 0;
        // @ts-expect-error The input is an AbortSignal, not an arbitrary option.
        voice.receiveAudio({ recording: true });
      } finally {
        await voice.close();
      }
    },
  });
}
