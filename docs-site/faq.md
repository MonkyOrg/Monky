---
description: "Leia antes de criar um servidor: por que o Monky não funciona como o Discord, onde o servidor roda e como seus amigos conseguem entrar."
---

# Perguntas frequentes

O Monky tem canais, voz, cargos e convites, então é fácil achar que ele
funciona como o Discord. Mas ele não funciona como o Discord: **não existe uma
nuvem do Monky**. O servidor roda no computador de alguém do seu grupo ou em uma
VPS que vocês controlam. Leia estas respostas antes de criar o seu.

## O Monky funciona como o Discord?

Não. A aparência é parecida, mas quem mantém o servidor funcionando é o seu
grupo, não uma empresa.

| Situação | Discord | Monky |
| --- | --- | --- |
| Onde o servidor roda | Na infraestrutura da empresa | No computador de quem criou ou em uma VPS |
| O dono desliga o computador | Nada muda | O servidor sai do ar |
| Amigos de outra casa entram | Basta o convite | Convite **e** um caminho até o servidor: porta liberada, VPN ou VPS |
| Conta | Cadastro com e-mail e senha | Identidade guardada no seu dispositivo, sem cadastro |
| Perdi o computador | Recupera pelo e-mail | Só com o backup da identidade |
| Histórico dos canais | Nos servidores da empresa | No servidor de quem hospeda |

## Criar um servidor

### Preciso criar um servidor para usar o Monky?

