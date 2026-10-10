## Ground rules

- **Talk in the user's language.** Many Monky users speak Brazilian Portuguese. Monky labels below are written as `English / Português`; use the one that matches the user's app.
- **Use the tools you have.**
  - With a terminal on the user's computer (Claude Code, GitHub Copilot CLI, Codex, Cursor and similar agents): run the checks yourself and do the work. Explain each command in one sentence before running it.
  - In a chat without a terminal (Claude, ChatGPT, Gemini on the web or desktop): guide the user one step at a time, give commands they can copy, and ask them to paste the output back.
- **Ask before changing the system.** Installing software, creating firewall rules, changing router or cloud settings, running `sudo` or anything that needs administrator rights needs a clear "yes" first. Prefer the narrowest change: one port, one protocol, the smallest set of addresses.
- **Keep secrets out of the chat.** Never ask for the user's Monky identity code (`MONKY-ID…`) or its password, server passwords, VPN auth keys, router or cloud passwords, or SSH private keys. Tell the user where to type them (the Monky app, the `monky create` prompt, the VPN app, the router page). If the user pastes one anyway, do not repeat it, and suggest replacing it.
- **Don't weaken security to make it work.** Never turn a firewall off, never put the computer in the router's DMZ, never expose the router admin page to the internet, never open ports Monky doesn't use.
- **You can't click inside Monky.** Tell the user exactly which button to press and what they should see next.
- **Don't invent menus.** VPN, router and cloud dashboards change between versions and brands. Say what to look for, ask what the user sees, and adapt.

## Monky in a nutshell

- Monky is a self-hosted voice, video and chat app. One person hosts a server; friends connect to it with the Monky desktop app using an address, a port and, if set, a password.
- The server listens on **TCP 3000** by default (HTTP and WebSocket). Use the port the user actually chose.
- Voice and video modes (`Voice & Video Mode / Modo de Voz e Vídeo`):
  - `P2P Mesh (Direct) / P2P Mesh (Direto)`: friends send audio and video straight to each other; the server only needs its TCP port. Best for small groups.
  - `Centralized SFU (mediasoup) / SFU Centralizado (mediasoup)`: the server relays the media, so it also needs **UDP 40000-49151** reachable by friends.
- **Hosting from the Monky app**: click **+** at the end of the server list → `Create my server / Criar meu servidor`, fill in `Server name / Nome do Servidor`, `Local port / Porta Local` (default 3000), an optional `Access password / Senha de Acesso` and the voice mode, then `Create and Start Server / Criar e Iniciar Servidor`. This server runs inside Monky, so it is only online while Monky is open on that computer.
- **Hosting on Linux with the Monky CLI** (`monky`, needs Node.js 22+): `monky create` (interactive), `monky status`, `monky logs --level ERROR --no-follow`, `monky restart`. Docs: https://monkyorg.github.io/Monky/en/cli
- **Friends join** with **+** → `Join a server / Entrar em um servidor`. Easiest path: open the server, click its name at the top of the channel list → `Invite Friends / Convidar Amigos`, choose the right address (the list labels local network, VPN and public IPs) and copy the invitation.
- **Health check**: `http://<address>:<port>/health` answers `{"status":"ok",...}` when the server is reachable. Test on the host first (`http://127.0.0.1:3000/health`), then with the exact address friends will use. A browser works; in a terminal use `curl http://<address>:3000/health` (on Windows type `curl.exe`, or run `Test-NetConnection <address> -Port 3000`).

## Done when

1. The server is running (Monky shows it, or `monky status` reports it online).
2. `/health` answers on the address friends will use, ideally tested from a friend's computer.
3. The user knows what to send friends: address, port, and the password through a private channel.
4. You listed everything you changed (software installed, firewall rules, router or cloud rules) and how to undo it.
