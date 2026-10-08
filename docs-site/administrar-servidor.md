# Administrar um servidor

Este guia reúne o que é **compartilhado por um servidor**: canais, cargos,
moderação, bots e limites. Microfone, câmera, idioma e preferências pessoais
ficam nas [Configurações do aplicativo](/configuracoes).

## Abrir as configurações

Clique no **nome do servidor → Configurações do Servidor**. Você precisa ser
dono, administrador ou ter as permissões correspondentes. Os controles
disponíveis dependem do seu acesso.

<AppScreenshot src="/screenshots/administrar-servidor-pt.png" alt="Aba Geral das configurações do servidor, com nome, limite de membros e cards de modo de voz P2P e SFU." caption="Estas escolhas afetam o servidor, não apenas o computador de quem abriu a janela." />

| Aba | Para que serve |
| --- | --- |
| Geral | Nome, imagem e banner, habilitação de eventos, limites, modo de voz e informações do processo servidor |
| Segurança | Senha de entrada |
| Recursos de Voz e Vídeo | Permissão de Soundboard, cache de áudios recentes, relay de mensagens diretas e relay TURN integrado |
| Armazenamento | Limites e uso de anexos |
| Notificações | Menções, edição de mensagens e avisos publicados no chat |
| Membros | Consultar membros e administrar acessos conforme suas permissões |
| Cargos | Organizar permissões, hierarquia e membros de cada cargo |
| Bots | Vincular, revisar capacidades e desvincular bots |

### Aplicação imediata

Switches e seleções aplicam imediatamente. Nomes, senhas e limites aplicam
ao terminar a edição, ao sair do campo ou pressionar `Enter`. **Pronto**
apenas fecha a janela; não desfaz o que já foi confirmado.

Enquanto houver uma operação pendente, o fechamento fica bloqueado. Um
download de TURN em 100% ainda precisa da confirmação de inicialização.
Erros indicam o que não foi aplicado e permitem corrigir e tentar novamente.

Criar, instalar, excluir e revogar continuam exigindo as ações explícitas.
Se a conexão ou a sessão mudar, reabra a janela para consultar o estado atual.

### Versão e informações

Em **Geral → Informações do Servidor**, a versão é a do processo que hospeda
o servidor, não a do cliente que você está usando. Clique para copiá-la.
Se estiver indisponível, não presuma que seja igual à do seu aplicativo.

Quando o servidor reinicia para atualizar, os clientes recebem um aviso
específico, inclusive se estiverem visualizando outro servidor. Aguarde e
tente reconectar. Um aviso de atualização não significa que a nova versão
já terminou de iniciar.

### Áudios recentes da Soundboard

Em **Recursos de Voz e Vídeo**, o administrador pode ativar o **Cache de
áudios recentes** e escolher entre 1 e 100 execuções. A opção só fica
disponível quando a Soundboard do servidor está habilitada e começa desligada
em servidores existentes.

Cada áudio usado na Soundboard ocupa uma única posição no histórico, inclusive
quando pessoas diferentes usam exatamente o mesmo arquivo. Um novo uso atualiza
quem tocou e o horário e move a entrada para o topo, também quando o áudio é
ouvido como prévia local fora de uma chamada. O servidor remove primeiro os
áudios mais antigos ao atingir o limite e aplica também um teto defensivo de
256 MB. Desativar o cache ou a Soundboard do servidor apaga imediatamente o
histórico e seus arquivos.

Quando o cache está ativo, qualquer membro encontra **Áudios recentes** no
menu do nome do servidor. A lista mostra quem tocou, quando e o tamanho do
arquivo. O botão de reprodução oferece uma prévia somente local, sem reenviar
o áudio para a chamada nem criar outra posição no histórico; **Baixar** abre o
diálogo seguro do sistema operacional. Um toast confirma quando o arquivo é
salvo; cancelar o diálogo não mostra confirmação.

### Mensagens diretas

Em **Recursos de Voz e Vídeo**, o switch **Permitir mensagens diretas por este servidor**
controla se clientes atualizados podem usar este servidor apenas como ponte
para DMs criptografadas ponta a ponta. O servidor não armazena o conteúdo nem
a fila dessas mensagens.

