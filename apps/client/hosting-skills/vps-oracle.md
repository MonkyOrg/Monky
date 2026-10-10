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
- **Shape**: one marked *Always Free-eligible*, such as `VM.Standard.E2.1.Micro` (AMD, 1 GB RAM) or `VM.Standard.A1.Flex` (Ampere ARM, more RAM). "Out of capacity" for Ampere is common: try again later, another availability domain, or the AMD shape.
- **Networking**: keep the default VCN and subnet with a **public IPv4 address**.
- **SSH key**: paste the user's public key, or let Oracle generate one and have the user save the private key. If they have none: `ssh-keygen -t ed25519` on their computer, then paste the `.pub` file.

Note the **public IP** shown on the instance page.

### 3. Open the ports in the cloud network

Instance page → the subnet → its **Security List** (usually "Default Security List") → **Add Ingress Rules**:

| Source CIDR | IP protocol | Destination port | When |
|---|---|---|---|
| `0.0.0.0/0` | TCP | `3000` | always |
| `0.0.0.0/0` | UDP | `40000-49151` | SFU mode |

If the instance uses a Network Security Group instead, add the same rules there. Keep the existing SSH (22) rule.

### 4. Open the ports in the VM firewall

Connect: `ssh ubuntu@<public-ip>` (`opc@` on Oracle Linux; add `-i <private-key>` if the key isn't the default one).

Oracle's Ubuntu images ship iptables rules that reject everything except SSH. Add Monky's ports at the top of the INPUT chain and save them so they survive reboots:

```bash
sudo iptables -I INPUT -p tcp --dport 3000 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 40000:49151 -j ACCEPT
sudo netfilter-persistent save
```

Don't switch these images to ufw: keep working with the existing iptables rules. On **Oracle Linux** (firewalld): `sudo firewall-cmd --permanent --add-port=3000/tcp --add-port=40000-49151/udp && sudo firewall-cmd --reload`.

Skip the UDP line if the server will use P2P mode.

<!-- include: shared/linux-cli.md -->

### Oracle Cloud notes

- **The VM disappeared or was stopped** → Oracle may reclaim Always Free instances it considers idle. Check Oracle's current Always Free policy; upgrading the account to Pay As You Go keeps Always Free resources free and avoids this.
