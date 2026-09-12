# Configurações

Abra pelo ícone de engrenagem na tela de conexão ou na barra inferior.

- **Perfil** — nickname e foto.
- **Servidores e configurações** — exporte seus servidores salvos e as
  configurações do app para um arquivo `.monkybackup` e restaure em outro
  computador. Você escolhe o que entra e o que sai a cada vez, e os dados também
  podem viajar junto do backup da identidade. O arquivo é protegido pela senha
  que você define na exportação: a lista de servidores salvos pode conter senhas
  de servidor, então ela nunca vai para o disco em texto aberto. Sem essa senha
  não há como recuperar o backup.
- **Dispositivos** — microfone, alto-falante/fone e câmera, com pré-visualização e atualização da lista.
- **Efeitos de câmera** — desfoque, fundo virtual com cor ou imagem e chroma key de fundo físico, processados localmente.
- **Sensibilidade de Voz (VAD)** — ajuste olhando o medidor; deixe o marcador acima do nível em silêncio.
- **Supressão de ruído** — escolha RNNoise, Speex, GTCRN, WebRTC (nativo) ou desative o processamento de ruído.
- **Saída geral e saídas avançadas** — use o mesmo dispositivo para tudo ou defina saídas para voz, compartilhamentos e mídias do chat.
- **Perfil de Qualidade e Desempenho** — afeta só o que você transmite.
- **Comportamento** — manter o Monky na bandeja ao fechar a janela e perguntar
  antes de desligar um servidor hospedado nesta máquina quando você for a última
  pessoa a sair dele.
- **Atualizações** — versão atual e verificação manual.
- **Comunidade** — atalhos para ideias, votação e bugs.

### Navegação por seções

Nas configurações do app e do servidor, selecionar uma categoria expande seus
atalhos de seção na barra lateral. Os submenus abrem e recolhem suavemente,
inclusive ao alternar rapidamente entre categorias. Clique em um deles para
rolar suavemente até aquela parte da página. A seção atual fica destacada também ao rolar
manualmente, sem recriar o formulário nem perder alterações ainda não salvas.
Seções ocultas ou indisponíveis não aparecem na navegação.

A abertura e o fechamento dos submenus, assim como a rolagem das seções e
das categorias do seletor de emojis, respeitam a
preferência de movimento reduzido do sistema: quando ativada, o deslocamento
é imediato, sem animação.

### Configurações do servidor: aplicação imediata

As configurações do servidor não têm uma etapa final de salvar. Switches e
seleções aplicam imediatamente; nomes, senhas e limites aplicam ao terminar
a edição, ao sair do campo ou pressionar `Enter`. **Pronto** apenas fecha a
janela, sem desfazer alterações já aplicadas.

Enquanto houver uma operação pendente, **Pronto**, `X`, `Esc`, o clique fora
da janela e outras tentativas de fechamento ficam bloqueados. A instalação
do TURN chegar a 100% não significa que terminou: o aplicativo espera a
confirmação final do servidor e mostra falhas reais de inicialização.

Erros indicam qual alteração não foi confirmada e permitem corrigir e tentar
novamente. Se a conexão ou a sessão mudar, reabra as configurações para obter
o estado atual; uma solicitação sem confirmação não é apresentada como salva.
Edições de cargos e perfis de bots também são imediatas, mas criação,
instalação, exclusão e revogação continuam exigindo suas ações explícitas.

### Seletor de cores

A cor da tela física do chroma key, a cor do fundo virtual e as cores dos
cargos usam o mesmo seletor do Monky. Clique na amostra de cor para abrir
os controles de matiz, saturação e brilho, as cores predefinidas e o campo
**HEX**, que aceita três ou seis dígitos.

Soltar o controle após arrastar ou escolher uma cor aplica a seleção.
Ao digitar um HEX válido, `Enter`, o botão de fechar ou um clique fora
confirmam a entrada; fechar o seletor não desfaz a cor escolhida. Uma entrada
inválida é indicada no próprio painel. `Escape` cancela somente a entrada
ainda em edição e fecha o seletor, sem fechar suas configurações.

