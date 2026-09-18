# Usar bots {#bots}

Bots acrescentam comandos, votações, música e miniapps ao seu servidor.
Este guia é para **quem usa ou administra o Monky**. Você não precisa
programar para seguir estas instruções.

::: tip Quer criar um bot?
Comece em [Seu primeiro bot](/bots-desenvolvimento). A documentação do SDK de bots tem
guias separados por recurso, exemplos e [referência completa da API](/bots-api).
:::

## O que é um bot?

É um programa externo que se conecta ao servidor e aparece na lista de membros
com o selo **BOT**. Seu operador mantém esse processo em execução; vincular um
bot no Monky não instala nem hospeda automaticamente o programa.

O bot publica seu próprio nome e avatar. A administração do servidor controla
o vínculo e as permissões, não a identidade visual dele.

## Duas formas de adicionar um bot

Você precisa ser dono/administrador ou ter **Adicionar e gerenciar bots**.
Abra **nome do servidor → Configurações do Servidor → Bots**.

### 1. Via URL (recomendado)

Peça ao operador a URL do **manifest**, não a página do GitHub nem a URL de
download do programa.

1. Cole a URL em **Vincular bot por URL** e clique em **Vincular**.
2. Confira o nome, a descrição e as capacidades solicitadas.
3. Ative somente os acessos que deseja conceder. Os switches começam desligados.
4. Clique em **Confirmar e vincular bot** e aguarde a conclusão.

<AppScreenshot src="/screenshots/bots-vincular-pt.png" alt="Configurações do servidor na aba Bots, com o campo de URL do manifest e o vínculo manual avançado recolhido." caption="O endereço local da captura serve apenas ao ambiente demonstrativo. Um bot remoto precisa de um endereço alcançável pelo seu servidor." />

<AppScreenshot src="/screenshots/bots-permissoes-pt.png" alt="Revisão de capacidades de GuiaBot, com switches para comandos, mensagens, seletores e miniapps." caption="A revisão mostra apenas o que esse bot solicitou. Vincular não significa conceder acesso irrestrito." />

