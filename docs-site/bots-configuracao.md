# Configurações e preferências

Declare opções reutilizáveis sem confundir comportamento compartilhado,
preferência pessoal e autorização. Este é o guia de implementação;
o [guia de uso](/bots#preferencias-e-permissoes) explica a interface.

**Referência:** [BotSettingsDefinition](/bots-api-interacoes#botsettingsdefinition),
[BotSettingsContext](/bots-api-interacoes#botsettingscontext) e
[BotFormField](/bots-api-interacoes#botformfield).

## Configurações por bot e servidor

Use **botão direito no bot → Configurações do bot**, inclusive no nome/foto de mensagens e cards privados. Quem tem acesso à aba **Configurações do servidor → Bots** também pode abrir as preferências de cada bot por ela, inclusive de bots offline. As preferências pessoais continuam disponíveis pelos pontos de entrada do próprio bot, sem um item duplicado no menu do servidor. O servidor precisa estar conectado; desligar o bot não apaga suas declarações ou configurações.

Reservas manuais ainda sem identidade aparecem apenas na administração de bots,
aguardando conexão; suas configurações ficam indisponíveis até o bot anunciar
a própria identidade.

| Escopo | Quem altera | Onde fica |
|---|---|---|
| **Comportamento neste servidor** | Administradores/proprietário ou cargo com **Configurar comportamento dos bots** (`CONFIGURE_BOTS`) | Banco desse servidor; afeta todos que usam esse bot nele |
| **Minhas preferências** | A própria pessoa | Perfil local, separado por endereço, servidor, identidade e bot; não sincroniza entre dispositivos |

`CONFIGURE_BOTS` é independente de `MANAGE_BOTS`, que controla vínculo e desvínculo, não a identidade. Nome e avatar só podem ser atualizados pelo bot autenticado. Quem não pode configurar não recebe os valores nem o formulário compartilhado. O SDK declara campos reutilizáveis; não injeta HTML nem cria uma aba global nas configurações do app. Se o bot não declarar opções compartilhadas, essa seção não aparece.

Declare antes de conectar/servir, reutilizando os tipos de campo de `BotForm`:

```ts
bot.settings({
  server: {
    title: 'Comportamento',
    fields: [
      { name: 'enabled', label: 'Ativado neste servidor', type: 'boolean', required: true, defaultValue: true },
      { name: 'limit', label: 'Quantidade máxima', type: 'integer', required: true, min: 1, max: 10, defaultValue: 5 },
    ],
  },
  user: {
    title: 'Minhas preferências',
    fields: [
      { name: 'compact', label: 'Respostas compactas', type: 'boolean', required: true, defaultValue: false },
    ],
  },
  localizations: {
    en: {
      server: {
        title: 'Behavior',
        fields: { enabled: { label: 'Enabled on this server' }, limit: { label: 'Maximum results' } },
      },
      user: { title: 'My preferences', fields: { compact: { label: 'Compact replies' } } },
    },
  },
});

bot.command({
  name: 'preferencias',
  description: 'Mostra as configurações desta interação',
  localizations: { en: { name: 'preferences', description: 'Show settings for this interaction' } },
  handler: async (ctx) => {
    const en = ctx.locale === 'en';
    const { server, user } = ctx.settings;
    if (server.enabled === false) {
      ctx.reply(en ? 'This feature is disabled on this server.' : 'Este recurso está desativado neste servidor.');
      return;
    }
    ctx.reply(user.compact === true
      ? (en ? 'Compact mode.' : 'Modo compacto.')
      : (en ? `Server limit: ${server.limit}.` : `Limite deste servidor: ${server.limit}.`));
  },
});

const detach = bot.onSettingsChanged((settings, { serverId }) => {
  console.log(serverId, settings.revision);
});
bot.once('closed', detach);
```

Campos obrigatórios de configurações precisam de defaults válidos; essa regra não muda os formulários de perguntas durante comandos. `false` e `0` são preservados. Textos, inteiros, switches, listas, escolhas e escolhas com prévia usam os mesmos controles, com **Salvar** explícito inclusive em escolhas apresentadas como botões. **Restaurar padrões** prepara a alteração, mas só persiste ao salvar.

`localizations` é opcional e aceita `pt-BR` e `en`, seguindo a preferência individual de idioma para o bot (por padrão, o Monky). Cada escopo pode traduzir `title`, `description`, `submitLabel` e, em `fields`, `label`, `description`, `placeholder` e `choices: { valor: { label, description } }` de campos/escolhas já declarados. As traduções não alteram nomes, tipos, valores padrão ou validação; textos não traduzidos usam a declaração original. O formulário compartilhado e suas traduções só são enviados a quem pode configurá-lo.

Consulte `bot.getServerSettings(ctx.serverId)` para ler o snapshot compartilhado
fora da cópia de uma interação. Use um ID recebido do SDK; o nome do servidor
não é um identificador de conexão. O retorno é `undefined` antes de o snapshot
estar disponível ou após desconectar.

`ctx.settings` é um snapshot validado pelo servidor, com `server`, `user`, `schemaRevision` e `serverRevision`. Invocações, autocomplete e respostas a seletores independentes recebem as preferências de quem iniciou aquela ação. Perguntas privadas do mesmo comando conservam o snapshot original; alterações posteriores valem para novas ações. `onSelectorResponse` entrega preferências somente ao bot proprietário, sem incluí-las no histórico público do seletor. Mensagens ou reações genéricas não transmitem preferências a todos os bots.

O cache de `getServerSettings()` e os eventos de configuração são separados por conexão/servidor do SDK. Reconexões idênticas preservam overrides. Escritas compartilhadas usam revisão otimista: alterações concorrentes ou declarações desatualizadas exigem recarregar, sem sobrescrever silenciosamente outra edição. Overrides compartilhados incompatíveis impedem a substituição da declaração; restaure esses campos na configuração antiga antes de registrar a nova versão. Preferências individuais incompatíveis são mostradas para revisão/reset, não descartadas silenciosamente. As declarações têm limite agregado de 64 KiB; os valores, 16 KiB por escopo, além dos limites usuais dos formulários.

**Decisões locais do host não são configurações do bot.** A confirmação/nome do download é uma preferência local oferecida automaticamente para bots com comandos `downloadsSound`. Ela nunca aparece em `ctx.settings`, não pode ser alterada por administrador ou bot e não concede acesso geral a arquivos. A pasta continua em Soundboard. Um bot como o Myinstants não precisa chamar `settings()` para oferecer essa preferência.