O **Conta-gotas** permite escolher uma cor da tela. Durante a seleção,
`Escape` cancela apenas o conta-gotas, mantendo a cor anterior e o painel
aberto. Falta de permissão ou falha de captura é informada, sem substituir
a cor por um valor padrão. Isso não desliga os efeitos nem transmite a
câmera sem filtro para a chamada.

### Aparecer offline

Em **Meu Perfil → Visibilidade → Aparecer offline**, o switch altera sua
presença em todos os servidores conectados, inclusive os que estão em segundo
plano. Você passa para a seção offline da lista de membros e vê **Invisível**,
com um indicador circular vazado de alto contraste na barra inferior.
Os outros membros veem sua presença como offline; alterar nickname ou foto
não torna você online novamente.

Isso não desconecta o cliente nem interrompe uma chamada em andamento. Sua
participação em um canal de voz continua visível nesse canal.

### Controles rápidos de áudio

Os ícones de microfone/fone e suas setas compartilham o mesmo estilo na barra
inferior. As setas abrem um painel para cima que mostra o dispositivo atual.
Passe o mouse sobre essa informação ou clique nela para abrir a lista lateral
de dispositivos. Pelo teclado, use as setas para navegar; `Esc` fecha primeiro
a lista lateral e depois o painel.

O painel do microfone também mostra o **Nível de entrada**, em uma barra
segmentada. As escolhas usam as mesmas configurações de **Voz e Vídeo** e
ficam salvas. O medidor é uma prévia local: não desmuta o microfone nem
transmite sua voz. Fechar o painel encerra a prévia. O botão
**Configurações de voz** abre diretamente a aba correspondente.

A borda verde de fala no seu avatar e na lista do canal só acende durante
uma chamada com o microfone ativo e sem mute, respeitando o PTT. Fora de uma
chamada, apenas os medidores locais nas configurações de microfone abertas
continuam funcionando. Essas prévias não ativam o indicador de fala da chamada;
pressionar o atalho de PTT fora dela também não o ativa.

O botão direito no seu próprio nome também abre o menu do usuário, tanto
nas listas quanto no seu perfil da barra inferior. Nesse menu você pode
alternar o mute manual do microfone e do áudio, inclusive antes de entrar
em chamada. O controle de volume de voz só aparece para outros usuários;
as demais ações continuam respeitando as permissões do servidor.
Um mute manual nunca remove um bloqueio aplicado por administrador.

Bloqueios administrativos de microfone e áudio valem para **a identidade
naquele servidor**, incluindo seus outros dispositivos. Sair e entrar na
chamada, trocar de servidor ou reiniciar o aplicativo ou o servidor não remove
o bloqueio: um administrador precisa liberá-lo.

Quem possui permissão para mutar ou ensurdecer membros pode aplicar e remover
esses bloqueios pelo menu de botão direito da lista de membros, mesmo quando
a pessoa está fora da voz ou desconectada. O menu consulta a restrição atual
antes de habilitar a ação. Expulsar da voz e mover de canal continuam exigindo
uma conexão em chamada.

Nos controles, o ícone e sua cor mostram seu mute pessoal; o bloqueio
administrativo aparece separadamente como um símbolo vermelho, apenas enquanto
você visualiza o servidor correspondente, mesmo sem entrar em um canal de voz.
O servidor informa essa restrição já na conexão, inclusive após reabrir o aplicativo.
Ao trocar de servidor, o símbolo e o tooltip passam a refletir apenas as
restrições do servidor visualizado. O bloqueio real de uma chamada em outro
servidor continua sendo respeitado. Nas listas de participantes, mute pessoal fica cinza
e restrições administrativas permanecem vermelhas. A sobreposição continua
mostrando os participantes da chamada ativa.

