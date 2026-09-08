# Monky — Especificação Técnica

## 1. Visão geral

O Monky será um aplicativo desktop desenvolvido utilizando **Electron**, cujo objetivo é fornecer uma comunicação simples entre amigos através de um servidor privado hospedado na máquina de um dos usuários.

O aplicativo terá como funcionalidades principais:

- Comunicação por voz;
- Compartilhamento de câmera;
- Compartilhamento de tela;
- Chat de texto;
- Canais de voz;
- Canais de texto;
- Nickname por servidor;
- Foto de perfil;
- Servidor privado protegido por senha;
- Hospedagem local;
- Possibilidade futura de hospedar o servidor separadamente;
- Baixo consumo de CPU;
- Baixo consumo de RAM;
- Baixo consumo de banda;
- Arquitetura modular e facilmente extensível.

Não haverá:

- Sistema de contas;
- E-mail;
- Login global;
- Cadastro;
- Sistema de amigos;
- Feed;
- Marketplace;
- Sistema de mensagens privadas;
- Recursos sociais complexos.

---

# 2. Filosofia do projeto

O projeto deve seguir cinco princípios fundamentais:

### 2.1 Simplicidade

A aplicação deve possuir somente funcionalidades necessárias para comunicação entre amigos.

### 2.2 Baixo consumo

O aplicativo deve consumir o mínimo possível de:

- CPU;
- RAM;
- GPU;
- armazenamento;
- banda de internet.

### 2.3 Self-hosted

O usuário deve conseguir criar um servidor utilizando a própria máquina.

O servidor não dependerá de infraestrutura externa.

### 2.4 Segurança

Mesmo sendo uma aplicação destinada a amigos, nenhuma conexão deve ser considerada confiável por padrão.

### 2.5 Manutenibilidade

O código deve ser organizado para permitir futuramente:

- novos tipos de canais;
- novos métodos de autenticação;
- servidor dedicado;
- novos codecs;
- novos recursos de vídeo;
- novos sistemas de moderação;
- novos protocolos de comunicação.

---

# 3. Tecnologias

## Cliente

- Electron
- TypeScript
- HTML
- CSS
- JavaScript/TypeScript
- WebRTC

## Backend/Servidor

Recomendação:

- Node.js
- TypeScript
- WebSocket
- SQLite

O servidor pode inicialmente utilizar o mesmo ecossistema TypeScript do cliente.

Isso facilita manutenção e compartilhamento de modelos/interfaces.

## Banco

SQLite.

O banco ficará localizado na máquina que hospeda o servidor.

Exemplo:

```text
server/
    data/
        server.db
```

---

# 4. Arquitetura geral

A arquitetura será dividida em:

```text
┌──────────────────────────────┐
│          Electron            │
│                              │
│ ┌──────────┐ ┌────────────┐ │
│ │ UI       │ │ WebRTC     │ │
│ │ Renderer │ │ Manager    │ │
│ └────┬─────┘ └─────┬──────┘ │
│      │             │        │
│ ┌────▼─────────────▼──────┐ │
│ │       Preload API       │ │
│ └────────────┬────────────┘ │
│              │              │
│ ┌────────────▼────────────┐ │
│ │ Application Services    │ │
│ └────────────┬────────────┘ │
│              │              │
│ ┌────────────▼────────────┐ │
│ │ Network / WebSocket     │ │
│ └─────────────────────────┘ │
└──────────────┬───────────────┘
               │
               │ WebSocket
               │
       ┌───────▼────────┐
       │     Server     │
       │                │
       │ Authentication │
       │ Users          │
       │ Channels       │
       │ Chat           │
       │ Signaling      │
       │ SQLite         │
       └───────┬────────┘
               │
               │ WebRTC signaling
               │
       ┌───────▼────────┐
       │ Other Clients  │
       └────────────────┘
```

---

# 5. Modelo de comunicação

O sistema deverá separar claramente:

## 5.1 Control Plane

Utilizado para:

- conexão;
- autenticação;
- nickname;
- criação de usuário;
- entrada/saída de canais;
- mensagens;
- presença;
- WebRTC signaling;
- configurações.

Utilizar:

**WebSocket sobre TLS quando disponível.**

---

# 6. Media Plane

Áudio, vídeo e compartilhamento de tela devem utilizar:

**WebRTC.**

O servidor não deverá transportar o áudio/vídeo normalmente.

Fluxo:

```text
Cliente A
   │
   │ WebRTC
   │
   ├──────────────────────┐
   │                      │
   ▼                      ▼
Cliente B              Cliente C
```

O servidor participa apenas da negociação:

```text
Client A
   │
   │ SDP / ICE
   ▼
Server
   │
   │ SDP / ICE
   ▼
Client B
```

Depois da negociação:

```text
Client A ◄──────────────► Client B
             WebRTC
```

Isso reduz drasticamente o consumo do servidor no modo P2P padrão.

### 6.1 Modo Centralizado: SFU (Selective Forwarding Unit)

A partir da versão 3.5.0, o Monky suporta alternar o servidor para o modo **SFU** baseado em `mediasoup`.

