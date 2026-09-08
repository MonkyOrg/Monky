# Monky CLI

Ferramenta de linha de comando para criar e administrar servidores Monky.

```
monky <comando> [subcomando] [opções]
```

O CLI é instalado globalmente e não depende do diretório em que você está: ele
mantém um registro dos servidores desta máquina em `~/.monky/servers.json` e
usa esse registro para saber a qual servidor cada comando se aplica.

## Instalação

Requer **Node.js 22 ou superior** (exigência do mediasoup, usado no modo SFU).

```bash
curl -fsSL https://monkyorg.github.io/install.sh | bash
```

Para instalar uma versão beta:

```bash
curl -fsSL https://monkyorg.github.io/install.sh | bash -s -- --beta
```

<details>
<summary>Instalação manual (sem o script)</summary>

Baixe o `.tgz` da versão desejada em
[Releases](https://github.com/MonkyOrg/Monky/releases) e instale com:

```bash
npm install -g --allow-scripts=mediasoup https://github.com/MonkyOrg/Monky/releases/download/vX.Y.Z/monky-cli-X.Y.Z.tgz
```

O `--allow-scripts=mediasoup` libera o `postinstall` do mediasoup, que compila o
worker do SFU. A partir do npm 12 os scripts de instalação são bloqueados por
padrão, e sem esse binário o servidor sobe mas o modo SFU não funciona: as
chamadas ficam sem mídia e o cliente fica tentando reconectar até o worker subir.
Em versões de npm anteriores à 11.16 o parâmetro é desnecessário e pode ser
omitido.

</details>

Para rodar o servidor como daemon (`monky start`), o CLI usa o
[PM2](https://pm2.keymetrics.io/). Se ele não estiver instalado, `monky start`
instala automaticamente. Os demais comandos apenas avisam:

```bash
npm install -g pm2
```

## Início rápido

```bash
monky create     # cria o servidor e oferece iniciá-lo
monky status     # confere se está no ar
monky logs       # acompanha os logs
```

## Múltiplos servidores

Uma mesma máquina pode hospedar quantos servidores quiser — cada um com sua
pasta de dados, sua porta e seu processo PM2 próprio.

Quando existe **um único** servidor, os comandos agem sobre ele diretamente.
Quando existe **mais de um**, o CLI pergunta qual você quer usar:

```
Há 2 servidores Monky nesta máquina.
Qual servidor deseja reiniciar?
❯ Amigos — porta 3000 — /srv/monky-amigos
  Trabalho — porta 3100 — /srv/monky-trabalho
```

Em scripts e cron (terminal não interativo) a pergunta não é possível, então
informe `--data` explicitamente:

```bash
monky --data /srv/monky-amigos restart
```

## Opções globais

| Opção | Descrição |
|---|---|
| `--data <pasta>` | Pasta de dados do servidor alvo. Obrigatório quando há vários servidores e o terminal não é interativo. |
| `--help`, `-h` | Exibe a ajuda. |

## Estrutura da pasta de dados

| Caminho | Conteúdo |
|---|---|
| `server.db` | Banco SQLite: membros, cargos, canais e mensagens. |
| `monky.json` | Porta do servidor. |
| `ecosystem.config.cjs` | Configuração do PM2, regravada a cada `start`/`restart`. |
| `attachments/`, `avatars/`, `icons/` | Arquivos enviados. |
| `auto-update.cjs` | Criado apenas quando o auto-update está ligado. |

## Códigos de saída

| Código | Significado |
|---|---|
| `0` | Sucesso. |
| `1` | Erro. A mensagem é impressa em `stderr`. |

---

# Referência de comandos

## `monky create`

Cria um novo servidor: prepara o banco, define o dono e salva a porta.
Substitui o antigo `monky bootstrap`, que continua funcionando como apelido.

```bash
monky create [opções]
```

O comando é interativo e pergunta, nesta ordem:

1. **Onde guardar os dados** — sugere `./data`, mas você pode informar qualquer
   caminho. Se já houver um servidor na pasta escolhida, ele pede outra.
2. **Código de identidade do dono** (`MONKY-ID:...`) — exporte pelo app Monky em
   *Configurações → Identidade → Exportar*.
3. **Senha da identidade** — a que você definiu ao exportar.
4. **Nickname do dono**
5. **Nome do servidor**
6. **Porta do servidor** (padrão: `3000`)
7. **Senha do servidor** — deixe vazio para um servidor aberto.
8. **Limite de membros** — pergunta se você quer um teto de cadastros. O padrão
   é não ter limite.

Ao final, exibe um resumo, pede confirmação e oferece iniciar o servidor.

### Opções

| Opção | Descrição | Padrão |
|---|---|---|
| `--identity <código>` | Código de identidade do dono | perguntado |
| `--name <nome>` | Nome do servidor | `Servidor dos Amigos` |
| `--port <n>` | Porta do servidor | `3000` |
| `--password <senha>` | Senha do servidor (vazio = sem senha) | perguntado |
| `--max-users <n>` | Limite de membros cadastrados (`0` = sem limite) | perguntado |
| `--voice-mode <p2p\|sfu>` | Modo de voz e mídia (`p2p` ou `sfu`) | `p2p` |

A senha da identidade nunca é aceita por opção: ela é sempre digitada de forma
oculta no terminal.

### Exemplos

```bash
# Totalmente interativo
monky create

# Pasta definida por opção, o resto perguntado
monky create --data /srv/monky-amigos

# Não interativo, exceto a senha da identidade
monky create --data /srv/monky-amigos \
  --identity "MONKY-ID:..." \
  --name "Servidor dos Amigos" --port 3000 --password "senhaDoServidor"
```

---

## `monky list`

Lista os servidores desta máquina e o estado de cada um. Também aceito como
`monky ls`.

```bash
monky list
```

```
NOME       STATUS   PORTA  PASTA DE DADOS
Amigos     online   3000   /srv/monky-amigos
Trabalho   stopped  3100   /srv/monky-trabalho
```

---

## `monky start`

Inicia um servidor **já criado**, como daemon do PM2.

```bash
monky start [--port <n>] [--fresh]
```

Se não houver nenhum servidor na máquina, o comando falha e aponta o
`monky create` — ele nunca cria um servidor por conta própria.

Antes de subir, o arquivo `ecosystem.config.cjs` é regravado, então a porta e o
nome atuais valem a partir daí. Ele fixa também o caminho absoluto do Node que
executou o comando (veja [Trocar a versão do Node](#trocar-a-versao-do-node)).

### Opções

| Opção | Descrição | Padrão |
|---|---|---|
| `--port <n>` | Porta só para esta execução | valor de `monky.json`, ou `3000` |
| `--fresh` | Remove o registro do processo no PM2 e o recria do zero | desligado |

Para mudar a porta de forma permanente use `monky config set port`.

`--fresh` raramente é necessário: o CLI detecta sozinho um registro
desatualizado e recria o processo. Ele existe para forçar isso à mão. Os logs
em `~/.pm2/logs` **não** são apagados.

::: warning Opções removidas
`--password`, `--max-users`, `--name`, `--voice-channel` e `--text-channel` não
são mais aceitos aqui. Eles só tinham efeito na criação do banco e eram
silenciosamente ignorados em servidores já existentes. Hoje o comando falha
indicando a alternativa: `monky create` ou `monky config set`.
:::

---

## `monky stop`

Para o servidor, mantendo-o registrado no PM2.

```bash
monky stop
```

O processo continua listado no PM2 de propósito: removê-lo descartaria os logs
justamente quando eles mais importam, logo depois de uma queda ou parada.
`monky logs` continua funcionando com o servidor parado.

Os contadores de pessoas online (inclusive na página inicial e no monitor)
excluem bots e contam uma identidade apenas uma vez, mesmo conectada em vários
dispositivos. Pessoas invisíveis ainda contam para o aviso de desligamento:
elas continuam conectadas e também serão desconectadas.

Se houver gente conectada no momento, o CLI avisa quantas pessoas serão
desconectadas e pede confirmação antes de parar. Em terminal não interativo
(scripts, cron) o aviso é exibido e a parada segue normalmente.

---

## `monky restart`

Reinicia o servidor aplicando a configuração atual.

```bash
monky restart [--port <n>] [--fresh]
```

O `ecosystem.config.cjs` é regravado antes do reinício, então uma porta ou nome
alterados desde o último `start` passam a valer.

Assim como no `stop`, se houver gente conectada o CLI avisa e pede confirmação
antes de reiniciar.

`--fresh` funciona igual ao do `monky start`: descarta o registro do processo no
PM2 antes de subir de novo.

---

## `monky status`

Exibe o estado do servidor.

```bash
monky status [--data <pasta>]
```

Com um único servidor (ou com `--data`), mostra o detalhe:

```
Estado do servidor: Amigos
status: online
dataDir: /srv/monky-amigos
porta: 3000
processo PM2: monky-server-a1b2c3d4
pid: 21877
uptime: 2026-08-27T18:02:11.000Z
restarts: 0
memória: 88 MB
cpu: 0%
node: 24.20.0
```

O `status` não repete apenas o que o PM2 diz: a porta é sondada de verdade. O
PM2 informa o estado que ele *pretende* manter, e não um que ele verificou —
um processo que falhou ao iniciar continua listado como `online`. Quando o que
o PM2 afirma não corresponde à realidade, aparece um bloco de diagnóstico:

```
Diagnóstico
⚠ O PM2 está executando o servidor no Node 20.20.2, mas o Monky exige Node 22+.
  Atualize o Node, rode "monky update" para recompilar os módulos nativos e "monky restart" para aplicar.
⚠ O PM2 marca o processo como "online", mas ele não tem PID — ou seja, nunca chegou a iniciar.
  Normalmente o PM2 está tentando usar um Node que não existe mais. Rode "monky restart --fresh" para registrar o processo de novo.
```

Com vários servidores e sem `--data`, imprime a mesma tabela do `monky list` —
uma consulta não tem efeito colateral, então não faz sentido perguntar.

---

## Trocar a versão do Node {#trocar-a-versao-do-node}

O PM2 roda como um **daemon de vida longa** e guarda o Node com que foi
iniciado. Atualizar o Node não o atualiza junto, e é daí que vem a maior parte
dos problemas depois de um upgrade.

O que quebra não é atualizar o Node, e sim o **caminho do binário mudar ou
desaparecer**:

| Situação | O que acontece |
|---|---|
| Upgrade no lugar (apt/NodeSource, segue em `/usr/bin/node`) | Continua funcionando: o caminho existe e passa a apontar para o Node novo |
| Trocar de gerenciador (apt → nvm) e remover o antigo | **Quebra**: o PM2 aponta para um binário que não existe mais e não consegue iniciar o processo |
| `nvm use` outra versão, sem remover a antiga | **Silencioso**: o servidor continua rodando no Node **antigo** |

No segundo caso o PM2 mostra `status: online` com `pid: N/A`, e nada escuta na
porta — o cliente reclama que "o computador está online, mas nenhum servidor
Monky está ativo na porta". O `monky status` aponta isso no diagnóstico.

Desde a versão 8.1, o `ecosystem.config.cjs` fixa o **caminho absoluto** do Node
que executou `monky start`, em vez de deixar o PM2 resolver `node` pelo ambiente
do daemon. Como o arquivo é regravado a cada `start` e `restart`, ele se
reajusta sozinho.

### Procedimento recomendado

Depois de mudar a versão do Node:

```bash
monky update     # recompila os módulos nativos para o novo ABI
monky restart    # refixa o interpretador no ecosystem
pm2 save         # grava o estado bom no dump do PM2
```

::: tip Use `monky restart`, não `pm2 restart`
Só o `monky` regrava o `ecosystem.config.cjs`. O `pm2 restart` reaproveita o
registro anterior, com o interpretador antigo.
:::

::: warning `pm2 update` sozinho não resolve
O `pm2 update` restaura os processos a partir de `~/.pm2/dump.pm2`, e o dump
carrega o interpretador antigo. Se o servidor não voltar, recrie o registro:

```bash
monky restart --fresh
```

Isso descarta o processo no PM2 e o registra de novo. Os arquivos em
`~/.pm2/logs` são preservados.
:::

Módulos nativos são um problema **à parte**: `better-sqlite3` e o worker do
mediasoup são compilados contra o ABI do Node (20 = 115, 22 = 127, 24 = 137).
Qualquer troca de versão maior exige reinstalar o CLI, e é isso que o
`monky update` faz.

---

## `monky logs`

Exibe os logs do servidor iniciado com `monky start`.

```bash
monky logs [--lines <n>] [--level <nível>] [--no-follow]
```

### Opções

| Opção | Descrição | Padrão |
|---|---|---|
| `--lines <n>` | Quantidade de linhas anteriores a exibir | `100` |
| `--level <nível>` | Nível mínimo: `INFO`, `WARN` ou `ERROR` | sem filtro |
| `--no-follow` | Imprime e sai, em vez de seguir em tempo real | segue |

`--level` filtra por nível mínimo: `INFO` mostra tudo, `WARN` mostra avisos e
erros, `ERROR` mostra só erros. Linhas de continuação (como stack traces)
acompanham o nível da linha acima delas.

### Exemplos

```bash
monky logs                              # segue em tempo real (Ctrl+C para sair)
monky logs --lines 500                  # começa com as últimas 500 linhas
monky logs --level WARN                 # só avisos e erros
monky logs --level ERROR --no-follow    # imprime os erros recentes e sai
```

::: tip
`monky logs` lê os logs do PM2. Se o servidor estiver rodando dentro do app
Monky, use o **Monitor do Servidor** no próprio app (menu do servidor → Monitor
do Servidor).
:::

---

## `monky members`

Lista os membros do servidor e seus cargos.

```bash
monky members
monky members info <nickname|clientId>
```

`members info` exibe id, clientId, chave pública, datas de criação e último
acesso, se é o dono e a lista de cargos.

---

## `monky admin`

Concede ou remove o cargo Admin.

```bash
monky admin add [nickname|clientId]
monky admin remove [nickname|clientId]
```

Sem argumento, o comando lista os membros para você escolher.

---

## `monky roles`

Administra os cargos do servidor.

```bash
monky roles                       # lista
monky roles create [nome] [cor] [permissões]
monky roles assign [membro] [cargo]
monky roles unassign [membro] [cargo]
monky roles delete [cargo]
```

Sem argumentos, cada subcomando é interativo. As permissões podem ser passadas
por nome, separadas por vírgula. A cor usa o formato `#RRGGBB`. O cargo padrão
do servidor não pode ser removido de um membro.

---

## `monky config`

Exibe ou altera a configuração do servidor.

```bash
monky config                        # exibe tudo
monky config set                    # escolhe a chave interativamente
monky config set <chave> [valor]    # altera direto
```

### Chaves

| Chave | Descrição | Padrão |
|---|---|---|
| `name` | Nome do servidor (mínimo 2 caracteres) | `Servidor dos Amigos` |
| `password` | Senha de entrada. Vazio, `none` ou `clear` remove a senha | sem senha |
| `port` | Porta TCP | `3000` |
| `icon` | Caminho de uma imagem, copiada para a pasta de dados. Vazio ou `clear` remove | sem ícone |
| `maxUsers` | Máximo de membros cadastrados. `0` remove o limite | `20` |
| `allowSoundboard` | Permite o soundboard (`true`/`false`) | `true` |
| `allowEveryoneMention` | Permite `@todos`/`@everyone` no chat (`true`/`false`) | `true` |
| `maxAttachmentFileBytes` | Tamanho máximo por anexo, em bytes | sem limite |
| `maxAttachmentStorageBytes` | Espaço total para anexos, em bytes | sem limite |
| `voiceMode` | Modo de voz: `p2p` (mesh direto) ou `sfu` (Selective Forwarding Unit) | `p2p` |
| `autoUpdate` | Liga a atualização automática diária (`true`/`false`) | `false` |
| `turn` | Liga o relay de mídia TURN (`true`/`false`). Só em Linux, exige o coturn instalado | `false` |

Alterar `port` com o servidor no ar oferece reiniciar na hora para aplicar.
Alterar `turn` exige um `monky restart` manual.
Alterar `voiceMode` aplica dinamicamente e notifica todos os clientes conectados.

### Exemplos

```bash
monky config
monky config set name "Servidor dos Amigos"
monky config set voiceMode sfu      # ativa modo SFU com estimativa de capacidade
monky config set password           # digitada de forma oculta
monky config set password clear     # remove a senha
monky config set maxUsers 50
monky config set autoUpdate true
monky config set turn true          # ver "Relay de mídia (TURN)" abaixo
```

---

## Relay de mídia (TURN)

Por padrão, a voz e o vídeo do Monky trafegam **direto entre os participantes**
(P2P). Quando dois membros estão atrás de **CGNAT**, eles não conseguem se
enxergar e a chamada não conecta. O TURN resolve fazendo o servidor **repassar a
mídia** desse par.

::: tip Guia completo
Veja a [página dedicada do Relay TURN](/turn) com instruções detalhadas de
portas, firewall (Oracle Cloud, AWS, iptables, ufw), verificação e
troubleshooting.
:::

### Ativando

```bash
monky config set turn true
monky restart
```

O coturn é instalado **automaticamente** pela sua distro. Se o servidor não rodar
como root, rode uma vez: `sudo bash scripts/install-turn.sh`

### Portas necessárias

| Porta | Protocolo | Função |
|---|---|---|
| `3478` | TCP e UDP | Sinalização TURN |
| `49152-65535` | UDP | Relay de mídia |

Devem estar abertas **tanto no firewall do Linux quanto no painel do provedor**
(Oracle Cloud, AWS, etc.).

### Verificando

```bash
monky status    # deve mostrar ✔ acessível
```

### Desligando

```bash
monky config set turn false
monky restart
```

---

## Modo SFU (Selective Forwarding Unit)

Por padrão, o Monky opera em **P2P Mesh**: cada pessoa transmite seus streams diretamente para todos os participantes do canal. No entanto, se um anfitrião for compartilhar tela em 1080p 60fps para 20 pessoas, precisaria de ~120 Mbps de upload contínuo.

O modo **SFU** centraliza o encaminhamento de mídia via `mediasoup`. Quem compartilha envia **uma única vez** para o servidor, e o servidor replica o fluxo para os ouvintes/espectadores.

### Ativando via CLI

```bash
monky config set voiceMode sfu
```

O CLI calcula e exibe automaticamente uma **estimativa de capacidade** baseada na quantidade de cores da CPU, memória RAM do servidor e banda de upload.

### Portas necessárias para SFU

| Porta | Protocolo | Função |
|---|---|---|
| `40000-49151` | UDP e TCP | Portas de mídia WebRTC do worker mediasoup |

O range precisa estar aberto no firewall do servidor (Oracle Cloud, AWS Security Group, iptables/ufw) — em UDP e também em TCP, que é o caminho de quem está numa rede que bloqueia UDP. Os comandos prontos e como conferir estão em [Abrindo as portas do Modo SFU](/hospedar-em-vps#abrindo-as-portas-do-modo-sfu).

---

## `monky update`

Atualiza o Monky para a última versão publicada.

```bash
monky update [--beta] [--check] [--yes]
```

### Opções

| Opção | Descrição |
|---|---|
| `--beta`, `-b` | Considera também as prereleases |
| `--check` | Apenas verifica e sai, sem atualizar |
| `--yes`, `-y` | Não pergunta nada — para uso em scripts e no auto-update |

O comando baixa e instala o novo pacote com `npm install -g` a partir dos
artefatos da release no GitHub.

Ao final, o servidor é reiniciado (com confirmação, exceto com `--yes`).

### Exemplos

```bash
monky update --check           # há atualização estável?
monky update --check --beta    # e considerando betas?
monky update                   # atualiza para a última estável
monky update --beta            # atualiza para a última, incluindo betas
```

### Atualização automática

```bash
monky config set autoUpdate true
```

Registra no PM2 uma tarefa diária, às 4h, que roda `monky update --yes` para
aquele servidor. O canal segue a versão instalada: se você está numa beta, o
auto-update acompanha o canal beta.

Funciona em Linux, macOS e Windows. Para desligar:

```bash
monky config set autoUpdate false
```

---

## `monky destroy`

Apaga **permanentemente** todos os dados de um servidor.

```bash
monky destroy [--data <pasta>]
```

Remove o banco, anexos, avatares e configurações, encerra o processo PM2 e tira
o servidor do registro. Pede duas confirmações: digitar `DESTROY` e um "sim"
final. Só aceita pastas que realmente contenham um servidor Monky.

Se houver gente conectada, o aviso aparece antes das confirmações, informando
quantas pessoas serão desconectadas.

---

## Ver também

- [Hospedar em VPS](/hospedar-em-vps) — deixar o servidor no ar 24/7
- [Verificar Releases](/verificar-releases) — conferir a autenticidade dos downloads
