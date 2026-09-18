# Solução de Problemas

Primeiro identifique a etapa que falhou: **conexão ao servidor**, **mídia da
chamada** ou **ação de um bot**. Uma porta de chat acessível não comprova que
voz e vídeo estejam passando; TURN não corrige o endereço de login.

| Sintoma | O que costuma resolver |
|---|---|
| macOS diz que o app "está danificado e não pode ser aberto" | Confira origem e checksum antes de alterar a quarentena. Veja [Download](/download#macos-o-aplicativo-esta-danificado-e-nao-pode-ser-aberto) |
| Não consigo conectar no servidor do meu amigo | Confirme processo, endereço, porta TCP e firewall. Em CGNAT, use uma rede VPN acessível aos participantes ou uma hospedagem publicamente alcançável. TURN só ajuda a mídia depois de conectar |
| Nickname já em uso | Nicknames são únicos por servidor — escolha outro |
| Entrei, mas ninguém me ouve | Confira Configurações › Voz e Vídeo, o medidor, o limite de detecção, PTT, mute pessoal e eventual bloqueio administrativo |
| Ouço uma pessoa, mas o avatar não indica sua fala | Atualize o cliente. O indicador acompanha o áudio decodificado de cada microfone em P2P e SFU, mesmo quando as estatísticas RTP informam nível zero. Ele fica oculto enquanto você está ensurdecido; áudio de tela não deve acioná-lo |
| Ouço todo mundo cortando | Use perfil Econômico, peça o mesmo a quem transmite e prefira cabo a Wi-Fi |
| Tela compartilhada sem som | Confira se a fonte/plataforma oferece áudio de compartilhamento, a opção escolhida e os volumes da origem e do receptor |
| Nada em Servidores na Rede | A descoberta só funciona na mesma LAN; clique em Buscar de novo e verifique UDP `41234` no firewall |
| Um participante ficou mudo só para mim | Clique com o botão direito nele e volte o volume individual para 100% |
| Só não consigo falar com **uma** pessoa específica (com o resto funciona) | Aparece um ícone vermelho `link_off` ao lado dela. Os dois provavelmente estão atrás de CGNAT e não há rota direta. Quem hospeda pode ligar o [relay TURN](/turn); a alternativa é os dois entrarem numa VPN. Só acontece no modo P2P Mesh |
| No **modo SFU**, ninguém ouve ninguém e a chamada nunca conecta | O range `40000-49151` precisa estar aberto em **UDP e TCP** no firewall e no roteador. A sinalização usa outra porta, então o servidor parece funcionar enquanto a mídia não passa. Veja [Abrindo as portas do Modo SFU](/hospedar-em-vps#abrindo-as-portas-do-modo-sfu) |
| No **modo SFU**, a chamada cai e o app fica avisando que está reconectando | Pode ser falha do processo ou do trajeto de mídia. Criar transportes e produtores pela sinalização não comprova conectividade ICE/DTLS. Confira nos logs os endereços e portas anunciados, o firewall da VM e as regras do provedor; conseguir reservar uma porta localmente não comprova acesso externo |
| O Avast (ou outro antivírus) apita ao instalar/atualizar | Confira a detecção, a origem e a integridade; não presuma falso positivo. Veja [Antivírus: Avast e similares](#antivirus-avast-e-similares) |
| O botão do **relay TURN** está esmaecido e não deixa clicar | Confira o motivo exibido: plataforma não suportada, modo SFU, versão antiga ou falta de privilégio para instalar coturn. Para este último caso, siga a [instalação manual](/turn#instalacao-manual-do-coturn), respeitando os outros serviços do host |
| O TURN está ligado mas ninguém conecta via relay | As portas podem estar fechadas. Veja o [guia completo de portas](/turn#portas-necessarias). Rode `monky status` — deve aparecer `✔ acessível` |
| No macOS, o compartilhamento de tela pede autorização mesmo já estando liberado | A permissão ficou presa na versão anterior — veja [macOS: a permissão de tela para de valer após atualizar](#macos-a-permissao-de-tela-para-de-valer-apos-atualizar) |
| Bot online, mas sem comandos | Confira capacidades aprovadas, permissão do cargo e switch do canal. Veja [Diagnóstico de bots](/bots#quando-algo-nao-funciona) |

## Antivírus: Avast e similares

Sem uma assinatura de distribuição reconhecida, antivírus baseados em reputação
podem marcar o aplicativo ou atualizador. Isso pode ser falso positivo,
mas código aberto e build automático não provam que qualquer arquivo encontrado
na sua máquina seja seguro. [Verifique a release](/verificar-releases) e
consulte o nome e o caminho exatos da detecção.

### Pastas do Monky para liberar

Não exclua pastas inteiras preventivamente. No histórico do antivírus,
identifique o arquivo bloqueado, compare com o artefato oficial e procure
orientação do fornecedor. Se confirmar um falso positivo, prefira a exceção
mais restrita para aquela detecção. Não desative a proteção em tempo real
nem libere a pasta dos seus dados pessoais.

### O aviso de "Old uninstaller" durante a atualização

O instalador NSIS pode executar uma cópia temporária do desinstalador anterior
em `%LOCALAPPDATA%\Temp\...`. Isso explica um nome como `old-uninstaller.exe`,
mas o nome sozinho não comprova legitimidade. Confira a origem da atualização
e a detecção antes de autorizar qualquer arquivo; não libere a pasta inteira.

::: danger Atenção
`%LOCALAPPDATA%\Temp` **não é uma pasta do Monky**. Ela é a pasta temporária
compartilhada por todo o Windows e por todos os programas da máquina. Colocá-la
inteira em exceção reduz a proteção do seu antivírus contra qualquer outro
software, e não só contra o Monky.

Não recomendamos essa exceção e ela **não é de responsabilidade do projeto**: se
optar por fazê-la, é **por sua conta e risco**.
:::

## macOS: a permissão de tela para de valer após atualizar

Você já autorizou o Monky em **Ajustes do Sistema › Privacidade e Segurança ›
Gravação de Tela**, a chave continua ligada, mas ao tentar compartilhar a tela o
app insiste que falta autorização. Desligar e ligar a chave não adianta.

O motivo: o macOS **não guarda essa permissão pelo nome do app**, e sim pela
**assinatura de código** do binário. Como o Monky ainda não é assinado com um
certificado Apple Developer ID, o sistema acaba identificando o app pelo
conteúdo do próprio binário — que muda a cada versão. Depois de atualizar, o
macOS enxerga um app com identidade nova, e a autorização concedida à versão
anterior não se aplica a ele. Como o nome e o caminho continuam idênticos, a
entrada antiga permanece listada e marcada — daí a impressão de que já está tudo
liberado.

### Como voltar a compartilhar a tela

A partir da versão `3.0.0-beta007`, o próprio Monky detecta esse estado. Ao
clicar em **Compartilhar Tela**, se o macOS estiver negando a captura, aparece um
aviso com o botão **Reabrir permissão**: ele limpa a autorização antiga e
reinicia o app, e o macOS pergunta de novo na próxima tentativa. É só conceder.

Se preferir fazer na mão (ou estiver numa versão anterior):

1. Feche o Monky por completo (inclusive o ícone na barra de menus).
2. No **Terminal**, rode:

   ```bash
   tccutil reset ScreenCapture com.monky.app
   ```

3. Abra o Monky e tente compartilhar a tela.
4. Quando o macOS pedir a autorização, conceda novamente.

Se o comando não resolver, remova a entrada na mão: **Ajustes do Sistema ›
Privacidade e Segurança › Gravação de Tela**, selecione o Monky, clique em
**−** para removê-lo, e então repita o passo 3 para que ele seja adicionado de
novo.

::: tip Correção definitiva
A solução real é assinar o app com um certificado **Apple Developer ID**, que
mantém a mesma identidade entre versões e faz a permissão sobreviver às
atualizações. Isso depende de uma conta paga do Apple Developer Program; o
projeto já está preparado para usá-la assim que estiver disponível.
:::

## Não consigo me conectar com alguém específico (CGNAT)

Se você consegue falar com a maioria das pessoas, mas **com uma pessoa
específica** a chamada não conecta (aparece ícone vermelho `link_off`), uma
causa possível é **CGNAT/NAT restritivo**, mas bloqueio de UDP, firewall,
VPN ou uma rota ICE inválida também podem impedir a conexão. O ícone identifica
a falha daquele par, não diagnostica sozinho o tipo de rede.

### Opção 1: Relay TURN (recomendado se o servidor é Linux)

O administrador do servidor pode ligar o relay TURN, que faz o servidor repassar
a mídia entre os dois. É transparente: o app usa automaticamente quando precisa.

Veja o [guia completo de TURN](/turn) — inclui como abrir portas, verificar e
diagnosticar.

### Opção 2: VPN

Se o servidor não for Linux (TURN não disponível) ou o admin não puder abrir as
portas, ambos os membros podem entrar numa **VPN** (como Tailscale, ZeroTier ou
WireGuard). A VPN cria uma rede virtual que contorna o CGNAT.

### Opção 3: modo SFU (se quem hospeda topar carregar a mídia)

No [modo SFU](/criar-seu-servidor#modos-de-voz-e-midia-p2p-mesh-vs-sfu) ninguém
se conecta diretamente aos outros participantes: cada pessoa fala com o
servidor. Isso evita depender do caminho direto entre os dois, mas ainda exige
uma rota acessível até o host, IP anunciado correto e portas `40000-49151`
liberadas. A mídia passa pelo host, que precisa da banda correspondente.

### Como saber se estou atrás de CGNAT?

- Compare o IP público mostrado por [ifconfig.me](https://ifconfig.me) com o
  endereço **WAN** do roteador, não o endereço local da página administrativa.
  Uma diferença sugere NAT adicional, que pode ser CGNAT ou outro roteador;
  confirme com o provedor. VPNs e proxies também podem alterar a comparação.
- Internet móvel (4G/5G) é quase sempre CGNAT.
- Provedores de fibra residencial no Brasil frequentemente usam CGNAT.