## Canais

Clique com o botão direito em uma área vazia da lista de canais para
**Criar Canal**, **Criar categoria** ou **Convidar Amigos**. As opções de criação
exigem **Gerenciar canais**; não há um botão fixo de criar categoria na lista.

Use o **+** ao lado de uma categoria. Escolha qualquer tipo de canal,
informe o nome e revise os switches antes de criar. Uma categoria pode misturar
texto, voz e fóruns. Canais sem categoria aparecem diretamente na lista, sem
um cabeçalho de categoria artificial, e podem ficar em qualquer posição: acima,
abaixo ou entre as categorias.

Para editar ou excluir, abra **Mais opções** no canal. A exclusão é uma ação
destrutiva: confira o nome e o impacto no histórico antes de confirmar.

### Fóruns

Escolha **Fórum** ao criar um canal. Cada postagem tem título, mensagem inicial
e anexos opcionais; as respostas usam o chat normal, com edição, reações,
anexos e busca. Os tópicos herdam sempre o acesso do fórum, inclusive mudanças
de categoria ou cargos. Não aparecem como canais soltos na barra lateral.

Use a busca por título e a ordenação por atividade, mais recentes ou mais
antigos. A lista mostra prévia, miniatura, respostas e reações. Quem criou a
postagem pode alterar seu título; **Gerenciar canais** permite fixar e bloquear
respostas pelo menu de contexto da postagem. **Nova postagem** expande o
compositor na própria lista. Abrir uma discussão mantém a lista à esquerda e
o chat à direita; o **X** fecha apenas a discussão, preservando busca e rascunho.

## Eventos, banner e ações ao vivo

Em **Configurações do Servidor → Geral**, o switch **Permitir eventos e ações
ao vivo** controla os dois recursos e exige **Gerenciar servidor**.
**Gerenciar eventos** controla criação, edição, início manual, encerramento,
cancelamento e exclusão de eventos. A permissão não é concedida
automaticamente aos membros; donos e administradores continuam autorizados.
Desabilitar o switch oculta e bloqueia os dois recursos. A programação dos
eventos fica pausada, inclusive após reiniciar o servidor, e seus horários são
deslocados pelo tempo da pausa ao reativar. Ações ao vivo em andamento são
encerradas imediatamente; enquetes comuns que não são ações ao vivo continuam
ativas.

Em **Eventos → Criar evento**, selecione **Em um canal de voz ou texto**, escolha
o tipo e use o dropdown pesquisável no próprio formulário. Ele mostra somente
canais daquele tipo. **Em outro lugar** aceita um link ou local presencial em campo livre.
A criação substitui visualmente a lista; as etapas deslizam sem fechar a janela,
e voltar ou cancelar restaura a tela anterior.
Preencha título, descrição, data, fuso, encerramento e até cinco imagens opcionais; confira a
revisão antes de salvar. Ao selecionar várias imagens, ajuste todas no mesmo
modal, navegando entre elas sem perder o enquadramento. O carrossel do formulário
também permite reajustar depois a imagem ativa. Locais externos precisam de horário final. É possível repetir
diariamente, semanalmente ou mensalmente, preservando o horário no fuso
escolhido. Data e hora aparecem lado a lado, com calendário no tema do aplicativo.
O dropdown de horários sugere intervalos de 15 minutos, mas aceita digitação de
qualquer horário válido, sem arredondamento. **Término e fuso horário** reúne
as opções adicionais. Sem horário final, um evento em canal deve ser encerrado
manualmente. **Ver detalhes** abre as informações de qualquer evento, inclusive
agendado, ativo ou encerrado. O menu **Mais opções** de cada evento reúne edição, encerramento,
cancelamento e exclusão. O início manual exige confirmação.

O servidor inicia e encerra automaticamente conforme a programação. Quem
marcou **Tenho interesse** e estiver conectado recebe aviso com som no início;
o som respeita as preferências do aplicativo. Eventos em salas privadas só são
visíveis para quem pode acessar a sala. O botão de entrar usa a sala do evento;
em eventos de texto, **Abrir canal** leva à conversa correspondente.