Topologia SFU:
```text
Client A ───(sendTransport: áudio/vídeo/tela)───► [ mediasoup SFU Worker ]
                                                          │
          ◄───(recvTransport: trilhas de A e C)───────────┤
Client B                                                  │
          ◄───(recvTransport: trilhas de A e B)───────────┘
Client C
```

Vantagens:
- Quem compartilha tela em 1080p60 transmite apenas 1 stream upstream.
- Redução exponencial do uso de CPU e banda dos clientes em chamadas com mais de 3 participantes.
- Reconexão automática ao SFU em caso de interrupção, sem trocar silenciosamente a topologia para P2P.
- Estimador de capacidade integrado (CPU, RAM, Bandwidth) no client e CLI.

Diagnóstico e recuperação:
- Os ícones de cada participante refletem o estado ICE/DTLS observado pelo servidor (conectando, conectado, reconectando ou falha), inclusive para quem apenas observa a lista do canal. A conexão WebSocket não comprova que a mídia está funcionando.
- O ping SFU usa o maior RTT disponível entre os transportes ativos de envio e recebimento; clientes que só recebem também têm medição. Os indicadores usam os mesmos limites: abaixo de 50 ms, excelente; de 50 a 119 ms, boa; a partir de 120 ms, ruim. Sem amostra, exibem estado desconhecido, não uma conexão saudável.
- A entrada na chamada e a reconstrução da sessão SFU reconciliam a lista autoritativa de participantes, independentemente de haver um produtor de áudio ativo.
- Ensurdecer silencia a voz, não o áudio de compartilhamento de tela. Em P2P e SFU, o áudio da tela depende de assistir à transmissão e dos controles próprios de silenciar/volume (0–200%); sair de ensurdecido não reativa uma tela silenciada.

---


# 7. Problema de NAT

Como o servidor será hospedado na máquina do usuário, deve ser considerado que conexões externas podem estar atrás de:

- NAT;
- CGNAT;
- firewall;
- roteador;
- redes corporativas.

A primeira versão deverá funcionar através de:

- IP;
- porta;
- port forwarding quando necessário.

A arquitetura deverá permitir posteriormente:

- STUN;
- TURN;
- servidor relay;
- servidor dedicado.

Isso deverá ser abstraído por uma interface de ICE/RTC.

Exemplo:

```text
IceProvider
├── DirectIceProvider
├── StunIceProvider
└── TurnIceProvider
```

---

# 8. Conexão ao servidor

Ao abrir o aplicativo, o usuário deverá visualizar:

```text
┌──────────────────────────────┐
│          Monky          │
│                              │
│ IP / Host                    │
│ [________________________]   │
│                              │
│ Porta                        │
│ [________________________]   │
│                              │
│ Senha                        │
│ [________________________]   │
│                              │
│ [ Entrar no servidor ]       │
│                              │
│ ───────── ou ─────────       │
│                              │
│ [ Criar servidor ]           │
└──────────────────────────────┘
```

---

# 9. Criação de servidor

Ao selecionar:

**Criar servidor**

o usuário deverá informar:

- Nome do servidor;
- Porta;
- Senha.

Opcionalmente:

- Nome do primeiro canal;
- Nome do primeiro canal de texto.

O servidor será iniciado localmente.

Exemplo:

```text
127.0.0.1:3000
```

Porém, para outros usuários acessarem:

```text
PUBLIC_IP:3000
```

Será responsabilidade do usuário configurar:

- firewall;
- port forwarding;
- DNS, caso deseje.

---

# 10. Servidor local

O servidor deverá funcionar como processo separado da interface.

Preferencialmente:

```text
Electron
   │
   └── Server Manager
          │
          └── Server Process
```

Isso permitirá futuramente executar:

```text
MonkyServer
```

sem Electron.

Assim será possível posteriormente hospedar o servidor:

- em VPS;
- em Linux;
- em Windows Server;
- em Docker;
- em NAS;
- em Raspberry Pi;
- em máquina dedicada.

---

# 11. Client ID

Cada instalação do aplicativo deverá gerar um identificador local.

Exemplo:

```text
clientId = UUIDv4
```

Esse ID deverá ser armazenado localmente.

Exemplo:

```text
client-id.json
```

ou armazenamento seguro equivalente.

O Client ID:

- não será utilizado como login;
- não será utilizado como identidade global;
- não será compartilhado desnecessariamente;
- servirá para identificar a sessão/conexão.

O IP não deverá ser utilizado como identidade do usuário.

---

# 12. Nickname

Ao entrar no servidor, o usuário deverá informar:

```text
Nickname
[ Murilo              ]

[ Entrar ]
```

O nickname deverá ser único dentro daquele servidor.

Exemplo:

```text
Murilo
```

Se outro usuário tentar:

```text
Murilo
```

o servidor deverá rejeitar.

Mensagem:

```text
Este nickname já está sendo utilizado.
```

O primeiro usuário conectado terá prioridade.

O segundo usuário deverá escolher outro nickname.

---

