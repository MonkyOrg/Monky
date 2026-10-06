# Relay de mídia (TURN)

Por padrão, a voz e o vídeo do Monky trafegam **direto entre os participantes**
(P2P). O servidor só intermedeia a apresentação inicial. Isso é ótimo: menos
latência e banda quase zero para quem hospeda.

O problema pode aparecer quando membros estão atrás de **CGNAT** — comum em
internet móvel e em boa parte dos provedores residenciais no Brasil. Nesse
cenário, dependendo do NAT e do firewall, os dois lados não conseguem uma
rota direta, mesmo que cada um conecte normalmente com os demais.

O **TURN** oferece um caminho alternativo: o servidor **repassa a mídia**
desse par. O WebRTC tenta usar a conectividade direta quando possível; o relay
também precisa estar alcançável e com portas e credenciais corretas.

::: info Esta página vale para o modo P2P Mesh
No [modo SFU](/criar-seu-servidor#modos-de-voz-e-midia-p2p-mesh-vs-sfu) cada
participante envia mídia ao servidor, em vez de diretamente aos outros.
O TURN integrado do Monky é oferecido somente para P2P: o app e o CLI recusam
habilitá-lo junto com SFU. Isso não dispensa uma rota acessível até o servidor.
Se a mídia SFU não flui, confira IP anunciado, processo e
[portas do SFU](/hospedar-em-vps#abrindo-as-portas-do-modo-sfu), em vez de
tentar habilitar uma combinação não suportada.
:::

## Requisitos

- Host **Linux** com IP público (uma VPS típica). O Monky só gerencia a
  instalação e execução desse relay no Linux; não oferece esse controle
  no Windows ou macOS.
- **Portas abertas** no firewall (veja abaixo).
- Banda no host: cada par relayado consome upload **e** download do servidor.

## Portas necessárias

| Porta | Protocolo | Função |
|---|---|---|
| `3478` | **TCP** | Porta de escuta do TURN (sinalização e allocate) |
| `3478` | **UDP** | Porta de escuta do TURN (sinalização e allocate) |
| `49152-65535` | **UDP** | Range de portas para relay de mídia |

::: warning O processo online não comprova o caminho de mídia
Libere os transportes da configuração acima para atender redes com restrições
diferentes. Alocação e tráfego são etapas distintas: a porta 3478 pode responder
enquanto a faixa de relay continua bloqueada. Confira a reprodução de mídia,
não apenas se o processo está rodando.
:::

## Abrindo portas no Linux

### 1. Firewall do provedor (painel web)

A maioria dos provedores de VPS (Oracle Cloud, AWS, Azure, GCP, Hetzner) tem um
firewall **fora** da máquina, no nível da rede. Esse firewall precisa ser
configurado **no painel web** do provedor — não basta mexer no `iptables`.

#### Oracle Cloud (OCI)

1. Acesse o console da Oracle Cloud
2. Vá em **Networking → Virtual Cloud Networks**
3. Clique na **VCN** da sua instância
4. No menu lateral, clique em **Security** (ou Subnets → sua subnet → Security List)
5. Clique na **Security List** associada
6. Clique em **Add Ingress Rules** e adicione 3 regras:

| Source CIDR | IP Protocol | Destination Port Range |
|---|---|---|
| `0.0.0.0/0` | UDP | `3478` |
| `0.0.0.0/0` | TCP | `3478` |
| `0.0.0.0/0` | UDP | `49152-65535` |

7. Salve

#### AWS (EC2)

1. Acesse o console da AWS → **EC2 → Security Groups**
2. Selecione o Security Group da sua instância
3. Aba **Inbound rules → Edit inbound rules**
4. Adicione as mesmas 3 regras (Custom UDP/TCP, source `0.0.0.0/0`)

#### Outros provedores

Procure por "Security Groups", "Firewall Rules" ou "Network ACL" no painel do
seu provedor. A lógica é a mesma: abrir as portas 3478 TCP/UDP e o range
49152-65535 UDP para qualquer origem.

### 2. Firewall do Linux (iptables)

Mesmo com o firewall do provedor aberto, o Linux pode ter regras próprias.
Execute:

```bash
# Abrir as portas
sudo iptables -I INPUT -p udp --dport 3478 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 3478 -j ACCEPT
sudo iptables -I INPUT -p udp --dport 49152:65535 -j ACCEPT

# Persistir (sobrevive a reboot)
sudo netfilter-persistent save
```

Esse comando pressupõe `netfilter-persistent` instalado e configurado.
Em outras distribuições, use o mecanismo de persistência do firewall local.

::: tip Se usar `ufw` em vez de `iptables`
```bash
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:65535/udp
```
:::

::: tip Se usar `firewalld` (CentOS/RHEL)
```bash
sudo firewall-cmd --permanent --add-port=3478/tcp
sudo firewall-cmd --permanent --add-port=3478/udp
sudo firewall-cmd --permanent --add-port=49152-65535/udp
sudo firewall-cmd --reload
```
:::

## Ativando o relay

::: warning Não reutilize o coturn de outro serviço
O Monky inicia sua própria instância. A instalação automática e o helper do
repositório tentam desativar o serviço coturn da distribuição para liberar
a porta 3478. Se outra aplicação depende desse serviço, planeje um host
separado antes de continuar; não pare um relay compartilhado.
:::

```bash
monky config set turn true
monky restart
```

O Monky tenta instalar coturn pelo gerenciador de pacotes da distribuição
quando necessário. Isso exige root ou `sudo` não interativo já autorizado;
o processo não abre um prompt de senha. Também é possível ativar em
**Configurações do Servidor → Recursos de Voz e Vídeo** no app.

### Instalação manual do coturn

Sem esses privilégios, prepare o host antes. Em **Debian/Ubuntu com systemd**,
num host dedicado ao relay do Monky:

```bash
sudo apt-get update
sudo apt-get install -y coturn
sudo systemctl disable --now coturn
command -v turnserver
```

Em outras distribuições, use o pacote `coturn` e o gerenciador de serviços
correspondentes. Depois volte a `monky config set turn true` e `monky restart`
com **o mesmo usuário que administra o servidor**, sem executar o Monky
inteiro como root.

Se você clonou o repositório, há também um helper. Execute a partir da raiz
do checkout:

```bash
sudo bash scripts/install-turn.sh
```

Esse arquivo **não acompanha a instalação global do CLI**. O caminho acima
não funciona em uma pasta arbitrária após `npm install -g`.

## Verificando se está funcionando

### Via CLI

```bash
monky status
```

Na seção **Relay TURN**, deve aparecer:

```
turn: sim
coturn: instalado
porta: 3478
status: ✔ acessível
```

Se aparecer `⚠ porta bloqueada`, revise os firewalls acima.

### Via rede (de outra máquina)

```bash
# Verifica se a porta está respondendo
nc -zv SEU_IP 3478
```

Isso testa somente a conexão **TCP**. Não confirma o transporte UDP, a faixa
de relay nem uma chamada completa entre duas redes.

### No próprio servidor

```bash
# Verifica se o coturn está escutando
sudo ss -tlnup | grep 3478
```

### No app

Um participante conectado via relay ganha um ícone âmbar `swap_horiz` ao lado
do nome, tanto no palco quanto na lista do canal de voz. Se ninguém mostrar o
ícone, ou todos estão conectando direto (cenário ideal) ou o relay não subiu —
confira com `monky logs`.

## Troubleshooting

| Sintoma | Causa provável | Solução |
|---|---|---|
| `monky status` mostra `⚠ porta bloqueada` | Porta 3478 fechada no firewall do provedor ou do Linux | Siga os passos de abertura de porta acima |
| coturn sobe mas ninguém conecta via relay | Falta `external-ip` no config (VPS com NAT) | Atualize para v4.13.2+ — a detecção é automática |
| `monky status` mostra `coturn: indisponível` | coturn não está instalado | Siga a [instalação manual](#instalacao-manual-do-coturn) |
| O botão TURN está esmaecido no app | Servidor não é Linux, ou versão antiga | Atualize o servidor; TURN só funciona em Linux |
| Chamada conecta mas com muita latência | Normal para relay — a mídia passa pelo servidor | Considere uma VPS mais próxima dos membros |

## Desligando

```bash
monky config set turn false
monky restart
```

O coturn permanece instalado mas não é iniciado. Nenhuma porta extra precisa
ficar aberta.

## Como funciona por baixo

O Monky usa o [coturn](https://github.com/coturn/coturn), o servidor TURN de
referência. Ao ligar o relay:

1. O Monky gera um **shared secret** aleatório e persiste no banco
2. No boot, detecta o **IP público** da VPS (via ipify.org) e o **IP local** da
   NIC
3. Gera o `turnserver.conf` com a diretiva `external-ip=PÚBLICO/PRIVADO` — sem
   isso, em VPS com NAT (Oracle, AWS, etc.), o coturn anuncia o IP privado e os
   relay candidates ficam inalcançáveis
4. Spawna o coturn como processo filho
5. Verifica se a porta 3478 está escutando e, se possível, se está acessível
   externamente
6. No login de cada cliente, gera **credenciais efêmeras** (TURN REST API) com
   validade de 12 horas
7. O WebRTC do cliente tenta a rota direta e só usa o relay se necessário
