# AI integration through MCP

Monky Desktop can expose tools to MCP-compatible assistants such as Codex CLI. The assistant controls your identity on already connected server sessions. Monky must remain running, including while minimized.

## Connect an assistant

1. Open **Settings → AI integration** in the desktop app.
2. Turn on **Enable integration**. Monky displays its local URL.
3. Select **Add assistant**, enter a name, and choose the servers and allowed actions. Connect to a new server first to make it available here.
4. Save and copy the commands from **Connect to Codex CLI**. The credential is shown only on this screen.
5. Run the commands in the terminal where you will open Codex CLI. Start a new Codex session and use `/mcp` to check the connection.

The commands set an environment variable and run `codex mcp add` with `--url` and `--bearer-token-env-var`. The variable applies to the current terminal; in a different terminal, set it again using your saved credential or generate a new one. Your assistant client may have its own tool confirmations.

The transport is **Streamable HTTP** with bearer token authentication. The endpoint listens only on `127.0.0.1`; entirely cloud-hosted programs cannot access it directly. A local program can use a cloud model: information returned by tools may be sent to that model’s provider.

## Available tools

| Permission | Tools |
| --- | --- |
| Read information and history | `get_state`, `list_servers`, `list_channels`, `list_members`, `read_messages`, `list_events`, `get_call_state` |
| Send messages | `send_message` |
| Create events | `create_event` |
| Join and leave calls | `join_call`, `leave_call` |

`list_servers` returns a `sessionRef` for each authorized connection. Use it for subsequent operations; list the servers again after reconnecting. Operations do not change the visible server or channel. Reading history does not mark messages read.

Messages are plain text in channels, without attachments or bot commands. `send_message` requires a UUID in `clientMessageId`; reuse the same UUID when retrying the same attempt. The server must advertise `chat-delivery`, which prevents delivering the same attempt twice.

Events are one-off, without images or recurrence, using the app’s default audience. Supply start and end times as Unix epoch milliseconds, an IANA time zone such as `America/Sao_Paulo`, and a location. Listing includes scheduled and active events. The server must offer `server-community`, and your user must have permission to create events.

A newly joined call starts muted without capturing the microphone. You can manually unmute in the app. The assistant receives no audio. Explicitly leave any other active call before joining a new one. `leave_call` only ends the specified session and room, confirming local cleanup even during reconnection without waiting for a remote leave acknowledgement.

If a write returns `unknown_outcome`, check its destination before retrying: losing a response does not mean the action did not happen. Event creation is not automatically retried.

## Manage access

In the same tab, **Edit** changes servers and capabilities. **Generate new credential** invalidates the previous token; **Revoke access** prevents new calls and cancels pending operations. Actions already applied by the server are not undone. Server permissions continue to apply.

After changing permissions, reconnect the assistant to refresh its tool catalog.

**Recent activity** keeps the last 100 operations, including assistant, action, time and outcome. Message content and credentials are not recorded. Tokens are stored only as hashes inside the app profile.

The URL persists across restarts. If its port is occupied, select **Generate another URL** and update the assistant configuration. Monky Dev and normal installations have separate profiles, credentials and ports.

## Development validation

```powershell
npm run build
npm run test:mcp --workspace=apps/client
npm run start --workspace=apps/client
```

`test:mcp` checks contracts, authentication, cancellation, PT/EN settings, and a disposable server from the same branch with two P2P and SFU participants. It uses neither the physical microphone nor installed profiles. For manual validation, create a disposable server in Monky Dev and follow the assistant setup above; verify messages, events and calls before continuing publication.
