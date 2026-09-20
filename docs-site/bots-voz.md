# Publicar e receber voz

Este guia é para transmitir e receber áudio que seu bot está autorizado a
usar. Parta do [tutorial](/bots-desenvolvimento) e solicite `commands` e
as capacidades necessárias: `publish_voice`, `receive_voice` ou ambas.
Consentimento para [execução no cliente](/bots-execucao-local) é uma
autorização adicional, não uma consequência de entrar em voz.

**Referência:** [BotVoiceConnection](/bots-api-midia#botvoiceconnection),
[BotVoiceJoinOptions](/bots-api-midia#botvoicejoinoptions) e
[ciclo de vida](/bots-api#duracao-e-limpeza).

## Voz para bots

O SDK separa a conexão de voz da fonte de áudio. `bot.joinVoice(serverId, channelId, options?)` cria a conexão P2P ou SFU apropriada ao servidor; o bot mantém a fila e o ritmo de publicação. A decodificação pode pertencer à sua fonte local ou a uma capacidade autorizada no cliente de um participante. Bots de texto não precisam iniciar conexões de mídia.

O bot entra com os estados pessoais de mute e deafen desligados; restrições administrativas existentes continuam valendo. Receber microfones exige aprovação independente de `receive_voice` e `receiveAudio: true` ao entrar. O padrão continua sendo publicar sem ouvir; ausência de permissão não é confundida com deafen pessoal.

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

## Receber microfones

Solicite `receive_voice` em `requestedCapabilities` e obtenha a aprovação em
**Configurações do bot → Permissões no servidor**. Entre com
`await bot.joinVoice(serverId, channelId, { receiveAudio: true, invocationId })`
e use `connection.receiveAudio({ signal })`. Existe um único iterador por
conexão; não há entrega à aplicação antes de criá-lo. Trocar o opt-in exige
sair e entrar novamente, mas pausar/retomar a escuta não exige reconectar.

Cada [BotVoicePacket](/bots-api-midia#botvoicepacket) contém:

| Campo | Significado |
| --- | --- |
| `channelId`, `userId`, `sessionId` | Sala, identidade e conexão de origem autenticadas; dois dispositivos da mesma conta têm sessões distintas |
| `opus` | Cópia de um pacote Opus bruto, sem RTP, Ogg ou mistura de participantes; não é PCM |
| `codec`, `clockRate`, `channels` | `opus`, relógio RTP de `48000` Hz e formato negociado de `2` canais |
| `sequenceNumber`, `timestamp`, `ssrc` | Sequência RTP de 16 bits, timestamp RTP de 32 bits e identificador da fonte; podem reiniciar numa nova fonte e os contadores dão a volta |
| `receivedAt` | Milissegundos monotônicos do processo do bot, não data/hora nem relógio RTP |

A recepção aceita a duração real dos pacotes Opus; a restrição de **20 ms**
pertence à publicação por `writeOpus()`. Entrega é ao vivo, sem garantia de
retransmissão, ordenação ou áudio sem perdas. A fila comporta **100 pacotes
no total**; se a aplicação ficar para trás, descarta os mais antigos e
incrementa `receiver.droppedPackets`. Não acumule uma segunda fila sem
limite e aguarde cada `next()` antes de pedir outro.

O transporte entrega somente microfones humanos da mesma sala, em P2P e
SFU. Outros bots, câmera, tela, áudio de tela, Soundboard e prévias privadas
não fazem parte dessa API. Mute da fonte descarta também seus pacotes
pendentes. No SFU, produtores de microfone são pausados pelo servidor.

### Exemplo mínimo: receber e responder

No projeto criado pelo CLI, declare
`requestedCapabilities: ['commands', 'receive_voice', 'publish_voice']`
e registre o comando abaixo. **Use fones em uma sala de teste**: ele devolve
até um segundo do microfone de quem chamou, sem IA, serviço pago ou arquivo.
É uma demonstração de ida e volta com os pacotes de **20 ms** do cliente
Monky; outra duração gera erro explícito de publicação e requer
decodificar/reencodar no formato de saída, não concatenar pacotes.

```ts
bot.command({
  name: 'voice-demo',
  description: 'Teste de ida e volta de voz',
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

Em um bot real, a resposta pode vir de outra fonte Opus autorizada, no
ritmo de 20 ms. Recepção e publicação funcionam simultaneamente na mesma
conexão; o SDK não interpreta, mistura nem grava os pacotes.

### PCM opcional

Para obter PCM, adicione um decoder **ao projeto do seu bot**, não ao
cliente Monky: `npm install opus-decoder`. Essa biblioteca opcional usa
libopus em WebAssembly, sem serviço externo. Por exemplo, para uma única
sessão selecionada:

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
      // pcm.channelData contém um Float32Array por canal, sem intercalar.
    }
  } finally {
    decoder.free();
  }
}
```

Use um decoder independente por fonte `(sessionId, ssrc)` se consumir
várias pessoas; libere cada um quando a fonte terminar. O exemplo imprime
somente metadados, não amostras de áudio. Bytes Opus concatenados não são
um arquivo Ogg/WAV nem uma entrada PCM para FFmpeg.

### Pausa, cancelamento e privacidade

`await voice.setMuted(true)` controla a transmissão, sem desligar a escuta.
`await voice.setDeafened(true)` interrompe a recepção e limpa a fila;
`setDeafened(false)` a restabelece, respeitando restrições administrativas.
Deafen também mantém a transmissão silenciada, como no restante do Monky.
O transporte SFU de publicação não é recriado nessas mudanças.

`break`, `receiver.return()` ou abortar o `signal` encerra o iterador e
coloca o bot em deafen, sem sair da sala. Para um novo iterador, aguarde
`receiver.return()`, chame `setDeafened(false)` e depois `receiveAudio()`.
`voice.close()`, saída, expulsão, revogação, mudança de canal/modo ou perda
de conexão encerram a recepção e liberam recursos. Falhas de transporte
são notificadas no evento `error` do bot; encerre suas próprias fontes,
decoders e listeners também.

`receivesAudio` informa o opt-in da conexão; `isReceivingAudio` informa
se a recepção está habilitada naquele momento, não se alguém está falando.
A interface mostra **Ouvindo vozes** nesse estado e usa os ícones
de proibição quando uma direção foi solicitada, mas não concedida.
Não solicitar publicação ou recepção não gera esse ícone. Mute/deafen
administrativo continua mostrando o bloqueio, mesmo com a capacidade
concedida; retirar a restrição não altera a permissão do bot. Mutar o bot
somente na reprodução local não revoga sua autorização de escuta.

O SDK não persiste, transcreve nem envia áudio a provedores de IA. O operador
é responsável por informar qualquer processamento e retenção que adicionar
e por cumprir os consentimentos e as regras de privacidade aplicáveis.

**Compatibilidade:** esta API requer protocolo **22**. Cliente, servidor e
bots devem ser atualizados juntos; a mudança exige release major.
Nenhuma permissão de escuta é concedida automaticamente a bots existentes.