# 13. Alteração de nickname

O usuário poderá alterar seu nickname a qualquer momento.

Antes da alteração:

```text
Nickname atual:
Murilo

Novo nickname:
Joao
```

O servidor deverá verificar novamente a unicidade.

Caso:

```text
Joao
```

já esteja sendo utilizado:

```text
Nickname indisponível.
```

---

# 14. Foto de perfil

Cada usuário poderá possuir uma foto de perfil.

Limite:

**5 MB.**

Formatos permitidos inicialmente:

- JPEG;
- PNG;
- WebP.

O servidor deverá validar:

- tamanho;
- MIME type;
- extensão;
- conteúdo real do arquivo.

Não confiar apenas na extensão enviada pelo cliente.

A imagem deverá ser processada/reduzida para evitar que um usuário envie uma imagem gigantesca em resolução.

Exemplo:

```text
Original
5 MB
4096x4096

↓

Processamento

↓

Avatar
256x256
WebP
```

---

# 15. Interface principal

Após entrar:

```text
┌─────────────────────────────────────────────────────────┐
│ Monky                                    ⚙         │
├──────────────┬──────────────────────────────┬───────────┤
│              │                              │           │
│ VOICE        │                              │           │
│              │                              │           │
│ 🔊 Geral     │       Área principal         │ Usuários  │
│ 🔊 Jogos     │                              │           │
│ 🔊 Amigos    │                              │           │
│              │                              │           │
│ TEXT         │                              │           │
│              │                              │           │
│ # geral      │                              │           │
│ # jogos      │                              │           │
│              │                              │           │
└──────────────┴──────────────────────────────┴───────────┘
```

---

# 16. Canais de voz

Cada servidor poderá possuir vários canais de voz.

Exemplo:

```text
VOICE

🔊 Geral
🔊 Jogos
🔊 Minecraft
🔊 Valorant
```

O usuário poderá:

- entrar;
- sair;
- mudar de canal.

---

# 17. Canais de texto

O servidor também poderá possuir canais de texto.

Exemplo:

```text
TEXT

# geral
# jogos
# avisos
```

O chat deverá ser propositalmente simples.

---

# 18. Chat

O chat deverá suportar:

- texto;
- mensagens;
- timestamp;
- nickname;
- avatar;
- mensagens do sistema.

Exemplo:

```text
[19:31] Murilo
Alguém vai jogar?

[19:32] João
Vou entrar daqui a pouco.
```

---

# 19. Chat — funcionalidades

Primeira versão:

- enviar mensagem;
- receber mensagem;
- histórico;
- scroll;
- timestamp;
- nickname;
- avatar;
- limite de tamanho;
- rate limit.

Não implementar inicialmente:

- GIF;
- emoji customizado;
- stickers;
- threads;
- replies;
- embeds;
- markdown complexo;
- edição de mensagens.

Esses recursos podem ser adicionados futuramente.

---

# 20. Limite de mensagens

Para evitar abuso:

```text
MAX_MESSAGE_LENGTH = 2000
```

O servidor deverá aplicar rate limiting.

Exemplo:

```text
10 mensagens / 5 segundos
```

Valores deverão ser configuráveis.

---

# 21. Canal de voz — interface

Ao entrar:

```text
┌────────────────────────────────────────────┐
│ 🔊 Geral                                   │
│                                            │
│ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
│ │  avatar  │ │  avatar  │ │  avatar  │   │
│ │  Murilo  │ │   João   │ │   Ana    │   │
│ │ 🟢       │ │          │ │ 🟢       │   │
│ └──────────┘ └──────────┘ └──────────┘   │
│                                            │
│ ───────────────────────────────────────── │
│                                            │
│ 🎤 🔇    📷    🖥️    🔊    🚪             │
└────────────────────────────────────────────┘
```

---

# 22. Controles de voz

O usuário terá:

### Microfone

- Ativar;
- Desativar.

### Áudio

- Ouvir;
- Não ouvir.

### Câmera

- Ativar;
- Desativar.

### Screen Share

- Ativar;
- Desativar.

### Sair

- Sair do canal.

---

# 23. Indicador de fala

Quando uma pessoa estiver falando:

```text
┌──────────────┐
│              │
│    AVATAR    │
│              │
│    Murilo    │
│              │
└──────────────┘
```

deverá receber uma borda visual indicando atividade de voz.

Exemplo:

```text
┌🟢─────────────┐
│              │
│    AVATAR    │
│              │
│    Murilo    │
└──────────────┘
```

A detecção deverá preferencialmente utilizar o próprio estado de áudio/WebRTC, evitando processamento pesado no renderer.

---

# 24. Câmera

O usuário poderá ativar sua câmera.

O vídeo deverá utilizar WebRTC.

Controles:

- ligar;
- desligar;
- trocar câmera;
- resolução;
- FPS.

A resolução padrão deverá ser baixa/moderada.

Exemplo inicial:

```text
640x360
30 FPS
```

Quando possível, o sistema deverá adaptar automaticamente a qualidade conforme:

- largura de banda;
- CPU;
- quantidade de participantes.

