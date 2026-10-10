---
name: monky-server-vps-generic
description: Hosts an always-on Monky voice and chat server on a rented Linux VPS (Hetzner, DigitalOcean, Linode, Vultr and similar) with the Monky CLI, opening the provider and VM firewalls. Use when the user wants a 24/7 Monky server on a VPS from any provider.
---

# Monky server on a Linux VPS

The server runs on a small rented Linux machine with a public IP, online 24/7 even when the user's computer is off. Your job: help pick and create the VPS, open Monky's ports in the provider's firewall and the VM firewall, install the Monky CLI, have the user create the server, and test from outside.

<!-- include: shared/common.md -->

## Steps

### 1. Choose and create the VPS

The user signs up and creates the VPS in the provider's panel (never fill in account or payment details for them). Suggest:

- The smallest plan is enough for a group of friends (1 vCPU, 1-2 GB RAM).
- **Ubuntu LTS** or **Debian** image, a region close to the friends, and a public IPv4 address.
- An **SSH key** instead of a password. If the user has none: `ssh-keygen -t ed25519` on their computer, then paste the **public** key (`.pub`) into the panel. The private key never leaves their computer.

### 2. Connect over SSH

`ssh <user>@<public-ip>` (many providers use `root`; the panel shows the default user). On Windows this works in PowerShell. If you have a terminal, you can run the following steps through this SSH session, except `monky create`.

Optionally update the system first (ask): `sudo apt-get update && sudo apt-get -y upgrade`.

### 3. Open the provider's firewall

Some providers filter traffic before it reaches the VM (cloud firewalls, security groups). If one is attached to the VPS, allow inbound **TCP 3000** and, for SFU, **UDP 40000-49151**, from anywhere. Keep the existing SSH rule.

### 4. Open the VM firewall

Check `sudo ufw status`:

- **Active** → `sudo ufw allow 3000/tcp` and, for SFU, `sudo ufw allow 40000:49151/udp`.
- **Inactive** → nothing is blocking. If the user wants it on, allow SSH **before** enabling it, or they'll be locked out: `sudo ufw allow OpenSSH`, the rules above, then `sudo ufw enable`.
- **firewalld** (Rocky, Alma, Fedora): `sudo firewall-cmd --permanent --add-port=3000/tcp --add-port=40000-49151/udp && sudo firewall-cmd --reload`.

<!-- include: shared/linux-cli.md -->