Eventos podem ser **Públicos** ou **Privados**. No modo privado, selecione pelo
menos um membro ou cargo; as duas listas são combinadas. A seleção não substitui
as permissões do canal: a pessoa também precisa continuar podendo ler o canal,
e perder um cargo remove o acesso imediatamente. O criador e quem possui
**Gerenciar servidor** mantêm acesso de administração. Links de evento nunca
concedem acesso ao público privado.

Nos detalhes, a aba de **interessados** lista os nomes e avatares, incluindo
membros desconectados, com **Carregar mais** para listas maiores. As mesmas
permissões do evento protegem essa lista.

O menu **Mais opções** oferece **Copiar link do evento** e **Exportar para
calendário (.ics)** a todos que podem visualizar o evento. O link não inclui a
senha do servidor; quem o recebe confirma a conexão e informa a senha, se
necessário. Também é possível colá-lo em **Entrar por convite**. Após entrar,
os detalhes abrem no servidor correto, inclusive para eventos no histórico.
O link não concede acesso a canais privados.

Em eventos recorrentes, **Exportar série para calendário (.ics)** inclui toda
a série, preservando o fuso e a repetição diária, semanal ou mensal. Dias
mensais que não existem em determinado mês usam o último dia daquele mês.
Escolha onde salvar o arquivo e importe-o no aplicativo de calendário.
O arquivo é uma cópia da programação: alterações futuras no Monky não são
sincronizadas automaticamente.
Horários inexistentes ou duplicados na mudança de horário de verão podem ser
interpretados de forma diferente pelo aplicativo de calendário; confira essas
ocorrências após importar.

O banner fica em **Geral**, junto do nome e da foto do servidor. Quem tem
**Gerenciar servidor** pode configurá-lo com recorte 1000 × 400.
O banner ocupa o topo da barra lateral, atrás do nome do servidor. O recorte
oferece zoom, arraste, rotação e redefinição. Os atalhos de **Eventos** e
**Ações ao vivo** mostram estado e contagem, mas banners e carrosséis aparecem
somente nos detalhes.

Eventos e Ações ao vivo têm permissões separadas. **Gerenciar eventos** controla
o calendário; **Emitir ações ao vivo** permite criar enquetes e formulários,
consultar respostas e encerrar essas interações. Participantes continuam
dependendo de acesso ao canal. Ações ao vivo de bots também exigem aprovação da
capacidade `live_actions`; quem iniciou, o próprio bot ou um gestor com
**Emitir ações ao vivo** pode encerrá-las.

Enquetes, formulários e Ações ao vivo de bots também aceitam público privado por
membros e cargos. Enquetes privadas ficam totalmente ausentes para quem não
pertence ao público: mensagem, histórico, respostas, busca, totais e paginação
não revelam sua existência. O criador e gestores com **Gerenciar servidor**
mantêm acesso, sempre respeitando a permissão atual de leitura do canal.

## Buscar mensagens

Use a busca no topo à direita ou `Ctrl+F` dentro de um chat para começar no
canal atual. O campo abre atalhos para selecionar usuários e canais;
**Mais opções de busca** abre o modal de filtros, com **Limpar filtros**,
**Cancelar** e **Aplicar filtros**. Combine texto, autores, canais, menções, mensagens humanas/de bots,
imagem, vídeo, áudio, arquivo, link e datas antes/depois/em um dia.
Datas de dia inteiro usam UTC. Os resultados são paginados; clicar leva à
mensagem no histórico, incluindo respostas de fóruns.

A busca não inclui canais sem acesso, mensagens excluídas nem cópias de
desfazer exclusões. Alterações de acesso invalidam resultados abertos.

::: warning Compatibilidade
Categorias mistas e fóruns exigem cliente e servidor com protocolo 31.
Use ambos os builds da mesma entrega para validação local; não conecte este
cliente a um servidor antigo. O SDK mantém o piso dos bots para recursos
anteriores, mas ações ao vivo precisam de servidor compatível.
:::