---

# 25. Compartilhamento de tela

O usuário poderá compartilhar:

- tela inteira;
- janela específica.

Não deverá ser permitido iniciar múltiplos compartilhamentos simultâneos pelo mesmo usuário na primeira versão.

Qualidade padrão:

```text
720p
30 FPS
```

O sistema deverá reduzir automaticamente a qualidade caso a rede fique congestionada.

---

# 26. Controle de banda

Esse é um requisito importante do projeto.

A aplicação deverá possuir um limite configurável.

Exemplo:

```text
Bandwidth limit:

Voice:
20-40 kbps

Camera:
250-600 kbps

Screen:
500-1500 kbps
```

Os valores deverão ser tratados como limites máximos aproximados, não garantias absolutas, pois protocolos WebRTC possuem overhead.

---

# 27. Perfil de qualidade

A aplicação poderá possuir três perfis:

### Econômico

```text
Audio: 24 kbps
Camera: 360p
Screen: 480p
```

### Normal

```text
Audio: 32 kbps
Camera: 480p
Screen: 720p
```

### Alta

```text
Audio: 48 kbps
Camera: 720p
Screen: 1080p
```

O padrão deverá ser:

**Normal.**

---

# 28. Prioridade de áudio

A voz deverá possuir prioridade sobre vídeo.

Quando houver congestionamento:

```text
1. Áudio
2. Câmera
3. Screen Share
```

O sistema deverá reduzir primeiro:

```text
Screen Share
```

antes de degradar o áudio.

---

# 29. Economia de banda

Quando ninguém estiver vendo a câmera:

```text
Camera = OFF
```

O stream deverá ser efetivamente interrompido ou suspenso.

Não simplesmente ocultado visualmente.

Da mesma maneira:

```text
Screen Share = OFF
```

deverá encerrar o envio do stream.

---

# 30. Arquitetura WebRTC

Criar uma abstração:

```text
WebRtcManager
```

Responsabilidades:

- criar PeerConnection;
- criar DataChannel quando necessário;
- criar tracks;
- remover tracks;
- negociar SDP;
- ICE candidates;
- reconnection;
- monitorar connection state;
- monitorar bitrate;
- monitorar packet loss.

Não permitir que componentes da UI manipulem diretamente WebRTC.

---

# 31. Gerenciamento de participantes

Criar:

```text
ParticipantManager
```

Responsável por:

- adicionar participante;
- remover participante;
- atualizar nickname;
- atualizar avatar;
- atualizar status;
- atualizar voice state;
- atualizar vídeo;
- atualizar screen share.

---

# 32. Comunicação baseada em eventos

O sistema deverá utilizar eventos internos.

Exemplo:

```text
UserJoined
UserLeft
NicknameChanged
AvatarChanged
VoiceChannelJoined
VoiceChannelLeft
MicrophoneEnabled
MicrophoneDisabled
CameraEnabled
CameraDisabled
ScreenShareStarted
ScreenShareStopped
MessageReceived
ServerDisconnected
```

Isso evita forte acoplamento entre UI, rede e WebRTC.

---

# 33. Event Bus

Poderá existir:

```text
EventBus
```

Exemplo:

```typescript
eventBus.emit("user.joined", user);
```

E:

```typescript
eventBus.on("user.joined", handler);
```

A UI não deverá conhecer diretamente a implementação da rede.

---

# 34. Estrutura do projeto

Recomendação:

```text
monky/
│
├── apps/
│   │
│   ├── client/
│   │   └── electron/
│   │
│   └── server/
│
├── packages/
│   │
│   ├── shared/
│   │   ├── models/
│   │   ├── events/
│   │   ├── protocols/
│   │   ├── constants/
│   │   └── validators/
│   │
│   ├── networking/
│   │
│   ├── webrtc/
│   │
│   └── security/
│
├── docs/
│
├── tests/
│
├── package.json
└── README.md
```

---

# 35. Client

```text
client/
│
├── main/
│   ├── main.ts
│   ├── windows/
│   └── security/
│
├── preload/
│   └── preload.ts
│
└── renderer/
    │
    ├── components/
    ├── pages/
    ├── stores/
    ├── services/
    ├── events/
    ├── models/
    └── styles/
```

---

# 36. Server

```text
server/
│
├── src/
│   │
│   ├── application/
│   │   ├── services/
│   │   ├── usecases/
│   │   └── events/
│   │
│   ├── domain/
│   │   ├── entities/
│   │   ├── value-objects/
│   │   └── repositories/
│   │
│   ├── infrastructure/
│   │   ├── database/
│   │   ├── websocket/
│   │   ├── security/
│   │   └── filesystem/
│   │
│   └── server.ts
│
└── data/
    └── server.db
```

---

# 37. SOLID

O projeto deverá seguir:

- Single Responsibility;
- Open/Closed;
- Liskov Substitution;
- Interface Segregation;
- Dependency Inversion.

Exemplo:

Não:

```typescript
class Server {
    saveUser()
    sendMessage()
    createChannel()
    connectWebRTC()
    saveFile()
}
```