Cliente e servidor precisam estar atualizados para trocar essa informação
antes de entrar na voz.

### Dicas e menus

Os tooltips do cliente usam um visual escuro e compacto, aparecem após cerca
de **150 ms** com o mouse e imediatamente ao navegar pelo teclado. `Esc`
dispensa a dica. Os menus e listas de seleção compartilham o mesmo tema;
nos seletores, use as setas, digite para buscar uma opção e confirme com
`Enter`. `Esc` fecha a lista sem alterar a escolha.

Os controles da barra inferior e os botões de **anexo, emoji e código** do
compositor têm movimentos próprios ao passar o mouse: a engrenagem gira,
a seta de compartilhamento se move, o soundboard solta notas e o emoji ri.
O efeito da câmera é uma moldura animada, não um indicador de gravação.
Cliques e mudanças de estado também têm um feedback visual curto. Os botões
da barra flutuante de ações das mensagens não recebem essas animações.
A preferência de movimento reduzido desativa esses efeitos.

No modal **Bloco de código**, arraste o canto inferior direito para ajustar
largura e altura; o editor acompanha o tamanho do modal. Os limites mantêm
uma margem de pelo menos **24 px** até as bordas da janela do aplicativo.

Essa padronização vale para a interface do cliente. Diálogos de arquivos e
menus da bandeja continuam sendo desenhados pelo sistema operacional.

### Teste do microfone

Em **Voz e Vídeo**, o teste permite iniciar e parar o retorno local da sua voz
enquanto acompanha a barra segmentada. Use fones de ouvido para evitar
realimentação entre o alto-falante e o microfone. O teste só reproduz áudio
após você iniciá-lo e não envia essa prévia para o canal de voz nem altera
seus estados de mute ou Push to Talk. Se você já estiver em uma chamada
desmutada, ela continua transmitindo sua voz normalmente. Sair da aba ou
fechar as configurações encerra o teste.

### Motores de supressão de ruído

Em **Voz e Vídeo → Supressão de ruído**, escolha um motor e compare o resultado
com **Testar microfone**. A prévia usa o mesmo processamento escolhido para a
chamada, sem transmitir o teste para outras pessoas.

| Opção | Uso e limites |
| --- | --- |
| RNNoise | Motor neural usado por padrão no Monky. |
| Speex | Filtro clássico de baixo custo, adequado a ruídos constantes. |
| GTCRN | Rede neural alternativa focada em voz; trabalha internamente em 16 kHz, limitando a fidelidade de música e sons agudos. |
| WebRTC (nativo) | Supressão integrada ao processamento WebRTC do aplicativo. |
| Desativada | Sem supressão de ruído; cancelamento de eco e ganho automático continuam ativos. |

Todos os motores processam localmente e seus arquivos acompanham o aplicativo.
A intensidade percebida varia com o microfone e o ambiente; nenhum motor é
melhor em todas as situações. A supressão nativa não é aplicada por cima
dos motores RNNoise, Speex ou GTCRN.

A troca mantém a track enviada à chamada e respeita mute e PTT. O botão rápido
de supressão desativa o processamento ou restaura o último motor escolhido.
Use a seta ao lado desse botão para escolher o motor sem sair da tela atual
ou abrir diretamente suas configurações.
Uma falha é informada; o app não troca silenciosamente para áudio sem filtro.

### Saídas de áudio por categoria

Em **Voz e Vídeo → Saída geral**, escolha o dispositivo padrão do aplicativo.
Essa escolha também vale para os vídeos do chat, inclusive no visualizador
ampliado. A seta do fone nos controles rápidos altera essa mesma saída geral.

O switch **Saídas avançadas** revela seletores para **Canal de voz**,
**Áudio de compartilhamentos** e **Mídias do chat**. **Usar saída geral**
acompanha a escolha principal; **Padrão do sistema** escolhe explicitamente
o dispositivo do sistema, mesmo se a saída geral for outra.