### Categorias e herança de acesso

**Criar categoria** fica no menu do clique direito da área vazia da lista.
Clique com o botão direito no nome de uma categoria para editar nome e acesso,
mover para cima/baixo ou excluir.
No menu de um canal, **Mover para categoria** muda seu agrupamento;
arrastar também move e reordena canais e categorias. Canais e categorias
dividem a mesma ordem na lista: durante o arraste, abrem-se faixas acima das
categorias e no fim da lista para deixar o canal fora de qualquer categoria;
soltar sobre o nome de uma categoria coloca o canal dentro dela. **Mover para
cima/baixo**, nos menus, segue
a mesma ordem. As setas das categorias recolhem
suas listas, lembrando a escolha por servidor e identidade neste dispositivo.

Novos servidores começam com **Canais de texto** e **Canais de voz** (nomes no
idioma escolhido no aplicativo). Servidores existentes migram para esses dois
grupos; canais privados preservam seu acesso como exceções individuais.

**Editar canal** e **Editar categoria** abrem configurações com os menus
**Geral** e **Permissões** na esquerda. As alterações são aplicadas ao clicar
em **Salvar**; fechar ou cancelar descarta o rascunho.

Novos canais herdam todas as regras da categoria, não apenas a visibilidade.
Em **Permissões**, os controles ficam sempre editáveis, sem um passo de
personalização. O aviso informa se as regras estão sincronizadas. Alterações
que diferem da categoria viram regras próprias ao salvar e exibem
**Sincronizar com categoria**; esse botão pede confirmação antes de substituir
o rascunho. Regras iguais às da categoria usam a sincronização, inclusive ao
desfazer uma alteração. Mover um canal sincronizado adota o acesso do destino;
mover para **Sem categoria** preserva o acesso efetivo atual. Excluir uma
categoria **não exclui canais nem histórico**: eles ficam sem categoria, no
lugar dela, e mantêm suas permissões. Revogar acesso também remove o canal da
lista; quem já está na chamada continua nela até sair. Chat, envio de anexos e
bots respeitam o mesmo acesso.

Cada permissão de **Todos**, de um cargo ou de uma pessoa possui três estados:
**X — Negar**, **— — Herdar** e **✓ — Permitir**. Herdar não concede nem nega;
mantém o resultado das permissões gerais. Regras de cargos prevalecem sobre
Todos; entre os cargos atribuídos, **Negar vence**, independentemente da ordem.
A regra individual de uma pessoa vence a dos cargos dela, tanto para permitir
quanto para negar.
Donos e administradores mantêm acesso total.

Use **Adicionar cargos e pessoas** para pesquisar e selecionar os alvos no mesmo
dropdown usado pela audiência de eventos privados. Pessoas offline também podem
ser selecionadas. Selecione um alvo na lista para editar suas permissões ou
remover sua regra; as alterações só entram em vigor ao salvar.

Por exemplo, negue **Enviar mensagens** para Todos e permita **Ler mensagens**
para manter um canal de avisos. Adicione um cargo e permita o envio para que
somente seus integrantes publiquem. Um segundo cargo com negação explícita
impede o envio mesmo assim, a menos que a pessoa tenha uma regra individual
que permita. **Ver canal** é independente de **Ler mensagens**:
retirar apenas a leitura mantém o canal visível, mas remove histórico, resultados
de busca e notificações de mensagens. Permissões de silenciar/ensurdecer membros
continuam gerais, pois essas restrições valem para a pessoa em todo o servidor.
**Gerenciar canais**, **Mover membros**, **Gerenciar eventos** e **Emitir ações
ao vivo** também são permissões gerais do servidor: elas não aparecem no editor
de permissões de canal ou categoria e não podem ser concedidas nem negadas por
regras locais. Regras antigas com essas permissões são ignoradas. **Falar** não bloqueia a entrada em
um canal de voz; quem tem **Ver canal** entra, mas fica sem microfone,
soundboard e áudio da tela até receber **Falar** naquele canal. **Usar
soundboard** também pode ser negado só em um canal; nesse caso, a soundboard
avisa que o bloqueio vem daquele canal.

