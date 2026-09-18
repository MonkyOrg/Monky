# O que o Monky oferece

Monky é um aplicativo de comunicação com servidores que você pode hospedar.
Os guias de uso e as capturas deste site descrevem o cliente desktop para
Windows e macOS; não é preciso programar ou instalar um bot para conversar.

## Conversas e mídia

- **Chat:** histórico no servidor, respostas, menções, reações, código, anexos,
  emojis e figurinhas de uma pasta local.
- **Voz:** WebRTC em P2P ou SFU, detecção de fala, PTT, mute/deafen e volume
  individual por participante/dispositivo.
- **Áudio local:** RNNoise, Speex, GTCRN ou WebRTC para supressão de ruído,
  teste do microfone e saídas por categoria.
- **Vídeo:** câmera, efeitos de fundo e compartilhamento de tela/janela;
  áudio de compartilhamento depende da plataforma e da fonte.
- **Soundboard:** biblioteca local, favoritos, busca, atalhos e permissões
  controladas pelo servidor.

Veja [Conversas, voz e mídia](/usando-o-app) e
[Configurações](/configuracoes). Os perfis Econômico, Normal, Alta Qualidade,
Gaming, Ultra e Personalizado ajustam a transmissão, não garantem uma taxa
de quadros em qualquer hardware.

## Servidores e comunidade

Conecte vários servidores ao mesmo tempo e troque a conversa visualizada
sem derrubar uma chamada em outro servidor. Há descoberta na rede local,
servidores salvos e favoritos.

Quem administra pode criar canais públicos/privados, configurar cargos,
moderar membros, controlar recursos e consultar métricas e logs protegidos.
O limite de membros considera cadastros, não apenas pessoas online.

Comece por [Criar pelo aplicativo](/criar-seu-servidor). Para operação contínua,
use o [CLI](/cli) e o [guia de VPS](/hospedar-em-vps).

## Bots e miniapps

Bots podem oferecer comandos, formulários privados, votações, prévias de
áudio, downloads autorizados, publicação de áudio e miniapps compartilhados.
Capacidades são aprovadas no servidor; tarefas no seu computador têm um
consentimento separado.

| Quero… | Guia |
| --- | --- |
| Adicionar ou usar um bot existente | [Usar bots](/bots) |
| Programar meu primeiro comando | [Seu primeiro bot](/bots-desenvolvimento) |
| Consultar propriedades, métodos e eventos | [Referência do SDK](/bots-api) |

## Onde os dados passam

| Recurso | Caminho |
| --- | --- |
| Identidade e preferências pessoais | Perfil local; exportação protegida quando solicitada |
| Chat, cargos, canais e anexos | Servidor escolhido pelo grupo |
| Mídia P2P | Caminho direto entre participantes quando possível; TURN pode repassá-la |
| Mídia SFU | Passa pelo servidor, que encaminha aos participantes |
| Ferramentas locais de bots | Cliente de quem consentiu; só operações implementadas pelo Monky |

Hospedagem própria não significa anonimato nem criptografia ponta a ponta
de todo conteúdo. Confira a [arquitetura](/arquitetura), quem administra sua
hospedagem e as permissões antes de compartilhar informações sensíveis.