Alertas e soundboard continuam usando a saída geral. Desativar o modo avançado
volta a usar a saída geral em todas as categorias sem apagar as escolhas
individuais. As opções ficam salvas e também são respeitadas com volumes
amplificados acima de 100%. Identificadores de dispositivos não são importados
de backups de outra máquina.

Se dispositivos salvos forem desconectados e impedirem a aplicação, use
**Usar padrão do sistema em todas as saídas**. Essa ação explícita redefine a
saída geral, remove as escolhas por categoria e desativa o modo avançado.
Ela fica acessível mesmo com os seletores avançados recolhidos, permitindo
recuperar a configuração quando vários dispositivos desaparecerem juntos.

### Efeitos e prévia da câmera

Em **Voz e Vídeo → Câmera**, a prévia fica ligada por padrão quando esses
controles são abertos. O controle para ocultá-la fica acima dos efeitos:
ao desligá-lo, o quadro permanece com a indicação **Visualização desligada**.
Essa escolha vale para a abertura atual; ao abrir os controles novamente,
a prévia volta ligada.
Essa captura é local e não liga a transmissão da câmera na chamada. Quando a
câmera da chamada já está ligada, ambas usam a mesma captura; ocultar ou fechar
a prévia não desliga a câmera da chamada.
Trocar o dispositivo também atualiza a chamada, mesmo com a prévia fechada.

Nos controles rápidos, a seta ao lado da câmera abre a escolha do dispositivo,
a prévia e os ajustes de efeitos. O painel também dá acesso direto à seção
correspondente nas configurações.

| Modo | Resultado |
| --- | --- |
| Desativado | Vídeo sem efeito de fundo. |
| Desfoque | Segmentação da pessoa e desfoque do fundo. |
| Cor | Fundo virtual de uma cor, inclusive verde, sem exigir tela verde física. |
| Imagem | Uma imagem local como fundo virtual. |
| Chroma key | Remove uma cor do cenário físico, normalmente uma tela verde, substituindo-a por cor ou imagem. |

Chroma key e fundo virtual verde são coisas diferentes: o primeiro recorta a
cor escolhida em toda a imagem, inclusive roupas e objetos dessa cor. O vídeo
da chamada não transmite transparência; o recorte recebe o fundo escolhido.
Os ajustes de tolerância, borda e redução de reflexo ajudam com telas físicas.
Branco, preto e cinza também podem ser usados como cor-chave. Nesses tons,
o brilho participa da comparação para não tratar todos os cinzas como a
mesma cor.
A segmentação automática é aproximada e pode falhar em cabelo, contornos e
iluminação difícil; não a trate como garantia de ocultar informações sensíveis.
Cada ajuste tem um botão **?** com uma explicação: passe o mouse ou use o
foco do teclado para consultar a ajuda sem alterar a configuração.

Imagens PNG, JPEG e WebP de até **8 MiB** são aceitas, com limites adicionais de
dimensões para evitar consumo excessivo. A imagem é normalizada e fica salva
localmente junto das preferências, não no backup geral de configurações.
Com **Limitar a 720p / 30 FPS** desligado por padrão, os efeitos seguem tanto
a **resolução quanto o FPS** do perfil de qualidade selecionado. Ative o switch
para reduzir o processamento, limitando ambos a até **1280 × 720 e 30 FPS**.
O limite não aumenta uma resolução ou taxa de quadros inferior, nem amplia
uma captura menor. A câmera e o processamento também podem reduzir a taxa
efetiva. Com os efeitos desativados, a qualidade normal da câmera é preservada.

O modelo e o processamento acompanham o aplicativo e funcionam sem uma API
externa: os frames são processados localmente antes de seguir pela chamada
P2P ou SFU. Em caso de falha, a câmera é desligada e o erro é mostrado, sem
voltar silenciosamente ao vídeo sem efeito. Desativar o efeito exige uma
escolha explícita.

### Favoritos de sons e servidores

