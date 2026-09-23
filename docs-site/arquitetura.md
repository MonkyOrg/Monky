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
| `apps/light` | Núcleo nativo headless em desenvolvimento; não é o cliente desktop publicado descrito nos guias de uso |
| `packages/shared` | O contrato entre os dois: tipos do protocolo, validadores, limites e perfis de qualidade |
| `packages/bot-sdk` | SDK, contratos de bot, conexão de voz, execução local e empacotamento do CLI de bots |

`packages/shared` é o que impede cliente e servidor de divergirem: os dois
importam os **mesmos** tipos e os **mesmos** validadores.

A implementação e as limitações atuais do Light estão no
[README próprio](https://github.com/MonkyOrg/Monky/tree/main/apps/light).
As seções de interface abaixo descrevem o cliente Electron.

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

`SessionManager` mantém conexão, chat, membros e miniapps separados por
sessão de servidor. As stores da sessão ativa emitem no barramento de interface
(`appEvents`); as de fundo atualizam seus dados por um barramento silencioso.
Preferências e a chamada ativa têm escopo global. Trocar a sessão visualizada
não equivale a encerrar as conexões.

As telas se inscrevem nos eventos relevantes; o diagrama mostra esse fluxo
lógico, não uma única store compartilhando dados de todos os servidores:

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
| `WebRtcManager` | Orquestração de mídia comum, publicações locais e conexões P2P; delega o transporte SFU |
| `webrtc/SfuClientEngine` | Transporte SFU: capacidades negociadas, producers, consumers e reconexão |
| `AudioProcessor` | Microfone, supressão de ruído, detecção de fala |
| `VideoService` | Captura compartilhada de câmera, efeitos locais e captura de tela |
| `ScreenAudioService` | Ponte do módulo nativo de áudio de tela para o WebRTC |
| `ParticipantManager` | Quem está online, em qual canal e com qual estado |
| `SoundboardService` | Sons e atalhos do soundboard |
| `KeybindService` | Atalhos globais |
| `AttachmentUploader` | Upload de anexos do chat |
| `UpdateService` | Verificação e aviso de atualização |

### Compartilhamento de tela: comportamento comum, transporte separado

Compartilhar uma tela é a mesma funcionalidade nos dois modos. O transporte
não deve ter uma segunda implementação da captura, das preferências de
qualidade ou das regras de codec.

| Responsabilidade | Onde fica |
|---|---|
| Captura, prévia e encerramento da fonte | `VideoService`; áudio capturado por `ScreenAudioService` |
| Parada/substituição nos controles, áudio associado e atualização da sessão correta | `screenShareControls.ts`, usado pelo seletor, views e saída/troca de chamada |
| Intenção de publicar cada tela, cancelamento e limpeza em caso de falha | Registro `localScreenShares` e métodos de compartilhamento do `WebRtcManager` |
| Intenção de assistir, independente da view e da preferência de mute | `VoiceStore`, ligada à sessão da chamada e aplicada pelo `WebRtcManager` aos dois transportes |
| Limites de bitrate/FPS e preferência de adaptação | `webrtc/mediaEncodingPolicy.ts`, usado por P2P e SFU |
| Escolha da família de codec e recusa de alternativas quando a escolha é explícita | `webrtc/codecPreferences.ts`, com capacidades fornecidas por cada transporte |
| Alterações serializadas de parâmetros RTP | `webrtc/rtpSenderParameters.ts`: qualidade e codec não sobrescrevem a transação um do outro |
| Recepção e associação da mídia remota à interface | `webrtc/RemoteMediaRouter`, comum aos dois modos |
| Captura/encoder/transporte nativos e ownership no Main | `nativeScreenSharing.ts` e `native/screen-share` |
| Assinaturas e apresentação de tela nativa ou recepção Chromium compatível | `webrtc/NativeScreenController.ts` e `webrtc/BrowserScreenSubscription.ts` |

No caminho Chromium, o que **precisa** diferir é o mecanismo de publicação. Em P2P há um sender por
destinatário, negociação SDP/ICE e uma m-line de envio dedicada a cada tela;
o encoder é selecionado também em `encodings[].codec`. Em SFU há um producer
no transporte de envio, e o codec é escolhido entre as capacidades negociadas
com o servidor. Preferir codecs no SDP não substitui fixar o encoder P2P, e
as capacidades locais usadas pelo P2P não substituem as capacidades do SFU.

Nesse caminho, a captura e a publicação têm ciclos de vida distintos: reconstruir um
transporte na mesma chamada preserva a captura ativa, mas sair da chamada ou
encerrar o compartilhamento encerra a fonte. Uma troca de modo que exige
saída/reentrada autorizada segue a limpeza completa da chamada. O SFU usa
`stopTracks: false`, e áudio e vídeo
de tela compartilham a proteção contra producers tardios após cancelamento
ou substituição. Trocar o codec refaz a publicação, não a captura.

O seletor consulta `WebRtcManager.assertScreenShareSupported()` antes de pedir
captura; `VideoService` não depende de codecs nem do modo de voz. Fechar o
seletor cancela uma aquisição pendente sem encerrar telas já publicadas.
O início do áudio também é cancelável antes da captura nativa ou durante a
publicação: encerrar a tela não pode produzir um anúncio tardio de áudio ativo.
O helper de controles captura a sessão da chamada, em vez de enviar atualizações
ao servidor que estiver visível quando uma operação assíncrona terminar.

Os valores do perfil são **tetos por envio**, não garantias de FPS nem um
orçamento agregado de upload. P2P pode transmitir a mesma tela para vários
destinatários; SFU normalmente a envia uma vez ao servidor. `GAMING` prioriza
framerate; os demais perfis priorizam resolução. Esses tetos não prometem
1080p120 sustentados.

O caminho nativo usa **libobs/WGC → AMF H.264 → WebRTC nativo** no Windows x64
qualificado, sem decodificar e recodificar o vídeo no transmissor. A escala
com stretch acontece antes do encoder. No receptor Windows, Media Foundation
decodifica e SharedTexture entrega os frames ao palco e à sobreposição.
Receptores Chromium negociam o perfil H.264 real antes de aceitar a assinatura.

Cada perfil demandado tem seu próprio pipeline; espectadores do mesmo perfil
compartilham captura/encoder, mas não a autorização de assistir. Há no máximo
quatro perfis por fonte e 16 espectadores por perfil. Sem demanda, o pipeline
é fechado e só o descritor da fonte permanece. A nova assinatura cria owners
novos, sem reutilizar engines retiradas. IPC centralizado, validação no Main
e comprovantes privados de fechamento preservam a posse dos recursos.

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

### Autenticação por identidade {#autenticacao-o-servidor-nunca-ve-uma-senha-sua}

O login é por desafio-resposta com criptografia de chave pública. Você não tem
conta nem cadastro: sua identidade **é** o seu par de chaves.

<div class="diagrama">

![Autenticação por desafio e assinatura: a chave privada permanece no cliente; a senha opcional de entrada é enviada ao servidor.](./diagramas/pt/07-autenticacao-o-servidor-nunca-ve-uma-sen.claro.svg){.tema-claro}
![Autenticação por desafio e assinatura: a chave privada permanece no cliente; a senha opcional de entrada é enviada ao servidor.](./diagramas/pt/07-autenticacao-o-servidor-nunca-ve-uma-sen.escuro.svg){.tema-escuro}

</div>

O `clientId` é derivado da própria chave pública, então ele não pode ser
falsificado: quem não tem a chave privada não consegue assinar o desafio.

A senha do servidor, quando existe, protege a *entrada* e é conferida pelo
servidor antes do desafio. Ela é diferente da senha local do backup da sua
identidade. A chave privada e a senha desse backup não são enviadas no login.

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

Na chamada SFU do motor de navegador, o cliente abre um par de **WebRTC Transports** com o servidor:
- **`sendTransport`:** Envia as trilhas locais (microfone, webcam, tela e áudio do sistema).
- **`recvTransport`:** Recebe as trilhas de todos os outros participantes roteadas pelo worker `mediasoup`.

O servidor identifica esse par pelo propósito `call`, também usado quando
`purpose` é omitido. Motores de tela com conexões próprias podem usar um par
`screen`, restrito a vídeo e áudio de tela. Producers e consumers registram seu
`transportId`: reconstruir um propósito não descarta os recursos do outro.
Criações em andamento também têm esse escopo: respostas tardias do worker
são fechadas após cancelamento, saída ou troca de canal, sem registrar
transportes abandonados nem afetar uma conexão substituta.
A saúde da conexão de voz considera o par `call`; a saúde de `screen` é
consultada separadamente. Isso prepara o isolamento do motor nativo sem mudar
o par atualmente usado pelo renderer.

O encerramento explícito `SFU_CLOSE_WEBRTC_TRANSPORT` seleciona um ID de
transporte `screen`, não o par inteiro, e responde com
`SFU_WEBRTC_TRANSPORT_CLOSED`. `SFU_PRODUCER_SET_PAUSED` também se restringe
à mídia de tela da própria sessão. Pausa/retomada de producers e consumers
aguarda a resposta do worker e confere se o recurso ainda existe. Pedidos
com `requestId` recebem confirmação ou erro correlacionado, inclusive no
encerramento de producers/consumers; os controles antigos sem `requestId`
continuam sem uma confirmação extra.

Quem transmite envia cada fluxo **uma única vez ao servidor**, em vez de uma
cópia por destinatário. Essa redução de envios não garante, sozinha, resolução,
FPS ou um custo específico de CPU/GPU.

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
transmitir as duas ao mesmo tempo. A fonte é anunciada na chamada sem exigir
o recebimento de sua mídia. Em P2P, a negociação e o `screen-video-meta`
associam a track à tela correta, separada da câmera.

Dá para compartilhar **até 2 telas simultâneas**. Cada uma é identificada pelo id
do seu próprio `MediaStream`, e é esse id que amarra a track, o sender e o
quadradinho na tela.

**Descoberta não é assinatura.** A intenção de assistir pertence à chamada,
não ao ciclo de vida de uma view. `Assistir transmissão` autoriza a entrega
daquela fonte ao destinatário; `Parar de assistir` a revoga. A escolha acompanha
a mesma fonte em reconstruções de view e transporte, mas não é herdada por uma
nova transmissão apenas por ter o mesmo dono.

Em P2P, `RTC_SIGNAL` de tipo `screen-watch` leva a intenção ao emissor. No caminho Chromium, os
senders de tela ficam sem track/encoding ativo até existir uma assinatura;
parar afeta somente aquele peer. Épocas do publisher e do viewer e uma revisão
crescente protegem contra comandos e negociações antigos. O servidor autentica
o remetente e verifica canal e fonte publicada.

Em SFU, o catálogo continua disponível sem criar consumers de tela automaticamente.
Os consumers de tela/áudio começam pausados **no servidor** e só são liberados
depois que o setup ainda válido termina. Parar fecha o consumer remoto e local;
pausar somente a track no cliente não seria suficiente para cortar banda.
Respostas tardias não podem reativar uma assinatura cancelada.

O áudio da tela é compartilhado por publisher/destinatário: ele continua
enquanto esse destinatário assistir pelo menos uma tela daquele publisher.
Microfone, câmera, outros espectadores e preferências de mute são independentes.
No caminho nativo, a última assinatura de um perfil encerra sua captura,
encoder e envio, inclusive publisher→SFU. O caminho Chromium mantém sua
captura/prévia e pode manter o upload ao SFU. RTCP e sinalização continuam permitidos; não se promete
zero bytes na chamada. Os contratos exigem cliente e servidor com o mesmo
`PROTOCOL_VERSION`.

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

Os perfis controlam resolução, FPS e teto de bitrate. No caminho Chromium,
os parâmetros de envio usam `RTCRtpSender.setParameters()`; no nativo,
configuram o pipeline real de captura/encoder/transporte:

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
outros perfis é o contrário no caminho Chromium. O nativo solicita o perfil
real escolhido e não esconde degradação como se a configuração garantisse FPS.

O perfil Personalizado permite solicitar até 1080p120 no caminho nativo.
O espectador pode pedir Fonte, 1080p60, 720p60 ou 480p30 (852×480); perfis
diferentes alocam pipelines separados, e não um redimensionamento só no player.

Lembre que esses números são **por par**. Compartilhar tela em Alta Qualidade
para 4 pessoas pede ~14 Mbps de upload.

### Telemetria

Durante uma transmissão, a telemetria distingue configuração, envio,
decodificação e apresentação. Estatísticas RTP usam deltas do timestamp do
próprio relatório; contadores Media Foundation usam o relógio de observação
do worker, não o horário em que o JavaScript leu um snapshot em cache.
Métricas indisponíveis permanecem indisponíveis, não viram zero. O transporte
H.264 externo não finge medir o tempo de codificação AMF como se fosse um
encoder interno do WebRTC.

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
    native/screen-share/     captura libobs, RTC nativo, contratos, build e licenças
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
- **Transmissão nativa qualificada em Windows x64, janela e AMD/AMF H.264.**
  Os demais caminhos continuam Chromium. Loopback Windows não substitui QA
  em rede externa, outros fabricantes de GPU ou macOS físico.

## Para saber mais

- [Monky CLI](/cli) — administração por linha de comando
- [Hospedar em VPS](/hospedar-em-vps) — colocar um servidor no ar
- [Recursos](/recursos) — o que o app faz, do ponto de vista de quem usa
- [CONTRIBUTING.md](https://github.com/MonkyOrg/Monky/blob/main/CONTRIBUTING.md) — como contribuir com código
