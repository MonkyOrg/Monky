# Publicar áudio na voz

Este guia é para transmitir áudio que seu bot está autorizado a usar.
Parta do [tutorial](/bots-desenvolvimento) e solicite `commands` e
`publish_voice`. Consentimento para [execução no cliente](/bots-execucao-local)
é uma autorização adicional, não uma consequência de entrar em voz.

**Referência:** [BotVoiceConnection](/bots-api-midia#botvoiceconnection),
[BotVoiceJoinOptions](/bots-api-midia#botvoicejoinoptions) e
[ciclo de vida](/bots-api#duracao-e-limpeza).

## Voz para bots

O SDK separa a conexão de voz da fonte de áudio. `bot.joinVoice(serverId, channelId, options?)` cria a conexão P2P ou SFU apropriada ao servidor; o bot mantém a fila e o ritmo de publicação. A decodificação pode pertencer à sua fonte local ou a uma capacidade autorizada no cliente de um participante. Bots de texto não precisam iniciar conexões de mídia.

O bot entra com os estados pessoais de mute e deafen desligados; restrições administrativas existentes continuam valendo. O SDK atual transmite áudio, mas ainda não oferece uma API para receber a voz dos participantes ([#642](https://github.com/MonkyOrg/Monky/issues/642)). Essa limitação não é representada como um deafen escolhido pelo bot.

Declare `voiceRequirement: 'joined'` em comandos que exigem voz ou `'same-bot-channel'` quando também é necessário estar na sala do bot, caso ele já esteja conectado à voz. Sem esse campo, os comandos mantêm o comportamento normal. Cliente e servidor aplicam a regra à execução, ao autocomplete e à prévia; o servidor usa a conexão exata da pessoa, não outro dispositivo da mesma conta. Sair ou mudar de sala cancela o trabalho pendente e invalida escolhas/prévias, sem transferir o pedido para outra sala. Uma fonte independente hospedada no bot não pertence à duração da invocação; um stream delegado ao cliente, porém, depende da presença de seu executor na voz.

O contexto de comando contém `invokerSessionId` e `invokerVoiceChannelId` autenticados pelo servidor. Eles descrevem a execução inicial; o segundo é `null` quando a conexão que chamou o comando não está em voz. **O campo não é um getter vivo.** Depois de uma busca, formulário ou outra espera, use `await ctx.getVoiceChannel()` para consultar novamente a sala da conexão original no servidor. Não procure a sala somente por `invokerId`: a mesma pessoa pode estar conectada em dois dispositivos, em salas diferentes.

```ts
bot.command({
  name: 'join',
  description: 'Entra na sua sala de voz',
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

Passe `invocationId` ao entrar pela solicitação de uma pessoa: o servidor confirma novamente a conexão, a sala atual e a autorização, inclusive para salas privadas. Trocar ou sair de sala entre a consulta e a entrada invalida o pedido. Essa capacidade é específica da voz e não dá acesso geral ao chat privado. A entrada sem invocação continua exigindo o acesso do próprio bot ao canal. Antes de alterar uma fila existente, revalide também a sala de quem solicitou a ação; terminar o comando que iniciou a reprodução não encerra a conexão de voz.

Use `bot.getVoiceConnection(serverId)` para obter a conexão daquele servidor e `await bot.leaveVoice(serverId)` para encerrá-la. Cada conexão expõe `channelId` e `humanParticipantCount`. O evento `voiceParticipantsChanged` entrega `{ serverId, channelId, humanParticipantCount }`; `voiceDisconnected` também informa o motivo em `reason`. Registre listeners uma vez e remova-os ao encerrar o bot.

`await connection.writeOpus(frame)` transmite **um pacote Opus bruto de 20 ms, com relógio de 48 kHz**, não um arquivo Ogg, MP3 ou bytes PCM. A fonte deve extrair os pacotes e enviá-los no ritmo de reprodução, sem descarregar o arquivo inteiro de uma vez. Mantenha a reprodução em uma sessão independente da invocação e interrompa a fonte ao sair da voz ou perder a conexão. `/pause` deve suspender o avanço da fonte; simplesmente parar de transmitir enquanto ela continua lendo perderia a posição.

A transmissão usa o mesmo indicador de fala dos demais participantes. O SDK publica mudanças de atividade, não um evento por pacote, e limpa o indicador quando a transmissão fica ociosa, é silenciada ou termina. Cada pessoa também pode mutar o bot apenas para si: isso não muda o áudio dos demais nem a reprodução ou a fila.

Quando a fonte for pausada ou encerrada, `connection.stopSpeaking()` limpa o indicador imediatamente, sem fechar a conexão nem alterar preferências de mute. Esse método não substitui pausar ou encerrar a própria fonte de áudio.

Mute/deafen administrativo tem outra semântica: enquanto a conexão estiver bloqueada, `writeOpus()` valida e descarta os pacotes, sem enviá-los nem gerar uma falha de mídia. Continue respeitando a cadência de 20 ms. No MonkyBot, a música e a fila avançam normalmente em silêncio; liberar o bloqueio devolve o som na posição atual. Uma pausa manual não é desfeita por essa mudança. Pacotes inválidos, conexões encerradas e falhas reais de transporte continuam produzindo erros.