Use a estrela para marcar sons no soundboard, tanto na grade/lista quanto
em **Configurações → Soundboard**, e servidores na lista **Salvos** da Home.
O filtro **Todos/Favoritos** combina com a busca, sem duplicar os itens.
Os favoritos aparecem primeiro, em ordem alfabética; os demais aparecem
depois, também em ordem alfabética. Marcar ou desmarcar move os itens com uma
transição suave; trocar **Todos/Favoritos** também anima a mudança da lista.
As animações respeitam a preferência de movimento reduzido do sistema.
A estrela pode ser acionada com `Enter` ou espaço e não toca o som nem abre
o servidor.

Favoritos de sons identificam o arquivo pelo caminho completo: arquivos com
o mesmo nome em pastas diferentes não se confundem. Voltar à pasta anterior
recupera suas estrelas. Favoritos de servidores acompanham o endereço e a
porta; renomear preserva a estrela e editar o endereço a transfere.
Excluir um servidor remove sua marcação.

Essas preferências são locais e não viajam no backup geral. Importar servidores
preserva estrelas dos endereços mantidos e remove as dos endereços retirados.
A ordenação preserva os atalhos associados aos sons e não altera a barra
lateral de servidores.

### Iniciar outro servidor durante uma chamada

Iniciar e visualizar um servidor próprio offline, pela Home ou pela barra
lateral, não entra automaticamente em voz e não interrompe a chamada atual,
o microfone, a câmera ou os compartilhamentos. Entrar em outro canal de voz
continua sendo uma ação separada.

Se outro servidor já estiver hospedado por esta instância do app, ele não será
desligado implicitamente. Use os controles de hospedagem para pará-lo
explicitamente quando for seguro, antes de iniciar um servidor diferente.

### Atalhos de teclado

Na aba **Atalhos**, escolha **Gravar atalho** (ou **Alterar atalho**).
Segure todas as teclas da combinação juntas e solte todas para salvar.
Por exemplo, `Ctrl + Q + W + E` usa três teclas comuns, não apenas modificadores
e uma tecla. O mesmo gravador é usado nos atalhos do **Soundboard**. `Esc`
cancela; fechar a janela ou sair dela também cancela a gravação.

Não há limite de quantidade de teclas imposto pelo Monky, mas o rollover do
teclado e as restrições do sistema operacional continuam valendo. Os atalhos
são observados passivamente, sem reservar teclas: `Q` continua disponível para
o aplicativo em foco. Isso não contorna bloqueios de anti-cheat ou de segurança.
Segurar a combinação não repete a ação; solte uma tecla necessária antes de
acioná-la novamente. Modificadores adicionais impedem o acionamento.

Os atalhos funcionam com o Monky em foco, minimizado ou em segundo plano,
inclusive durante chamadas com o microfone ativo. No Windows, a captura de
atalhos roda em um processo separado para evitar interferência do WebRTC.

**Mutar microfone**, **mutar áudio (ensurdecer)** e **mutar soundboard** também
funcionam fora de chamada. A escolha fica salva e é respeitada ao entrar no
canal de voz, permitindo entrar já mutado. Fora de chamada, essas ações mudam
apenas suas preferências locais, sem enviar atualizações de voz ao servidor.
Os atalhos de câmera, compartilhamento de tela e parar sons do soundboard
só atuam dentro de um canal de voz.

Novos atalhos guardam a posição física da tecla e exibem o caractere do layout,
incluindo `º` e `ñ` em teclados espanhóis quando suportados pelo sistema.
No Windows, a conversão usa o layout real da janela em foco, não uma tabela
americana fixa. Depois de trocar o idioma/layout, solte e pressione novamente
a combinação. Se o sistema não conseguir distinguir duas teclas de uma
combinação, ela não é registrada para evitar acionar a ação errada.
Atalhos antigos continuam sendo lidos; se uma combinação de outro layout não
for reconhecida, grave-a novamente. Permissões de entrada/acessibilidade podem
ser necessárias para a captura global. O Push-to-Talk mantém sua tecla ou botão
do mouse configurado separadamente.

