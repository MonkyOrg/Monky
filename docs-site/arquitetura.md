---
aside: false
pageClass: pagina-arquitetura
---

# Arquitetura

Como o Monky é construído por dentro: os componentes, como eles conversam e por
que as decisões foram tomadas desse jeito.

Esta página descreve o **que existe hoje no código**. Se você procura a
especificação original do projeto — com MVP, fases e ideias futuras —, ela está
em [`docs/especificacao-tecnica.md`](https://github.com/MonkyOrg/Monky/blob/main/docs/especificacao-tecnica.md).

## A ideia central: dois planos separados

Tudo no Monky parte de uma separação: **o que o servidor controla** e **o que
trafega direto entre as pessoas**.

<div class="diagrama">

![A ideia central: dois planos separados](./diagramas/pt/01-a-ideia-central-dois-planos-separados.claro.svg){.tema-claro}
![A ideia central: dois planos separados](./diagramas/pt/01-a-ideia-central-dois-planos-separados.escuro.svg){.tema-escuro}

</div>

O servidor cuida de login, canais, chat, cargos e **sinalização**. No modo
padrão, ele apresenta os participantes uns aos outros e sai da frente: voz,
vídeo e tela trafegam **P2P via WebRTC**, sem passar por ele.

Isso tem duas consequências que explicam quase todo o resto do projeto:

- **A banda do servidor quase não importa.** Ele não carrega mídia, então um VPS
  modesto aguenta o grupo. O custo de banda fica com os participantes.
- **A conversa não é legível pelo servidor.** Mesmo quem hospeda não consegue
  ouvir a chamada — o WebRTC é criptografado ponta a ponta entre os pares.

::: warning As duas consequências valem para o modo padrão
Quem hospeda pode trocar o plano de mídia para o [modo SFU](#topologia-2-sfu-selective-forwarding-unit), e aí as duas afirmações acima deixam de valer: o servidor passa a carregar toda a mídia do canal e a ter acesso ao conteúdo dela. O SRTP termina no `mediasoup`, que decifra os pacotes e os cifra de novo para cada destinatário — é assim que qualquer SFU funciona, e é o preço de não mandar o mesmo vídeo N vezes. Continua não existindo terceiro na jogada, já que o servidor é seu, mas o "nem quem hospeda consegue ouvir" é uma propriedade do P2P Mesh, não do Monky.
:::

## Os componentes

O repositório é um monorepo com workspaces npm:

| Workspace | O que é |
|---|---|
| `apps/client` | O app Electron — a interface, e também o anfitrião quando você hospeda pelo próprio app |
| `apps/server` | O servidor: WebSocket, SQLite e o [Monky CLI](/cli) |
| `packages/shared` | O contrato entre os dois: tipos do protocolo, validadores, limites e perfis de qualidade |

`packages/shared` é o que impede cliente e servidor de divergirem: os dois
importam os **mesmos** tipos e os **mesmos** validadores.

## O cliente

### Três processos

O Electron separa o app em três contextos, e o Monky respeita essa separação:

<div class="diagrama">

![Três processos](./diagramas/pt/02-tres-processos.claro.svg){.tema-claro}
![Três processos](./diagramas/pt/02-tres-processos.escuro.svg){.tema-escuro}

</div>

O renderer roda com `contextIsolation: true` e `nodeIntegration: false`: a
interface **não tem acesso ao Node**. Tudo que precisa do sistema operacional —
escolher uma tela para compartilhar, ler o módulo nativo de áudio, mexer na
bandeja — passa pela ponte `window.api` exposta pelo preload.

### A interface não usa framework

Talvez a decisão mais incomum do projeto: **o renderer é TypeScript e DOM puro**.
Não há React, Vue ou Svelte. As telas montam o próprio HTML com template strings
e se re-renderizam.

O estado fica em *stores* singleton que emitem eventos num barramento
(`appEvents`), e as telas se inscrevem no que lhes interessa:

<div class="diagrama">

![A interface não usa framework](./diagramas/pt/03-a-interface-nao-usa-framework.claro.svg){.tema-claro}
![A interface não usa framework](./diagramas/pt/03-a-interface-nao-usa-framework.escuro.svg){.tema-escuro}

</div>

### Os serviços

Cada responsabilidade grande do cliente vive em uma classe própria, em
`src/renderer/core/`:

| Serviço | Responsabilidade |
|---|---|
| `NetworkClient` | WebSocket, autenticação, heartbeat e reconexão |
| `WebRtcManager` | As conexões P2P: mesh, tracks, renegociação |
| `AudioProcessor` | Microfone, supressão de ruído, detecção de fala |
| `VideoService` | Captura compartilhada de câmera, efeitos locais e captura de tela |
| `ScreenAudioService` | Ponte do módulo nativo de áudio de tela para o WebRTC |
| `ParticipantManager` | Quem está online, em qual canal e com qual estado |
| `SoundboardService` | Sons e atalhos do soundboard |
| `KeybindService` | Atalhos globais |
| `AttachmentUploader` | Upload de anexos do chat |
| `UpdateService` | Verificação e aviso de atualização |

### O que fica salvo na sua máquina

O cliente usa `localStorage` para preferências simples, IndexedDB para os
efeitos e a imagem de fundo da câmera, e armazenamento nativo para a identidade.
São dados com finalidades e garantias diferentes.

<div class="diagrama">

![O que fica salvo na sua máquina](./diagramas/pt/04-o-que-fica-salvo-na-sua-maquina.claro.svg){.tema-claro}
![O que fica salvo na sua máquina](./diagramas/pt/04-o-que-fica-salvo-na-sua-maquina.escuro.svg){.tema-escuro}

</div>

| Chave | Conteúdo |
|---|---|
| `monky_settings` | Preferências: qualidade, dispositivos, volumes, atalhos, soundboard |
| `monky_nickname` / `monky_avatar` | Sua identidade visual |
| `monky_saved_servers` | Servidores que você salvou para reconectar |
| `monky_created_servers` | Servidores que você criou nesta máquina |
| `monky_favorites` | Favoritos locais de sons por caminho completo e de servidores por endereço/porta |
| `monky_device_id` | Identifica **este dispositivo** (permite a mesma pessoa em dois aparelhos) |
| `monky_language` | Idioma da interface |

No IndexedDB `monky-camera-effects`, preferências e uma imagem normalizada
ficam no mesmo registro transacional. A falha de persistência não troca a
preferência em memória; dados corrompidos não são interpretados como
consentimento para transmitir a câmera sem efeito.

A segmentação usa MediaPipe/Selfie Segmenter com modelo e WASM empacotados,
sem CDN ou envio de frames a uma API. Segmentação, composição e chroma key
rodam em um worker com `OffscreenCanvas`, com um frame em trânsito por vez.
O segmentador é criado sob demanda uma vez por worker e reutilizado entre
desfoque, cor, imagem e chroma; no chroma ele fica ocioso. Desativar os efeitos
ou encerrar a captura libera o worker e o modelo. Resolução e cadência seguem
o perfil selecionado. O limitador opcional, desligado por padrão, restringe
ambas a 1280 × 720 e 30 FPS, sem ampliar uma captura menor ou duplicar frames
para compensar limitações de captura ou processamento.
`CameraPublication` coordena substituições e falhas com os publishers
P2P/SFU; a captura pertence ao `VideoService`, não ao preview ou ao producer.

A **chave privada fica de fora dessa lista de propósito**. Ela é o que prova
quem você é (veja [Autenticação](#autenticacao-o-servidor-nunca-ve-uma-senha-sua))
e nunca chega ao renderer: mora em `identity.json`, na pasta `userData`, cifrada
com o `safeStorage` do Electron — o cofre do sistema operacional. Onde o sistema
não oferece cifragem, o arquivo é gravado em claro e o próprio registro diz qual
dos dois casos aconteceu.

## O servidor

### As três formas de rodar

O mesmo código de servidor sobe de três maneiras, e a diferença não é técnica —
é de quem cuida dele:

<div class="diagrama">

![As três formas de rodar](./diagramas/pt/05-as-tres-formas-de-rodar.claro.svg){.tema-claro}
![As três formas de rodar](./diagramas/pt/05-as-tres-formas-de-rodar.escuro.svg){.tema-escuro}

</div>

Hospedar **pelo app** é o caminho de dois cliques, e é por isso que o cliente
importa `@monky/server` diretamente: não há processo separado nem porta de
administração. O preço é que o servidor vive enquanto o app viver.

O **CLI** existe para o caso oposto — um servidor que não deveria depender de
alguém manter uma janela aberta. Ele administra vários servidores na mesma
máquina, cada um com sua pasta de dados e seu processo no PM2.

### Camadas

Não há container de injeção de dependência: a montagem é explícita, feita à mão
em `MonkyServer.create()`. Você consegue ler o arquivo e ver exatamente o que
depende do quê.

<div class="diagrama">

![Camadas](./diagramas/pt/06-camadas.claro.svg){.tema-claro}
![Camadas](./diagramas/pt/06-camadas.escuro.svg){.tema-escuro}

</div>

Além do WebSocket, o servidor expõe algumas rotas HTTP: `/health`, `/preview` e
`/invite-info` (informações públicas para a tela de convite), `/avatars/*` e o
upload/download de `/attachments`.

A porta padrão é a **3000**.

### O protocolo

Toda mensagem tem o mesmo formato:

```ts
{
  type: MessageType,     // 'CHAT_SEND', 'VOICE_JOIN', 'RTC_SIGNAL'…
  requestId?: string,    // volta na resposta, para correlacionar
  payload: T
}
```

O `requestId` é o que permite ao cliente saber qual resposta pertence a qual
pedido — o WebSocket é assíncrono e as respostas não chegam necessariamente na
ordem em que foram feitas.

A validação dos payloads usa **zod**, com os schemas em `packages/shared` —
os mesmos que o cliente usa para validar antes de enviar.

::: warning A versão do protocolo é exata, não compatível
`PROTOCOL_VERSION`, definida em `packages/shared/src/constants.ts`, precisa ser
**idêntica** nos dois lados. Não há
negociação nem modo de compatibilidade: se o cliente manda uma versão diferente
da do servidor, a autenticação é recusada.

É por isso que subir o protocolo é sempre uma *breaking change* e obriga uma
release **major** — existe até uma verificação no CI que barra o PR se isso não
for respeitado.
:::

### Autenticação: o servidor nunca vê uma senha sua

O login é por desafio-resposta com criptografia de chave pública. Você não tem
conta nem cadastro: sua identidade **é** o seu par de chaves.

<div class="diagrama">

![Autenticação: o servidor nunca vê uma senha sua](./diagramas/pt/07-autenticacao-o-servidor-nunca-ve-uma-sen.claro.svg){.tema-claro}
![Autenticação: o servidor nunca vê uma senha sua](./diagramas/pt/07-autenticacao-o-servidor-nunca-ve-uma-sen.escuro.svg){.tema-escuro}

</div>

O `clientId` é derivado da própria chave pública, então ele não pode ser
falsificado: quem não tem a chave privada não consegue assinar o desafio.

A senha do servidor, quando existe, protege a *entrada* — é conferida antes de o
desafio ser emitido.

### Sessões: a mesma pessoa em vários aparelhos

Uma sessão é identificada por `userId:deviceId`, não só pelo usuário. É isso que
permite você estar no desktop e no notebook ao mesmo tempo, aparecendo como uma
pessoa só.

- Reconectar **do mesmo aparelho** substitui a conexão antiga (evita fantasmas
  depois de uma queda de rede).
- Conectar **de outro aparelho** cria uma sessão nova, até o limite de **3
  sessões simultâneas** por identidade.

O limite existe para uma identidade só não esgotar os recursos do servidor
(conexões, áudio, banda) abrindo aparelhos sem fim. Ele é independente do
`maxUsers`, que conta *cadastros* — várias sessões da mesma pessoa continuam
valendo uma vaga só.

### Banco de dados

SQLite, em um arquivo `server.db` dentro da pasta de dados do servidor. As
migrações são arquivos `.sql` numerados, aplicados na subida e registrados numa
tabela `schema_migrations` — o servidor só roda o que ainda não rodou.

| Tabela | Guarda |
|---|---|
| `server_meta` | Configuração do servidor: nome, senha, dono, limites, ícone |
| `users` | Membros, com a chave pública de cada um |
| `channels` | Canais de voz e de texto |
| `messages` | Histórico do chat |
| `mentions` | Menções, para destacar e notificar |
| `message_attachments` | Anexos das mensagens |
| `roles` / `user_roles` | Cargos e quem tem cada um |
| `schema_migrations` | Controle das migrações já aplicadas |

### Cargos e permissões

Permissões são bits combinados numa máscara. Dois cargos são especiais:

- **Admin** — recebe todas as permissões e não pode ser apagado.
- **Membro** — o cargo padrão de quem entra.

A checagem é centralizada em `PermissionService.checkPermission()`. O **dono do
servidor** é um caso à parte: ele recebe as permissões de admin
independentemente dos cargos que tenha.

### Proteção contra abuso

| Proteção | Como |
|---|---|
| Flood de mensagens | Janela deslizante: 10 mensagens a cada 5 s |
| Tamanho da mensagem | 2000 caracteres |
| Avatar | 5 MB, e o arquivo precisa ter assinatura de PNG, JPEG ou WebP |
| Anexos | Limite por arquivo e orçamento total do servidor, ambos configuráveis |
| Soundboard | Áudio recusado acima de ~4 MB |
| Path traversal | Nomes de arquivo passam por `basename` e o caminho final é conferido contra a pasta permitida |

Repare no detalhe do avatar: a validação olha os **bytes mágicos** do arquivo, e
não a extensão. Renomear um executável para `.png` não engana a checagem.

## O plano de mídia

O Monky suporta **dois modos de voz e mídia**: o modo padrão **P2P Mesh** e o modo **SFU (Selective Forwarding Unit)** baseado em `mediasoup`.

### Topologia 1: P2P Mesh (Padrão)

Cada participante abre uma conexão direta com **cada** um dos outros.

<div class="diagrama">

![Topologia: mesh completo](./diagramas/pt/08-topologia-mesh-completo.claro.svg){.tema-claro}
![Topologia: mesh completo](./diagramas/pt/08-topologia-mesh-completo.escuro.svg){.tema-escuro}

</div>

Com **N** participantes, cada pessoa mantém **N−1** conexões e o canal tem **N(N−1)/2** no total. Quem compartilha tela envia o mesmo vídeo N−1 vezes, uma para cada par.

::: tip Quando usar P2P Mesh
Excelente para grupos pequenos de amigos e servidores em VPSs econômicos (como instâncias gratuitas com pouca CPU/banda), pois o servidor não carrega pacotes de áudio/vídeo.
:::

### Topologia 2: SFU (Selective Forwarding Unit)

No modo SFU, cada cliente abre apenas **2 WebRTC Transports** com o servidor:
- **`sendTransport`:** Envia as trilhas locais (microfone, webcam, tela e áudio do sistema).
- **`recvTransport`:** Recebe as trilhas de todos os outros participantes roteadas pelo worker `mediasoup`.

Quem transmite envia seu fluxo em 1080p60 **uma única vez**, economizando drasticamente o upload e a CPU do usuário.

::: tip Resiliência & Reconexão Automática
Se o processo SFU sofrer qualquer falha ou indisponibilidade, o cliente avisa em tela e passa a **refazer a sessão SFU automaticamente**, com espera progressiva entre as tentativas, até o servidor voltar.

Não existe queda para P2P: uma malha em que só o lado que percebeu a falha troca de protocolo nunca se forma, porque o outro lado continua respondendo como cliente SFU e descarta a oferta recebida. O resultado seria uma chamada muda por trás de um aviso tranquilizador — por isso o caminho é reconectar, e não degradar.
:::

Quando um administrador muda explicitamente de **SFU para P2P**, os participantes
são avisados e o cliente encerra o transporte anterior antes de voltar
automaticamente ao próprio canal. Essa entrada usa uma autorização temporária,
de uso único, vinculada à sessão e ao canal, e respeita as permissões e os limites
atuais. Sair voluntariamente, ser removido ou iniciar outra chamada cancela
o retorno automático.

### Sinalização

O servidor só entrega envelopes. Ele reescreve o remetente (para ninguém forjar
identidade) e recusa a entrega se os dois pares não estiverem no mesmo canal de
voz.

<div class="diagrama">

![Sinalização](./diagramas/pt/09-sinalizacao.claro.svg){.tema-claro}
![Sinalização](./diagramas/pt/09-sinalizacao.escuro.svg){.tema-escuro}

</div>

### Atravessando o NAT

Quase ninguém tem IP público direto, então os pares precisam descobrir por onde
se alcançam. O Monky usa **servidores STUN** públicos (Google e Cloudflare) para
cada lado descobrir seu próprio endereço externo.

::: tip TURN é opcional, e desligado por padrão
STUN só *descobre* o caminho; ele não repassa nada. Quando a rede é restritiva
demais — NAT simétrico, firewall corporativo, alguns CGNATs de operadora — não
existe caminho direto e a conexão de mídia falha.

Um servidor **TURN** resolve isso retransmitindo a mídia. Mas TURN carrega
vídeo, e custa banda proporcional ao uso — o que reintroduz exatamente o custo
que a arquitetura P2P evita. Por isso o relay do Monky é **opcional** e vem
desligado: quem hospeda decide se quer pagar essa banda.

Quando ligado, o servidor sobe um **coturn** ao seu lado e entrega as
credenciais no login. O ICE continua preferindo a rota direta e só usa o relay
para os pares que realmente não conseguem se conectar. Detalhes em
[Relay de mídia (TURN)](/turn).
:::

Quando uma conexão cai ou trava, o `WebRtcManager` primeiro tenta um **ICE
restart** (renegociar o caminho sem derrubar a chamada) e, se não resolver,
refaz a conexão do zero com aquele par.

### Áudio

<div class="diagrama">

![Áudio](./diagramas/pt/10-audio.claro.svg){.tema-claro}
![Áudio](./diagramas/pt/10-audio.escuro.svg){.tema-escuro}

</div>

A captura já pede cancelamento de eco e ganho automático ao WebRTC nativo. O
diagrama ilustra o motor padrão, **RNNoise**; **Speex** e **GTCRN** usam a
mesma posição na cadeia. Os três rodam em `AudioWorklet`, com WASM empacotado
pela dependência [`@sapphi-red/web-noise-suppressor`](https://github.com/sapphi-red/web-noise-suppressor).
Ao selecionar um deles, a supressão nativa é **desligada** para
evitar processamento duplicado. Também é possível usar somente a supressão
do **WebRTC (nativo)** ou nenhuma.

`AudioProcessor` prepara o novo motor antes de substituir a conexão interna,
mantendo a track de destino enviada por P2P ou SFU. A prévia local compartilha
o fluxo processado da chamada quando possível; quando precisa capturar por
conta própria, aplica o mesmo motor sem se conectar à saída nem ao WebRTC.

As saídas resolvem preferências gerais e por categoria. Voz e áudio de tela
têm `AudioContext`s separados em toda a faixa de volume, de 0 a 200%.
O Chromium compartilha um renderizador nativo entre as tracks WebRTC: os
elementos de áudio ficam ativos com volume zero para decodificação, e somente
os grafos por categoria produzem som. A saída nativa compartilhada acompanha
a voz para manter coerente a referência de cancelamento de eco; ela nunca
é redirecionada para a saída escolhida para a tela. Os players nativos de chat,
incluindo o visualizador ampliado, aplicam a saída de mídias antes de reproduzir.

Mudo e ensurdecer desabilitam a track (`enabled = false`) em vez de removê-la.
Assim não é preciso renegociar a conexão a cada clique no botão de mudo.

### Vídeo e compartilhamento de tela

A câmera segue as dimensões e o FPS do perfil de qualidade escolhido.

O compartilhamento de tela é uma track **separada** da câmera — você pode
transmitir as duas ao mesmo tempo. Ao começar a compartilhar, a conexão é
renegociada e o Monky manda junto um `screen-video-meta` para que o outro lado
saiba que aquela track é uma tela, e não um rosto.

Dá para compartilhar **até 2 telas simultâneas**. Cada uma é identificada pelo id
do seu próprio `MediaStream`, e é esse id que amarra a track, o sender e o
quadradinho na tela.

O Monky também marca a track com uma dica de conteúdo: `motion` prioriza
fluidez (bom para jogos e vídeo), `detail` prioriza nitidez (bom para código e
texto).

### Áudio da tela: o módulo nativo

O navegador não entrega o som do sistema junto com a imagem da tela. Por isso o
Monky tem um módulo nativo em C++:

| Plataforma | Como |
|---|---|
| **Windows** | WASAPI *process loopback* — captura o som do sistema ou de um app específico, excluindo o próprio Monky para não gerar eco |
| **macOS** | ScreenCaptureKit (macOS 13+), com filtro de janela para não vazar áudio de apps que você não está compartilhando |
| **Outras** | Não suportado — o app segue funcionando, só sem áudio de tela |

Se o módulo não carregar, nada quebra: o compartilhamento continua funcionando
sem som e o app avisa.

### Qualidade e banda

Os perfis controlam resolução, FPS e teto de bitrate, aplicados via
`RTCRtpSender.setParameters()`:

| Perfil | Áudio | Câmera | Tela |
|---|---|---|---|
| **Econômico** | 24 kbps | 640×360 @ 24fps · 250 kbps | 854×480 @ 15fps · 900 kbps |
| **Normal** | 32 kbps | 854×480 @ 30fps · 450 kbps | 1280×720 @ 30fps · 2000 kbps |
| **Alta Qualidade** | 48 kbps | 1280×720 @ 30fps · 600 kbps | 1920×1080 @ 30fps · 3500 kbps |
| **Gaming Mode** | 28 kbps | 640×360 @ 20fps · 300 kbps | 1920×1080 @ 60fps · 6000 kbps |

O **Gaming Mode** é o mais revelador: ele *reduz* a câmera para gastar tudo na
tela em 60fps. E, só nele, a preferência de degradação vira
`maintain-framerate` — sob banda apertada o Monky sacrifica resolução para
segurar os 60fps, porque num jogo a fluidez importa mais que a nitidez. Nos
outros perfis é o contrário.

Lembre que esses números são **por par**. Compartilhar tela em Alta Qualidade
para 4 pessoas pede ~14 Mbps de upload.

### Telemetria

Durante uma transmissão o Monky lê as estatísticas do WebRTC
(`RTCPeerConnection.getStats()`) a cada 1,5 s e mostra FPS, resolução e bitrate
reais — do lado de quem envia, ainda codec e keyframes; de quem recebe, perda de
pacotes e jitter.

## Reconexão

Quando o WebSocket cai, o cliente tenta voltar sozinho, com esperas crescentes
(1s, 2s, 3s, 5s — a última se repete). O servidor mantém a sessão viva por **20
segundos** antes de anunciar a saída, então uma queda rápida de Wi-Fi não
expulsa ninguém da lista.

<div class="diagrama">

![Reconexão](./diagramas/pt/11-reconexao.claro.svg){.tema-claro}
![Reconexão](./diagramas/pt/11-reconexao.escuro.svg){.tema-escuro}

</div>

Repare no passo mais contraintuitivo: ao voltar, o cliente **derruba todas as
conexões P2P e recomeça**, mesmo as que pareciam vivas. Parece drástico, mas é o
caminho mais confiável — enquanto o WebSocket esteve fora, outras pessoas podem
ter entrado, saído ou trocado de canal, e não há como saber quais dos pares
antigos ainda valem. Reconstruir a partir do estado novo é mais barato que
descobrir, par a par, quem sobrou.

Se os 20 segundos estourarem antes da volta, a sessão é encerrada e a saída é
anunciada normalmente — a reconexão vira uma entrada nova.

## Onde cada coisa mora

```
apps/
  client/
    native/screen-audio/     módulo C++ de áudio de tela (Windows/macOS)
    src/main/                processo main: janela, bandeja, updater, IPC
    src/preload/             a ponte window.api
    src/renderer/
      core/                  serviços: rede, WebRTC, áudio, vídeo
      stores/                estado + eventos
      views/                 as telas
      i18n/                  traduções PT/EN
  server/
    src/application/         regras de negócio (services)
    src/infrastructure/      WebSocket, banco, segurança, logs
    src/cli/                 o Monky CLI
packages/
  shared/                    protocolo, validadores, limites, perfis
```

## Limites conhecidos

Coisas que são consequência direta da arquitetura, não bugs:

- **Mesh não escala.** Ótimo para um punhado de amigos, ruim para dezenas. Quem
  precisa de grupos maiores troca para o [modo SFU](#topologia-2-sfu-selective-forwarding-unit),
  pagando com banda e CPU do host o que economiza na conexão de cada participante.
- **TURN desligado por padrão.** Redes muito restritivas podem impedir a
  conexão de mídia mesmo com o servidor acessível. Há relay opcional, mas ele
  custa banda do host e só roda em Linux.
- **Protocolo exige igualdade exata.** Cliente e servidor precisam ter a mesma
  `PROTOCOL_VERSION`; atualizar um lado só quebra a conexão.
- **Áudio de tela só em Windows e macOS**, por depender de API nativa de cada
  sistema.

## Para saber mais

- [Monky CLI](/cli) — administração por linha de comando
- [Hospedar em VPS](/hospedar-em-vps) — colocar um servidor no ar
- [Recursos](/recursos) — o que o app faz, do ponto de vista de quem usa
- [CONTRIBUTING.md](https://github.com/MonkyOrg/Monky/blob/main/CONTRIBUTING.md) — como contribuir com código
