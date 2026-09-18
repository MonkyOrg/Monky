# Execução no cliente

Solicite operações conhecidas do Monky no computador de quem iniciou a ação,
em vez de executar código arbitrário. Parta do [tutorial](/bots-desenvolvimento)
e declare `commands` e `local_execution` em `requestedCapabilities`.

**Referência:** [LocalExecutionClient](/bots-api-midia#localexecutionclient),
[LocalRequestContext](/bots-api-midia#localrequestcontext),
[LocalTaskSpec](/bots-api-midia#localtaskspec),
[LocalOpusStream](/bots-api-midia#localopusstream) e
[erros tipados](/bots-api-midia#localexecutionerror).

## Exemplo: pesquisar sem iniciar reprodução

Este comando prepara a capacidade com consentimento, pesquisa metadados e
responde em privado. Ele não entra em voz, não monta uma fila e não inicia
streaming. A consulta tem no máximo 200 caracteres.

```ts
bot.command({
  name: 'search-local',
  description: 'Search public video metadata using your client',
  localCapabilities: ['youtube-audio'],
  options: [{ name: 'query', description: 'Search query', type: 'string', required: true }],
  localizations: {
    'pt-BR': {
      name: 'buscar-local',
      description: 'Pesquisa metadados de vídeos públicos pelo seu cliente',
      options: { query: { description: 'Consulta de pesquisa' } },
    },
  },
  handler: async (ctx) => {
    const en = ctx.locale === 'en';
    const query = ctx.args.query;
    if (typeof query !== 'string' || !query.trim() || query.trim().length > 200) {
      ctx.reply(en ? 'Use a query of 1–200 characters.' : 'Use uma consulta de 1 a 200 caracteres.');
      return;
    }
    const executor = bot.localExecution(ctx.serverId).executor({
      kind: 'invocation',
      invocationId: ctx.invocationId,
    });
    const result = await executor.execute(
      { operation: 'youtube.search', query: query.trim() },
      { signal: ctx.signal },
    );
    if (ctx.signal.aborted) return;
    ctx.reply(en
      ? `Found ${result.tracks.length} results. No audio has been played.`
      : `Encontrados ${result.tracks.length} resultados. Nenhum áudio foi reproduzido.`);
  },
});
```

Em autocomplete, o contexto é `{ kind: 'autocomplete', requestId }`; em
prévia, `{ kind: 'audio-preview', requestId }`. Use os IDs entregues ao
callback, não o ID original do renderer. Uma fonte retida usa
`{ kind: 'source', sourceContextId }` e tem duração própria.

## Execução local de capacidades

Essa infraestrutura pertence ao SDK e ao cliente, não exclusivamente ao MonkyBot. Um comando declara `localCapabilities: ['youtube-audio']` somente quando precisa de processamento local. Comandos de controle ou consulta de fila não devem pedir instalação apenas para poder executar.

Ao **selecionar o comando**, por clique ou teclado, o Monky inicia seus pré-requisitos antes de preencher parâmetros, pesquisar ou executar. Quando necessária, a autorização é solicitada **por bot, servidor, instalação e chave pública**, neste dispositivo. É possível negar, permitir até encerrar a conexão com o servidor ou manter a autorização até revogá-la. Nomes iguais não compartilham permissão. Apenas navegar pela lista não pede autorização. Fechar o comando ou trocar de canal cancela sua preparação; uma conclusão atrasada não executa o comando.

O pedido usa um modal com o visual do Monky, controlado pelo Main. Antes de permitir, ele descreve Node.js, yt-dlp e FFmpeg, a finalidade de cada ferramenta e o limite conservador de espaço adicional, separando arquivos já instalados de novos downloads. Após a aprovação, o **mesmo modal** acompanha a instalação: o download mostra bytes reais e uma barra; consulta, verificação e extração usam uma animação sem percentual inventado. Opções e progresso permanecem visíveis mesmo quando a descrição precisa rolar. O comando só é liberado após a preparação e a autorização serem concluídas.

Uma preparação concluída é reutilizada na mesma conexão, inclusive ao selecionar novamente o comando. Ao editar a busca, o compositor mostra o carregamento da pesquisa, não um novo aviso de instalação. Se a instalação falhar, **Tentar novamente** repete a preparação no mesmo modal, preservando a duração escolhida e reutilizando as ferramentas concluídas. Se uma limpeza anterior falhou, essa ação tenta limpar os arquivos retidos antes de instalar novamente, somente após confirmar que os processos nativos foram encerrados. Uma ferramenta inválida ou um bloqueio persistente continua impedindo a instalação; o erro e o número da tentativa ficam visíveis. Cancelar durante a instalação aguarda o encerramento e a limpeza; uma preparação que falha não grava uma nova permissão.

As tarefas continuam verificando a integridade dos executáveis antes do uso. O cliente reutiliza apenas o resultado do teste nativo de versão de uma geração já verificada neste processo; substituir arquivos, remover a ferramenta ou reiniciar o cliente exige um novo teste. Na música, o streaming local já consulta uma fonte atualizada e revalida o solicitante, então a fila não cria outra tarefa de consulta imediatamente antes dele. Pedidos de adicionar e pular recebem confirmação de processamento, e cada início de faixa tem um aviso de preparação antes de **Tocando**; o aviso de reprodução só aparece após o primeiro quadro enviado à voz.

Esperas de pesquisa, prévia, início do comando, resposta do bot, envio de formulários/seletores, download e cancelamento têm indicadores animados, preservando o texto localizado e os controles de cancelamento disponíveis. Os indicadores param ao concluir ou falhar e respeitam a preferência de movimento reduzido do sistema.

Em **Configurações → Ferramentas de bots**, a pessoa pode consultar ferramentas instaladas, versões, armazenamento, cache, permissões e tarefas. O atalho **Gerenciar permissões e ferramentas locais** nas configurações do bot abre essa seção pessoal, não uma permissão administrativa do servidor.

**Remover ferramenta** e **Limpar cache** também usam uma confirmação com o visual do Monky, sem diálogo nativo do sistema. O mesmo modal mostra o andamento, permite tentar novamente em caso de falha e só fecha após a operação terminar. É possível desistir antes de confirmar; após confirmar, a limpeza precisa concluir o encerramento das tarefas. A aba libera as demais ações assim que a operação termina, sem ficar presa à atualização do inventário; leituras sem resposta exibem um erro que permite atualizar novamente.

- **Ferramentas:** Node.js, yt-dlp e FFmpeg portáteis são obtidos de receitas conhecidas pelo Monky, com verificação de integridade. Não é uma instalação global nem uma alteração do `PATH` da pessoa.
- **Compartilhamento:** bots podem reutilizar os mesmos arquivos instalados; suas autorizações continuam separadas.
- **Revogação e remoção:** interrompem o trabalho afetado. Remover uma ferramenta revoga as capacidades que dependem dela; o bot não pode reinstalá-la silenciosamente.
- **Limpar cache:** interrompe as tarefas locais, mas mantém ferramentas e permissões. O espaço exibido é o armazenamento efetivamente retido, não o total de áudio já transmitido.

::: warning Limites de confiança e conectividade
O processo separado melhora o isolamento de ciclo de vida, mas **não é uma sandbox do sistema operacional**. O SDK solicita operações fixas; não recebe uma API de shell, caminhos executáveis ou scripts enviados pelo bot. O consentimento é validado no Main do Electron, não concedido por uma preferência do renderer.

A transmissão precisa de um canal WebRTC privado entre cliente e bot, mesmo quando a sala usa SFU. Uma chamada SFU funcionando não comprova que esse caminho privado está acessível. A configuração ICE autorizada pelo servidor é reutilizada; não há ativação automática de TURN, áudio por WebSocket ou substituição do executor se a conexão falhar.
:::

### Contratos do SDK

`BotClient` implementa `LocalExecutionProvider`: obtenha o cliente de execução com `const client = bot.localExecution(serverId)`. Os contratos públicos `LocalExecutionClient`, `LocalExecutor` e `LocalOpusStream` separam a origem autorizada, cada tarefa e o relógio de reprodução:

| Operação | Responsabilidade |
|----------|------------------|
| `bot.localExecution(serverId)` | Seleciona a conexão do servidor, sem selecionar outro usuário |
| `client.executor(context)` | Usa uma invocação, autocomplete, prévia ou referência de fonte autorizada |
| `executor.execute(spec, { signal })` | Executa `youtube.search`, `youtube.resolve` ou `youtube.preview` |
| `client.retainSource(invocationId, url, { signal })` | Retém a origem e a URL canônica de um item a partir de uma invocação real |
| `client.checkSourceAvailability(sourceContextId, voiceChannelId, { signal })` | Confirma a presença e o acesso da conexão original, sem iniciar uma tarefa no cliente |
| `executor.stream(spec, { voiceChannelId, signal })` | Abre uma nova tarefa `youtube.stream` para a sala atual |
| `client.releaseSource(sourceContextId)` | Libera a referência de um item removido ou concluído |

Nos contextos de autocomplete e prévia, `requestId` é o identificador remapeado pelo servidor entregue ao callback do SDK. A prévia retornada pode conter outro `requestId`, da solicitação original do cliente: devolva o `LocalWirePreviewResult` sem reescrever seus campos. Ele contém somente referências; o Ogg permanece no cliente de origem. Metadados `LocalMediaTrack` não têm `audioUrl`, e o token de autorização do Main nunca faz parte das mensagens de comando.

Uma referência retida não é uma tarefa ativa. Não mantenha o `AbortSignal` da invocação como duração da reprodução, nem use outra sessão da mesma conta após uma desconexão. Cada reprodução abre uma tarefa nova, sujeita à autorização e à presença atuais.

Para retomar entradas aguardando o solicitante, use `checkSourceAvailability()`: o servidor verifica a fonte retida, a conexão física original, a sala e o acesso atual. O sucesso não instala ferramentas, não abre transporte e não substitui o consentimento ou a admissão do próximo stream. Uma saída e volta à voz na mesma conexão pode tornar a fonte disponível; reconectar o cliente não reativa referências da conexão encerrada, mesmo reutilizando o mesmo `invokerSessionId`. Eventos `voiceParticipantsChanged` podem disparar consultas sequenciais e agrupadas, mas a contagem de pessoas, um comando recente ou outra sessão nunca são autorização.

O stream fornece pacotes Opus em `frames`. O bot mantém a cadência de 20 ms e chama `markFrameAdvanced()` **uma vez por quadro consumido pelo seu relógio**, depois de `writeOpus()`. Prefetch, crédito de recepção e chegada de bytes não são avanço de reprodução. Aguarde `setPaused()` e observe `stream.signal` também enquanto a fila estiver pausada. `LocalExecutionError.event` distingue falha, saída da voz, desconexão e revogação; decidir avisos e mudanças na fila continua sendo responsabilidade do bot.

Uma recusa antes da admissão da tarefa, ou em uma operação de referência/controle, usa `LocalExecutionRpcError`. Consulte `code` e, quando presentes, `reason` ou `cancellationCause`; esse erro não inventa um evento de tarefa. Não trate uma recusa de consentimento ou uma falha de transporte como erro de autenticação do provedor.

O fim do decoder não significa que o último quadro já foi consumido. Preserve a cauda até as confirmações finais: `stream.closed` resolve somente após a drenagem de reprodução e a conclusão confirmada pelo servidor, e rejeita em falha ou cancelamento. Aguarde `stream.close()` para cancelar trabalho ativo ou aguardar a conclusão de um stream já drenado; a rejeição de `closed` por si só não substitui o encerramento. Encerrar um stream não libera automaticamente a referência de sua fonte. No cliente, o processo nativo pode terminar antes das confirmações de reprodução, sem perder a possibilidade de cancelar ou revogar a tarefa restante.

Usar o computador do solicitante não garante que o provedor aceite uma requisição. A capacidade inicial aceita somente vídeos públicos individuais elegíveis do YouTube, sem contas, cookies ou contorno de restrições. Recusas do provedor permanecem erros explícitos.

### Validação integrada no checkout

O modal e a indicação de busca têm regressões próprias em `npm run test:local-execution --workspace=@monky/client`. Para exercitar só apresentação, decisões, progresso e cancelamento do modal, use `npm run test:local-preparation --workspace=@monky/client`. Seu preload é um bundle isolado, gerado também pelo build normal, para manter `sandbox: true` sem expor uma API genérica ao documento.

Depois do build do Monky, o teste abaixo inicia servidor, SDK e dois clientes Electron isolados, em salas P2P e SFU reais. Ele mede áudio decodificado no ouvinte e verifica consentimento, mute/PTT, pausa, saída da voz, drenagem final e encerramento dos recursos. Não reutiliza perfis ou servidores pessoais.

```powershell
$env:MONKY_WORKER_TEST_FFMPEG = 'C:\caminho\ffmpeg.exe'
npm run test:local-execution:e2e --workspace=@monky/client
```

Para exercitar também o **registro de comandos de produção do MonkyBot**, faça o build do bot com o SDK compatível instalado e, na raiz do Monky, defina o checkout dele:

```powershell
$env:MONKY_LOCAL_E2E_MUSIC_BOT_ROOT = 'C:\caminho\MonkyBot'
npm run test:local-execution:e2e --workspace=@monky/client
Remove-Item Env:\MONKY_LOCAL_E2E_MUSIC_BOT_ROOT
```

Esse modo carrega o SDK realmente instalado no bot e percorre busca, prévia, `/play`, fila mista, `/pause`, retorno do solicitante e `/skip` pela interface. Ambos os modos usam áudio autoral controlado: não acessam o YouTube nem comprovam que o provedor aceitará uma requisição real.
