# Getting started

This guide takes you from the first launch to your first conversation. You
need the [installed app](/en/download) and a server address — or you can create
your own server directly in Monky.

## 1. Create or import your identity

On first launch, choose **Create new identity**. If you already use Monky on
another computer and want to keep the same account on your servers, choose
**Import existing identity** and use the backup exported from that device.

<AppScreenshot src="/screenshots/identidade-en.png" alt="Monky's first launch, offering Create new identity and Import existing identity." caption="Your identity replaces a central account. Creating another identity does not recover the previous one's roles or links." />

Next, enter your **nickname** and optionally choose an avatar. This profile is
global: it is used on every connected server and can be changed later under
**Settings → My Profile** without creating a new account.

### Keep an identity backup

Under **Settings → My Profile**, export your identity and choose a strong
password. Keep the file somewhere safe; do not share it or its password.
The public identity code is different from the backup that lets another
device use your account. Without a backup, creating a new identity does not
restore the previous one's access.

## 2. Choose how to connect

After creating the identity and profile, Monky opens **Home**. It has the
server rail on the left, the **Direct messages** list and the **Friends** page
with Available, All and Pending tabs. If no server is saved yet, the **+**
button on the rail is highlighted.

<AppScreenshot src="/screenshots/inicio-en.png" alt="Monky Home with the server rail, direct messages and Friends page." caption="Use the + button on the rail to create or join a server. Home remains available even with no connected servers." />

| Situation | Next step |
| --- | --- |
| Someone already hosts for the group | [Join a server](/en/entrar-em-um-servidor) |
| I want to host on my computer | [Create in the app](/en/criar-seu-servidor) |
| I need an always-on server | [Host on a VPS](/en/hospedar-em-vps) |

Saved servers connect in the background by default to keep friend presence and
direct messages working. Disable this under **Settings → My Profile →
Connections** if you prefer manual connections. The server marked **Join on
startup** still opens in the foreground.

## 3. Start a conversation

After connecting, choose a **text channel** to send a message. To start a call,
click a **voice channel**: connecting to a server does not automatically
enable your microphone.

The bottom controls let you mute your microphone, deafen and open settings.
Check your input device in **Voice and Video** before the first call. Use
headphones when testing microphone playback.

Continue with [Chat, voice and media](/en/usando-o-app). To resolve a connection
or audio failure, see [Troubleshooting](/en/solucao-de-problemas).

::: tip You do not need a bot to use Monky
Bots are optional. To use one already on your server, follow the
[bot guide](/en/bots); to program one, use the
[bot SDK documentation](/en/bots-desenvolvimento).
:::
