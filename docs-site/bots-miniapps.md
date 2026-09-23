# Miniapps compartilhados

Use uma tela quando vários participantes precisam acompanhar o mesmo estado.
Para uma pergunta individual, prefira [formulários privados](/bots-interacoes).
O exemplo complementa o [tutorial](/bots-desenvolvimento) e exige `commands`
e `miniapps`; ele não precisa de `publish_voice`.

**Referência:** [BotScreen](/bots-api-midia#botscreen),
[BotScreenCreate](/bots-api-midia#botscreencreate),
[BotScreenPatch](/bots-api-midia#botscreenpatch) e
[BotScreenActionEvent](/bots-api-midia#botscreenactionevent).

<AppScreenshot src="/screenshots/miniapp-pt.png" alt="Miniapp de exemplo em foco no palco de voz do Monky." caption="O cliente hospeda a visualização isolada; o bot continua responsável pelo estado e pelas regras." />

## Telas programáveis compartilhadas

Uma tela é um miniapp HTML/CSS/JavaScript apresentado **no palco de voz**. Quem está na sala recebe um convite no mesmo canto dos avisos de compartilhamento de tela e escolhe se quer visualizar. Não há card de miniapp no chat nem abertura automática. Diferentemente dos formulários privados de `ctx.prompt()`, ele aceita vários participantes e continua ativo depois que o handler do comando termina. O `/jogo-da-velha` do MonkyBot demonstra dois jogadores e espectadores; as regras continuam no bot, não no JavaScript de quem está vendo a tela.

O cartão permanece no palco junto de câmeras e compartilhamentos, mesmo com a visualização fechada. **Abrir miniapp** inicia a visualização local; **Sair do miniapp** a encerra e devolve o cartão ao estado fechado, sem encerrar o miniapp para os demais. Focar ou voltar à grade só altera o layout: não recarrega a tela nem muda quem ocupa as vagas de jogador. Abrir uma tela para assistir não equivale a entrar na partida.

**Encerrar miniapp** é outra ação: remove a instância, o cartão e os convites
para todos e fecha as visualizações abertas. Só aparece para quem invocou o
comando criador ou para um administrador (`ADMINISTRATOR`, incluindo o dono do
servidor). O servidor verifica a mesma autorização e a presença desta conexão
na sala; ocultar o botão não é a proteção. O criador é a identidade autenticada
`creatorUserId`, preservada ao entrar por outro dispositivo ou reconectar, e não
o ID do bot nem um campo fornecido pelo miniapp. Telas criadas sem invocação não
têm criador humano; somente administradores podem encerrá-las pelo cliente.

As outras visualizações abertas exibem um aviso temporário com o nome do
miniapp, no idioma do cliente. Quem apenas recebeu o convite ou já saiu da
visualização não recebe esse aviso.

Dentro de um comando, `ctx.createScreen()` consulta a sala de voz atual de quem chamou e associa o miniapp àquela sala e à invocação, inclusive em sala privada autorizada. `screen.channelId` é sempre um **canal de voz**, não `ctx.channelId` (o canal de texto do comando). Sem voz, a criação é recusada. O bot não precisa estar conectado ao áudio para oferecer um miniapp. A API avulsa `bot.createScreen(serverId, input)` exige acesso do próprio bot; passar `invocationId` permite a autorização específica da invocação. Isso não concede acesso geral a mensagens privadas.

```ts
bot.command({
  name: 'tela',
  description: 'Abre uma tela compartilhada',
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

No documento isolado, o bridge `window.monkyScreen` fornece:

| API da tela | Comportamento |
|-------------|---------------|
| `viewer` | Contexto local imutável com `id`, `nickname` e `locale` (`pt-BR` ou `en`) da pessoa que abriu a tela |
| `onState((state, revision) => ...)` | Entrega o estado inicial e as atualizações; retorna uma função de unsubscribe |
| `sendAction(action, payload)` | Envia uma intenção vinculada à revisão atual; retorna se o bridge aceitou o envio, não se o bot aceitou a ação |

Leia `window.monkyScreen.viewer.locale` dentro do callback de `onState()` para traduzir os controles de cada pessoa. Trocar o idioma no aplicativo também aciona esse callback, sem mudar o estado/revisão compartilhados nem recriar o iframe. Não escolha o idioma dos controles a partir do estado público ou do idioma de quem criou a tela.

O evento `screenAction` do SDK entrega `{ serverId, screenId, instanceId, channelId, userId, userNickname, action, payload, revision, actionId }`. Use a identidade autenticada desse envelope, nunca um jogador/usuário informado em `payload`. Valide a ação e suas regras no bot antes de chamar `await bot.updateScreen(serverId, screen, { state, expectedRevision })`. Passe o snapshot recebido, ou um `BotScreenRef` com `{ id, instanceId }`, não apenas o ID textual. Uma atualização aceita incrementa `revision` e chega aos participantes; uma revisão antiga é rejeitada em vez de sobrescrever uma alteração concorrente. O HTML permanece o mesmo durante as atualizações de estado.

Use `listScreens(serverId, channelId)` com o ID da sala de voz para obter
snapshots atuais e `closeScreen(serverId, screen)` para o próprio bot encerrar.
O `instanceId` é gerado pelo servidor: mesmo reutilizando `id`, uma nova tela
ganha outra instância. Updates, ações, encerramentos e eventos antigos não
podem atingir a substituta. O END humano não exige a última revisão do estado;
uma atualização concorrente não impede o encerramento da instância correta.

O evento `screenRemoved` entrega `{ serverId, id, instanceId, channelId, reason }`.
Quando `reason === 'ended'`, também inclui `endedByUserId`, autenticado pelo
servidor. Os demais motivos são `closed`, `access_revoked`, `bot_disconnected`
e `view_revoked` (revogação de uma visualização local, não encerramento global).
Remova o estado correspondente no bot comparando **servidor, ID e instância**:
cancele timers/expiração, aborte trabalho pendente e libere as vagas do jogo.
Se a instância controla música, encerre também a fonte/fila que ela possui e
libere seus recursos; o SDK não pode adivinhar a regra de domínio do bot.
Não use um erro de instância inexistente como sinal para recriá-la.

Depois de um END, a invocação criadora ainda em execução é cancelada, incluindo
seus prompts e trabalho pendente; ela não pode criar outra tela. Um novo comando
é necessário. Invocações concluídas/expiradas continuam
inválidas para criação. O SDK rejeita leituras/updates cuja resposta foi
ultrapassada por uma remoção, em vez de devolver um snapshot aparentemente
ativo. Depois de qualquer `await`, confira se a sessão do jogo ainda é a mesma
antes de armazenar o resultado. `ctx.signal` é abortado se a invocação ainda
estiver ativa, mas não acompanha a tela depois que o handler termina: use
`screenRemoved` para o teardown do miniapp.

Registre listeners uma vez e remova-os ao encerrar. O cliente recupera os
miniapps ativos ao entrar na sala; sair, mudar de sala ou desconectar fecha a
visualização local e revoga ações. **Sair do miniapp** não envia END, não apaga
o estado compartilhado e não libera automaticamente uma vaga de jogador.

**Estado compartilhado, sem segredos:** os participantes autorizados que estão naquela sala de voz recebem o HTML e o estado JSON. O servidor também verifica a presença na sala para listar e interagir; estar em outro canal ou em voz em outro dispositivo não autoriza esta conexão. Interações exigem `USE_BOT_COMMANDS`. Não inclua tokens, caminhos locais ou informações secretas de um jogador. A tela não recebe Node.js, preload, IPC, acesso ao DOM do cliente ou autorização para rede, navegação, popups e downloads. Inclua os recursos visuais no documento em vez de depender de CDNs ou requisições externas.

Os limites são 128 KiB de HTML, 64 KiB de estado e 8 KiB por ação; JSON aceita até 12 níveis e 8.192 nós. Há até quatro miniapps por sala de voz, 16 por bot e 64 por servidor, com limites de frequência e deduplicação de ações. Eles vivem em memória e são removidos ao reiniciar/desconectar o bot, perder a autorização de acesso à sala ou receber um encerramento autorizado. Sair da sala, inclusive deixá-la vazia, não apaga automaticamente o estado. A expiração do jogo é responsabilidade do bot. Se persistir partidas, persista também seu encerramento: reiniciar o bot não deve recuperar uma partida explicitamente encerrada.