### Modo de entrada e Push to Talk

Em **Voz e Vídeo → Modo de Entrada**, escolha um dos dois cards: **Atividade
de Voz (VAD)** ou **Push to Talk**. Os cards também podem ser acionados pelo
teclado, sem radio buttons.

Com PTT habilitado, o **botão de microfone no canto inferior esquerdo** ganha
a marca **PTT** sob o ícone, sem borda: amarelo com ícone de entrada de voz
enquanto aguarda a tecla e verde com microfone aberto ao transmitir. Quando
há mute manual ou áudio desativado, aparece apenas o microfone cortado em
vermelho, sem a marca PTT. Um bloqueio feito por administrador acrescenta o
símbolo vermelho de proibido, sem substituir o ícone pessoal nem esconder
a marca PTT. O bloqueio impede a transmissão, mesmo que seu mute pessoal esteja
desativado. Fora de chamada, o estado de espera fica cinza.

Clicar no botão continua alternando o **mute manual**. Segurar a tecla do PTT
não desfaz esse mute: apenas abre o microfone quando permitido. O estado
acompanha a abertura real, incluindo o atraso de liberação ao soltar a tecla.
A tecla configurada e a descrição do estado aparecem no tooltip e nas
configurações; não há mais um indicador separado no palco da chamada.

### Perfis de qualidade

| Perfil | Áudio | Câmera | Tela | Quando usar |
|---|---|---|---|---|
| Econômico | 24 kbps | 360p | 480p | Internet lenta ou instável |
| Normal | 32 kbps | 480p | 720p | Uso geral |
| Alta Qualidade | 48 kbps | 720p | 1080p | Internet rápida e PC sobrando |
| Gaming | 28 kbps | reduzida | fluida (60 FPS) | Jogando: prioriza voz e tela fluida |

O perfil **Personalizado** abre listas com os valores mais usados — proporção
(16:9, 16:10, 4:3 e 21:9), resolução (da mais baixa até 4K), FPS e bitrate. Cada
lista tem a opção **Personalizado...**, que libera o campo numérico livre para
quem quiser um valor fora da lista. Trocar a proporção mantém a resolução mais
próxima da que você já usava.

### Compartilhando a tela enquanto joga

Codificar vídeo custa caro, e o codec escolhido decide se esse custo cai na CPU
ou na GPU. AV1 e VP9 comprimem melhor, mas quase nenhum PC tem encoder de
hardware para eles — a 1080p60 o trabalho vai todo para a CPU e o jogo perde
FPS. H.264 tem aceleração por hardware em praticamente toda placa de vídeo
(NVENC, QuickSync, AMF).

Por isso, no perfil **Gaming** o codec **Automático** coloca o H.264 na frente.
Se você usa outro perfil e sente o jogo travando ao compartilhar, escolha
**H.264 / AVC** em *Codec de Vídeo Preferido*.

**Automático** pode negociar outro codec compatível. Uma escolha explícita é
obrigatória para sua tela em P2P e SFU, inclusive ao trocar de tela ou de modo de
voz. Se ela não puder ser usada, o cliente informa o motivo e não transmite
usando um codec diferente.

No Windows, o Monky também captura a tela pela API **Windows Graphics Capture**,
que compõe na GPU e não entrega quadros quando nada muda na tela. Ela precisa do
Windows 10 1809 ou mais novo, e não funciona dentro de sessões de Área de
Trabalho Remota — nesses casos o Monky volta sozinho para o método antigo. Para
forçar o método antigo, inicie o app com a variável `MONKY_DISABLE_WGC=1`.

Uma última dica que vale para qualquer programa de captura: compartilhar **a
janela do jogo** costuma custar menos que compartilhar o monitor inteiro, e
jogar em *fullscreen sem bordas* evita as trocas de modo que fazem o jogo
engasgar.
