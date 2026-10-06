# Formulários, seletores e mensagens

Use respostas privadas para conversar com quem chamou e controles públicos
quando a ação pertence ao grupo. Parta de [Seu primeiro bot](/bots-desenvolvimento).
Além de `commands`, exemplos públicos precisam de `send_messages`;
votações pedem `selectors` e reações/citações também podem exigir `read_messages`.
Veja a [matriz de capacidades](/bots-permissoes).

**Referência:** [CommandContext](/bots-api-cliente#commandcontext),
[BotForm](/bots-api-interacoes#botform),
[BotChoice](/bots-api-cliente#botchoice) e
[BotSelector](/bots-api-interacoes#botselector).

<AppScreenshot src="/screenshots/formulario-pt.png" alt="Formulário privado renderizado pelo Monky com texto, seleção e switch." caption="Você declara os campos e aguarda a resposta; não precisa montar esses controles em HTML." />

## Ações ao vivo nativas

Com protocolo 31, `ctx.createLiveAction()` destaca uma interação acima dos
canais. Declare `commands` e `live_actions`, obtenha aprovação administrativa
e conceda **Emitir ações ao vivo** ao cargo de quem chama o comando. O servidor
deriva a pessoa e o canal da invocação; não aceite identidades enviadas pelo bot.
Não há HTML, iframe, JavaScript ou URL de aplicativo nesse contrato.

```ts
bot.command({
  name: 'confirmar',
  description: 'Abre uma confirmação para o grupo',
  handler: async (ctx) => {
    await ctx.createLiveAction({
      title: 'Confirme sua participação',
      expiresAt: Date.now() + 15 * 60_000,
      audience: {
        visibility: 'private',
        userIds: ['id-do-membro'],
        roleIds: ['id-do-cargo'],
      },
      content: {
        kind: 'form',
        form: {
          title: 'Participação',
          fields: [{ name: 'nome', label: 'Nome', type: 'text', required: true }],
        },
      },
    });
  },
});
```

`bot.onLiveActionSubmission((submission, { serverId }) => { ... })` retorna
uma função para remover o listener. `submission` traz `id`, `submissionId`,
`userId`, `userNickname`, `channelId`, `locale` e `values` validados pelo servidor.
O recebimento confirma o encaminhamento ao bot, não a conclusão de uma operação
externa. Respostas de formulário não são guardadas como histórico de enquete.

Para votações duráveis, crie o seletor com `ctx.createSelector()` e use
`content: { kind: 'selector', selectorId: selector.id }` na ação ao vivo.
Isso exige também `selectors` e `send_messages`; os votos usam o seletor
existente, não um segundo armazenamento. O banner desaparece ao encerrar
o seletor ou expirar.

Use `bot.listLiveActions(serverId)`, `bot.updateLiveAction(serverId, {
id, expectedRevision, ...patch })` e `bot.closeLiveAction(serverId, id)`
para recuperação, atualização e encerramento. O prazo máximo é de 30 dias
por operação; há limite de 50 ações simultâneas por servidor. Alterar a
definição invalida formulários antigos. Ações não concedem acesso a canais
privados e a revisão de capacidades continua obrigatória.
Quem iniciou a Ação ao vivo e membros com **Emitir ações ao vivo** também podem
encerrá-la manualmente pelo detalhe da ação.

Sem `audience`, a ação é pública. Para uma ação privada, envie
`{ visibility: 'private', userIds, roleIds }` com pelo menos um ID; membro e
cargo têm semântica **OU**. O servidor reavalia cargos e leitura do canal em
tempo real. O criador e gestores com **Gerenciar servidor** mantêm acesso, mas
links e a própria Ação ao vivo nunca concedem acesso ao canal. `updateLiveAction`
pode substituir o público ou voltar para `{ visibility: 'public' }`.

## Respostas privadas e publicação

`ctx.reply()` e `ctx.replyEphemeral()` são privados: somente a conexão de quem chamou vê a resposta, no mesmo chat em que iniciou o comando. Não é uma mensagem direta nem uma mensagem publicada para os demais membros.

As respostas aparecem em cartões com nome, foto e identificação do bot, além do contexto **“Fulano usou /comando”**. O servidor fornece a identidade de quem chamou e o nome do comando; o bot não pode se passar por outra pessoa. Essa referência não expõe os parâmetros preenchidos, inclusive quando um resultado é publicado no canal.

```ts
bot.command({
  name: 'segredo',
  description: 'Conta um segredo só pra você',
  handler: (ctx) => {
    ctx.replyEphemeral('🤫 Só você está vendo isso!');
  },
});
```

Para compartilhar um resultado deliberadamente, use `ctx.publish('Resultado para o canal')`. A publicação respeita a visibilidade do canal, é persistida no histórico e aceita reações; os formulários e suas respostas continuam privados. Respostas privadas de comandos são temporárias e não fazem parte do histórico persistido do canal.

## Formulários e conversas em etapas

O bot pode aguardar entradas do usuário sem abrir um modal e sem pedir mensagens formatadas manualmente. Cada `await ctx.prompt(...)` cria um formulário **dentro do chat de quem chamou**. As respostas de usuários, dispositivos e servidores diferentes ficam isoladas.

```ts
bot.command({
  name: 'lista',
  description: 'Publica uma lista por formulário',
  handler: async (ctx) => {
    const result = await ctx.prompt({
      title: 'Nova lista',
      fields: [
        { name: 'pergunta', label: 'Pergunta', type: 'text', required: true, maxLength: 200 },
        {
          name: 'opcoes', label: 'Opções', type: 'string-list',
          required: true, minItems: 2, maxItems: 10, maxLength: 80,
          placeholder: 'Uma opção por campo',
        },
      ],
    });
    if (!result) return;
    if (typeof result.pergunta !== 'string' || !Array.isArray(result.opcoes)) {
      throw new Error('Resposta de formulário inesperada');
    }
    const text = `**${result.pergunta}**\n${result.opcoes.map((option, i) => `${i + 1}. ${option}`).join('\n')}`;
    ctx.publish(text);
  },
});
```

Os tipos de campo disponíveis são `text` (com `multiline` opcional), `integer`,
`select`, `boolean`, `string-list` e `image-list`. Todos aceitam `name`,
`label`, `description` e `required`; campos compatíveis também aceitam
`defaultValue`. Use `defaultValue` para permitir editar uma etapa anterior, e
`submitLabel` no formulário para personalizar o botão de envio.

### Carrosséis de imagem

`image-list` retorna de zero a cinco referências temporárias, vinculadas à
pessoa e ao canal que enviaram as imagens. A apresentação é declarativa e
reutilizável:

```ts
const result = await ctx.prompt({
  title: 'Escolha as imagens',
  fields: [{
    name: 'imagens',
    label: 'Imagens',
    type: 'image-list',
    maxItems: 5,
    presentation: {
      format: 'landscape', // banner | landscape | square | portrait
      fit: 'contain',      // cover | contain
      size: 'regular',     // compact | regular | wide
    },
  }],
});
if (!result) return;

const imagens = result.imagens;
if (Array.isArray(imagens) && imagens.length > 0) {
  ctx.reply({
    content: 'Prévia das imagens selecionadas',
    components: [{
      type: 'carousel',
      imageAssetRefs: imagens,
      label: 'Imagens selecionadas',
      presentation: { format: 'landscape', fit: 'contain', size: 'regular' },
    }],
  });
}
```

O componente de resposta é privado e temporário, como `ctx.reply()`; ele não é
aceito por `ctx.publish()`, `sendMessage()` ou resultados persistentes de
seletores. Para uma superfície durável e compartilhada, crie uma Ação ao vivo
com `imageAssetRefs` e a mesma configuração em `imagePresentation`:

```ts
await ctx.createLiveAction({
  title: 'Galeria',
  description: 'Escolha uma opção depois de conferir as imagens.',
  expiresAt: Date.now() + 15 * 60_000,
  imageAssetRefs: imagens,
  imagePresentation: { format: 'square', fit: 'cover', size: 'compact' },
  content: {
    kind: 'form',
    form: {
      title: 'Escolha',
      fields: [{ name: 'confirmar', label: 'Confirmar', type: 'boolean', required: true }],
    },
  },
});
```

Cada referência pode ser promovida uma única vez. `cover` abre o recorte no
formato escolhido; `contain` preserva a imagem inteira e aplica o encaixe na
exibição. Os presets limitam largura e proporção no cliente e respeitam telas
estreitas, sem aceitar CSS, pixels ou URLs arbitrárias fornecidas pelo bot.

Após o servidor aceitar o envio, o formulário desaparece do chat e seus valores são descartados no cliente. Se o envio falhar, o formulário permanece com os valores preenchidos e a mensagem de erro, permitindo tentar novamente.

`prompt()` retorna `null` se a conversa for cancelada, expirar ou perder a conexão. Retorne do handler nesse caso; use `ctx.signal` para cancelar operações externas. Só pode existir um formulário pendente por invocação: aguarde um antes de abrir o próximo. Há até 10 campos, 20 opções por seleção/lista e cinco comandos simultâneos por conexão. Cada invocação dura no máximo cinco minutos e 100 etapas; abrir outro formulário não reinicia esse prazo. O bot não pode enviar respostas depois de encerrar o handler.

## Seletores privados

`ctx.choose()` simplifica perguntas com uma única escolha. Em `presentation: 'buttons'`, clicar responde imediatamente; em `'dropdown'` (padrão), a pessoa seleciona e confirma. A resposta é o `value` declarado, ou `null` quando a interação termina. Cada etapa é visível somente para quem iniciou o comando.

```ts
bot.command({
  name: 'atividade',
  description: 'Escolhe uma atividade em duas etapas',
  handler: async (ctx) => {
    const activity = await ctx.choose({
      title: 'O que vamos fazer?',
      presentation: 'buttons',
      choices: [
        { label: 'Jogar', value: 'game' },
        { label: 'Conversar', value: 'chat' },
      ],
    });
    if (activity === null) return;
    const time = await ctx.choose({
      title: 'Quando?',
      submitLabel: 'Confirmar horário',
      choices: [
        { label: 'Agora', value: 'now' },
        { label: 'Mais tarde', value: 'later' },
      ],
    });
    if (time !== null) ctx.reply(`Escolha: ${activity}, ${time}`);
  },
});
```

Também é possível usar `presentation: 'buttons'` em um campo `select` de `ctx.prompt()`. Ao clicar, o formulário inteiro é validado e enviado; os demais campos obrigatórios precisam estar preenchidos.

## Seletores públicos e votações

Para perguntas que devem permanecer no canal, use `bot.createSelector(serverId, definição)`. Diferentemente de uma invocação privada, o seletor é persistido no servidor e continua existindo após desconexões. Botões respondem ao clicar; dropdowns exigem confirmação.

```ts
const selector = await bot.createSelector(serverId, {
  channelId,
  title: 'Qual atividade devemos organizar?',
  choices: [
    { label: 'Campeonato', value: 'tournament' },
    { label: 'Sessão de conversa', value: 'chat' },
  ],
  presentation: 'buttons',
  responder: 'any',
  allowChange: true,
  expiresAt: Date.now() + 60 * 60 * 1000,
  maxResponders: 50,
});
```

`responder: 'any'` aceita membros humanos com acesso e permissão no canal. Para restringir a uma pessoa, use `'invoker'` com seu `invokerId`. Cada pessoa tem uma resposta; `allowChange` permite substituí-la sem aumentar o total de participantes. `maxResponders: 1` encerra na primeira resposta válida. Informe duração (`expiresAt`), limite de participantes (`maxResponders`) ou ambos; o primeiro limite atingido encerra a interação. A duração máxima é de 30 dias e o limite máximo é de 10.000 participantes.

O evento `selectorUpdate` entrega `{ serverId, selector }` ao bot proprietário, com as respostas por ID de usuário. Os demais clientes recebem somente totais e a própria escolha. Registre o listener uma vez no ciclo de vida do bot e remova-o ao encerrar. Use `bot.listSelectors(serverId)` após conectar para recuperar os estados, `updateSelector(serverId, id, patch)` para ajustar título/limites e `closeSelector(serverId, id)` para encerrar manualmente.

Dentro de um comando, prefira `ctx.createSelector(definição)` — não é necessário informar `channelId` nem `invokerId`. O servidor vincula a criação à invocação real, permitindo enquetes também em canais privados aos quais a pessoa tem acesso. Esse vínculo vale somente para o seletor e seu canal; não concede ao bot acesso geral às mensagens ou reações privadas. Operações posteriores e recuperação revalidam as permissões atuais de quem criou a enquete. Se essa pessoa perder acesso, o bot deixa de receber as respostas e não pode publicar resultados até recuperar a autorização. A API avulsa `bot.createSelector()` continua exigindo acesso do próprio bot ao canal.

Após o encerramento, `await bot.finalizeSelector(serverId, id, conteúdo)` publica o resultado no canal de forma idempotente: repetir a finalização não cria outra mensagem. Isso permite recuperar o processamento depois de uma queda do bot. Não mantenha um handler privado aberto enquanto aguarda uma votação longa.

## Reações e respostas por emoji

Mensagens persistidas dos canais de texto aceitam reações pelo seletor de emojis. Cada pessoa pode adicionar emojis diferentes, mas somente uma reação por emoji; clicar novamente remove a própria reação. Os totais e os nomes de quem reagiu ficam disponíveis no chat e sobrevivem ao carregamento do histórico. Mensagens privadas temporárias de comandos não recebem reações públicas.

No SDK, `bot.sendMessage(serverId, channelId, texto)` aguarda a publicação e retorna a mensagem com seu `id`. `addReaction(serverId, channelId, messageId, emoji)` e `removeReaction(...)` alteram somente a reação do próprio bot. Os eventos `reactionAdded` e `reactionRemoved` fornecem os IDs do canal, mensagem e usuário, seu apelido e o emoji, com `{ serverId }` como segundo argumento. Os helpers tipados `onReactionAdded` e `onReactionRemoved` retornam uma função para remover o listener.

Para responder publicamente a uma mensagem persistida, use `bot.sendMessage(serverId, channelId, texto, { replyToMessageId: id })`. O quarto argumento é opcional; chamadas existentes continuam funcionando. O servidor exige uma mensagem original não apagada no mesmo canal acessível e devolve `message.reply` com a referência resolvida. Isso é diferente de `ctx.reply()`, que continua sendo uma resposta privada a um comando.

Uma pergunta pode continuar o comando após uma reação válida, sem confundir respostas de outros canais ou usuários:

```ts
bot.command({
  name: 'confirmar',
  description: 'Responde a uma pergunta com emoji',
  handler: async (ctx) => {
    const message = await bot.sendMessage(ctx.serverId, ctx.channelId, 'Continuar? Reaja com 👍 ou 👎.');
    const answer = await new Promise<string | null>((resolve) => {
      const finish = (value: string | null) => {
        detach();
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const onAbort = () => finish(null);
      const detach = bot.onReactionAdded((reaction, { serverId }) => {
        if (serverId === ctx.serverId && reaction.channelId === ctx.channelId &&
            reaction.messageId === message.id && reaction.userId === ctx.invokerId &&
            ['👍', '👎'].includes(reaction.emoji)) finish(reaction.emoji);
      });
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      if (ctx.signal.aborted) finish(null);
    });
    if (answer !== null) ctx.reply(answer === '👍' ? 'Vamos continuar!' : 'Tudo bem, paramos aqui.');
  },
});
```

O exemplo aceita somente a primeira reação válida de quem executou o comando e remove o listener ao responder, cancelar, desconectar ou expirar. Reações normais continuam independentes desse fluxo.
