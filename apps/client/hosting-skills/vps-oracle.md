---
name: monky-server-vps-oracle
description: Hosts an always-on Monky voice and chat server on an Oracle Cloud Always Free VM with the Monky CLI, including the Security List ingress rules and the VM's iptables firewall. Use when the user wants a free 24/7 Monky server on Oracle Cloud.
---

# Monky server on Oracle Cloud (Always Free)

Oracle Cloud's Always Free tier includes small VMs with a public IP, so the server stays online 24/7 at no cost. Oracle blocks traffic twice: in the cloud network (Security List) and in the VM's own iptables rules. Your job: help create the VM, open Monky's ports in both places, install the Monky CLI, have the user create the server, and test from outside.

<!-- include: shared/common.md -->

## Steps

### 1. Account

The user creates the Free Tier account at https://www.oracle.com/cloud/free/ themselves (Oracle asks for a card to verify identity; Always Free resources are not charged). The **home region** can't be changed later: pick one close to the friends. Never fill in account or payment details for the user.

### 2. Create the VM

In the console: Compute → Instances → Create instance.

- **Image**: Ubuntu (LTS). Oracle Linux also works; its SSH user is `opc` and it uses firewalld (step 4).
- **Shape**: one marked *Always Free-eligible*. Prefer `VM.Standard.A1.Flex` (Ampere ARM) with 2 OCPUs and 12 GB, the current Always Free maximum for A1; `VM.Standard.E2.1.Micro` (AMD, 1 GB RAM) also works, with a swap file (see below). "Out of capacity" for Ampere is common: try again later or use the AMD shape. Check Oracle's current Always Free limits if the console offers different numbers.
- **Networking**: create a new virtual cloud network and public subnet (or keep an existing public one) with a **public IPv4 address**.
- **SSH key**: paste the user's public key, or let Oracle generate one and have the user save the private key. If they have none: `ssh-keygen -t ed25519` on their computer, then paste the `.pub` file.

Note the **public IP** shown on the instance page.

### 3. Open the ports in the cloud network

Instance page → the virtual cloud network → **Security** tab → **Default Security List** → **Security rules** → **Add Ingress Rules**:

| Source CIDR | IP protocol | Destination port | When |
|---|---|---|---|
| `0.0.0.0/0` | TCP | `3000` | always |
| `0.0.0.0/0` | UDP | `40000-49151` | SFU mode |
| `0.0.0.0/0` | TCP | `40000-49151` | SFU mode, for clients whose network blocks UDP |
| `0.0.0.0/0` | TCP | `7780-7781` | only when hosting MonkyBot (manifest and games) |

If the instance uses a Network Security Group instead, add the same rules there. Keep the existing SSH (22) rule. Other bots declare their own ports: run the bot's `requirements` command (for example `monkybot requirements`) before opening them.

### 4. Open the ports in the VM firewall

Connect: `ssh -i <private-key> ubuntu@<public-ip>` (`opc@` on Oracle Linux; on Linux/macOS run `chmod 400` on the key first).

Oracle's Ubuntu images ship iptables rules that reject everything except SSH. Add Monky's ports at the top of the INPUT chain and save them so they survive reboots:

```bash
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 40000:49151 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 40000:49151 -j ACCEPT
sudo netfilter-persistent save
```

Don't switch these images to ufw: keep working with the existing iptables rules. On **Oracle Linux** (firewalld): `sudo firewall-cmd --permanent --add-port=3000/tcp --add-port=40000-49151/udp --add-port=40000-49151/tcp && sudo firewall-cmd --reload`.

Skip the two 40000-49151 lines if the server will use P2P mode.

<!-- include: shared/linux-cli.md -->

### Optional: host a bot on the same VM (MonkyBot)

1. Open TCP `7780-7781` in the Security List (step 3) and in iptables: `sudo iptables -I INPUT -p tcp --dport 7780:7781 -j ACCEPT && sudo netfilter-persistent save`.
2. Install and set it up by URL: `curl -fsSL https://monkyorg.github.io/install-monkybot.sh | bash`, then `monkybot setup` (choose **Install by URL**, keep port 7780, enter the VM public IP as host; the user confirms the access notice) and `monkybot start`.
3. The user pastes the **Manifest** URL printed by `monkybot start` in Monky under `Server Settings → Bots → Link bot by URL / Configurações do Servidor → Bots → Vincular bot por URL` and reviews the requested capabilities.
4. So it survives reboots, run the `pm2 startup` command from the MonkyBot README for its own PM2 profile (`--hp "$HOME/.monkybot" --service-name pm2-monkybot`).

### Oracle Cloud notes

- **1 GB VM (E2.1.Micro)** → add the 2 GB swap file from the CLI section before installing; the server and a bot fit, but installs need the swap.
- **The VM disappeared or was stopped** → Oracle may reclaim Always Free instances it considers idle. Check Oracle's current Always Free policy; upgrading the account to Pay As You Go keeps Always Free resources free and avoids this.
