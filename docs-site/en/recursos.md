# What Monky offers

Monky is a communication app with servers you can host yourself. The user
guides and screenshots on this site describe the desktop client for Windows
and macOS; you do not need to program or install a bot to talk.

## Conversations and media

- **Chat:** server-side history, replies, mentions, reactions, code, attachments,
  emojis and stickers from a local folder.
- **Voice:** P2P or SFU WebRTC, speech detection, PTT, mute/deafen and individual
  participant/device volume.
- **Local audio:** RNNoise, Speex, GTCRN or WebRTC noise suppression, microphone
  testing and per-category outputs.
- **Video:** camera, background effects and screen/window sharing; shared
  audio depends on the platform and source.
- **Soundboard:** local library, favorites, search, keybinds and server-controlled
  permissions.

See [Chat, voice and media](/en/usando-o-app) and [Settings](/en/configuracoes).
Economy, Normal, High Quality, Gaming, Ultra and Custom profiles configure
transmission; they do not guarantee a frame rate on every device.

## Servers and community

Connect to several servers at once and switch the conversation you view
without dropping a call on another server. Local network discovery,
saved servers and favorites are available.

Administrators can create public/private channels, configure roles, moderate
members, control features and inspect metrics and protected logs. Member
limits count registrations, not just online people.

Start with [Create in the app](/en/criar-seu-servidor). For continuous
operation, use the [CLI](/en/cli) and [VPS guide](/en/hospedar-em-vps).

## Bots and miniapps

Bots can provide commands, private forms, polls, audio previews, authorized
downloads, audio publication and shared miniapps. Server administrators
approve capabilities; tasks on your computer require separate consent.

| I want to… | Guide |
| --- | --- |
| Add or use an existing bot | [Use bots](/en/bots) |
| Program my first command | [Your first bot](/en/bots-desenvolvimento) |
| Look up properties, methods and events | [SDK reference](/en/bots-api) |

## Where data travels

| Feature | Path |
| --- | --- |
| Identity and personal preferences | Local profile; protected export when requested |
| Chat, roles, channels and attachments | Server chosen by the group |
| P2P media | Directly between participants when possible; TURN can relay it |
| SFU media | Through the server, which forwards it to participants |
| Local bot tools | Consenting person's client; only operations implemented by Monky |

Self-hosting does not mean anonymity or end-to-end encryption for every
kind of content. Check the [architecture](/en/arquitetura), your host's
administrators and permissions before sharing sensitive information.
