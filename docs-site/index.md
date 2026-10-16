---
description: "Chat, voz, vídeo e compartilhamento de tela em servidores que você ou seu grupo hospeda, sem conta central. Baixe grátis para Windows e macOS."
layout: home
title: Monky
titleTemplate: Chat, voz e vídeo em servidores seus
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
    - theme: alt
      text: Entrar no servidor da comunidade
      link: https://monkyorg.github.io/Monky/convite/#~EYmDv64PTW9ua3kgQ29tbXVuaXR5
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

## Servidor da comunidade

Quer conhecer o Monky antes de montar o seu? Entre no **Monky Community**, o
servidor aberto da comunidade: tire dúvidas, teste voz e compartilhamento de
tela e experimente o MonkyBot. Ele não tem senha.

[Entrar no Monky Community](https://monkyorg.github.io/Monky/convite/#~EYmDv64PTW9ua3kgQ29tbXVuaXR5)

O convite abre o Monky instalado. Se ainda não tiver o aplicativo, a página do
convite oferece o download.

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
