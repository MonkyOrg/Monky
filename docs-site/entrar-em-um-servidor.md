# Entrar Em Um Servidor

Na aba **Entrar no Servidor** existem quatro caminhos.

<AppScreenshot src="/screenshots/inicio-pt.png" alt="Tela inicial do Monky, com as opções de conexão e os campos do servidor." caption="O endereço e a porta precisam apontar para o processo que hospeda o servidor." />

## Convite por link

Cole o link em **Entrar por convite** e clique em **Revisar convite**, ou abra
o link HTTPS recebido no navegador. A página oficial tenta abrir o aplicativo
instalado usando `monky://` e oferece botões para abrir, copiar ou baixar o Monky.
O navegador pode pedir sua confirmação. Em execução de desenvolvimento ou
portátil, cole o link no aplicativo; o teste local não registra um protocolo
global no seu sistema.

O link curto usa a própria página inicial, no formato
`https://monkyorg.github.io/Monky/#~...`; a abertura direta usa
`monky://#~...`. O trecho após `#~` contém os dados completos em formato
binário, com compressão sem perda quando ela reduzir o tamanho. Não há
encurtador, código cadastrado ou serviço central para resolver o convite:
o aplicativo lê o próprio link, mesmo sem carregar o site.

Confira nome, endereço e porta no modal e clique em **Entrar**. O Monky usa
automaticamente o nome da identidade atual, sem pedir que você o redigite.
O campo de apelido só aparece se a identidade ou seu nome ainda não estiver
configurado. Um link recebido nunca conecta por conta própria nem encerra suas
outras sessões ou a chamada atual. Se você já estiver conectado ao servidor,
a sessão é reaproveitada sem substituir as credenciais salvas.

Para gerar um link, abra **Convidar Amigos** no servidor e copie o convite.
Ele sai **sem senha por padrão**. O switch **Incluir senha no convite** usa a
senha já conhecida pelo cliente, sem pedir que você a digite novamente.
Quando essa senha não estiver disponível, o link continua funcionando sem
ela: quem entra a informa se o servidor exigir.
Com a senha incluída, não é necessário receber endereço, porta ou senha
separadamente: basta o convite e a confirmação no aplicativo.

Os dados ficam no fragmento após `#`, não em uma consulta ao site. Isso é
codificação, não criptografia: qualquer pessoa com um convite que inclua
senha poderá usá-la. O certificado HTTPS é o do site oficial; não é preciso
instalar um certificado no servidor para compartilhar o link. O convite
não altera o transporte do servidor nem libera portas, VPN ou firewall.

## Servidores na Rede

Clique em **Buscar**. O app escuta por cerca de 5 segundos os servidores Monky na rede local e lista nome, IP e versão. Clique em **Entrar**.

## Servidores Salvos

Todo servidor em que você entra fica salvo. A bolinha indica **online** ou **offline**, e a lista mostra quem está conectado. Use **Usar** para preencher os campos ou **X** para remover.

## Entrada manual

Preencha **Seu Nickname**, **IP / Host do Servidor**, **Porta** (normalmente `3000`) e **Senha do Servidor** se existir. Depois clique em **Entrar no Servidor**.

## Vários servidores ao mesmo tempo

Depois de entrar, a coluna de ícones à esquerda lista seus servidores. Clicar em um deles leva você para lá **sem desconectar do anterior**: a conexão antiga continua viva em segundo plano.

Na prática, isso significa que:

- **Sua chamada de voz não cai quando você troca de servidor.** Enquanto ela estiver rolando em outro servidor, o ícone dele na coluna da esquerda ganha uma marca verde de áudio.
- **Mensagens que chegam num servidor em segundo plano são recebidas normalmente** e marcam o ícone dele com um ponto. O app não toca som nesse caso — o alerta seria de uma conversa que você não está vendo.
- **Voltar para um servidor já conectado é instantâneo**, sem nova autenticação nem tela de carregamento.

Você fala em um servidor por vez, porque o microfone é um só: ao entrar em um canal de voz de outro servidor, a chamada **muda de lugar** e você sai automaticamente do canal anterior. O chat de texto, esse sim, continua ativo em todos ao mesmo tempo.

O botão **Início** (a casinha, no topo da coluna) volta à tela inicial sem
desconectar servidores nem encerrar a chamada. A barra lateral permite
reabrir uma conexão, e os controles inferiores continuam disponíveis.
O botão **Desconectar** da barra inferior sai somente do servidor indicado
no botão, após confirmação. Em seguida, o Monky abre o próximo servidor
conectado; se não houver nenhum, mostra a tela inicial.

## Vários dispositivos ao mesmo tempo

Você pode entrar no mesmo servidor a partir de mais de um computador usando a mesma identidade — por exemplo, o desktop e o notebook. Cada dispositivo aparece como uma entrada própria na lista de voz, com um sufixo `(2)`, `(3)` para diferenciar, mas continua sendo uma única pessoa na lista de membros e ocupa apenas uma vaga do servidor.

Alguns detalhes que valem saber:

- O áudio entre os **seus próprios** dispositivos é descartado automaticamente, para não causar microfonia. Câmera e compartilhamento de tela continuam funcionando normalmente entre eles.
- Mute pessoal e volume individual são controles do dispositivo. Um bloqueio administrativo de microfone/áudio vale para sua identidade naquele servidor, incluindo os demais dispositivos; expulsar do servidor desconecta todos eles.
- O limite é de **3 dispositivos simultâneos** por pessoa.

Se algo falhar, veja [Solução de Problemas](/solucao-de-problemas).