O servidor precisa alcançar o manifest e o bot precisa conseguir conectar de
volta ao servidor. Se um está em uma VPS e o outro no seu computador,
`localhost` não conecta essas duas máquinas. O operador encontra os detalhes
em [Requisitos de rede do bot](/bots-conexao#requisitos-de-rede).

### 2. Manual por token (avançado)

Use quando o bot não expõe um manifest acessível:

1. Abra **Mostrar opção avançada** e gere um vínculo/token.
2. Copie o token mostrado **uma única vez** e informe-o no setup do bot.
3. Aguarde o processo conectar e anunciar sua identidade e capacidades.
4. Abra as configurações desse bot, revise **Permissões no servidor** e salve.

O token autentica o vínculo; **não aprova ações**. Uma reserva ainda sem
identidade fica aguardando a conexão na administração de bots. Não divulgue o
token nem o confunda com o token do GitHub usado para baixar releases privadas.

## Executar um comando

Em um canal de texto, digite `/`. O catálogo mostra o bot responsável, o nome
e a descrição de cada comando. Comandos podem ter nomes traduzidos de acordo
com sua preferência de idioma.

<AppScreenshot src="/screenshots/comandos-pt.png" alt="Catálogo de slash commands do bot demonstrativo, aberto acima do campo de mensagem." caption="Escolha o comando pelo catálogo para manter o bot correto, inclusive quando dois bots usam o mesmo nome." />

- Navegue com as setas e confirme por clique ou `Enter`.
- **Espaço** seleciona o comando destacado sem executá-lo imediatamente.
- Preencha os campos obrigatórios; os opcionais aparecem em **+N**.
- Em buscas com sugestões, selecione um resultado válido. Digitar texto
  sozinho não confirma uma escolha de autocomplete.
- Use os controles de cancelamento quando não quiser continuar.

Comandos sem parâmetros e sem download podem começar assim que forem
selecionados. No autocomplete, confirmar o último obrigatório pode executar
imediatamente quando não há opcionais. Havendo opcionais, o compositor
permanece aberto para você revisar e enviar.

## Respostas, formulários e votações

A resposta padrão de um comando é **privada**: só a conexão que executou
o comando a vê, dentro do chat. Ela não entra no histórico público.
O bot pode publicar explicitamente um resultado, se tiver permissão.

<AppScreenshot src="/screenshots/formulario-pt.png" alt="Formulário privado do GuiaBot com campos para uma atividade, escolha de horário e switch de lembrete." caption="Formulários são preenchidos no próprio chat. O exemplo é demonstrativo; cada bot define suas perguntas." />

Uma votação pública é diferente: fica no canal para os membros autorizados
responderem e pode continuar após você fechar a conversa. Os controles
informam as escolhas e o estado; tempo, limite de participantes e possibilidade
de trocar o voto dependem da configuração da votação.

## Preferências e permissões

Clique com o botão direito no bot — na lista de membros ou em sua mensagem —
e abra **Configurações do bot**. Também há acesso pela lista de bots nas
configurações do servidor.

| Seção | Quem controla | O que muda |
| --- | --- | --- |
| **Minhas preferências** | Você | Idioma desse bot e preferências pessoais neste dispositivo |
| **Comportamento neste servidor** | Administração ou cargo autorizado a configurar bots | Opções compartilhadas que o próprio bot disponibiliza |
| **Permissões no servidor** | Quem pode gerenciar bots | Capacidades que o bot pode executar nesse servidor |

**Seguir o Monky** usa o idioma do aplicativo. Uma escolha própria vale
somente para esse bot/servidor/identidade neste perfil; não traduz mensagens
antigas nem renomeia os comandos para todo mundo.

Ao revisar capacidades, o servidor encerra o trabalho anterior daquele bot,
incluindo interações e mídia. Uma reconexão pode acontecer; alterações não
devem ser usadas como tentativa de "reiniciar" uma música em andamento.

### Quem pode usar

Além da autorização do bot, a pessoa precisa de **Executar comandos de bots**
no cargo. O canal precisa manter **Permitir comandos de bots** ligado.
Desligar esse switch bloqueia comandos e interações naquele canal,
**inclusive para administradores**.

Bots não recebem cargos de pessoas. Estar autorizado a publicar áudio ou
abrir um miniapp não dá acesso irrestrito a canais privados.

### Ferramentas no seu computador

Permissão no servidor **não autoriza o seu dispositivo**. Alguns comandos
pedem que o Monky prepare ferramentas locais. O pedido explica o motivo,
as ferramentas e o espaço necessário; você pode negar, permitir até
desconectar ou manter a autorização até revogá-la.

Em **Configurações → Ferramentas de bots**, consulte ferramentas, espaço,
cache, permissões e tarefas. Remover uma ferramenta ou revogar acesso
interrompe o trabalho afetado. As instalações são gerenciadas pelo Monky,
não uma autorização para o bot enviar scripts arbitrários.

### Baixar para o Soundboard

Configure antes uma pasta em **Configurações → Soundboard**. O download
autorizado mostra nome, destino e origem e nunca substitui um arquivo
existente. Ouvir uma prévia não baixa o som para essa pasta nem transmite
áudio para a chamada.

Para voltar a confirmar o nome de cada arquivo, abra **Configurações do bot →
Minhas preferências → Perguntar o nome antes de baixar** e salve.

## Miniapps na sala de voz

Um bot pode abrir uma tela interativa compartilhada na sala. O convite e o
card ficam no **palco de voz**, não como um site externo que se abre sozinho.

<AppScreenshot src="/screenshots/miniapp-pt.png" alt="Miniapp demonstrativo aberto no palco de voz, com escolhas de atividades compartilhadas." caption="Uma tela do bot usa o palco da chamada, mas não é a câmera nem o compartilhamento de tela de alguém." />

**Abrir miniapp** inicia sua visualização. **Sair do miniapp** fecha só a sua
visualização. **Encerrar miniapp**, disponível para quem o criou ou para um
administrador autorizado, encerra aquela instância para todos.

O SDK atual permite que bots **publiquem áudio**, mas não recebam o microfone,
a câmera ou o compartilhamento dos participantes. Não existe um switch para
dar permissão de escuta.

## Monky Bot (bot oficial)

O [MonkyBot](https://github.com/MonkyOrg/MonkyBot) oferece utilitários, votações,
música e um jogo da velha. A instalação do processo é descrita no repositório
do bot; depois, faça o vínculo e a revisão no Monky.

| Objetivo | Comandos |
| --- | --- |
| Conferir disponibilidade e ajuda | `/ping`, `/ajuda` |
| Utilitários | `/dado`, `/moeda`, `/8ball` |
| Criar uma votação | `/enquete` |
| Buscar e adicionar música | `/play` |
| Ver a reprodução | `/queue`, `/nowplaying` |
| Controlar a fila | `/pause`, `/resume`, `/skip`, `/remove`, `/clear` |
| Parar ou sair | `/stop`, `/leave` |
| Abrir uma partida compartilhada | `/jogo-da-velha` |

Os nomes exibidos podem variar com o idioma. Use o catálogo para ver os
nomes locais, parâmetros e descrições da versão instalada.

Entre em voz antes de usar os comandos musicais. Há uma fila por servidor;
se o bot já estiver em outra sala, entre nela para controlar a reprodução.
A busca, a resolução e a conversão de áudio usam o cliente de quem pediu,
com consentimento; a VPS do bot não substitui automaticamente esse dispositivo.

Spotify, playlists, álbuns e transmissões ao vivo não são suportados por essa
integração. Use somente conteúdo cuja reprodução você está autorizado a
realizar e respeite os
[termos do provedor](https://developers.google.com/youtube/terms/developer-policies).
Mudanças no provedor podem impedir a reprodução mesmo com a chamada funcionando.

## Quando algo não funciona

| Sintoma | O que conferir |
| --- | --- |
| Bot online, sem comandos | Capacidades declaradas/aprovadas, permissão do cargo e switch do canal. Não reinstale nem apague chaves para resolver uma aprovação pendente |
| Erro ao abrir o manifest | Processo do bot em execução, URL correta, porta e firewall nos dois sentidos |
| Token inválido ou identidade diferente | O operador precisa conferir o vínculo e preservar a identidade original; não gere chaves a cada reinício |
| Comando pede ferramentas novamente | Confira se a autorização era temporária ou foi revogada, e se a preparação terminou |
| Prévia funciona, mas a música não toca | Confirme sua presença em voz, as ferramentas, o acesso ao provedor e o transporte privado de mídia |
| Bot para após atualizar | Confira compatibilidade de protocolo, logs do processo e capacidades recém-solicitadas |

Desvincular revoga o acesso daquele cadastro. Vincular novamente exige outra
revisão. Atualizar um bot não deve exigir apagar a identidade ou os cadastros
válidos dos outros servidores.

<LegacyBotLinks />