Preferir:

```text
UserService
MessageService
ChannelService
WebRtcService
FileService
```

---

# 38. Dependency Injection

Serviços deverão receber dependências por interface.

Exemplo:

```typescript
interface UserRepository {
    findById(id: string): Promise<User | null>;
    findByNickname(nickname: string): Promise<User | null>;
    create(user: User): Promise<void>;
}
```

Implementação:

```text
SqliteUserRepository
```

Futuramente:

```text
PostgresUserRepository
```

sem alterar o domínio.

---

# 39. Banco de dados

SQLite deverá possuir inicialmente:

```text
Server
User
Channel
Message
```

Possivelmente:

```text
ServerSettings
```

---

# 40. Tabela User

Campos:

```text
id
client_id
nickname
avatar_path
created_at
last_seen_at
```

O nickname deverá possuir índice/constraint apropriada para garantir unicidade.

---

# 41. Tabela Channel

```text
id
server_id
name
type
position
created_at
```

Tipos:

```text
VOICE
TEXT
```

---

# 42. Tabela Message

```text
id
channel_id
user_id
content
created_at
```

O banco deverá armazenar somente o necessário.

---

# 43. Histórico

O servidor deverá armazenar mensagens de texto.

Por padrão:

```text
100 mensagens
```

podem ser carregadas inicialmente.

O restante poderá ser carregado sob demanda.

Isso evita enviar milhares de mensagens ao conectar.

---

# 44. Autenticação

Não haverá conta.

A autenticação será:

```text
IP
+
PORT
+
PASSWORD
```

O cliente enviará:

```text
clientId
nickname
password
```

O servidor deverá verificar a senha antes de aceitar a conexão.

---

# 45. Senha do servidor

A senha nunca deverá ser armazenada em texto puro.

Utilizar:

```text
Argon2id
```

ou outro algoritmo moderno de password hashing.

Banco:

```text
password_hash
```

Nunca:

```text
password
```

---

# 46. Comunicação segura

Sempre que possível:

```text
TLS
```

deverá ser utilizado.

A arquitetura deverá permitir:

```text
ws://
```

somente para desenvolvimento/local.

Produção deverá preferir:

```text
wss://
```

---

# 47. Segurança do Electron

O Electron deverá utilizar:

```text
contextIsolation: true
nodeIntegration: false
sandbox: true
```

A UI não deverá possuir acesso direto ao Node.js.

Utilizar:

```text
Preload
```

como única ponte.

Exemplo:

```text
Renderer
   │
   ▼
Preload API
   │
   ▼
Electron Main
```

---

# 48. IPC

O IPC deverá possuir uma API pequena e explícita.

Não expor:

```typescript
ipcRenderer
```

diretamente.

Expor:

```typescript
window.api.connect()
window.api.disconnect()
window.api.sendMessage()
window.api.joinChannel()
window.api.startCamera()
window.api.startScreenShare()
```

---

# 49. Validação

Toda entrada recebida do usuário deverá ser validada.

Exemplo:

```text
nickname
password
message
channel name
avatar
IP
port
```

Nunca confiar na validação do cliente.

O servidor deverá validar novamente.

---

# 50. Proteção contra abuso

Implementar:

- Rate limiting;
- Limite de mensagens;
- Limite de tamanho de mensagem;
- Limite de upload;
- Limite de avatar;
- Limite de conexões;
- Limite de nickname;
- Validação de comandos;
- Timeout de conexão;
- Heartbeat;
- Disconnect de clientes inativos.

---

# 51. Proteção contra flood

Exemplo:

```text
MAX_MESSAGES_PER_SECOND
MAX_CONNECTIONS_PER_IP
MAX_UPLOADS_PER_MINUTE
```

Valores configuráveis.

---

# 52. Upload de avatar

O avatar deverá:

1. verificar tamanho;
2. verificar MIME;
3. verificar conteúdo;
4. decodificar;
5. redimensionar;
6. converter;
7. salvar.

Nunca servir diretamente arquivos arbitrários enviados pelo usuário.

---

# 53. Proteção contra path traversal

Nunca permitir:

```text
../../arquivo
```

ou similares.

Os nomes físicos dos arquivos deverão ser gerados pelo servidor.

Exemplo:

```text
avatars/
    5f9a8c2d.webp
```

e não:

```text
avatars/
    murilo.jpg
```

---

# 54. Logs

O servidor deverá possuir logs.

Categorias:

```text
INFO
WARN
ERROR
SECURITY
NETWORK
```

Não registrar:

- senha;
- tokens;
- conteúdo sensível desnecessário.

---

# 55. Reconnection

Caso a conexão WebSocket caia:

```text
Connecting...
```

O cliente deverá tentar reconectar automaticamente.

Estratégia:

```text
1s
2s
4s
8s
16s
30s
```

com limite máximo.

---

# 56. Voice reconnection

Caso WebRTC seja desconectado:

1. verificar conexão;
2. tentar ICE restart;
3. renegociar;
4. reconstruir PeerConnection se necessário.