**Ver canal** decide quem encontra um canal de voz e entra nele por conta
própria. Quem tem **Mover membros** e consegue acessar o canal ainda pode trazer
qualquer pessoa para ele, mesmo que ela não veja o canal; bots são a exceção e
nunca entram assim em canais privados. Quem está dentro de um canal de voz
continua vendo o canal, com o chat dele, até sair, mesmo que perca **Ver canal**
nesse meio-tempo. Depois de sair, só volta sozinho se puder ver o canal.

### Canal privado

O switch privado configura a negação de **Ver canal** para Todos. Permita essa
permissão nos cargos ou nas pessoas que devem entrar; dono e administradores sempre podem
acessar. **Gerenciar canais**, sozinho, não ignora uma negação local.
Não é uma senha separada do servidor.
Revise os cargos antes de compartilhar conteúdo sensível.

### Comandos de bots no canal

O switch **Permitir comandos de bots** controla comandos, formulários e
botões naquele canal. Desligado, vale inclusive para administradores.
Isso não substitui a [aprovação de capacidades de cada bot](/bots#preferencias-e-permissoes).

## Cargos e permissões

**Todos** fica fixo no topo, sem cor. É a base automática de qualquer membro,
não um cargo atribuível: não é possível adicionar/remover pessoas, reordenar,
renomear ou excluir Todos. Seus controles gerais são switches de liga/desliga.
Todos abre o mesmo editor dos cargos comuns, somente com a aba **Permissões**,
sem as abas **Geral** e **Membros**.

Nos demais cargos, cada permissão também é um switch de liga/desliga. Ligado
concede a permissão a quem tem o cargo; desligado não concede nem retira, então
a pessoa ainda pode recebê-la de Todos ou de outro cargo. Um cargo não consegue
tirar o que Todos libera: para restringir algo a poucas pessoas, desligue em
Todos e ligue só nos cargos que devem ter a permissão. Um cargo novo começa com
tudo desligado, ou seja, com as mesmas permissões de Todos.

Servidores novos não criam o cargo Membro. Sem cargo, a pessoa usa Todos.
Com vários cargos, as permissões se somam: basta um cargo conceder para a
pessoa ter a permissão. Dono e administradores têm acesso total. O cargo
Membro antigo sem personalizações é convertido em Todos; cargos personalizados
ou utilizados em audiências privadas de eventos e ações são preservados.

Na atualização, os cargos que usavam **Negar**, **Herdar** e **Permitir**
voltam a ser switches: Permitir vira ligado, e Herdar e Negar viram desligado.
Negações em cargos do servidor deixam de existir, então quem só perdia uma
permissão por causa de um cargo volta a recebê-la de Todos. Para impedir algo
em um lugar específico, use **Negar** nas permissões do canal ou da categoria.
Em servidores que ainda usavam switches com a regra antiga, uma permissão só
valia se todos os cargos da pessoa a tivessem; agora basta um deles.

Essa mudança exige clientes atualizados (protocolo 35 ou posterior). Clientes
antigos são orientados a atualizar antes de conectar, para que também removam
conteúdo já carregado quando a leitura for revogada.

A aba **Membros** lista todas as pessoas cadastradas no servidor, inclusive
as offline. Desconectar não remove ninguém
da lista; cargos e acessos continuam administráveis conforme suas permissões.
Bots são administrados separadamente na aba **Bots**.

**Cargos → Criar cargo** abre um modal próprio para nome, cor e permissões.
O menu de **três pontos → Editar cargo** abre o mesmo editor para um cargo
existente, sem expandir a lista. Na criação, **Criar cargo** confirma o novo
cargo; use o **X** ou `Esc` para cancelar.
As alterações em cargos existentes continuam sendo aplicadas imediatamente.
Um cargo pode ser atribuído
automaticamente a novos membros quando essa opção estiver habilitada.

A aba **Geral** reúne nome, cor, autoatribuição e uma seção separada para
**Excluir cargo**. A exclusão também está no menu de três pontos e sempre pede
confirmação antes de remover o cargo de todos os membros.

Na aba **Membros** do editor aparecem apenas as pessoas que possuem o cargo,
inclusive offline. Use **Remover do cargo** na linha da pessoa para retirá-lo.
**Adicionar aos membros** abre outro modal com busca e somente pessoas que
ainda não possuem o cargo; **Adicionar** aplica o cargo à pessoa escolhida.
A lista é atualizada após a confirmação do servidor, preservando a busca.
Um toast confirma cada adição ou remoção concluída, sem texto de carregamento
no rodapé. Falhas mantêm o estado confirmado e permitem tentar novamente.

<AppScreenshot src="/screenshots/cargos-pt.png" alt="Lista de cargos de um servidor demonstrativo, mostrando os cargos padrão e um cargo de facilitadores." caption="Separe permissões de uso e de administração. Evite conceder Administrador quando um acesso específico basta." />

Arrastar reordena os cargos. A hierarquia limita quem pode gerenciar cargos e
membros; não trate a cor ou a posição visual como prova de uma permissão.
Um membro pode ter mais de um cargo.

Permissões relacionadas a bots são separadas:

- **Executar comandos de bots**: permite usar comandos e interações.
- **Adicionar e gerenciar bots**: permite administrar vínculos e capacidades.
- **Configurar comportamento dos bots**: permite alterar o comportamento compartilhado.

As permissões de membros humanos não são atribuídas aos bots como cargos.
Para eles, use a revisão própria de capacidades.

## Moderação de voz

O menu de botão direito de um membro apresenta as ações que você pode usar.
Expulsar da voz ou mover para outro canal exige uma conexão em chamada.
Restringir microfone/áudio pode ser feito também fora da chamada, com a
permissão correspondente.

Um **bloqueio administrativo** vale para a identidade naquele servidor,
incluindo seus outros dispositivos. Reconectar, trocar de canal ou reiniciar
não remove a restrição: um administrador precisa liberá-la.

O mute pessoal e o bloqueio administrativo são distintos. O primeiro não
desfaz o segundo. Os ícones vermelhos de restrição indicam o bloqueio
administrativo; a pessoa ainda pode manter seu próprio microfone mutado
depois de ser liberada.

## Escolher P2P ou SFU

| Modo | Caminho da mídia | Principal cuidado |
| --- | --- | --- |
| P2P | Cada participante envia diretamente aos demais, ou por TURN quando necessário | Upload dos participantes e conectividade entre as redes |
| SFU | Participantes publicam no servidor, que encaminha aos espectadores | CPU, banda, IP anunciado e portas de mídia do servidor |

O modo pode ser escolhido em **Geral → Modo de Voz e Vídeo**. Mudar o modo
durante uma chamada reconfigura a mídia; avise os participantes e confira
as condições de rede antes.

TURN é um relay para conexões P2P que não conseguem um caminho direto.
SFU centraliza o encaminhamento da chamada. Nenhum deles substitui abrir a
porta de conexão ao servidor, nem torna uma máquina sob CGNAT publicamente
acessível sem uma rota adequada.

Consulte [TURN](/turn) e [Hospedagem em VPS](/hospedar-em-vps) para portas,
limites e preparação. O estimador de capacidade é uma orientação, não uma
garantia de desempenho para qualquer rede ou máquina.

## Operação e continuidade

- Mantenha cliente, servidor e bots com versões de protocolo compatíveis.
- Preserve o banco de dados e a identidade dos bots; não apague registros
  como primeiro passo de diagnóstico.
- Confira backups antes de migrações, exclusões e mudanças de hospedagem.
- Se hospeda pelo aplicativo, fechar/parar esse processo afeta todos os
  participantes. Para operação contínua, veja o [CLI](/cli) e a [VPS](/hospedar-em-vps).

Para gerenciar o acesso de um bot e entender por que ele aparece online sem
comandos, continue em [Usar bots](/bots).
