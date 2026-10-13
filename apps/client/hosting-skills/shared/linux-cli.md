### Install Node.js 22+ and the Monky CLI

Run these on the server, over SSH.

1. Check Node.js: `node --version`. The CLI needs **22 or newer** (mediasoup, used by SFU mode, requires it).
2. If Node.js is missing or older, install it with **nvm**: it installs per user, so `npm install -g` works without `sudo`. Use the current install command from https://github.com/nvm-sh/nvm#installing-and-updating, open a new shell, then run `nvm install 22`. (Node.js from the system package manager also works, but global npm installs then need `sudo` or a user-owned npm prefix.)
3. Install the CLI with the official installer, which checks the Node.js version and installs the latest stable `monky`:

   ```bash
   curl -fsSL https://monkyorg.github.io/install.sh | bash
   ```

4. Confirm: `monky --version`.

If the install fails while building **mediasoup**, install build tools (`sudo apt-get install -y build-essential python3`) and run the installer again. On machines with 1 GB of RAM, add a swap file first:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

### Create the server (the user types the secrets)

1. The server owner is the identity used here. In the Monky desktop app the user opens `Settings → My Profile → Export identity / Configurações → Meu Perfil → Exportar identidade` and generates their identity code (`MONKY-ID…`), protected by a password they choose.
2. `monky create` is interactive: it asks for the data folder (the default is fine), the identity code, the identity password, the server name, the port, an optional server password, an optional member limit and the voice mode, then offers to start the server.
3. **Ask the user to run it themselves in their own SSH window**, so the identity code and passwords never pass through you. Do not run `monky create` from a non-interactive shell and never pass `--identity`. You may suggest non-secret flags to skip questions, for example:

   ```bash
   monky create --name "Friends" --port 3000 --voice-mode sfu
   ```

   Use `--voice-mode sfu` only if the UDP range 40000-49151 is open in every firewall; otherwise use `p2p`. A VPS has the bandwidth to relay media, so SFU is usually the better choice there.
4. Accept the offer to start it. The CLI keeps the server running in the background with PM2.

### Verify and connect

1. On the server: `monky status` and `curl http://127.0.0.1:3000/health`.
2. From the user's computer: `http://<public-ip>:3000/health`. If it answers on the server but not from outside, a firewall is still closed (cloud rules or the VM firewall).
3. In Monky the user clicks **+** → `Join a server / Entrar em um servidor` with the public IP, the port and the server password. They join as the owner because the server was created with their identity.
4. Useful later: `monky logs --level ERROR --no-follow` (recent errors), `monky restart`, `monky update`.

### Troubleshooting

- **Timeout from outside, works on the server** → the TCP port is closed in the provider's firewall or in the VM firewall.
- **Joins, but voice never connects in SFU mode** → UDP 40000-49151 is closed somewhere. Open it, or switch to P2P with `monky config set voiceMode p2p` and `monky restart`.
- **`npm install -g` fails with EACCES** → Node.js came from the system packages. Install Node.js with nvm as described above instead of running the installer with `sudo`.
- **`monky` not found after logging in again** → open a new shell or run `source ~/.bashrc` so nvm loads.
