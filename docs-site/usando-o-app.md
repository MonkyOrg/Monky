# Usando o App

## Voz

Clique em um **canal de voz** para entrar na chamada. Quem fala ganha um anel verde no avatar. A barra inferior tem microfone, fone/ensurdecer e desconectar. O painel mostra ping médio e permite sair só da chamada.

Use clique direito em um participante para ajustar o volume individual dele. O ajuste vale só neste computador e para aquele dispositivo: se a mesma pessoa estiver conectada de duas máquinas, cada uma tem seu próprio volume.

A chamada acompanha você: se trocar de servidor na coluna da esquerda, ela continua tocando, e o ícone do servidor onde ela está fica marcado. Entrar em um canal de voz de outro servidor move a chamada para lá. Veja [Vários servidores ao mesmo tempo](/entrar-em-um-servidor#varios-servidores-ao-mesmo-tempo).

## Câmera e tela

Na barra de mídia: **Câmera**, **Compartilhar Tela** e **Soundboard**. O compartilhamento permite escolher uma tela inteira ou uma janela específica, com áudio de tela para os participantes.

Em **Configurações → Voz e Vídeo → Câmera**, compare desfoque, fundo virtual
de cor ou imagem e chroma key de tela física na prévia. Os efeitos são locais
e valem também para a chamada. Fechar a prévia não desliga uma câmera em uso;
veja limites e cuidados nas [configurações](/configuracoes).

Quem transmite aparece com selo **LIVE**. Clique no card para destacar ou use tela cheia.

## Chat

Cada canal de texto tem histórico salvo no servidor, avatares, horários, formatação básica e limite anti-flood de 10 mensagens a cada 5 segundos.

Uma mensagem começada e não enviada fica guardada no canal onde você estava digitando. Ir para o palco de voz, abrir outro canal e voltar não apaga o texto — cada canal guarda o seu rascunho, que só some quando você envia a mensagem ou sai do servidor.

Ao passar o mouse sobre uma mensagem (ou chegar aos botões com `Tab`), uma barra flutuante oferece **Emoji**, **Responder**, **Copiar mensagem** e **Mais opções**. O menu de três pontos mostra os nomes completos; **Editar mensagem** aparece apenas para o autor, se o servidor permitir, e **Apagar mensagem** para o autor ou moderadores. Use as setas para navegar no menu e `Escape` para fechá-lo.

**Responder** mantém uma referência à mensagem original, com autor e prévia. A resposta pode incluir texto, anexos, código ou figurinha; mensagens públicas de bots também podem receber respostas. Cancele pelo `×` no campo de composição ou com `Escape`. A referência acompanha o rascunho do canal. Clicar na prévia leva à mensagem original, carregando uma janela do histórico se necessário; **Voltar às mensagens recentes** retorna ao fim da conversa. A prévia acompanha edições e mostra **Mensagem apagada** se o original for excluído, sem preservar seu conteúdo. Mensagens privadas de bots não podem ser usadas como referência.

## Menções

Digitar `@` no campo de mensagem abre a lista de membros: escolha alguém para inserir `@apelido`. Quem é mencionado recebe o destaque na mensagem, o badge no canal e o som de menção.

O primeiro item da lista é o `@todos` (ou `@everyone` — os dois tokens funcionam em qualquer idioma), que notifica todo mundo que enxerga aquele canal. Canais privados continuam privados: quem não tem acesso não é notificado.

Quem administra o servidor pode desligar isso em **Configurações do servidor → Geral → Permitir menção a todos**, ou pela CLI com a chave `allowEveryoneMention`. O padrão é ligado.

## Blocos de código

O botão `< >`, ao lado da carinha, abre uma janela para colar código. Escolha a linguagem na lista (ou deixe em *Texto simples*) e envie com o botão ou com `Ctrl+Enter`.

Dentro da janela o `Tab` indenta em vez de pular para o próximo campo, e `Shift+Tab` remove a indentação. Com várias linhas selecionadas, vale para todas de uma vez.

No chat o código aparece em um bloco destacado, com o nome da linguagem no topo e um botão **Copiar** que leva o trecho para a área de transferência sem a formatação. O contador da janela já inclui as marcações do bloco, então ele mostra o tamanho real da mensagem que será enviada.

Quem preferir digitar direto no campo de mensagem também pode: envolver o trecho em três crases (```` ``` ````) tem o mesmo efeito, e escrever a linguagem logo depois da primeira crase (por exemplo ```` ```python ````) liga o destaque de sintaxe.

## Emojis e figurinhas

O botão de carinha ao lado do campo de mensagem abre um seletor com as abas **Emojis** e **Figurinhas**. Na barra inferior de categorias dos emojis, o ícone de relógio leva a **Recentes**.

O relógio de **Recentes** também aparece na barra de categorias do seletor de reações. Os dois compartilham os últimos 32 emojis distintos selecionados neste dispositivo, do mais recente para o mais antigo, mesmo depois de reiniciar o app. Navegar entre categorias ou pesquisar não altera a lista; selecionar novamente um emoji o move para o começo. Figurinhas não entram nessa lista.

Em **Emojis** há o catálogo completo, dividido por categorias e com busca em português (procure por `coracao`, `festa`, `bolo`…). Clicar em um emoji o insere onde o cursor estiver, então dá para misturar emoji e texto na mesma mensagem.

Em **Figurinhas** você escolhe uma pasta do seu computador, do mesmo jeito que faz com o soundboard — pelo próprio seletor ou em **Configurações › Figurinhas**. Toda imagem `.png`, `.gif`, `.webp`, `.jpg`, `.apng` ou `.avif` de até 8 MB vira uma figurinha; GIFs animados continuam animados. Arquivos acima do limite aparecem esmaecidos, com o motivo, em vez de sumirem da lista. Clicar em uma figurinha a envia na hora, como uma mensagem própria, e ela aparece para todos em um quadrado de tamanho fixo.

A pasta é lida de novo toda vez que o seletor abre, então adicionar ou apagar arquivos com o app aberto funciona. Se precisar, o botão de recarregar (ao lado de *Trocar de Pasta*) força uma nova leitura.

Recebeu uma figurinha de alguém? Passe o mouse sobre ela e clique no botão de salvar para copiá-la para a sua pasta.

A pasta fica só na sua máquina: a imagem é enviada ao servidor quando você usa a figurinha, como qualquer anexo. Por isso enviar figurinha exige a permissão **Anexar arquivos**.

## Soundboard

Em **Configurações › Soundboard**, escolha uma pasta com `.mp3`, `.wav` ou `.ogg`. Na chamada, toque pelo botão de soundboard. Volume e mudo local ficam nas mesmas configurações. O anfitrião pode desativar o soundboard do servidor inteiro e, em **Configurações do Servidor › Cargos**, liberar a permissão **Usar soundboard** apenas para os cargos desejados.

Use as estrelas e o filtro **Todos/Favoritos** para localizar sons junto com
a busca. Os favoritos vêm primeiro, e cada grupo fica em ordem alfabética,
sem mudar os atalhos associados aos sons. Marcar a estrela não toca o som.
A mesma ordenação existe na lista de servidores salvos da Home.