Não. Se alguém do seu grupo já hospeda, basta
[entrar no servidor dessa pessoa](/entrar-em-um-servidor). Para conhecer o
aplicativo, entre no
[Monky Community](https://monkyorg.github.io/Monky/convite/#~EYmDv64PTW9ua3kgQ29tbXVuaXR5),
o servidor aberto da comunidade. Crie um servidor só se você vai ser quem
hospeda para o grupo.

### Criei um servidor, mas meus amigos não conseguem entrar. Por quê?

Ao clicar em **Criar e Iniciar Servidor**, o Monky abre um servidor **no seu
computador**. Quem está na mesma rede que você entra direto. Quem está em outra
internet precisa de um caminho até a sua máquina, e o roteador bloqueia esse
acesso por padrão. Escolha uma opção:

| Opção | Quando usar |
| --- | --- |
| Liberar a porta no roteador (port forwarding) | Você tem acesso ao roteador e um IP público próprio |
| VPN como Radmin VPN, Hamachi, ZeroTier ou Tailscale | Você não quer ou não pode mexer no roteador; todos entram na mesma VPN |
| [Hospedar em uma VPS](/hospedar-em-vps) | Você quer o servidor no ar o tempo todo |

O convite leva o endereço e a porta, mas **não libera portas nem configura a
VPN**. Veja [Liberar acesso pela internet](/criar-seu-servidor#liberar-acesso-pela-internet).
Se a sua operadora usa CGNAT, liberar a porta não basta; confira
[como saber se você está atrás de CGNAT](/solucao-de-problemas#como-saber-se-estou-atras-de-cgnat).
Não conhece esses termos? Veja [o que é uma VPN, uma VPS e liberar uma porta](#nao-sabe-o-que-e-uma-vpn-ou-uma-vps).

### O servidor continua no ar quando eu fecho o Monky?

Depende de como você fecha:

- **Fechar a janela:** por padrão, o Monky continua na bandeja do sistema e o
  servidor segue no ar. Isso muda em **Configurações → Sobre e Updates →
  Minimizar para a bandeja ao fechar**.
- **Sair do Monky:** o servidor para e todos são desconectados.
- **Desligar, reiniciar ou suspender o computador:** o servidor sai do ar.

Ao abrir o Monky de novo, o servidor não volta sozinho: clique com o botão
direito no ícone dele no trilho e escolha **Iniciar**. Para um servidor sempre
disponível, use uma [VPS](/hospedar-em-vps).

### Hospedo no meu computador ou em uma VPS?

| Aspecto | No aplicativo | Em uma VPS |
| --- | --- | --- |
| Disponibilidade | Enquanto seu computador e o Monky estiverem ligados | 24 horas |
| Custo | Nenhum além da sua internet e energia | O do provedor escolhido |
| Configuração | Pelo aplicativo, mais porta liberada ou VPN | Pelo [Monky CLI](/cli), em Linux |

### Onde ficam as mensagens e os canais do meu servidor?

Na máquina que hospeda o servidor. Não há uma cópia na nuvem do Monky: se essa
máquina perder os dados, o histórico do servidor se perde junto.

### P2P ou SFU: qual escolho?

Comece pelo **P2P Mesh**, o padrão: voz e vídeo vão direto entre as pessoas e
o servidor quase não usa banda. O **SFU** ajuda em chamadas grandes e
transmissões pesadas, mas exige mais portas abertas e mais banda de quem
hospeda. Veja [P2P e SFU](/criar-seu-servidor#modos-de-voz-e-midia-p2p-mesh-vs-sfu).

## Não sabe o que é uma VPN ou uma VPS?

São as duas formas mais comuns de deixar seus amigos entrarem sem depender do
seu roteador. Escolha uma delas; você não precisa das duas.

### O que é uma VPN?

Uma VPN cria uma rede particular pela internet: computadores em casas
diferentes passam a se enxergar como se estivessem na mesma rede local. Todos
do grupo instalam o mesmo programa, como Radmin VPN, Hamachi, ZeroTier ou
Tailscale, e entram na mesma rede dentro dele. Depois, seus amigos se conectam
ao Monky usando o endereço que a VPN mostra para o seu computador.

É uma solução gratuita e não exige mexer no roteador. O servidor continua no
seu computador, então ele ainda sai do ar quando você sai do Monky.

::: warning VPN de privacidade não serve
Serviços que escondem seu IP para navegar, como os anunciados para assistir a
conteúdo de outros países, não colocam você e seus amigos na mesma rede. Use um
dos programas citados acima.
:::

### O que é uma VPS?

Uma VPS é um computador alugado em um data center, ligado 24 horas e com um
endereço público na internet. Você instala nela o servidor do Monky pelo
[Monky CLI](/cli), e o servidor fica no ar mesmo com o seu computador
desligado.

Normalmente é paga por mês e é configurada por linha de comando, em Linux. O
passo a passo está em [Hospedar em VPS](/hospedar-em-vps).

### O que é liberar uma porta?

É configurar o seu roteador para encaminhar ao seu computador as conexões que
chegam da internet em uma porta, a `3000` por padrão. A opção fica na página de
configuração do roteador, com nomes como *Port Forwarding*, *Redirecionamento
de portas* ou *Servidor virtual*. Algumas operadoras usam CGNAT e não permitem
esse encaminhamento; nesse caso, use uma VPN ou uma VPS.

## Conta e identidade

### Preciso criar uma conta ou informar um e-mail?

Não. Na primeira abertura, o Monky cria uma identidade que fica guardada no seu
dispositivo. Não existe cadastro, e-mail nem senha central.

### Troquei ou formatei o computador. Como recupero minha conta?

Somente com o [backup da identidade](/primeiros-passos#guarde-um-backup-da-identidade)
exportado antes. Sem ele, não há como recuperar: nenhuma empresa guarda a sua
conta. Uma identidade nova é uma pessoa nova para os servidores, e os cargos e
amigos da anterior não voltam.

### Posso usar o Monky em mais de um computador?

Sim. Importe a mesma identidade em cada computador. Você pode ficar conectado ao
mesmo servidor por até 3 dispositivos ao mesmo tempo. Veja
[Vários dispositivos ao mesmo tempo](/entrar-em-um-servidor#varios-dispositivos-ao-mesmo-tempo).

## Conversas e privacidade

### Quem hospeda o servidor consegue ler as mensagens?

As mensagens dos **canais** ficam guardadas no servidor, então quem o hospeda
tem acesso a esses dados. No modo SFU, voz e vídeo também passam pelo servidor.
As **mensagens diretas** são criptografadas de ponta a ponta, e o servidor
apenas as repassa, sem guardar. Veja [Onde os dados passam](/recursos#onde-os-dados-passam).

### Por que minha mensagem direta ficou semitransparente?

Ela ainda não foi entregue. Uma mensagem direta só é transmitida quando vocês
dois estão online em pelo menos um servidor em comum; até lá, ela fica guardada
no seu computador. Veja [Amigos e mensagens diretas](/amigos-e-mensagens-diretas#conversar).

## Outras dúvidas

### O Monky é gratuito?

Sim. O aplicativo é gratuito e de código aberto. Hospedar em uma VPS pode ter o
custo do provedor que você escolher.

### Em quais sistemas o Monky funciona?

O aplicativo está disponível para Windows e macOS. Veja o [Download](/download).

### Onde peço ajuda ou relato um problema?

- Consulte a [Solução de problemas](/solucao-de-problemas).
- Pergunte no
  [Monky Community](https://monkyorg.github.io/Monky/convite/#~EYmDv64PTW9ua3kgQ29tbXVuaXR5).
- Relate bugs em
  [Discussions › Bug Reports](https://github.com/MonkyOrg/Monky/discussions/categories/bug-reports)
  e sugira ideias em
  [Discussions › Ideas](https://github.com/MonkyOrg/Monky/discussions/categories/ideas).
