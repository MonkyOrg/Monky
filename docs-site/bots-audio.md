# Prévias e downloads de áudio

Prévia, download e publicação em voz são operações distintas. Os exemplos
complementam o [primeiro bot](/bots-desenvolvimento): declare `commands`,
e também `sound_download` para comandos com `downloadsSound`.
Para uma transmissão na chamada, use o [guia de voz](/bots-voz).

**Referência:** [AudioPreviewSource](/bots-api-interacoes#audiopreviewsource),
[CommandAudioPreviewContext](/bots-api-cliente#commandaudiopreviewcontext),
[SoundDownloadRequest](/bots-api-interacoes#sounddownloadrequest) e
[SoundDownloadResult](/bots-api-interacoes#sounddownloadresult).

## Seleção com prévia de áudio

Qualquer plugin pode acrescentar `audio` a uma `SelectionChoice`. A variante `audio.url` funciona em escolhas estáticas de comandos, respostas de autocomplete, campos `select` de `ctx.prompt()`, `ctx.choose()` e seletores persistentes de `createSelector()`. A variante sob demanda, `audio.resourceId`, é destinada às escolhas do autocomplete atual. Sem `audio`, a opção continua sendo uma seleção comum; não é preciso criar um componente específico para cada bot.

```ts
import type { SelectionChoice } from '@monky/bot-sdk';

const choices: SelectionChoice[] = [
  {
    label: 'Bell',
    value: 'bell',
    description: 'Short bell sound',
    audio: {
      url: 'https://cdn.example.com/sounds/bell.mp3',
      fileName: 'bell.mp3',
      durationMs: 1200,
    },
  },
];
```

Na variante acima, `audio.url` é obrigatório; `fileName` e `durationMs` são opcionais. A prévia usa HTTPS público e os mesmos formatos e limite de 3 MiB do download. O cliente carrega os bytes em memória pelo processo nativo, validando DNS, redirecionamentos, MIME e estrutura do áudio; não usa a URL externa diretamente no player do renderer. Essa variante continua funcionando sem mudanças, inclusive para fontes como MyInstants.

As opções podem ter descrição, botão de prévia e barra de progresso com tempo decorrido/duração. Há **um controle de volume compartilhado (0–100%) por comando**, mantido ao trocar resultados ou parâmetros, com porcentagem visível. Formulários com vários campos de áudio também usam um único controle; seletores persistentes têm seu próprio volume. Ouvir ou ajustar o volume **não seleciona, envia nem baixa o arquivo para a biblioteca**. Só uma prévia toca por vez, localmente, na saída de mídia do chat (ou na saída geral quando não há configuração avançada específica); mudanças dessa saída também se aplicam à prévia em andamento, e nada é transmitido ao canal de voz. Fechar ou trocar o seletor interrompe carregamento/reprodução e libera os recursos. A prévia não exige pasta configurada. Sugestões aparecem num painel rolável acima do compositor; os campos abaixo se ajustam ao placeholder/conteúdo, respeitam a largura disponível e destacam foco ou valores inválidos. Parâmetros opcionais podem ser removidos pelo **×**, sem perder o rascunho.

### Áudio gerado somente ao ouvir

Quando a fonte não oferece um pequeno arquivo HTTPS público, retorne `audio: { resourceId, fileName?, durationMs? }` no autocomplete e declare `audioPreview` no comando. **Nunca combine `url` e `resourceId`.** `resourceId` tem até 128 caracteres; ele identifica um recurso do provider, não uma URL para o cliente buscar.

O exemplo lê um arquivo **autoral, com no máximo 10 segundos e 256 KiB**, que você deve fornecer em `audio/bell.ogg` ao lado do módulo. Para gerar clipes dinamicamente, substitua somente o corpo de `loadPreview`: obtenção dos bytes, resolução da mídia e conversão devem acontecer no processo do bot, respeitando o `signal`, nunca durante o autocomplete. A busca de metadados continua no callback `autocomplete`.

```ts
import { readFile } from 'node:fs/promises';
import type { CommandAudioPreviewContext, CommandAudioPreviewData } from '@monky/bot-sdk';

const previews = new Map([
  ['bell', { label: 'Bell', file: new URL('./audio/bell.ogg', import.meta.url) }],
]);

async function loadPreview(ctx: CommandAudioPreviewContext): Promise<CommandAudioPreviewData> {
  const source = previews.get(ctx.resourceId);
  if (!source) throw new Error('Unknown preview resource');
  return { bytes: await readFile(source.file, { signal: ctx.signal }), mimeType: 'audio/ogg' };
}

bot.command({
  name: 'preview-sample',
  description: 'Choose an audio sample',
  options: [{ name: 'sound', description: 'Sound', type: 'string', required: true, autocomplete: true }],
  autocomplete: ({ query }) => [...previews].filter(([, source]) =>
    source.label.toLowerCase().includes(query.toLowerCase())
  ).map(([id, source]) => ({
    label: source.label, value: id,
    audio: { resourceId: id, fileName: `${id}.ogg`, durationMs: 10_000 },
  })),
  audioPreview: loadPreview,
  handler: (ctx) => {
    if (typeof ctx.args.sound !== 'string' || !previews.has(ctx.args.sound)) throw new Error('Unknown sample');
    ctx.reply(`Selected: ${ctx.args.sound}`);
  },
});
```

`CommandDefinition.audioPreview` aceita um retorno direto ou uma `Promise<CommandAudioPreviewData>`. O contexto exportado `CommandAudioPreviewContext` contém `resourceId`, `serverId`, `optionName`, `locale` (`'pt-BR' | 'en'`), `signal` e `settings` imutável, capturado na mesma busca. Não contém invocação, fila, métodos de publicação ou download. `CommandAudioPreviewData` contém apenas `bytes: Uint8Array` (um `Buffer` também serve) e `mimeType: 'audio/ogg' | 'audio/mpeg' | 'audio/wav'`.

- Só o botão de ouvir chama o provider. Digitar, navegar ou selecionar não gera o clipe; ouvir não executa o comando nem modifica a fila.
- O transporte usa o **WebSocket já autenticado**, pessoa → servidor → bot → pessoa. Não exige `serve()`, hospedagem pública, URL assinada ou porta adicional. O servidor troca os IDs do provider por tokens efêmeros vinculados à mesma pessoa, dispositivo, canal, bot, comando, opção e busca; apenas escolhas anunciadas e ainda válidas podem ser ouvidas.
- O prazo de geração é **30 segundos**; o limite é **256 KiB de bytes** (base64 somente no transporte) e **10 segundos de reprodução**. O processo nativo valida MIME, tamanho e estrutura antes de criar a fonte local do player. Isso não relaxa as proteções HTTPS/DNS/redirecionamento da variante URL.
- As escolhas lazy expiram após **60 segundos**, ou antes ao mudar a consulta/opção/comando, fechar, perder acesso, alterar configurações ou desconectar. Trocar de prévia cancela a anterior. Propague `signal` também para subprocessos e libere seus recursos.
- Há até **4 providers simultâneos por `BotClient`** e 100 solicitações pendentes por servidor. Um provider que ignora o abort continua ocupando sua vaga até concluir. Erros, timeout, bytes vazios, MIME inválido e excesso de tamanho retornam falha explícita; erros lançados pelo provider também chegam ao evento `error` do SDK.

## Downloads locais autorizados

Declare `downloadsSound: true` quando um comando puder pedir **um** download para a soundboard. O compositor informa essa capacidade, exige autorização por execução e bloqueia a ativação com um aviso se a pasta não estiver configurada ou autorizada. **Selecionar/executar o comando nunca abre o seletor de pastas.** Configure a pasta previamente nas configurações da soundboard; uma pasta já confirmada é reutilizada. Isso não concede ao bot uma permissão geral para acessar arquivos.

```ts
bot.command({
  name: 'download-sample',
  description: 'Download a soundboard sample',
  downloadsSound: true,
  handler: async (ctx) => {
    const result = await ctx.downloadSound({
      url: 'https://cdn.example.com/sounds/bell.mp3',
      fileName: 'bell.mp3',
      title: 'Bell',
    });
    if (result === null) return;
    const en = ctx.locale === 'en';
    switch (result.status) {
      case 'downloaded':
        ctx.reply(en ? 'Sound saved to your soundboard.' : 'Áudio salvo na sua soundboard.');
        break;
      case 'exists':
        ctx.reply(en ? 'That file already exists; nothing was replaced.' : 'O arquivo já existe; nada foi substituído.');
        break;
      case 'failed':
        ctx.reply(en ? `Download failed (${result.reason}).` : `Falha no download (${result.reason}).`);
        break;
      case 'cancelled':
        ctx.reply(en ? 'Download cancelled.' : 'Download cancelado.');
        break;
    }
  },
});
```

Substitua a URL de exemplo por um áudio público válido. Em um bot de catálogo, use o `value` selecionado para obter apenas URL, nome e título; **não baixe o áudio no bot**. `ctx.downloadSound()` encaminha a solicitação ao computador da conexão que iniciou o comando. O servidor e o bot/VPS não recebem o arquivo nem o caminho local, e outro dispositivo do mesmo usuário não herda a solicitação.

Antes de iniciar a transferência, o cliente pede confirmação do pedido real, mostrando bot, título, arquivo, pasta e origem. Nesse mesmo diálogo, a pessoa pode **alterar o nome do arquivo**, com o nome original preenchido e a extensão preservada. Nomes inválidos bloqueiam a confirmação; arquivos existentes nunca são sobrescritos. O nome escolhido aparece no card local, mas não é enviado ao bot/servidor. O switch **“Não perguntar novamente”** vale somente para esse bot, servidor/endereço e identidade neste perfil local; não autoriza outros plugins. Ao ativá-lo, os próximos downloads usam o nome sugerido pelo bot, sem repetir a confirmação ou reutilizar um nome personalizado anterior. Para reativar, use **botão direito no bot → Configurações do bot → Minhas preferências → Perguntar o nome antes de baixar** e salve. Essa alteração não restaura nem modifica as confirmações de outros bots. Recusar devolve `cancelled`, sem gravar ou abrir o seletor de pastas. Cancelamento, desconexão e expiração também fecham uma confirmação pendente.

O chat mostra um card privado com identidade do bot/comando/usuário autenticada pelo servidor, estado de confirmação pendente e depois progresso real do cliente. Bytes e porcentagens permanecem locais; você não precisa enviar mensagens de progresso. A conclusão é baseada na gravação, não no término do handler.

O resultado, exportado como `SoundDownloadResult`, é discriminado por `status`:

| Status | Significado |
|--------|-------------|
| `downloaded` | O novo arquivo foi gravado |
| `exists` | O destino já existia e não foi alterado |
| `failed` | Falha tipada em `reason` |
| `cancelled` | Download local cancelado enquanto a invocação ainda existia |

`failed.reason` pode ser `no_folder`, `invalid_request`, `invalid_url`, `blocked_url`, `invalid_file_name`, `unsupported_audio`, `too_large`, `http_error`, `network_error`, `write_failed` ou `timeout`. Não há caminho, bytes ou erro bruto do sistema no resultado. `null` significa que a própria invocação terminou, expirou ou perdeu conexão; nesse caso, retorne do handler.

São aceitos HTTPS público, sem credenciais ou fragmentos, e nomes simples de arquivo de até 128 caracteres (`.mp3`, `.wav`, `.ogg`, `.m4a`, `.aac` ou `.webm`); `title` tem até 100 caracteres e a URL até 2.048. O cliente valida destinos/redirecionamentos, conteúdo e tamanho e nunca sobrescreve arquivos existentes. O limite é **3 MiB (3.145.728 bytes)**, o mesmo da reprodução, disponível em `LIMITS.MAX_SOUNDBOARD_FILE_SIZE` no shared e no SDK.

Sempre use `await`. Só é permitida uma solicitação por invocação, mesmo após `exists`, falha ou cancelamento; repetir exige uma nova execução autorizada. O pedido tem prazo de dois minutos, incluindo a espera pela confirmação e limitado também pelo prazo restante da invocação. Cancelar, desconectar ou encerrar o handler interrompe trabalho pendente. Contextos encerrados, comandos sem autorização e chamadas repetidas geram erro no SDK, sem iniciar outro download.