O usuário não deverá precisar sair e entrar manualmente sempre que possível.

---

# 57. Estado do usuário

Estados:

```text
ONLINE
IDLE
VOICE
DISCONNECTED
```

Não haverá necessidade de um complexo sistema de presença.

---

# 58. Estado do microfone

```text
MUTED
UNMUTED
```

---

# 59. Estado da câmera

```text
OFF
ON
```

---

# 60. Estado do compartilhamento

```text
OFF
SCREEN
```

---

# 61. Estado do áudio

O usuário poderá escolher:

```text
Listening
Not Listening
```

Isso deverá afetar localmente os streams recebidos.

Não deve necessariamente desconectar o usuário da sala.

---

# 62. Canais de voz e WebRTC

Quando o usuário entra:

```text
JOIN VOICE CHANNEL
```

O servidor informa os participantes atuais.

Exemplo:

```text
User A
User B
User C
```

O cliente cria PeerConnections conforme necessário.

---

# 63. Mesh

A primeira versão poderá utilizar:

**WebRTC Mesh.**

Exemplo com quatro usuários:

```text
A ─── B
│ \   │
│  \  │
│   \ │
C ─── D
```

Isso funciona bem para grupos pequenos.

---

# 64. Limitação do Mesh

Não utilizar Mesh como solução definitiva para grupos grandes.

Com muitos participantes:

```text
Upload
CPU
Network
```

crescem rapidamente.

Por isso a arquitetura deverá permitir futuramente:

```text
P2P Mesh
      ↓
SFU
```

---

# 65. SFU futuro

Posteriormente poderá existir:

```text
MediaServer
```

com:

- mediasoup;
- Janus;
- LiveKit;
- ou implementação equivalente.

A aplicação não deverá depender disso na primeira versão.

---

# 66. Escalabilidade futura

A arquitetura deverá permitir:

```text
Electron Client
       │
       ▼
Dedicated Server
       │
       ├── Signaling
       ├── Authentication
       ├── Chat
       └── SFU
```

sem modificar completamente o cliente.

---

# 67. Configuração

Configuração local:

```text
config/
    client.json
```

Servidor:

```text
config/
    server.json
```

Exemplo:

```json
{
  "port": 3000,
  "maxUsers": 20,
  "maxMessageLength": 2000,
  "maxAvatarSize": 5242880
}
```

---

# 68. Limite de usuários

O servidor deverá possuir configuração:

```text
maxUsers
```

Padrão sugerido:

```text
20
```

Isso também ajuda a manter o Mesh sob controle.

---

# 69. Limite de usuários por canal

Cada canal poderá possuir:

```text
maxParticipants
```

Exemplo:

```text
10
```

---

# 70. Interface visual

A interface deverá ser extremamente simples.

Evitar:

- animações pesadas;
- blur excessivo;
- transparências;
- partículas;
- sombras complexas;
- backgrounds animados;
- efeitos 3D;
- vídeos de fundo.

Priorizar:

- CSS simples;
- poucos elementos;
- componentes reutilizáveis;
- baixa utilização de GPU.

---

# 71. Tema

Inicialmente:

```text
Dark Theme
```

Com possibilidade futura de:

```text
Light Theme
```

---

# 72. Layout

Estrutura:

```text
Server
│
├── Channels
│
├── Main Content
│
└── Members
```

Não implementar inicialmente múltiplas barras complexas.

---

# 73. Gerenciamento de estado

O frontend deverá utilizar um estado centralizado.

Exemplo conceitual:

```text
ServerState
UserState
ChannelState
VoiceState
ChatState
ConnectionState
```

Não espalhar estado através de dezenas de componentes.

---

# 74. Testes

Deverão existir:

## Unit Tests

Testar:

- autenticação;
- nickname;
- permissões;
- validações;
- mensagens;
- canais;
- repositories;
- rate limiting.

## Integration Tests

Testar:

```text
Client → Server
Server → SQLite
Client → WebSocket
```

## E2E

Testar:

```text
Criar servidor
↓
Entrar
↓
Escolher nickname
↓
Entrar canal
↓
Enviar mensagem
↓
Ativar microfone
↓
Ativar câmera
↓
Compartilhar tela
↓
Sair
```

---

# 75. Monitoramento

O servidor deverá acompanhar:

```text
CPU
RAM
Connected Users
Active Voice Channels
WebSocket Connections
WebRTC Sessions
Bandwidth In
Bandwidth Out
Packet Loss
```

Inicialmente isso poderá existir apenas nos logs.

---

# 76. Métricas de WebRTC

Monitorar:

- bitrate;
- packet loss;
- RTT;
- jitter;
- connection state;
- ICE state;
- frames dropped;
- frames sent;
- frames received.

Essas informações serão fundamentais para diagnosticar problemas de voz/vídeo.

---

# 77. Atualização

O cliente deverá possuir arquitetura preparada para atualização futura.

Não permitir que:

```text
Server
```

e

```text
Client
```

dependam obrigatoriamente da mesma versão para funcionalidades básicas.

O protocolo deverá possuir:

```text
protocolVersion
```

---

# 78. Protocolo

Todas as mensagens WebSocket deverão possuir estrutura semelhante a:

```json
{
  "type": "MESSAGE_TYPE",
  "requestId": "uuid",
  "payload": {}
}
```

Exemplo:

```json
{
  "type": "CHAT_MESSAGE",
  "requestId": "abc",
  "payload": {
    "channelId": "123",
    "content": "Olá!"
  }
}
```

---

# 79. Request ID

Toda operação que exigir resposta deverá possuir:

```text
requestId
```

Isso permitirá correlacionar:

```text
Request
↓
Response
```

e facilitar debugging.

---

# 80. Eventos do servidor

Exemplos:

```text
SERVER_READY
USER_JOINED
USER_LEFT
USER_UPDATED
CHANNEL_CREATED
CHANNEL_DELETED
MESSAGE_CREATED
VOICE_USER_JOINED
VOICE_USER_LEFT
VOICE_STATE_CHANGED
RTC_OFFER
RTC_ANSWER
RTC_ICE_CANDIDATE
SERVER_ERROR
```

---

# 81. Versionamento do protocolo

Exemplo:

```text
protocolVersion: 1
```

Caso futuramente seja necessário:

```text
protocolVersion: 2
```

o servidor poderá rejeitar clientes incompatíveis de forma controlada.

---

# 82. Princípio importante: servidor autoritativo

O cliente nunca deverá decidir:

- se nickname está disponível;
- se usuário está conectado;
- se usuário pode entrar em canal;
- se mensagem é válida;
- se arquivo é permitido.

O servidor sempre será a autoridade.

---

# 83. Persistência

O servidor deverá persistir:

- configuração;
- usuários conhecidos;
- canais;
- mensagens;
- avatares;
- configurações.

Não deverá persistir:

- áudio;
- vídeo;
- screen share.

A menos que uma funcionalidade de gravação seja adicionada futuramente.

---

# 84. Backup

O servidor deverá permitir backup simples:

```text
server.db
avatars/
config/
```

O usuário poderá copiar a pasta inteira para outro computador.

---

# 85. Migração

O banco deverá possuir migrations.

Exemplo:

```text
migrations/
    001_initial.sql
    002_add_avatar.sql
    003_add_channel_position.sql
```

Nunca alterar diretamente tabelas existentes sem migration.

---

# 86. Princípio de extensibilidade

Novas funcionalidades deverão ser adicionadas através de módulos.

Exemplo:

```text
features/
    chat/
    voice/
    video/
    screen-share/
    users/
    channels/
```

Evitar criar um único arquivo gigantesco:

```text
server.ts
```

com milhares de linhas.

---

# 87. Separação de domínio

O domínio não deverá conhecer:

- Electron;
- SQLite;
- WebSocket;
- DOM;
- WebRTC diretamente.

Exemplo:

```text
Domain
   ↑
Application
   ↑
Infrastructure
```

---

# 88. Tratamento de erros

Erros deverão possuir códigos.

Exemplo:

```text
AUTH_INVALID_PASSWORD
NICKNAME_ALREADY_EXISTS
NICKNAME_INVALID
CHANNEL_NOT_FOUND
CHANNEL_FULL
MESSAGE_TOO_LONG
RATE_LIMITED
AVATAR_TOO_LARGE
SERVER_FULL
PROTOCOL_VERSION_UNSUPPORTED
```

Isso facilita tratamento no cliente.

---

# 89. UX de erro

O usuário nunca deverá receber:

```text
WebSocketError: ECONNRESET...
```

Deverá receber:

```text
Não foi possível conectar ao servidor.
Verifique o IP, porta e senha.
```

Detalhes técnicos ficam nos logs.

---

# 90. Primeiro MVP

O primeiro MVP deverá conter somente:

### Conexão

- [ ] Criar servidor
- [ ] Entrar em servidor
- [ ] IP
- [ ] Porta
- [ ] Senha
- [ ] Client ID

### Usuário

- [ ] Nickname
- [ ] Nickname único
- [ ] Alteração de nickname
- [ ] Avatar até 5 MB

### Servidor

- [ ] Canais de texto
- [ ] Canais de voz
- [ ] Lista de usuários

### Chat

- [ ] Enviar mensagem
- [ ] Receber mensagem
- [ ] Histórico
- [ ] Timestamp

### Voz

- [ ] Entrar no canal
- [ ] Sair
- [ ] Microfone
- [ ] Mute
- [ ] Deafen
- [ ] Indicador de fala

### Vídeo

- [ ] Câmera
- [ ] Compartilhamento de tela

### Infraestrutura

- [ ] SQLite
- [ ] WebSocket
- [ ] WebRTC
- [ ] Segurança Electron
- [ ] Rate limiting
- [ ] Logs
- [ ] Reconnection

---

# 91. Funcionalidades explicitamente fora do MVP

Não implementar inicialmente:

