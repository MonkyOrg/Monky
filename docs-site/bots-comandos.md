# Comandos e autocomplete

Defina como seu bot é descoberto, quais valores recebe e quando uma busca
acontece. Os trechos complementam a instância `bot` de
[Seu primeiro bot](/bots-desenvolvimento) e exigem `commands`.

**Referência:** [CommandDefinition e contextos](/bots-api-cliente#commanddefinition),
[CommandOption](/bots-api-interacoes#commandoption) e
[SelectionChoice](/bots-api-interacoes#selectionchoice).

<AppScreenshot src="/screenshots/comandos-pt.png" alt="Catálogo nativo mostrando comandos localizados do GuiaBot." caption="O SDK fornece a definição; o cliente apresenta o catálogo, os campos e os motivos de indisponibilidade." />

## Anatomia de um comando

```ts
bot.command({
  name: 'nome',               // Nome do slash command (sem a /)
  description: 'Descrição',    // Exibida no dropup de comandos
  options: [                   // Parâmetros (opcional)
    {
      name: 'param',
      description: 'Descrição do parâmetro',
      type: 'string',         // Tipo do parâmetro
      required: true,          // Obrigatório?
    },
  ],
  handler: (ctx) => {
    // ctx.channelId  — canal onde foi invocado
    // ctx.invokerId  — ID do usuário
    // ctx.invokerNickname — apelido
    // ctx.invokerSessionId — conexão/dispositivo que iniciou o comando
    // ctx.invokerVoiceChannelId — sala de voz inicial, não um estado vivo
    // ctx.getVoiceChannel() — consulta a sala atual da conexão original no servidor
    // ctx.serverId   — ID do servidor (útil em modo multi-servidor)
    // ctx.args       — argumentos { nome: string | number | boolean }
    // ctx.locale     — idioma preferido para este bot ('pt-BR' ou 'en')
    // ctx.reply()    — responde só para quem chamou, dentro do chat
    // ctx.publish()  — publica explicitamente um resultado no canal
    // ctx.prompt()   — aguarda um formulário privado; pode ser chamado em etapas
    // ctx.choose()   — aguarda uma opção privada, por botões ou dropdown
    // ctx.createScreen() — cria uma tela compartilhada independente do handler
    // ctx.downloadSound() — aguarda um download local autorizado de soundboard
    // ctx.signal     — aborta ao cancelar, desconectar, expirar ou concluir
  },
});
```

## Idioma dos comandos e preferências

Cada pessoa pode escolher o idioma no dropdown **Configurações do bot > Minhas
preferências > Idioma do bot** e confirmar em **Salvar**, inclusive para bots
sem formulário de configuração próprio.
**Seguir o Monky** usa o idioma do aplicativo; a escolha explícita vale somente
para aquele bot, servidor/endereço e identidade no perfil local. Restaurar os
padrões volta a seguir o Monky. O idioma efetivo chega em `ctx.locale` também no
autocomplete e na prévia de áudio. Interações já iniciadas mantêm o idioma
capturado para formulários e escolhas. Mensagens com variantes fornecidas pelo
bot acompanham o idioma do aplicativo de cada leitor, inclusive no histórico. O nome
do comando no cabeçalho de uma resposta acompanha o idioma de quem a lê, usando
os metadados disponíveis; sem eles, aparece o nome canônico.

Declare `localizations` para nomes locais, aliases e textos de descoberta e preenchimento:

```ts
bot.command({
  name: 'play',
  description: 'Choose playback order',
  options: [{
    name: 'mode', label: 'Mode', description: 'Playback order', type: 'string',
    choices: [{ label: 'Shuffle', value: 'shuffle' }],
  }],
  localizations: {
    'pt-BR': {
      name: 'tocar',
      aliases: ['musica'],
      description: 'Escolha a ordem de reprodução',
      options: {
        mode: {
          label: 'Modo', description: 'Ordem de reprodução', placeholder: 'Escolha',
          choices: { shuffle: { label: 'Aleatório' } },
        },
      },
    },
  },
  handler: (ctx) => { ctx.reply(ctx.locale === 'en' ? 'Ready.' : 'Pronto.'); },
});
```

O `name` principal continua sendo o identificador canônico: o usuário em
português vê `/tocar` e pode digitar `/tocar`, `/musica` ou `/play`, mas o servidor
e `ctx.commandName` recebem `play`. A preferência é **apenas para aquela pessoa**,
nunca uma renomeação global. Nomes de argumentos, `ctx.args.mode` e
`choices[].value` não são traduzidos. Descrições, `label`, `placeholder` e
rótulos/descrições de escolhas continuam traduzíveis; campos ou escolhas não
declarados são rejeitados. Texto ausente usa a declaração original.

Nomes locais e aliases usam slugs ASCII minúsculos de 1 a 32 caracteres:
começam com letra ou número e aceitam letras, números, `_` e `-`. Cada idioma
aceita até oito aliases únicos. A declaração do bot rejeita colisões entre
comandos, inclusive um alias que esconda o nome canônico de outro comando.
Colisões entre bots continuam oferecendo a escolha do bot; o cliente não
executa o primeiro resultado por acidente. Só os aliases do idioma efetivo e
os nomes canônicos são aceitos. Trocar o idioma durante o preenchimento atualiza
nomes e rótulos, preservando o bot, comando canônico, valores e cursor.

O SDK exporta `BotLocale`, `normalizeBotLocale`, `resolveBotLocale` e
`localizeCommand`, além de `getCommandPresentation` e do tipo
`CommandPresentation`. `normalizeBotLocale('en-US')` resulta em `en`; mantenha
`pt-BR` e `en` como chaves de `localizations`. `resolveBotLocale` pode receber a
lista de idiomas suportados pelo bot e um idioma padrão. `localizeCommand`
produz metadados de exibição sem modificar a declaração ou os identificadores.
`getCommandPresentation(definicao, ctx.locale)` retorna
`{ canonicalName, displayName, inputNames }`. Use `displayName` em ajuda privada;
jamais o envie como `commandName` no protocolo. Por exemplo, usando o mesmo
array `commandDefinitions` registrado com `bot.command()`:

```ts
import { getCommandPresentation, localizeCommand } from '@monky/bot-sdk';

bot.command({
  name: 'help',
  description: 'Help',
  localizations: { 'pt-BR': { name: 'ajuda' } },
  handler: (ctx) => ctx.reply(commandDefinitions.map(command =>
    `/${getCommandPresentation(command, ctx.locale).displayName} — ${
      localizeCommand(command, ctx.locale).description
    }`
  ).join('\n')),
});
```

Formulários e escolhas continuam usando `ctx.locale`, não
`ctx.settings.user.locale`. `ctx.reply()` mantém a ajuda privada; `ctx.publish()`
a torna visível para todo o canal, mesmo quando cada leitor vê um idioma diferente.

### Mensagens no idioma de quem lê

`ctx.reply()`, `ctx.replyEphemeral()`, `ctx.publish()`, `bot.sendMessage()` e
`bot.finalizeSelector()` aceitam uma string simples ou um `BotLocalizedMessage`:

```ts
ctx.publish({
  content: 'Track added to the queue.',
  localizations: {
    'pt-BR': 'Música adicionada à fila.',
    en: 'Track added to the queue.',
  },
});
```

O bot escreve as variantes; **não há tradução automática**. Cada leitor escolhe
a variante pelo idioma do aplicativo, não pelo idioma de quem executou o comando
nem pela preferência usada no formulário do bot. `content` é obrigatório e serve
de fallback quando não existe variante. Cada texto respeita o limite do servidor (16.000 caracteres por padrão; `0` sem limite de caracteres);
as chaves suportadas são `pt-BR` e `en`.

As variantes permanecem no histórico e nas referências de resposta; copiar usa
o texto exibido. Trocar o idioma atualiza a exibição sem modificar a mensagem.
Excluir apaga também as variantes. Bots que enviam apenas strings continuam
funcionando, mas essas mensagens não ganham traduções retroativas.

Sorteie dados/moedas uma única vez e gere as variantes do **mesmo resultado**.
Preserve títulos de músicas, perguntas, opções e textos livres de pessoas.
O contrato exige cliente, servidor e SDK de bots compatíveis com o protocolo 21.

## Parâmetros guiados no chat

Ao digitar `/`, o menu mostra os comandos utilizados com mais frequência e os agrupa por bot. Cada item identifica o comando, sua descrição e o bot responsável. Ao navegar, os parâmetros obrigatórios e a quantidade de opcionais ajudam a escolher o comando. Pressionar **Espaço** seleciona o comando destacado no menu e abre seu compositor, sem executá-lo. Espaços no texto comum ou nos parâmetros continuam sendo texto.

Ao selecionar um comando com parâmetros, o compositor compacto identifica **qual bot e comando** estão selecionados e apresenta campos nomeados com descrição e placeholder. Parâmetros opcionais podem ser adicionados quando necessários. O envio usa os nomes declarados em `options`; não é necessário juntar valores com vírgulas. Comandos sem parâmetros que não solicitam download local, como `/ping` e `/enquete`, iniciam a interação imediatamente ao serem selecionados por clique, Enter ou Tab; a seleção com Espaço aguarda uma confirmação de envio.

A frequência de uso é local e separada por servidor e identidade. Apenas contagens e recência são guardadas, nunca os valores preenchidos nos parâmetros.

| Tipo | Controle | Valor em `ctx.args` |
|------|----------|--------------------|
| `string` | Texto; `choices` para seleção fixa ou `autocomplete: true` para sugestões dinâmicas | `string` |
| `integer` | Número inteiro, com limites opcionais `min` e `max` | `number` |
| `boolean` | Switch | `boolean` |
| `user` | Seleção de membro | ID do membro (`string`) |

`required: true` impede enviar sem preencher. Um parâmetro opcional não preenchido é omitido; valores válidos como `false` e `0` não são descartados. O servidor valida os parâmetros novamente antes de chamar o bot. Dois bots podem ter um comando com o mesmo nome: a seleção no chat mantém o bot escolhido.

Os obrigatórios aparecem ao selecionar o comando; todos precisam estar válidos para liberar a execução. Os opcionais restantes ficam em `+N`: clique ali ou pressione **Seta direita no fim do último campo** para listar os parâmetros que podem ser adicionados. Selecionar um deles abre seu preenchimento, sem executar o comando. Dentro do texto, a seta continua movendo o cursor normalmente.

## Autocomplete antes de executar

Uma opção `string` pode declarar `autocomplete: true`. Nesse caso, o comando precisa de um callback `autocomplete`; não combine essa opção com `choices` estático.

```ts
const catalog = [
  { label: 'Bell', value: 'bell', description: 'Short bell sound' },
  { label: 'Drum', value: 'drum', description: 'Single drum hit' },
];

bot.command({
  name: 'findsound',
  description: 'Find a sound',
  options: [
    { name: 'sound', description: 'Sound', type: 'string', required: true, autocomplete: true },
  ],
  autocomplete: ({ query }) =>
    catalog.filter((choice) => choice.label.toLowerCase().includes(query.toLowerCase())),
  handler: (ctx) => {
    ctx.reply(ctx.locale === 'en' ? `Selected: ${ctx.args.sound}` : `Selecionado: ${ctx.args.sound}`);
  },
});
```

O callback recebe `{ query, page, cursor, optionName, args, locale, serverId, signal, settings }` e pode retornar uma lista de `SelectionChoice` (`{ label, value, description?, audio? }`) ou uma página `{ choices, hasMore?, nextCursor? }`, diretamente ou por `Promise`. `page` começa em zero; `cursor` é opcional. `args` contém somente as outras opções já preenchidas e válidas; obrigatórios ainda ausentes são permitidos nessa etapa. `query` contém o texto da opção editada. `settings` é um snapshot imutável das configurações do servidor e preferências dessa pessoa.

No exemplo, o catálogo é local ao bot. Para uma fonte externa, substitua a filtragem por uma busca de **metadados**, passe `signal` ao `fetch` e valide o retorno. O callback não recebe uma invocação nem métodos de resposta/download. As consultas são enviadas ao bot selecionado enquanto a pessoa digita; não são publicadas no canal nem persistidas no histórico.

O cliente espera **700 ms sem digitação** e espaça os envios reais em pelo menos **1 segundo** por conexão, inclusive entre páginas e ao reabrir o menu. A preparação local acontece antes de reservar esse intervalo e antes de iniciar o prazo da resposta. O servidor continua limitando a uma consulta por usuário a cada 500 ms, somando os dispositivos, com prazo de 15 segundos por página. Retorne no máximo **20 choices por resposta**, com valores únicos: `label` até 100 caracteres, `value` até 2.000 e `description` até 500. **Não há corte no total acumulado no menu.** `query` aceita até 200 caracteres; o bot pode impor um limite menor.

Para habilitar rolagem com carregamento sob demanda, retorne `hasMore: true` enquanto houver outra página. O cliente incrementa `page` ao se aproximar do fim da lista, mantém as escolhas anteriores e remove duplicatas por `value`. Se a fonte usa cursores ou uma página precisa ser dividida em vários lotes, retorne também `nextCursor` (string opaca de até 512 caracteres); o cliente o devolve em `cursor`. Valide esse cursor no provider: ele não é uma autorização nem deve ser tratado como URL confiável. Não busque todas as páginas antecipadamente.

```ts
autocomplete: ({ query, page }) => {
  const matches = catalog.filter((choice) => choice.label.toLowerCase().includes(query.toLowerCase()));
  const offset = page * 20;
  return { choices: matches.slice(offset, offset + 20), hasMore: offset + 20 < matches.length };
},
```

Sem `hasMore` (inclusive no retorno antigo em array), a resposta continua sendo uma lista única. Use `hasMore: false` na última página e omita `nextCursor`; uma lista vazia encerra uma busca sem continuação. Falhas ao carregar mais mantêm os resultados e permitem tentar a mesma página novamente. Fechar o compositor, alterar a busca, cancelar, perder acesso ou desconectar invalida o contexto; respostas atrasadas são descartadas. As prévias sob demanda de cada página mantêm sua própria autorização e expiração, sem serem invalidadas apenas por carregar a página seguinte. SDK, servidor e cliente no protocolo 20 são necessários; callbacks antigos em array não precisam mudar após atualizar o SDK e declarar as capacidades utilizadas.

Setas apenas navegam. Enter ou clique confirmam uma sugestão. **Sem parâmetros opcionais, se todos os obrigatórios estiverem válidos, esse mesmo gesto executa o comando uma única vez.** Se houver opcionais, a escolha apenas preenche o campo: o compositor fica aberto para usar `+N` e o envio acontece com um Enter posterior ou pelo botão de executar. Se faltar algum obrigatório, ele precisa ser preenchido antes de executar. Texto digitado sem uma escolha válida não executa o comando. Alterar o texto invalida a escolha anterior. `value` é um identificador opaco, não uma autorização: o handler deve validá-lo novamente antes de resolver os metadados do resultado.
