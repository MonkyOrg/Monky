---
layout: home
title: Documentation
hero:
  name: Monky
  text: Talk. Host. Build.
  tagline: From your first connection to your own bot. Find the right path to use Monky, manage your server and build integrations.
  image:
    src: /logo.png
    alt: Monky
  actions:
    - theme: brand
      text: Download Monky
      link: /en/download
    - theme: alt
      text: Get started
      link: /en/primeiros-passos
    - theme: alt
      text: Develop a bot
      link: /en/bots-desenvolvimento
features:
  - title: Use the app
    details: Join a server, chat over text or voice and share your screen. Illustrated guides, with no programming required.
    link: /en/primeiros-passos
    linkText: Open the getting started guide
  - title: Manage your server
    details: Host from the app or on a VPS. Organize channels, roles, permissions and connectivity.
    link: /en/criar-seu-servidor
    linkText: Choose how to host
  - title: Develop bots
    details: Build commands, forms, polls, audio and miniapps with Monky's TypeScript bot SDK. Tutorials and a complete API reference.
    link: /en/bots-desenvolvimento
    linkText: Create your first bot
---

## A place for your group

Monky brings chat, voice, video and screen sharing together on servers hosted
by you or someone in your group. No central account is required: your identity
stays on your device.

<AppScreenshot src="/screenshots/conversa-en.png" alt="Monky showing text and voice channels, a conversation and a demo server's member list." caption="The app in use. Screenshots in this guide use the official Windows client with demo profiles and data." />

## Find what you need

| I want to… | Start here |
| --- | --- |
| Download the app | [Download for Windows and macOS](/en/download) |
| Join my friends | [Identity and getting started](/en/primeiros-passos) |
| Adjust my microphone or camera | [App settings](/en/configuracoes) |
| Add or use an existing bot | [Bots for users and administrators](/en/bots) |
| Build a bot | [Bot SDK tutorial](/en/bots-desenvolvimento) |
| Look up a method or type | [Bot SDK reference](/en/bots-api) |
| Fix a problem | [Troubleshooting](/en/solucao-de-problemas) |

## How it works

1. Someone hosts from the app or on a VPS.
2. Other people join using that server's address and port.
3. The server maintains channels, permissions and text history. Media uses WebRTC.

In **P2P Mesh**, media travels directly between participants when the network
allows it; a **TURN relay** can help when there is no direct route. In **SFU**
mode, the server receives and forwards media. This changes network requirements,
bandwidth usage and who can access the media — see
[P2P and SFU](/en/criar-seu-servidor#voice-media-modes-p2p-mesh-vs-sfu).

For internal implementation details, see the [architecture](/en/arquitetura).
