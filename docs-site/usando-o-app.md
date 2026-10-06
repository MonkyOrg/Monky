# Usando o App

Depois de conectar, a lateral esquerda organiza servidores e canais; o centro
mostra a conversa ou o palco de voz; a lista à direita reúne os membros.
Conectar ao servidor e entrar em uma chamada são ações separadas.

<AppScreenshot src="/screenshots/conversa-pt.png" alt="Conversa demonstrativa com servidores e canais à esquerda, mensagens ao centro e membros à direita." caption="Captura do cliente para Windows com dados demonstrativos. Nomes, conversas e bot foram criados para este guia." />

## Canais e categorias

Quem possui permissão para gerenciar canais pode arrastar canais para reordenar
ou mover entre categorias e arrastar o cabeçalho das próprias categorias para
reordená-las. Canais sem categoria e categorias dividem a mesma ordem, então um
canal solto pode ficar acima, abaixo ou entre as categorias. Durante o arraste,
a categoria de destino recebe o mesmo destaque tracejado usado ao mover
participantes entre canais de voz. Esse contorno aparece somente sobre a metade
de baixo do nome da categoria; na metade de cima, uma linha indica que o canal
fica logo acima dela, fora da categoria. Sobre os canais, uma linha indica a
posição exata. Categorias recolhidas também aceitam o canal. Para levar um
canal ao fim da lista, fora de qualquer categoria, solte-o em **Sem categoria**,
que aparece no fim da lista durante o arraste. Servidores ainda não atualizados
mantêm os canais sem categoria no topo.

Na barra de servidores à esquerda, arraste qualquer servidor, inclusive o que
está aberto, para mudar a ordem ou para dentro e fora de uma pasta.

## Fóruns

Fóruns organizam conversas em threads. Use a busca e o seletor de ordenação para
encontrar discussões por atividade recente, data de criação mais recente ou
mais antiga. Quando ainda não houver nenhuma thread, o fórum mostra apenas o
convite para começar a primeira conversa.

O campo no topo pesquisa threads enquanto você digita. Com ele em foco,
**Shift + Enter** abre uma nova postagem e reaproveita o texto como título. Na
criação, fotos e vídeos possuem um seletor próprio, que bloqueia outros
formatos, aceita até cinco mídias e mostra uma prévia compacta em carrossel. O
foco segue diretamente para a mensagem, sem ampliar o campo de busca. O seletor
de arquivos aceita qualquer anexo, inclusive fotos e vídeos, e os apresenta em
cards compactos com nome, formato e tamanho antes da publicação. Ao publicar
várias mídias, a primeira mensagem preserva o
carrossel em vez de exibir cada item isoladamente.
Fóruns extensos carregam as threads em lotes conforme você se aproxima do fim
da lista e mostram cards de skeleton durante cada carregamento.

O autor pode renomear, fechar, reabrir ou apagar a própria thread. Fechar impede
novas respostas, mas permanece uma ação do autor. Pessoas com permissão para
gerenciar canais podem fixar, trancar, destrancar, renomear ou apagar threads;
o trancamento é um estado administrativo separado do fechamento. Nos dois
estados, o compositor fica somente leitura e explica o motivo no placeholder,
sem exibir um alerta adicional.

## Voz

Clique em um **canal de voz** para entrar na chamada. Quem fala ganha um anel verde no avatar. A barra inferior tem microfone, fone/ensurdecer e desconectar. O painel mostra ping médio e permite sair só da chamada.

Cada canal de voz também possui um chat persistente. Passe o mouse sobre a linha
do canal e use o botão redondo de balão, ao lado dos três pontos, para abrir o
palco e o chat na lateral direita sem entrar na chamada. No palco, o mesmo balão
preenchido no canto superior direito mostra ou oculta o painel. Arraste a borda
esquerda do chat para ajustar sua largura; o tamanho escolhido é lembrado.
Mensagens, anexos, reações,
enquetes, menções e busca continuam disponíveis mesmo quando você não está
conectado à voz.