- contas;
- login;
- e-mail;
- amigos;
- DM;
- Nitro;
- boosts;
- bots;
- marketplace;
- emojis personalizados;
- stickers;
- GIFs;
- threads;
- fórum;
- eventos;
- comunidades;
- descoberta de servidores;
- monetização;
- SFU;
- gravação;
- streaming público;
- integração com Twitch;
- integração com Spotify;
- Rich Presence.

Esses recursos podem ser adicionados posteriormente.

---

# 92. Roadmap

## Fase 1 — Fundação

- Electron;
- TypeScript;
- estrutura do projeto;
- servidor;
- SQLite;
- WebSocket;
- protocolo;
- Client ID.

## Fase 2 — Servidor

- criação;
- conexão;
- senha;
- nickname;
- canais;
- usuários.

## Fase 3 — Chat

- mensagens;
- histórico;
- avatar;
- rate limiting.

## Fase 4 — Voz

- WebRTC;
- microfone;
- mute;
- deafen;
- voice activity;
- múltiplos usuários.

## Fase 5 — Vídeo

- câmera;
- múltiplos vídeos;
- screen share.

## Fase 6 — Segurança

- TLS;
- Argon2;
- validações;
- limites;
- hardening Electron;
- logs.

## Fase 7 — Performance

- profiling;
- redução de RAM;
- redução de CPU;
- bitrate adaptativo;
- otimização WebRTC.

## Fase 8 — Servidor dedicado

Separar:

```text
Monky Client
```

de:

```text
Monky Server
```

permitindo hospedagem independente.

---

# 93. Requisito de performance

A aplicação deverá ser projetada para permanecer leve quando:

```text
Cliente conectado
+
sem chamada
+
sem câmera
+
sem screen share
```

O consumo deverá ser mínimo.

Durante chamada:

- áudio deverá possuir prioridade;
- vídeo deverá utilizar bitrate adaptativo;
- screen share deverá utilizar bitrate controlado;
- streams desligados não deverão consumir banda significativa.

---

# 94. Requisito de banda

O usuário deverá possuir uma configuração:

```text
Maximum upload bandwidth
Maximum download bandwidth
```

Exemplo:

```text
Upload:
1 Mbps

Download:
2 Mbps
```

A aplicação deverá adaptar a qualidade dos streams dentro desses limites sempre que tecnicamente possível.

---

# 95. Configuração para jogos

Adicionar um preset:

## Gaming Mode

Objetivo:

**não prejudicar jogos online.**

Características:

- áudio com baixa largura de banda;
- câmera reduzida;
- screen share limitado;
- prioridade para áudio;
- bitrate configurável;
- evitar processamento desnecessário;
- suspender vídeo quando não estiver sendo visualizado.

Exemplo:

```text
Voice: 24-32 kbps
Camera: 300 kbps
Screen: 500 kbps
```

---

# 96. Regra fundamental de performance

A aplicação nunca deverá utilizar:

```text
CPU/GPU
```

para processar algo que possa ser realizado pelo:

```text
WebRTC
Browser Media Stack
OS
```

Deve-se evitar processamento manual de:

- áudio;
- vídeo;
- frames;
- codecs.

Sempre que possível, utilizar as APIs nativas.

---

# 97. Regra fundamental de arquitetura

A UI não deverá saber como o servidor funciona.

A UI deverá trabalhar com abstrações:

```typescript
ChatService
VoiceService
ServerService
UserService
```

e não:

```typescript
WebSocket
SQLite
RTCPeerConnection
```

diretamente.

---

# 98. Objetivo final

O resultado esperado é uma aplicação:

```text
┌─────────────────────────────────────────┐
│              MONKY                      │
├─────────────────────────────────────────┤
│                                         │
│  Servidor privado entre amigos          │
│                                         │
│  IP + Porta + Senha                     │
│                                         │
│  Nickname                               │
│                                         │
│  ┌──────────┐ ┌──────────────────────┐ │
│  │ Canais   │ │                      │ │
│  │          │ │   Voz / Vídeo        │ │
│  │ 🔊 Geral │ │                      │ │
│  │ 🔊 Jogos │ │   👤 👤 👤           │ │
│  │          │ │                      │ │
│  │ # geral  │ │                      │ │
│  │ # jogos  │ │                      │ │
│  └──────────┘ └──────────────────────┘ │
│                                         │
│       🎤   📷   🖥️   🔊   🚪            │
└─────────────────────────────────────────┘
```

O projeto deverá privilegiar:

**simplicidade > quantidade de funcionalidades**

**performance > efeitos visuais**

**segurança > conveniência**

**arquitetura limpa > implementação rápida**

**extensibilidade > código descartável**

**WebRTC P2P > servidor retransmitindo mídia**

---

# 99. Resultado arquitetural esperado

A arquitetura final deverá permitir que o mesmo código evolua de:

```text
Electron
   ↓
Servidor na máquina do usuário
   ↓
WebRTC P2P
```

para:

```text
Electron
   ↓
Servidor dedicado
   ↓
Signaling
   ↓
SFU
   ↓
WebRTC
```

sem precisar reescrever completamente o cliente.

Esse é o principal objetivo arquitetural do projeto.