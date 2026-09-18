---
layout: home
title: Documentação
hero:
  name: Monky
  text: Converse. Hospede. Crie.
  tagline: Do primeiro acesso ao seu próprio bot. Encontre o caminho certo para usar o Monky, cuidar do seu servidor e desenvolver integrações.
  image:
    src: /logo.png
    alt: Monky
  actions:
    - theme: brand
      text: Baixar o Monky
      link: /download
    - theme: alt
      text: Começar a usar
      link: /primeiros-passos
    - theme: alt
      text: Desenvolver um bot
      link: /bots-desenvolvimento
features:
  - title: Usar o aplicativo
    details: Entre em um servidor, converse por texto ou voz e compartilhe sua tela. Guias ilustrados, sem precisar programar.
    link: /primeiros-passos
    linkText: Abrir os primeiros passos
  - title: Cuidar do seu servidor
    details: Hospede pelo aplicativo ou em uma VPS. Organize canais, cargos, permissões e conectividade.
    link: /criar-seu-servidor
    linkText: Escolher como hospedar
  - title: Desenvolver bots
    details: Crie comandos, formulários, votações, áudio e miniapps com o SDK de bots em TypeScript. Tutoriais e referência completa.
    link: /bots-desenvolvimento
    linkText: Criar seu primeiro bot
---

## Um lugar para o seu grupo

O Monky reúne chat, voz, vídeo e compartilhamento de tela em servidores que
você ou alguém do seu grupo hospeda. Não exige uma conta central: sua
identidade fica no seu dispositivo.

<AppScreenshot src="/screenshots/conversa-pt.png" alt="Monky com canais de texto e voz, uma conversa e a lista de membros de um servidor demonstrativo." caption="O aplicativo em uso. As capturas deste guia usam o cliente oficial no Windows, com perfis e dados demonstrativos." />

## Encontre o que precisa

| Quero… | Comece aqui |
| --- | --- |
| Baixar o aplicativo | [Download para Windows e macOS](/download) |
| Entrar com meus amigos | [Identidade e primeiros passos](/primeiros-passos) |
| Ajustar o microfone ou a câmera | [Configurações do aplicativo](/configuracoes) |
| Adicionar ou usar um bot pronto | [Guia de bots para usuários e administradores](/bots) |
| Criar um bot | [Tutorial do SDK de bots](/bots-desenvolvimento) |
| Consultar um método ou tipo | [Referência do SDK de bots](/bots-api) |
| Resolver uma falha | [Solução de problemas](/solucao-de-problemas) |

## Como funciona

1. Uma pessoa hospeda pelo app ou em uma VPS.
2. As demais entram pelo endereço e pela porta desse servidor.
3. O servidor mantém canais, permissões e histórico de texto. A mídia usa WebRTC.

No **P2P Mesh**, a mídia passa diretamente entre participantes quando a rede
permite; um **relay TURN** pode ajudar quando não há rota direta. No **SFU**, o
servidor recebe e redistribui a mídia. Essa escolha muda os requisitos de rede,
o consumo de banda e quem tem acesso à mídia — veja
[P2P e SFU](/criar-seu-servidor#modos-de-voz-e-midia-p2p-mesh-vs-sfu).

Para detalhes do funcionamento interno, consulte a [arquitetura](/arquitetura).
