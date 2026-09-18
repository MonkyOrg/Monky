# Entrar Em Um Servidor

Na aba **Entrar no Servidor** existem três caminhos.

<AppScreenshot src="/screenshots/inicio-pt.png" alt="Tela inicial do Monky, com as opções de conexão e os campos do servidor." caption="O endereço e a porta precisam apontar para o processo que hospeda o servidor." />

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

O botão **Início** (a casinha, no topo da coluna) pede confirmação para
desconectar de todos os servidores, incluindo a chamada ativa. Trocar o
servidor visualizado e confirmar essa saída são ações diferentes.

## Vários dispositivos ao mesmo tempo

Você pode entrar no mesmo servidor a partir de mais de um computador usando a mesma identidade — por exemplo, o desktop e o notebook. Cada dispositivo aparece como uma entrada própria na lista de voz, com um sufixo `(2)`, `(3)` para diferenciar, mas continua sendo uma única pessoa na lista de membros e ocupa apenas uma vaga do servidor.

Alguns detalhes que valem saber:

- O áudio entre os **seus próprios** dispositivos é descartado automaticamente, para não causar microfonia. Câmera e compartilhamento de tela continuam funcionando normalmente entre eles.
- Mute pessoal e volume individual são controles do dispositivo. Um bloqueio administrativo de microfone/áudio vale para sua identidade naquele servidor, incluindo os demais dispositivos; expulsar do servidor desconecta todos eles.
- O limite é de **3 dispositivos simultâneos** por pessoa.

Se algo falhar, veja [Solução de Problemas](/solucao-de-problemas).