Use clique direito em um participante para ajustar o volume individual dele. O ajuste vale só neste computador e para aquele dispositivo: se a mesma pessoa estiver conectada de duas máquinas, cada uma tem seu próprio volume.

A chamada acompanha você: se trocar de servidor na coluna da esquerda, ela continua tocando, e o ícone do servidor onde ela está fica marcado. Entrar em um canal de voz de outro servidor move a chamada para lá. Veja [Vários servidores ao mesmo tempo](/entrar-em-um-servidor#varios-servidores-ao-mesmo-tempo).

## Câmera e tela

Na barra de mídia: **Câmera**, **Compartilhar Tela** e **Soundboard**. Escolha
uma tela ou janela específica; a disponibilidade de áudio de compartilhamento
depende da plataforma e da fonte. Confira o que será capturado antes de iniciar.

Em **Configurações → Voz e Vídeo → Câmera**, compare desfoque, fundo virtual
de cor ou imagem e chroma key de tela física na prévia. Os efeitos são locais
e valem também para a chamada. Fechar a prévia não desliga uma câmera em uso;
veja limites e cuidados nas [configurações](/configuracoes).

Na prévia rápida, escolher **Imagem** sem um fundo definido mantém o painel
aberto e mostra o aviso no próprio painel. A prévia fica desligada e seu switch
bloqueado até você escolher uma imagem. Isso também vale para chroma key com
substituição por imagem; nenhum vídeo sem o efeito é publicado como alternativa.

Quem pode assistir vê o selo **LIVE**. Clique no card para destacar ou use tela cheia.

### Ajuste de FPS para o codificador

Na seção **Qualidade** das configurações, toda mudança de resolução, FPS,
bitrate, preset, codec ou método de codificação passa pela verificação da
combinação antes de reaplicar uma transmissão. O modo **Manual** mantém o codec e
o método escolhidos. Se o perfil não for suportado, o app testa
taxas de quadros menores e só ajusta os FPS após confirmar uma combinação
compatível neste computador — por exemplo, de 4K120 para 4K60. Um aviso explica
o ajuste; resolução, bitrate, câmera e áudio permanecem iguais.

Os limites numéricos de câmera e áudio continuam valendo; verificar a tela
não exige iniciar a webcam. O app não inventa limites de bitrate do codificador.
Falhas temporárias na verificação não reduzem os FPS. Se nenhuma opção for
compatível, a mudança de perfil não é aplicada: ajuste a qualidade ou escolha
outro codificador. Durante uma transmissão,
o ajuste passa pela mesma validação das mudanças manuais de qualidade;
se ela impedir a alteração, o perfil anterior é mantido.

### Compartilhamento privado

No seletor de tela ou janela, ative **Compartilhamento privado** e abra
**Quem pode assistir**. O dropdown permite buscar e selecionar vários
**Usuários** ou **Cargos**, com fotos dos usuários, cores dos cargos e uma lista
com rolagem. Os selecionados aparecem resumidos no campo; reabra a lista para
desmarcar alguém. Selecionar um usuário **ou**
um cargo que ele possui libera o acesso; não é necessário atender aos dois.
Selecione pelo menos um: uma seleção vazia bloqueia o início, nunca torna a
transmissão pública. Novas transmissões são públicas por padrão.

Para as outras pessoas, não aparece transmissão, selo LIVE nem áudio de tela.
Isso também vale para administradores: não há acesso automático. O servidor
verifica o público antes de permitir vídeo ou áudio; conhecer um identificador
de transmissão não permite assistir. As permissões do canal e a participação
na mesma chamada continuam necessárias.

A seleção acompanha a transmissão ao trocar a fonte, reconectar ou mudar a
qualidade, e identifica a pessoa, não apenas um dispositivo. Remover ou excluir
um cargo revoga imediatamente as assinaturas que dependem dele, sem encerrar
o microfone ou outras transmissões permitidas. Adicionar um cargo dá
visibilidade à transmissão. O público é escolhido antes de iniciar; para
definir outro, encerre a transmissão e inicie novamente.

### Quem está assistindo

Em cliente e servidor com suporte à lista de espectadores (protocolo 30), cada
card de transmissão mostra até dois avatares e **+N assistindo** para os demais,
sem repetir a contagem total. Passe o
mouse, clique ou use o teclado para abrir a lista completa; **Escape** fecha.
Todos na chamada que podem ver a transmissão podem consultar a lista, mesmo
sem assistir. Nas transmissões privadas, o público autorizado continua sendo
respeitado.

Na lista aberta, se você estiver assistindo, o resumo mostra **Você e mais X pessoas estão
assistindo**. A lista conta conexões com assinatura aceita, não apenas pessoas
autorizadas, e não comprova atenção à tela. Duas conexões da mesma pessoa
aparecem separadamente. A atualização ocorre aproximadamente a cada dois
segundos; se a consulta falhar, o card informa a indisponibilidade em vez de
mostrar uma contagem desatualizada. A prévia local não conta como espectador.

## Eventos

Ao criar ou editar um evento, você pode clicar ou arrastar até **5 imagens** de
uma vez. Cada imagem passa pelo recorte 5:2 e pode ser navegada, reordenada ou
removida no mesmo editor. A primeira funciona como capa compacta nas listas; o
carrossel completo aparece somente nos detalhes. O atalho lateral informa o
estado do evento sem repetir banners ou imagens. Na lista, clique em qualquer
área livre do card para abrir os detalhes; o menu de três pontos reúne edição,
encerramento e as demais ações administrativas.

Início e término são obrigatórios e aparecem juntos; o fuso horário permanece
nas opções secundárias. Ao avançar com um valor inválido, o aplicativo mostra
um toast, destaca o campo correspondente e leva o foco até ele. Fóruns podem
receber eventos, mas threads não aparecem como canais de localização. Ao ativar
a visibilidade privada, o formulário rola até **Quem pode acessar** sem abrir a
lista automaticamente.

## Ações ao vivo

Eventos representam compromissos com data, horário, local e interessados.
**Ações ao vivo** são interações temporárias que estão acontecendo agora. Os
dois atalhos são independentes e aparecem somente para quem pode visualizar ou
gerenciar seu conteúdo.

Quem possui **Emitir ações ao vivo** pode abrir **Ações ao vivo → Criar ação ao
vivo** e escolher:

- **Enquete**, usando o mesmo fluxo de enquetes nativas e publicada
  obrigatoriamente como ação ao vivo;
- **Formulário**, com texto curto, texto longo, número, switch de sim/não,
  escolha única, escolha múltipla, dropdown e classificação de 1 a 5. Cada
  pergunta aparece em um bloco próprio; escolhas usam listas de rádio ou caixas.
  As opções são adicionadas ou removidas em linhas individuais.

O formulário pertence a um canal de texto e aceita uma resposta por pessoa.
Threads de fórum não são canais de publicação e, por isso, não oferecem criação
de enquete, evento ou formulário.
Antes de publicar, o criador pode ativar **Respostas anônimas**. Nesse modo,
nome, avatar e horário nunca são enviados para as telas de resultado nem para o
CSV; o servidor mantém o vínculo interno somente para impedir uma segunda
resposta e permitir que a própria pessoa edite seu envio. A configuração não
pode ser alterada depois da publicação.
Na escolha múltipla, a pessoa pode marcar várias opções válidas sem duplicatas.
Enquanto estiver aberto, cada participante pode reabri-lo e editar a própria
resposta. Somente quem criou ou possui **Emitir ações ao vivo** pode ver os
resultados e encerrar a ação. Esses controles ficam no menu de três pontos do
card da ação, sem ocupar o formulário de resposta; quando o formulário não é
anônimo, a visualização dos resultados também identifica os participantes. A
tela de respostas oferece as
visões **Resumo**, **Pergunta** e **Individual**. Resumo e Pergunta usam gráficos
de rosca ou barras quando o tipo de resposta permite uma distribuição; a última
visão reutiliza o formulário em modo somente leitura. Respostas textuais no
Resumo usam uma lista rolável com carregamento progressivo. Todas as respostas
também podem ser exportadas em CSV. Em **Pergunta**, as respostas são paginadas e podem
abrir o envio individual correspondente; valores repetidos oferecem um seletor
para escolher qual envio abrir.
Formulários encerrados deixam de
aparecer na lista e seus dados são removidos do servidor após 30 dias.

Enquetes, formulários e ações de bots usam a lista agregada de Ações ao vivo.
Imagens e carrosséis aparecem nos detalhes, nunca na barra lateral. O sorteio
continua sendo uma ação oferecida por bot, não um tipo nativo do criador.

## Chat

Cada canal de texto tem histórico salvo no servidor, avatares, horários, formatação básica e limite anti-flood de 10 mensagens a cada 5 segundos.

Em servidores compatíveis, suas mensagens mostram **Enviando**, **Enviada ao
servidor** ou **Falha ao enviar** junto ao horário. A confirmação é de recebimento
pelo servidor, não de leitura. Em caso de falha, **Tentar novamente** reenvia a
mesma mensagem sem duplicá-la, inclusive quando a confirmação anterior se perdeu.
Texto, respostas, código e anexos ficam preservados na fila da sessão, mesmo
ao trocar de canal ou reconectar ao mesmo servidor e identidade. Essa fila é
mantida em memória enquanto o aplicativo está aberto; ela não é um arquivo local
permanente de mensagens.

O limite padrão é de **16.000 caracteres**, configurável em **Configurações do
servidor → Geral**. Desligar o switch remove o limite de caracteres, não a
proteção de transporte de 8 MiB por pacote. O contador acompanha mudanças sem
reconectar. Em servidores compatíveis, os controles de recursos não negociados
indicam que é preciso atualizar.

Uma mensagem começada e não enviada fica guardada no canal onde você estava digitando. Ir para o palco de voz, abrir outro canal e voltar não apaga o texto — cada canal guarda o seu rascunho, que só some quando você envia a mensagem ou sai do servidor.

O botão **+** abre as ações do compositor. **Anexar arquivo** mantém o fluxo de
upload existente; **Criar enquete** abre um fluxo em três etapas para a pergunta,
de 2 a 10 respostas — cada uma com emoji opcional —, até 5 imagens em carrossel
selecionáveis de uma só vez, com prévia, navegação animada e reordenação,
duração e/ou limite de votantes. A enquete pode aceitar uma resposta ou várias;
nesse caso, cada pessoa confirma em conjunto quantas respostas quiser, inclusive
todas. O voto pode ser alterado até o encerramento. A enquete fecha no primeiro
limite atingido e a mensagem permanece com as contagens e percentuais finais.

Quem possui **Emitir ações ao vivo** também pode destacar a mesma enquete acima
dos canais. A mensagem e a ação ao vivo são duas superfícies do mesmo recurso:
um voto feito em qualquer uma aparece na outra, sem duplicação. Sem a permissão,
o switch continua visível com a explicação e a enquete normal pode ser enviada.
As imagens aparecem na mensagem mesmo sem ação ao vivo.

Ao passar o mouse sobre uma mensagem (ou chegar aos botões com `Tab`), uma barra flutuante oferece **Emoji**, **Responder**, **Copiar mensagem** e **Mais opções**. O menu de três pontos mostra os nomes completos; **Editar mensagem** aparece apenas para o autor, se o servidor permitir, e **Apagar mensagem** para o autor ou moderadores. Use as setas para navegar no menu e `Escape` para fechá-lo.

Depois de apagar, **Desfazer** restaura a mesma mensagem, com seus blocos, anexos e reações, durante **60 segundos** por padrão. O prazo continua ao trocar de canal ou reconectar e é controlado pelo servidor. Só quem apagou pode desfazer; para mensagens de outra pessoa, essa pessoa ainda precisa ter permissão de moderação. O autor não pode reverter uma exclusão feita por um moderador. As referências de respostas voltam a mostrar a mensagem restaurada, sem enviar uma nova mensagem nem repetir notificações de menção.

Configure **Configurações do servidor → Notificações → Prazo para desfazer exclusões (segundos)**, ou a chave `messageDeleteUndoSeconds` no CLI, entre **1 e 86.400 segundos**. Mudanças valem somente para novas exclusões. Ao vencer o prazo, não é mais possível restaurar. O conteúdo fica em um backup temporário privado do servidor durante a janela e é removido na próxima limpeza periódica após o vencimento. Este recurso requer cliente e servidor atualizados para o protocolo **27**; clientes anteriores não interpretam restaurações.

`Ctrl+C` copia o texto selecionado com a formatação exibida; `Ctrl+Shift+C` copia o mesmo texto sem formatação. No macOS, use `Cmd` no lugar de `Ctrl`. Sem seleção, o atalho atua somente sobre a mensagem que está com foco, não sobre a conversa inteira. **Copiar mensagem**, tanto na barra quanto em **Mais opções**, copia com formatação por padrão, como `Ctrl+C`. Uma seleção dentro da mensagem é respeitada também por esses botões. No menu, clicar no texto, `Enter` ou `Espaço` executa essa cópia; passar o mouse, clicar na seta ou usar `→` abre as opções **Copiar com formatação**, **Copiar Markdown** e **Copiar sem formatação**. Use `←` ou `Escape` para voltar e `Tab` para sair.

A cópia formatada oferece HTML para aplicativos de texto rico e texto visível para destinos textuais, sem acrescentar marcadores como `**`. **Copiar Markdown** é a opção explícita para obter a marcação original. **Copiar sem formatação** oferece somente o texto visível, sem Markdown nem HTML. Ao colar uma cópia formatada no Monky, a marcação é recuperada e continua editável; HTML externo não é inserido na interface. Mensagens somente com imagem ou figurinha copiam a imagem; outros anexos, ou a opção **Copiar sem formatação**, copiam os nomes dos arquivos, sem transferir os anexos.

O campo de mensagem exibe Markdown enquanto você digita e também ao editar uma mensagem. Títulos, negrito, itálico, tachado, citações e código aparecem formatados; os marcadores ficam discretos no trecho onde está o cursor e somem nos demais trechos. Blocos de código usam o mesmo editor na composição e na edição, com seletor de linguagem, numeração das linhas e realce de sintaxe, sem mostrar as crases delimitadoras. O texto original é preservado para envio e edição. As prévias de respostas também mostram a formatação, inclusive o código e os marcadores das listas. Listas numeradas preservam o primeiro número informado, como `4. item`.

Endereços começados por `http://`, `https://` ou `www.` são reconhecidos como links enquanto você digita e ficam clicáveis na mensagem enviada. Isso não insere marcação no rascunho, não altera links criados pelo formulário e não se aplica dentro de código. Endereços `www.` usam HTTPS ao abrir; pontuação ao redor não entra no link.

No campo de mensagem, o botão direito abre **Recortar**, **Copiar**, **Colar**, **Colar como texto sem formatação** e **Selecionar tudo**, com os atalhos correspondentes. Ações indisponíveis ficam desabilitadas. Sobre um link no editor, o menu oferece **Copiar link** (o endereço), **Abrir link** no navegador, **Editar link** pelo mesmo formulário e **Remover link**, mantendo o texto. Ao remover um link automático, o endereço continua visível mas deixa de ser link, inclusive depois de enviar; desfazer restaura o link. Esses menus funcionam na composição e na edição de mensagens.

Clicar fora fecha o menu, inclusive no próprio campo de mensagem ou de código. **Recortar**, **Copiar** e **Copiar link** exibem uma confirmação breve. No formulário de link, endereços como `www.google.com` ou `exemplo.com` usam HTTPS automaticamente quando o protocolo é omitido; `http://` explícito é preservado.

O botão **Opções de formatação**, ao lado do emoji, abre uma barra dentro do campo. **Negrito**, **itálico** e **tachado** funcionam como toggles: sem seleção, ligam ou desligam o efeito para o que você digitar; com seleção, alteram a formatação sem inserir texto de exemplo. `Ctrl+B` e `Ctrl+I` também funcionam. Separadores agrupam esses controles e as listas. Listas e citações podem formatar linhas existentes ou começar no campo vazio, com o cursor após o marcador. O botão de link abre um formulário acima do botão, sem modal, com os campos **Texto para exibir** e **Endereço**, preenchendo o primeiro com a seleção. Erros aparecem apenas depois de tentar inserir; `Escape` ou clicar fora fecha o formulário. `Escape` recolhe a barra. O menu **+** reúne anexos e enquetes. `Enter` envia ou salva; `Shift+Enter` cria uma linha e continua listas. No editor de código, `Enter` cria uma linha e `Ctrl+Enter` (`Cmd+Enter` no macOS) envia ou salva. As linhas em branco entre trechos são preservadas na mensagem enviada e na cópia, como na prévia.

Para copiar a **imagem**, e não o nome ou endereço do arquivo, use **Copiar imagem**
nos controles do anexo ou no menu do botão direito. Isso também funciona no menu
das figurinhas. Na visualização ampliada, use o botão de copiar ou `Ctrl+C`
(`Cmd+C` no macOS), sem texto selecionado. O destino recebe uma imagem PNG no
tamanho original; imagens animadas são copiadas como um quadro estático.
A cópia aceita até 50 MB e 64 megapixels e avisa se a imagem ou o clipboard
estiverem indisponíveis, sem substituir a imagem por um link.

Na visualização ampliada, role sobre a imagem para aproximar ou afastar:
a imagem e seu container crescem juntos, sem um recorte fixo no centro.
Quando ultrapassar a janela, arraste para explorar os detalhes. O duplo clique
alterna entre o enquadramento inicial e o tamanho original, até o limite de
8× do enquadramento inicial; setas navegam pelos
anexos e `Escape` fecha o visualizador.

**Responder** mantém uma referência à mensagem original, com autor e prévia. A resposta pode incluir texto, anexos, código ou figurinha; mensagens públicas de bots também podem receber respostas. Cancele pelo `×` no campo de composição ou com `Escape`. A referência acompanha o rascunho do canal. Clicar na prévia leva à mensagem original, carregando uma janela do histórico se necessário; **Voltar às mensagens recentes** retorna ao fim da conversa. A prévia acompanha edições e mostra **Mensagem apagada** se o original for excluído, sem preservar seu conteúdo. Mensagens privadas de bots não podem ser usadas como referência.

## Menções

Digitar `@` no campo de mensagem lista somente membros que podem ler o canal atual, incluindo quem está offline: escolha alguém para inserir `@apelido`. A lista acompanha alterações de cargos e privacidade. Menções digitadas manualmente também são verificadas pelo servidor; quem não tem acesso não recebe uma menção pendente. Quem é mencionado recebe o destaque na mensagem, o badge no canal e o som de menção.

O primeiro item da lista é o `@todos` (ou `@everyone` — os dois tokens funcionam em qualquer idioma), que notifica todo mundo que enxerga aquele canal. Canais privados continuam privados: quem não tem acesso não é notificado.

Quem administra o servidor pode desligar isso em **Configurações do servidor →
Notificações → Permitir menção a todos**, ou pelo CLI com a chave
`allowEveryoneMention`. O padrão é ligado.

## Bots e miniapps

Digite `/` em um canal de texto para descobrir os comandos disponíveis.
Bots podem responder em privado, publicar votações ou abrir miniapps no
palco de voz. O [guia de uso de bots](/bots) explica permissões, preferências
e consentimento sem exigir programação.

## Blocos de código

**Opções de formatação → Enviar bloco de código** e três crases criam um bloco de código **dentro do rascunho**, sem
enviar a mensagem. Busque e filtre a linguagem pelo nome ou abreviação (como
`js` ou `ps1`), edite ou recolha o bloco e intercale
texto e várias respostas na ordem desejada. Cada bloco pode ser removido.
Código colado com cercas Markdown também vira bloco editável. Tudo é enviado
junto; uma falha de envio mantém os blocos para tentar novamente.

No servidor antigo, o seletor de código ainda abre em janela, mas confirmar
insere o código no rascunho em vez de enviá-lo imediatamente.

O editor e a mensagem enviada exibem destaque de sintaxe e números de linha.
No editor, `Tab` indenta, `Shift+Tab` remove a indentação, `Esc` devolve o foco ao
seletor de linguagem e `Ctrl+Enter` envia a composição. No chat, o botão **Copiar**
copia somente o código, sem os números e os controles.
O contador inclui as cercas do texto de compatibilidade. As referências são
validadas pelo servidor e mostram **Mensagem apagada** se a origem for excluída.

Em mensagens compostas só por imagem ou figurinha, **Copiar mensagem** e
`Ctrl+C` sem seleção copiam a imagem, não seu nome. Mensagens que também contêm
texto continuam oferecendo esse texto; **Copiar imagem** permanece disponível.

## Emojis e figurinhas

O botão de carinha ao lado do campo de mensagem abre um seletor com as abas **Emojis** e **Figurinhas**. Na barra inferior de categorias dos emojis, o ícone de relógio leva a **Recentes**.

O relógio de **Recentes** também aparece na barra de categorias do seletor de reações. Os dois compartilham os últimos 32 emojis distintos selecionados neste dispositivo, do mais recente para o mais antigo, mesmo depois de reiniciar o app. Navegar entre categorias ou pesquisar não altera a lista; selecionar novamente um emoji o move para o começo. Figurinhas não entram nessa lista.

Em **Emojis** há o catálogo completo, dividido por categorias e com busca em português (procure por `coracao`, `festa`, `bolo`…). Clicar em um emoji o insere onde o cursor estiver, então dá para misturar emoji e texto na mesma mensagem.

Em **Figurinhas** você escolhe uma pasta do seu computador, do mesmo jeito que faz com o soundboard — pelo próprio seletor ou em **Configurações › Figurinhas**. Toda imagem `.png`, `.gif`, `.webp`, `.jpg`, `.apng` ou `.avif` de até 8 MB vira uma figurinha; GIFs animados continuam animados. Arquivos acima do limite aparecem esmaecidos, com o motivo, em vez de sumirem da lista. Clicar em uma figurinha a envia na hora, como uma mensagem própria, e ela aparece para todos em um quadrado de tamanho fixo.

A pasta é lida de novo toda vez que o seletor abre, então adicionar ou apagar arquivos com o app aberto funciona. Se precisar, o botão de recarregar (ao lado de *Trocar de Pasta*) força uma nova leitura.

Recebeu uma figurinha de alguém? Passe o mouse sobre ela e clique no botão de salvar para copiá-la para a sua pasta.

A pasta fica só na sua máquina: a imagem é enviada ao servidor quando você usa a figurinha, como qualquer anexo. Por isso enviar figurinha exige a permissão **Anexar arquivos**.

## Soundboard

O modal e a barra lateral mostram o som em reprodução, o tempo decorrido/duração
e **Parar reprodução de som**. Abrir o modal não toca nada; fechá-lo não
interrompe a reprodução normal. Parar seu som também avisa a chamada; parar o
som de outra pessoa só silencia a reprodução local.

Na grade ou lista, abra o botão de **três pontos verticais** de um áudio para acessar
**Editar**, **Renomear áudio** e **Apagar áudio**. **Editar** abre o editor de
corte e fades. Na lista, o botão fica no extremo direito, depois do atalho.
O menu funciona com teclado e fecha com `Esc` ou clique fora,
sem iniciar a reprodução. Renomear e apagar alteram o arquivo na pasta do sistema operacional;
a exclusão é permanente e pede confirmação. Favoritos e atalhos acompanham a
alteração. Nomes existentes não são substituídos. Se uma pasta antiga não estiver
autorizada, selecione-a novamente em **Trocar pasta**.

O editor mostra a forma de onda real do áudio: arraste as alças superiores para
definir início/fim do corte e as inferiores para ajustar fade-in/fade-out. Os
tempos aparecem ao lado; não é preciso digitar números. Pelo teclado, use as
setas para passos de 0,01 s, `Shift` para 0,1 s e `Alt` para uma amostra.
`Home`/`End` vão aos limites e `Esc` cancela um arraste. Ao encurtar o corte,
fades que não cabem são reduzidos proporcionalmente, com aviso.
As alças de cada par ficam alinhadas; só se separam verticalmente quando estão
próximas demais, para que uma não cubra a outra.

O player **Resultado editado · Só para você** reproduz o trecho final, com corte
e fades aplicados, usando a saída, volume e limitador da soundboard, sem
transmitir à chamada. Use **Reproduzir/Pausar**, **Voltar ao início**, **Parar**
e a barra de posição; o cursor acompanha a reprodução na forma de onda.
Pausar mantém a posição; voltar ao início não retoma um áudio pausado.
Alterar corte/fades reinicia o player para não tocar uma edição desatualizada,
e fechar o editor libera a reprodução. Alterar o nome da cópia não interrompe o som.
No rodapé ficam apenas as ações de salvamento. **Salvar novo áudio**
mantém o original e cria um WAV PCM de 24 bits a 48 kHz, preservando mono/estéreo.
**Sobrescrever original** pede confirmação e mantém nome, formato, favoritos e
atalhos. WAV não exige ferramenta adicional; para outros formatos, prepare o
FFmpeg em **Configurações › Ferramentas de bots**. Sem ele, a sobrescrita fica
bloqueada com aviso, mas salvar um novo WAV continua disponível. A substituição
só ocorre após gerar e validar o resultado; uma alteração externa no original
impede a sobrescrita. A recodificação de formatos comprimidos pode acrescentar
um pequeno preenchimento ao início/fim do áudio.

O editor não normaliza nem adiciona outros efeitos. Entradas `.mp3`, `.wav`,
`.ogg`, `.m4a`, `.aac` e `.webm` dependem do suporte do decodificador, em mono
ou estéreo. O editor não impõe limites artificiais de tamanho ou duração:
arquivos maiores que 3 MiB ou 120 segundos podem ser abertos, ouvidos no player
e salvos. A capacidade real depende da memória disponível e do formato de
arquivo (WAV RIFF usa tamanhos de 32 bits). O limite de envio de sons para a
chamada continua separado e não limita a edição local. Formatos não suportados
e falhas de gravação exibem um erro.

O Monky prepara uma pasta local de soundboard automaticamente. Em **Configurações › Soundboard**, confira o caminho ou escolha outra pasta com `.mp3`, `.wav` ou `.ogg`; pastas já escolhidas são preservadas. Na chamada, toque pelo botão de soundboard. Volume e mudo local ficam nas mesmas configurações. O anfitrião pode desativar o soundboard do servidor inteiro e, em **Configurações do Servidor › Cargos**, liberar a permissão **Usar soundboard** apenas para os cargos desejados.

Use as estrelas e o filtro **Todos/Favoritos** para localizar sons junto com
a busca. Os favoritos vêm primeiro, e cada grupo fica em ordem alfabética,
sem mudar os atalhos associados aos sons. Marcar a estrela não toca o som.
A mesma ordenação existe na lista de servidores salvos da Home.
