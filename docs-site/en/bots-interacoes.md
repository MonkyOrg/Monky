# Forms, selectors and messages

Use private replies to talk to the caller and public controls when an action
belongs to the group. Start with [Your first bot](/en/bots-desenvolvimento).
Beyond `commands`, public examples need `send_messages`; polls need `selectors`,
and reactions/quotes can also require `read_messages`.
See the [capability matrix](/en/bots-permissoes).

**Reference:** [CommandContext](/en/bots-api-cliente#commandcontext),
[BotForm](/en/bots-api-interacoes#botform),
[BotChoice](/en/bots-api-cliente#botchoice) and
[BotSelector](/en/bots-api-interacoes#botselector).

<AppScreenshot src="/screenshots/formulario-en.png" alt="A private form rendered by Monky with text, selection and switch controls." caption="Declare fields and await a response; you do not have to build these controls in HTML." />

## Private replies and publishing

`ctx.reply()` and `ctx.replyEphemeral()` are private: only the calling connection sees the response in the same chat where the command started. This is neither a direct message nor a message published to other members.

Replies appear in cards with the bot's name, photo, and badge, plus **“Nickname used /command”** context. The server supplies the caller's identity and the command name; bots cannot impersonate another caller. This reference does not expose parameter values, including when a result is published to the channel.

```ts
bot.command({
  name: 'secret',
  description: 'Tells you a secret',
  handler: (ctx) => {
    ctx.replyEphemeral('🤫 Only you can see this!');
  },
});
```

To deliberately share a result, use `ctx.publish('Result for the channel')`. Publishing respects channel visibility, is persisted in history, and supports reactions; forms and their answers remain private. Private command replies are temporary and are not part of the channel's persisted history.

## Forms and multi-step conversations

A bot can wait for user input without opening a modal or requesting manually formatted messages. Each `await ctx.prompt(...)` creates a form **inside the caller's chat**. Answers from different users, devices, and servers stay isolated.

```ts
bot.command({
  name: 'list',
  description: 'Publish a list using a form',
  handler: async (ctx) => {
    const result = await ctx.prompt({
      title: 'New list',
      fields: [
        { name: 'question', label: 'Question', type: 'text', required: true, maxLength: 200 },
        {
          name: 'options', label: 'Options', type: 'string-list',
          required: true, minItems: 2, maxItems: 10, maxLength: 80,
          placeholder: 'One option per field',
        },
      ],
    });
    if (!result) return;
    if (typeof result.question !== 'string' || !Array.isArray(result.options)) {
      throw new Error('Unexpected form answer');
    }
    const text = `**${result.question}**\n${result.options.map((option, i) => `${i + 1}. ${option}`).join('\n')}`;
    ctx.publish(text);
  },
});
```

Available field types are `text` (with optional `multiline`), `integer`, `select`, `boolean`, and `string-list`. All accept `name`, `label`, `description`, `required`, and a type-compatible `defaultValue`. Use `defaultValue` to edit a previous step, and the form's `submitLabel` to customize its submit button.

Once the server accepts a submission, the form disappears from chat and its values are discarded in the client. If submission fails, the form retains the entered values and displays the error so the caller can try again.

`prompt()` returns `null` if the conversation is cancelled, expires, or loses its connection. Return from the handler in that case; use `ctx.signal` to cancel external operations. Only one form may be pending per invocation: await it before opening the next. Limits are 10 fields, 20 choices/list items, and five simultaneous commands per connection. Each invocation lasts at most five minutes and 100 steps; opening another form does not reset that deadline. A bot cannot send replies after its handler has finished.

## Private selectors

`ctx.choose()` simplifies questions with one choice. With `presentation: 'buttons'`, clicking responds immediately; with `'dropdown'` (the default), the caller selects and confirms. The response is the declared `value`, or `null` when the interaction ends. Each step is visible only to the caller.

```ts
bot.command({
  name: 'activity',
  description: 'Choose an activity in two steps',
  handler: async (ctx) => {
    const activity = await ctx.choose({
      title: 'What should we do?',
      presentation: 'buttons',
      choices: [
        { label: 'Play', value: 'game' },
        { label: 'Chat', value: 'chat' },
      ],
    });
    if (activity === null) return;
    const time = await ctx.choose({
      title: 'When?',
      submitLabel: 'Confirm time',
      choices: [
        { label: 'Now', value: 'now' },
        { label: 'Later', value: 'later' },
      ],
    });
    if (time !== null) ctx.reply(`Choice: ${activity}, ${time}`);
  },
});
```

You can also use `presentation: 'buttons'` on a `select` field in `ctx.prompt()`. Clicking validates and submits the entire form, so other required fields must be filled first.

## Public selectors and voting

For questions that should remain in the channel, use `bot.createSelector(serverId, definition)`. Unlike a private invocation, the selector is persisted on the server and remains available after disconnections. Buttons respond on click; dropdowns require confirmation.

```ts
const selector = await bot.createSelector(serverId, {
  channelId,
  title: 'Which activity should we organize?',
  choices: [
    { label: 'Tournament', value: 'tournament' },
    { label: 'Chat session', value: 'chat' },
  ],
  presentation: 'buttons',
  responder: 'any',
  allowChange: true,
  expiresAt: Date.now() + 60 * 60 * 1000,
  maxResponders: 50,
});
```

`responder: 'any'` accepts human members with channel access and permission. To restrict responses to one person, use `'invoker'` with their `invokerId`. Each person has one response; `allowChange` lets them replace it without increasing the participant count. `maxResponders: 1` closes on the first valid response. Provide a deadline (`expiresAt`), a participant limit (`maxResponders`), or both; the first limit reached closes the interaction. The maximum duration is 30 days and the maximum participant limit is 10,000.

The `selectorUpdate` event delivers `{ serverId, selector }` to the owning bot, including responses by user ID. Other clients receive only totals and their own choice. Register the listener once for the bot's lifecycle and remove it on shutdown. Use `bot.listSelectors(serverId)` after connecting to recover states, `updateSelector(serverId, id, patch)` to adjust title/limits, and `closeSelector(serverId, id)` to close manually.

Inside a command, prefer `ctx.createSelector(definition)` — `channelId` and `invokerId` are supplied automatically. The server binds creation to the real invocation, allowing polls in private channels the caller can access. This authorization applies only to that selector and channel; it does not grant the bot general access to private messages or reactions. Later operations and recovery revalidate the creator's current permissions. If that person loses access, the bot stops receiving responses and cannot publish results until authorization is restored. Standalone `bot.createSelector()` still requires the bot's own channel access.

After closure, `await bot.finalizeSelector(serverId, id, content)` publishes the result to the channel idempotently: repeating finalization does not create another message. This lets processing recover after a bot crash. Do not keep a private handler open while waiting for a long-running vote.

MonkyBot's `/enquete` uses this mechanism: it requires 2–10 options and at least one closing condition (1 minute to 30 days, using minutes/hours/days; or 1–10,000 voters). It publishes immediately after the form, allows vote changes, and closes at the first limit reached. Results show counts, percentages, the winner/tie, or no votes. Polls and pending results are recovered after restarts.

## Reactions and emoji responses

Persisted text-channel messages support reactions through the emoji picker. Each person may add different emojis, but only one reaction per emoji; clicking again removes their own reaction. Totals and the names of people who reacted are available in chat and survive history loading. Temporary private command replies do not receive public reactions.

In the SDK, `bot.sendMessage(serverId, channelId, text)` awaits publication and returns the message with its `id`. `addReaction(serverId, channelId, messageId, emoji)` and `removeReaction(...)` change only the bot's own reaction. The `reactionAdded` and `reactionRemoved` events provide channel, message and user IDs, the user's nickname, and the emoji, with `{ serverId }` as the second argument. Typed helpers `onReactionAdded` and `onReactionRemoved` return an unsubscribe function.

To publicly reply to a persisted message, use `bot.sendMessage(serverId, channelId, text, { replyToMessageId: id })`. The fourth argument is optional; existing calls keep working. The server requires a non-deleted original in the same accessible channel and returns its resolved reference in `message.reply`. This differs from `ctx.reply()`, which remains a private command response.

A question can continue the command after a valid reaction without mixing responses from other channels or users:

```ts
bot.command({
  name: 'confirm',
  description: 'Answer a question with an emoji',
  handler: async (ctx) => {
    const message = await bot.sendMessage(ctx.serverId, ctx.channelId, 'Continue? React with 👍 or 👎.');
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
    if (answer !== null) ctx.reply(answer === '👍' ? "Let's continue!" : "Okay, we'll stop here.");
  },
});
```

The example accepts only the caller's first valid reaction and removes the listener on response, cancellation, disconnection, or expiry. Ordinary reactions remain independent of this flow.
