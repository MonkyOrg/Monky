---
description: "Read this before creating a server: why Monky doesn't work like Discord, where the server runs and how your friends can join."
---

# Frequently asked questions

Monky has channels, voice, roles and invites, so it's easy to assume it works
like Discord. But it doesn't work like Discord: **there is no Monky cloud**.
The server runs on the computer of someone in your group or on a VPS you
control. Read these answers before creating yours.

## Does Monky work like Discord?

No. It looks similar, but your group keeps the server running, not a company.

| Situation | Discord | Monky |
| --- | --- | --- |
| Where the server runs | On the company's infrastructure | On the creator's computer or on a VPS |
| The owner turns off their computer | Nothing changes | The server goes offline |
| Friends from another home join | The invite is enough | Invite **and** a route to the server: an open port, a VPN or a VPS |
| Account | Sign-up with email and password | Identity stored on your device, no sign-up |
| I lost my computer | Recover it by email | Only with your identity backup |
| Channel history | On the company's servers | On the host's server |

## Creating a server

### Do I need to create a server to use Monky?

No. If someone in your group already hosts one, just
[join their server](/en/entrar-em-um-servidor). To try the app, join
[Monky Community](https://monkyorg.github.io/Monky/en/convite/#~EYmDv64PTW9ua3kgQ29tbXVuaXR5),
the open community server. Only create a server if you will be the one hosting
for your group.

### I created a server, but my friends can't join. Why?

When you click **Create and Start Server**, Monky starts a server **on your
computer**. People on your network join right away. People on another internet
connection need a route to your machine, and your router blocks that by
default. Pick one option:

| Option | When to use it |
| --- | --- |
| Open the port on your router (port forwarding) | You can access your router and have your own public IP |
| A VPN such as Radmin VPN, Hamachi, ZeroTier or Tailscale | You don't want to or can't change your router; everyone joins the same VPN |
| [Host on a VPS](/en/hospedar-em-vps) | You want the server online all the time |

The invite carries the address and port, but it **doesn't open ports or set up
the VPN**. See [Open access over the internet](/en/criar-seu-servidor#open-access-over-the-internet).
If your ISP uses CGNAT, opening the port isn't enough; check
[how to know if you're behind CGNAT](/en/solucao-de-problemas#how-to-know-if-you-re-behind-cgnat).
New to these terms? See [what a VPN, a VPS and opening a port mean](#don-t-know-what-a-vpn-or-a-vps-is).

### Does the server stay online when I close Monky?

It depends on how you close it:

- **Closing the window:** by default, Monky stays in the system tray and the
  server stays online. Change this in **Settings › About and Updates ›
  Minimize to system tray on close**.
- **Quitting Monky:** the server stops and everyone is disconnected.
- **Shutting down, restarting or putting the computer to sleep:** the server
  goes offline.

When you open Monky again, the server doesn't come back on its own: right-click
its icon on the rail and choose **Start**. For a server that is always
available, use a [VPS](/en/hospedar-em-vps).

### Should I host on my computer or on a VPS?

| Aspect | In the app | On a VPS |
| --- | --- | --- |
| Availability | While your computer and Monky are running | 24 hours a day |
| Cost | Nothing beyond your internet and power | Whatever your provider charges |
| Setup | In the app, plus an open port or a VPN | With the [Monky CLI](/en/cli), on Linux |

### Where are my server's messages and channels stored?

On the machine that hosts the server. There is no copy in a Monky cloud: if that
machine loses its data, the server's history is lost with it.

### P2P or SFU: which should I choose?

Start with **P2P Mesh**, the default: voice and video go directly between
people and the server uses almost no bandwidth. **SFU** helps with large calls
and heavy streams, but it needs more open ports and more bandwidth from the
host. See [P2P and SFU](/en/criar-seu-servidor#voice-media-modes-p2p-mesh-vs-sfu).

## Don't know what a VPN or a VPS is?

They are the two most common ways to let your friends in without depending on
your router. Pick one; you don't need both.

### What is a VPN?

A VPN creates a private network over the internet: computers in different homes
see each other as if they were on the same local network. Everyone in the group
installs the same program, such as Radmin VPN, Hamachi, ZeroTier or Tailscale,
and joins the same network inside it. Then your friends connect to Monky using
the address the VPN shows for your computer.

It's free and doesn't require changing your router. The server is still on your
computer, so it still goes offline when you quit Monky.

::: warning Privacy VPNs won't work
Services that hide your IP while browsing, like the ones advertised for
watching content from other countries, don't put you and your friends on the
same network. Use one of the programs listed above.
:::

### What is a VPS?

A VPS is a computer you rent in a data center, running 24 hours a day with a
public address on the internet. You install the Monky server on it with the
[Monky CLI](/en/cli), and the server stays online even with your computer
turned off.

It is usually paid monthly and set up from the command line, on Linux. The
step-by-step guide is in [Host on a VPS](/en/hospedar-em-vps).

### What does opening a port mean?

It means setting up your router to forward to your computer the connections
that arrive from the internet on a port, `3000` by default. The option is in
your router's settings page, under names like *Port Forwarding* or *Virtual
Server*. Some ISPs use CGNAT and don't allow this forwarding; in that case, use
a VPN or a VPS.

## Account and identity

### Do I need to create an account or give an email?

No. The first time you open Monky, it creates an identity stored on your
device. There is no sign-up, email or central password.

### I changed or reformatted my computer. How do I recover my account?

Only with an [identity backup](/en/primeiros-passos#keep-an-identity-backup)
exported beforehand. Without it, there is no way to recover it: no company
keeps your account. A new identity is a new person to servers, and the roles
and friends of the old one don't come back.

### Can I use Monky on more than one computer?

Yes. Import the same identity on each computer. You can be connected to the
same server from up to 3 devices at once. See
[Several devices at once](/en/entrar-em-um-servidor#several-devices-at-once).

## Conversations and privacy

### Can the server host read the messages?

**Channel** messages are stored on the server, so whoever hosts it has access
to that data. In SFU mode, voice and video also pass through the server.
**Direct messages** are end-to-end encrypted, and the server only relays them
without storing them. See [Where data travels](/en/recursos#where-data-travels).

### Why is my direct message semi-transparent?

It hasn't been delivered yet. A direct message is only sent when you are both
online on at least one shared server; until then, it stays on your computer.
See [Friends and direct messages](/en/amigos-e-mensagens-diretas#chat).

## Other questions

### Is Monky free?

Yes. The app is free and open source. Hosting on a VPS may cost whatever your
chosen provider charges.

### Which systems does Monky run on?

The app is available for Windows and macOS. See [Download](/en/download).

### Where can I get help or report a problem?

- Check [Troubleshooting](/en/solucao-de-problemas).
- Ask on
  [Monky Community](https://monkyorg.github.io/Monky/en/convite/#~EYmDv64PTW9ua3kgQ29tbXVuaXR5).
- Report bugs in
  [Discussions › Bug Reports](https://github.com/MonkyOrg/Monky/discussions/categories/bug-reports)
  and suggest ideas in
  [Discussions › Ideas](https://github.com/MonkyOrg/Monky/discussions/categories/ideas).
