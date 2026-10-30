---
description: "Store Monky bot data on the server or on participants' computers, with the admin's approval."
---

# Bot storage

A bot can keep data in two places, each with its own capability. Both start
turned off and depend on the approval of whoever administers the server.

| Where | Capability | Who reads and writes | Who decides |
|-------|------------|----------------------|-------------|
| On the Monky server | `server_storage` | Only the bot, through the SDK: `bot.storage(serverId)` | The administrator, in the permission review |
| On the computer of whoever opens a miniapp | `device_storage` | Only the bot's miniapps: `window.monkyScreen.storage` | The administrator allows **asking**; each person decides on their own computer |

**Reference:** [BotStorage](/en/bots-api-cliente#botstorage),
[BotStoredObject](/en/bots-api-cliente#botstoredobject),
[BotStorageUsage](/en/bots-api-cliente#botstorageusage),
[BotRequestError](/en/bots-api-cliente#botrequesterror),
[BOT_STORAGE_LIMITS](/en/bots-api-ferramentas#bot_storage_limits) and, in miniapps,
[BotScreenStorage](/en/bots-api-midia#botscreenstorage).

Game saves are the typical case: an emulator can keep the slots on the
server, for everyone in the room, and the autosaves on each person's
computer, without making anyone download files.

## Declare the capabilities

```ts
const bot = new BotClient({
  requestedCapabilities: ['commands', 'miniapps', 'server_storage', 'device_storage'],
  publicKey,
});
```

Declare only what you use. Like any new capability, both arrive turned off in
the review and are not enabled by a reconnection. Servers that predate bot
storage do not know these names: the SDK leaves them out of the registration
and the manifest sent to those servers, so the rest of the bot keeps working.

## On the server: `bot.storage(serverId)` {#no-servidor}

Objects stay on the server and only the bot itself reads them. People allowed
to manage bots see how much space they take in **Bot settings → Storage**;
everyone else gets no data about the storage on the server, only about their
own computer.

```ts
const storage = bot.storage(serverId);

await storage.put(`nes/${romId}/slot-1`, state, { contentType: 'application/octet-stream' });
const saved = await storage.get(`nes/${romId}/slot-1`); // BotStoredObject | null
if (saved) emulator.load(saved.data); // Uint8Array

const page = await storage.list({ prefix: `nes/${romId}/`, limit: 50 });
for (const object of page.objects) console.log(object.key, object.sizeBytes, object.updatedAt);
if (page.next) await storage.list({ prefix: `nes/${romId}/`, after: page.next });

await storage.delete(`nes/${romId}/slot-1`); // true if it existed
const usage = await storage.usage(); // { usedBytes, maxBytes, objectCount, maxObjects, level }
```

- `put()` takes a `Uint8Array`, an `ArrayBuffer` or text (stored as UTF-8)
  and replaces the object with the same key. The answer has `key`,
  `sizeBytes`, `contentType` and `updatedAt`, without the data.
- `list()` returns up to 100 objects per page, in key order. Continue with
  `after: page.next` until `next` is `null`.
- Keys are logical names, such as `nes/<rom>/slot-1`: up to 200 characters,
  letters, digits, `.`, `_`, `-` and `/`, starting with a letter or digit,
  without empty, `.` or `..` segments. They never become file paths on the server.
- Each object takes up to 4 MiB, because it travels in a single message. The
  total starts at 100 MB per bot, and the administrator can set it from 1 MB
  to 100 GB. There are up to 10,000 objects per bot and 20 operations per second.

Failures reject with [`BotRequestError`](/en/bots-api-cliente#botrequesterror),
whose `code` is a `ProtocolErrorCode`:

| `code` | When |
|--------|------|
| `STORAGE_FULL` | The write does not fit the limit or the number of objects |
| `BOT_PERMISSIONS_REQUIRED` | `server_storage` was not approved on this server |
| `FEATURE_REQUIRES_UPDATE` | The server does not have bot storage yet |
| `FEATURE_UNAVAILABLE` | The server was started without bot storage; updating does not help |
| `RATE_LIMITED` | More than 20 operations per second |
| `BAD_REQUEST` | Invalid key, data or listing |

`bot.storage()` throws right away if `server_storage` is not in
`requestedCapabilities`.

### Autosaves

A save nobody asked for should not interrupt the activity. With
`{ autosave: true }`, a full storage makes `put()` resolve `null` instead of
rejecting:

```ts
const saved = await storage.put(`nes/${romId}/autosave`, state, { autosave: true });
if (!saved) {
  // Full: Monky already warns people on the miniapp card. Keep playing.
}
```

Other errors, such as a missing permission, still reject. For saves the
person asked for, leave `autosave` off and show the failure.

## On computers: `monkyScreen.storage` {#nos-computadores}

With `device_storage` approved, whoever opens one of the bot's miniapps
chooses, in the same **Continue and open** notice, whether it may keep data
on their computer:

- **Do not store** (default): nothing is written. The miniapp works normally.
- **This session only**: lasts until the person leaves the miniapp. Next
  time, Monky asks again.
- **Always**: stop asking.

In **Bot settings → Storage → On this computer**, the person switches the
decision between **Ask**, **Always** and **Never**, sets the limit (50 MB by
default, from 1 MB to 100 GB) and deletes the data. Changes apply at once,
including to an open miniapp.

| API | Behavior |
|-----|----------|
| `status` | `'granted'`, `'denied'` or `'unavailable'` |
| `onStatus(callback)` | Calls back right away with the current status and again on every change; returns an unsubscribe function |
| `get(key)` | Resolves a `string`, an `ArrayBuffer` or `null` |
| `set(key, value, { autosave })` | Stores text, an `ArrayBuffer`, a typed array or a `Blob`; resolves `true` |
| `delete(key)` | Resolves `true` if the key existed |
| `list({ prefix })` | Resolves `[{ key, size, updatedAt }]` in key order |
| `usage()` | Resolves `{ usedBytes, maxBytes, level }` |

The status starts as `unavailable` and changes when Monky connects the
miniapp, right after it loads. Use `onStatus()` instead of reading `status`
only once:

```js
const storage = window.monkyScreen.storage; // missing in older Monky clients
let autosaveAllowed = false;
storage?.onStatus((status) => {
  autosaveAllowed = status === 'granted';
  if (autosaveAllowed) void restoreAutosave();
});

async function restoreAutosave() {
  const state = await storage.get(`nes/${romId}/autosave`);
  if (state instanceof ArrayBuffer) emulator.load(new Uint8Array(state));
}

async function autosave(state) {
  // No permission, full or too large: resolves false and the game goes on.
  if (autosaveAllowed) await storage.set(`nes/${romId}/autosave`, state, { autosave: true });
}
```

`unavailable` also means that the administrator did not allow
`device_storage`, that the server predates the feature or that the miniapp
was opened without storage. Older Monky clients have no
`monkyScreen.storage`: check that it exists. Always offer a button to
**download** the save, which works without any permission.

Outside `autosave`, failures reject with an error named `MonkyStorageError`
and a `reason`: `denied`, `unavailable`, `quota`, `too_large`, `invalid`,
`busy` or `failed`. Values of other types reject with `TypeError`.

Data is kept apart per server, account and bot. The miniapp does not choose
that scope: Monky ties each request to the view it opened. All miniapps of the
same bot share the person's space on that server, so prefix keys per app. The
same key rules apply, with 4 MiB per object, up to 1,000 objects and 20
operations per second in each view.

The web storage of the miniapp origin (`localStorage`, IndexedDB) is still
discarded when the view closes; use `monkyScreen.storage` for what must last.

### Saving on close {#salvar-ao-fechar}

`monkyScreen.storage` keeps working during
[`onClose`](/en/bots-miniapps#ciclo-de-vida-da-visualizacao), while the view
closes hidden and muted. A **This session only** choice also lasts until it
finishes. That is the moment to keep progress without asking anything:

```js
window.monkyScreen.onClose?.(async () => {
  await storage?.set(`nes/${romId}/autosave`, emulator.saveState(), { autosave: true });
});
```

`onClose` has at most 5 seconds: if it does not finish, the document is
discarded. Also keep the periodic autosave, because quitting or reloading
Monky leaves no time for any hook.

## Space warnings {#avisos}

`usage.level` is `ok`, `near_full` (from 90% of the limit) or `full` (limit
reached, or a write was just refused for lack of space). Freeing space or
raising the limit brings the level back to normal.

While the bot's storage on this computer is almost full or full, Monky shows a
warning in the bottom-left corner of the miniapp card: **Storage almost full**
or **Storage full: autosaves paused**. People allowed to manage bots also see
it when the storage on the server fills up; everyone else is only warned about
their own computer. Monky draws it, not the miniapp, and it opens **Bot
settings → Storage**. Do not reproduce this warning in the app; handle `null`,
`false` and `STORAGE_FULL` without blocking the activity.

## Removing the bot, revoking and deleting

- **Unlinking the bot** deletes what it stored on the server. The confirmation
  shows how much will be deleted.
- **Revoking `server_storage`** blocks access but keeps the data. Whoever can
  manage bots deletes it in **Bot settings → Storage → On the server**.
- **Revoking `device_storage`** stops new requests. Data already written stays
  on the computers, and each person decides whether to delete it.
- Monky never deletes data from a computer remotely. In **Settings → Bot
  tools → Bot data on this computer**, the person sees everything miniapps
  kept, including from servers and bots they no longer use, and deletes what
  they want.

## Compatibility

Storage requires a server and a client with protocol version 39 (the
`bot-storage` feature). With an older server, `bot.storage()` rejects with
`FEATURE_REQUIRES_UPDATE` and miniapps get no storage. Older clients do not
see the new capabilities or the **Storage** tab.
