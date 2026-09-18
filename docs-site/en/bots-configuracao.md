# Settings and preferences

Declare reusable options without confusing shared behavior, personal
preferences and authorization. This is the implementation guide;
[Use bots](/en/bots#preferences-and-permissions) explains the interface.

**Reference:** [BotSettingsDefinition](/en/bots-api-interacoes#botsettingsdefinition),
[BotSettingsContext](/en/bots-api-interacoes#botsettingscontext) and
[BotFormField](/en/bots-api-interacoes#botformfield).

## Per-bot settings on each server

**Right-click a bot → Bot settings**, including its name/avatar in messages and private cards. People with access to **Server Settings → Bots** can also open each bot's preferences there, including offline bots. Personal preferences remain available through the bot's own entrypoints, without a duplicate server-dropdown item. The server must be connected; disconnecting a bot does not remove its declarations or saved configuration.

Manual reservations still awaiting their first identity appear only in bot
management; their settings remain unavailable until the bot announces its
own identity.

| Scope | Who can change it | Storage |
|---|---|---|
| **Behavior on this server** | Administrators/owner or roles with **Configure bot behavior** (`CONFIGURE_BOTS`) | This server's database; affects everyone using that bot there |
| **My preferences** | The individual user | Local profile, separated by endpoint, server, identity, and bot; not synchronized across devices |

`CONFIGURE_BOTS` is independent of `MANAGE_BOTS`, which controls linking and unlinking, not identity. Only the authenticated bot can change its name and avatar. Unauthorized readers receive neither the shared values nor the shared form. The SDK declares reusable fields; it does not inject HTML or create a global app-settings tab. Bots without shared settings do not show that section.

Declare settings before connecting/serving, using the existing `BotForm` field types:

```ts
bot.settings({
  server: {
    title: 'Behavior',
    fields: [
      { name: 'enabled', label: 'Enabled on this server', type: 'boolean', required: true, defaultValue: true },
      { name: 'limit', label: 'Maximum results', type: 'integer', required: true, min: 1, max: 10, defaultValue: 5 },
    ],
  },
  user: {
    title: 'My preferences',
    fields: [
      { name: 'compact', label: 'Compact replies', type: 'boolean', required: true, defaultValue: false },
    ],
  },
  localizations: {
    'pt-BR': {
      server: {
        title: 'Comportamento',
        fields: { enabled: { label: 'Ativado neste servidor' }, limit: { label: 'Quantidade máxima' } },
      },
      user: { title: 'Minhas preferências', fields: { compact: { label: 'Respostas compactas' } } },
    },
  },
});

bot.command({
  name: 'preferences',
  description: 'Show settings for this interaction',
  localizations: { 'pt-BR': { name: 'preferencias', description: 'Mostra as configurações desta interação' } },
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

Required settings fields need valid defaults; this does not change ordinary command prompt forms. `false` and `0` are preserved. Text, integers, switches, lists, choices, and audio choices reuse the same controls, with an explicit **Save** even for button-style choices. **Restore defaults** prepares a change but does not persist it until saving.

Optional `localizations` supports `pt-BR` and `en`, following the person's preferred bot language (Monky's language by default). Each scope may translate `title`, `description`, `submitLabel`, and, under `fields`, `label`, `description`, `placeholder`, and `choices: { value: { label, description } }` for already-declared fields/choices. Translations never change names, types, defaults, or validation; missing text falls back to the original declaration. Shared forms and their translations are only sent to people authorized to configure them.

Use `bot.getServerSettings(ctx.serverId)` to read the shared snapshot outside
an interaction's captured copy. Use an ID received from the SDK; the server's
name is not a connection identifier. It returns `undefined` before a snapshot
is available or after disconnection.

`ctx.settings` is a server-validated snapshot with `server`, `user`, `schemaRevision`, and `serverRevision`. Invocations, autocomplete, and independent selector responses receive the initiating user's preferences. Private continuations keep the original invocation snapshot; later changes apply to new actions. `onSelectorResponse` delivers preferences privately to the owning bot, never in public selector history. Generic messages and reactions do not distribute preferences to every bot.

`getServerSettings()` caches and settings events are isolated by SDK connection/server. Identical reconnects preserve overrides. Shared writes use optimistic revisions: concurrent changes and outdated declarations require a reload instead of silently overwriting another edit. Incompatible shared overrides reject a replacement declaration; reset those fields through the old settings before registering the new version. Incompatible individual preferences are surfaced for review/reset rather than silently discarded. Declarations have an aggregate 64 KiB limit, and values a 16 KiB limit per scope, in addition to existing form limits.

**Local host decisions are not bot configuration.** Download confirmation/renaming is a local preference automatically provided for bots with `downloadsSound` commands. It never appears in `ctx.settings`, cannot be changed by administrators or bots, and does not grant general filesystem access. Folder selection remains in Soundboard. A bot such as Myinstants does not need a `settings()` declaration to offer this preference.
