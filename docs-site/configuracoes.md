# Configurações

Abra a **engrenagem** na tela inicial ou na barra inferior. Estas são as
preferências do seu aplicativo. Para mudar algo compartilhado com os
participantes, use [Configurações do Servidor](/administrar-servidor).

| Aba | O que você encontra |
| --- | --- |
| Meu Perfil | Nickname, foto, visibilidade, idioma, identidade e backups |
| Voz e Vídeo | Dispositivos, microfone, PTT, saídas, supressão de ruído e câmera |
| Soundboard / Figurinhas | Pastas locais e controles dessas bibliotecas |
| Atalhos | Combinações para ações rápidas |
| Notificações e Sons | Sons e avisos pessoais |
| Qualidade e compartilhamento | Perfis de voz, câmera e tela, codec, prévia local e telemetria |
| Ferramentas de bots | Instalações locais, permissões, cache e tarefas |
| Logs | Eventos locais e diagnóstico do cliente |
| Sobre e Updates | Versão, atualização, comportamento da janela e comunidade |

## Meu Perfil

Altere seu nickname e foto nesta aba. **Idioma** aplica Português (Brasil)
ou English imediatamente e salva a preferência neste computador.

Em **Identidade**, exporte ou importe sua identidade criptográfica para continuar
sendo reconhecido nos servidores. Veja os cuidados em
[Primeiros passos](/primeiros-passos#guarde-um-backup-da-identidade).

**Servidores e configurações** exporta um `.monkybackup` protegido pela senha
que você escolher. Selecione o que deseja incluir/restaurar; esses dados
também podem acompanhar a exportação da identidade. A lista de servidores
pode conter senhas e não é gravada em texto aberto nesse backup.
Sem a senha escolhida, não há recuperação do arquivo.

### Qualidade, bitrate e telemetria

Em **Qualidade e compartilhamento**, os presets, codec e valores personalizados ficam junto de
**Telemetria de vídeo**. **Voz e Vídeo** concentra dispositivos, processamento
de áudio e prévias. Para ver FPS, resolução e bitrate sobre câmera/tela, use
**Qualidade e compartilhamento → Telemetria de vídeo**: o switch, a posição e o modo ficam salvos
e são aplicados sem reiniciar a transmissão.

No perfil **Personalizado**, passe o mouse ou navegue com `Tab` até a
interrogação ao lado de cada **Bitrate**. A dica explica o efeito e o custo:
mais bitrate pode preservar detalhes; menos economiza banda, mas pode reduzir
a fidelidade ou criar blocos no vídeo. Isso não aumenta sozinho resolução ou FPS.

Como ponto de partida para **um envio de vídeo**, use o upload real medido,
não a velocidade de download contratada:

| Upload | Teto inicial de bitrate |
| --- | --- |
| 5 Mbps | 2000 kbps |
| 10 Mbps | 5000 kbps |
| 20 Mbps | 10000 kbps |
| 50 Mbps ou mais | 20000 kbps |

Reserve ao menos **30% de margem** e desconte os outros usos, incluindo áudio,
câmera e telas simultâneas. Em P2P, cada destinatário recebe uma cópia; no SFU,
conte o envio ao servidor. Os valores são referências, não garantias de qualidade:
codec, conteúdo, resolução e FPS também influenciam a necessidade de banda.
Para voz, 24–32 kbps por envio são um ponto de partida; 48–64 kbps dão mais
fidelidade. Com 1 Mbps de upload, 64 kbps usam 6,4% por envio antes dos demais custos.

### Assistir a telas compartilhadas

No canal de voz, clique em **Assistir transmissão** na tela que deseja abrir.
O aviso de que alguém está compartilhando não inicia sozinho o recebimento
da imagem e do som. **Parar de assistir** interrompe a entrega daquela tela
somente para você, sem desligar seu microfone, sua câmera ou a transmissão
dos outros espectadores. Isso vale tanto em P2P quanto em SFU.

O som compartilhado pertence à pessoa que transmite: se você estiver assistindo
a duas telas dela, parar uma mantém o som necessário para a outra. Parar a última
encerra também esse recebimento de áudio. Mutar o som é uma preferência de
reprodução separada; não substitui **Parar de assistir** para economizar banda.

Trocar de página, usar a janela destacada ou ativar a sobreposição não altera
as telas que você escolheu assistir na chamada. Sair da chamada ou encerrar a
fonte remove essa escolha; uma nova transmissão precisa ser escolhida novamente.
Uma reconexão de transporte preserva a escolha enquanto a mesma fonte continuar
válida.

No caminho nativo, a última pessoa que para de assistir encerra também o
pipeline de captura, encoder e envio daquele perfil, inclusive ao SFU.
O anúncio da fonte permanece disponível para voltar a assistir. O caminho
Chromium preserva sua captura/prévia e pode continuar enviando ao SFU.
Sinalização, controle da conexão, voz e câmera podem continuar usando a rede.

### Compartilhamento nativo e qualidade do espectador

O seletor mostra os métodos e o codificador H.264 disponíveis no backend
nativo deste dispositivo. Opções indisponíveis ficam desabilitadas com o
motivo; a marca da GPU não garante suporte. Não há troca automática para
Chromium ou para outra fonte. A tentativa automática de **Captura de jogo**
para **Normal**, quando necessária, usa somente a mesma janela e gera um aviso.

Para até **3840×2160**, **120 FPS** e **80000 kbps**, use **Personalizado** em
**Qualidade e compartilhamento**; os presets existentes não mudam. **Em 4K,
o máximo é 60 FPS**: atingir 3840 px de largura ou 2160 px de altura limita
automaticamente o campo e a lista de FPS. Os valores digitados também respeitam
esses tetos; valores acima deles são ajustados com um aviso visível.
Os limites ainda dependem do encoder: **4K/60** exige H.264 nível 5.2.
Se o dispositivo não admitir o perfil, ele será recusado, sem
reduzir FPS silenciosamente; em uma troca de qualidade, o preflight mantém a
fonte anterior enquanto verifica a nova configuração. Reserve banda para o
jogo e para cada perfil transmitido. No seletor, **Manter proporção** encaixa a imagem no tamanho
escolhido, adicionando bordas quando necessário, sem distorcer. Desligado,
mantém o comportamento atual de esticar para preencher. O switch começa
desligado em cada novo compartilhamento e não é uma preferência global.

A prévia de um novo compartilhamento entra em foco assim que seu tile fica
disponível. Você pode desfocá-la: mudanças de qualidade, reconexões e tentativas
de outro método não voltam a focá-la. Com uma tela em foco, use o scroll para
dar zoom, sem precisar de Ctrl; arraste para mover a imagem ampliada e dê um
duplo clique para restaurar. A prévia e cada espectador mostram um
indicador **Normal** ou **Jogo** conforme o modo confirmado para aquele fluxo,
inclusive nas miniaturas. Enquanto não houver confirmação por imagem, o
indicador fica oculto; escolher Captura de jogo não basta para exibir Jogo.

Ao assistir a uma tela nativa, **Qualidade recebida** solicita um perfil real
ao transmissor: **Máxima da fonte** ou perfis com tetos de **1080p/60**,
**720p/60** e **480p/30**. Todos respeitam o limite de quem transmite;
opções equivalentes não se repetem. O teto de 480p usa 852×480 para
compatibilidade com o encoder. Isso muda a mídia enviada, não apenas o tamanho
do player. Perfis diferentes podem usar encoders e upload adicionais.
Resolução, FPS e bitrate configurados são limites, não garantias de desempenho.
Cliente e servidor precisam ser atualizados juntos para usar esse comportamento.

### Aparecer offline

Em **Meu Perfil → Visibilidade → Aparecer offline**, o switch altera sua
presença em todos os servidores conectados, inclusive os que estão em segundo
plano. Você passa para a seção offline da lista de membros e vê **Invisível**,
com um indicador circular vazado de alto contraste na barra inferior.
Os outros membros veem sua presença como offline; alterar nickname ou foto
não torna você online novamente.

Isso não desconecta o cliente nem interrompe uma chamada em andamento. Sua
participação em um canal de voz continua visível nesse canal.

## Voz e Vídeo

Escolha o microfone e acompanhe o medidor antes de entrar em uma chamada.
Ajuste o limite de detecção de voz acima do nível do ambiente em silêncio.
Confira a saída de áudio e use o teste local com fones.

<AppScreenshot src="/screenshots/configuracoes-voz-pt.png" alt="Aba Voz e Vídeo mostrando o microfone, o teste local e opções de entrada." caption="As prévias são locais. Abrir estas configurações não desmuta nem autoriza uma transmissão por si só." />

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

O recorte usa **Robust Video Matting (RVM)**, que estima a cor e a transparência
do primeiro plano e usa os frames anteriores para acompanhar o movimento.
Desfoque, cor e imagem exigem GPU com WebGL2; se ela não estiver disponível,
o efeito não é ativado e a câmera fica parada com uma mensagem de erro.
Não há troca silenciosa por outro modelo. Chroma físico continua oferecendo
composição CPU quando WebGL2 não está disponível. A resolução final segue seu perfil.
O desfoque preserva o enquadramento e usa a máscara para evitar que as cores
da pessoa se espalhem pelo fundo junto ao contorno. O recorte é automático:
os antigos controles **Recorte da pessoa** e **Suavidade do recorte** não são
aplicados ao RVM, evitando endurecer as transparências de cabelo e bordas.
Seus valores legados permanecem salvos, sem alterar os demais ajustes.
O modelo e o grafo somam cerca de 4,4 MB, além do runtime TensorFlow.js.
As licenças e fontes estão disponíveis nas configurações. Isso não elimina as limitações
de iluminação e enquadramento, nem garante recorte idêntico ao de outros apps.

### Overlay da chamada

**Manter proporção dos cards** preserva 16:9 ao redimensionar o overlay ou mudar
o número de participantes. Desligue o switch para o layout livre anterior.
Arraste também pela área livre e pelos cards, não só pelo cabeçalho; botões
continuam clicáveis. Os oito indicadores de redimensionamento aparecem apenas
perto do ponteiro, nos cantos e no meio das bordas. Apenas um fica ativo por vez:
cantos mostram sua própria diagonal e bordas mostram a direção horizontal ou
vertical correspondente, sem sobrepor o indicador do canto.

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

## Soundboard e figurinhas

O soundboard cria uma pasta padrão no perfil local do Monky automaticamente.
Você pode trocar essa pasta em **Configurações → Soundboard**; uma pasta já
escolhida não é substituída. Para figurinhas, escolha uma pasta na aba
correspondente. As bibliotecas são locais, não pastas do servidor.
Configurar uma pasta não envia todos os seus arquivos.
Consulte [Soundboard e figurinhas no uso diário](/usando-o-app#soundboard)
para formatos, envio e permissões.

### Limite local do soundboard

**Controlar sons muito altos** fica desligado por padrão. Mesmo desligado,
ajuste o **Teto de intensidade** de **1 a 10**; o valor inicial é **6**.
Ative o switch para aplicar o teto escolhido.
Quanto menor o teto, maior a redução dos sons excessivamente altos.
Sons abaixo do teto mantêm o volume; sons mais baixos nunca são amplificados.
O mesmo switch e o ajuste do teto ficam diretamente no **modal do Soundboard**,
logo abaixo dos controles de volume, sem precisar abrir as configurações.
As duas telas compartilham a preferência e podem ser operadas pelo teclado.
Durante a reprodução, um marcador na barra mostra a intensidade **antes da
redução**, na mesma escala do teto. A bolinha de arraste define o limite;
o marcador móvel e o valor “Antes do limite” mostram o áudio real.
Verde indica abaixo do teto, amarelo indica até um nível abaixo dele e vermelho
indica acima. As faixas acompanham o teto escolhido. Um valor maior que 10
continua visível no texto, mesmo quando o marcador chega ao fim da barra.
As cores ajudam a escolher o corte; não diagnosticam distorção no arquivo.

O teto é aplicado depois de misturar os soundboards, inclusive suas prévias
locais, e depois do volume escolhido: vários sons simultâneos também respeitam
o limite. Voz, música e o áudio recebido pelos outros participantes não mudam.

A decisão considera a energia do áudio ao longo do tempo, ponderada pela
frequência, em vez de apenas seu maior pico. Uma proteção separada evita
picos digitais excessivos. O processamento antecipa aproximadamente 100 ms
para reduzir o som alto desde o início, inclusive em efeitos curtos.

A escala é relativa: não mede nem garante volume físico no fone ou nas caixas,
que também depende do sistema e do dispositivo. Não recupera a qualidade de
um arquivo já distorcido. A escolha e o teto persistem ao reiniciar.

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

## Atalhos

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

## Qualidade e compartilhamento {#qualidade}

O perfil controla o que **você transmite**; não aumenta a resolução da câmera
ou da tela de outra pessoa. A mesma aba reúne codec, prévia local do
compartilhamento, recepção de tela e telemetria; os perfis continuam incluindo voz e câmera.

### Recepção de tela

Em **Configurações → Qualidade e compartilhamento → Recepção de tela**, escolha
**Nativo** ou **Chromium**. No Windows, **Nativo é o padrão**, usando o runtime
incluído no Monky. Não há fallback automático: se ele falhar, o aviso indica
onde selecionar Chromium manualmente. A escolha é salva e vale ao começar a
assistir ou clicar em **Tentar novamente**; para uma tela já aberta, pare de
assistir e assista novamente. Câmera, voz e transmissão da própria tela não mudam.

**Chromium tem uma limitação conhecida:** no ensaio Windows houve quedas de FPS
e congelamentos periódicos. O aviso permanece visível nas configurações; escolher
esse receptor não corrige a limitação. No macOS, **Chromium é o padrão** e
**Nativo** fica desabilitado como **Em breve**. Isso permite assistir a perfis
compatíveis, mas não habilita captura libobs no Mac nem qualifica seu desempenho.

### Perfis de qualidade

| Perfil | Áudio | Câmera | Tela | Quando usar |
|---|---|---|---|---|
| Econômico | 24 kbps | 360p | 480p | Internet lenta ou instável |
| Normal | 32 kbps | 480p | 720p | Uso geral |
| Alta Qualidade | 48 kbps | 720p | 1080p | Internet rápida e PC sobrando |
| Gaming | 28 kbps | reduzida | fluida (60 FPS) | Jogando: prioriza voz e tela fluida |
| Ultra | 64 kbps | 1080p / 60 FPS | 1080p / 60 FPS | Banda e hardware suficientes para taxas mais altas |

São alvos de configuração, não uma garantia de FPS ou bitrate observado.
Dispositivo, codec, rede, número de participantes e conteúdo afetam o resultado.

O perfil **Personalizado** abre listas com os valores mais usados — proporção
(16:9, 16:10, 4:3 e 21:9), resolução (da mais baixa até 4K), FPS e bitrate. Cada
lista tem a opção **Personalizado...**, que libera um campo numérico para
valores fora da lista, dentro dos mesmos limites: 3840×2160, 80000 kbps de vídeo
e 120 FPS (60 FPS ao atingir 3840 px de largura ou 2160 px de altura).
O áudio mantém seu limite próprio de 510 kbps. Trocar a proporção mantém a resolução mais
próxima da que você já usava.

### Compartilhando a tela enquanto joga

Codificar vídeo consome recursos. A aceleração depende da placa, do driver e
do suporte confirmado pelo backend. Para compartilhar a tela, **Automático**
usa **H.264 / AVC** hoje; **AV1** continua desabilitado como **Em breve**.
A escolha do codificador de hardware é separada do codec. Se não houver
suporte, o cliente informa o motivo em vez de trocar silenciosamente de codec.

O seletor separa **Telas** e **Janelas**. Cada janela aparece uma única vez
na lista de janelas; não existe uma lista de jogos detectados. Depois de
selecionar uma janela, os cards de método oferecem **Normal**
como padrão e **Captura de jogo** como escolha explícita. Trocar o método
mantém a mesma janela e sua escolha de áudio. Selecionar outra janela volta ao
padrão Normal, sem levar junto a escolha de Captura de jogo da janela anterior.

A janela do próprio Monky pode ser compartilhada **somente sem áudio**, para
evitar eco da chamada. Ao selecioná-la, o switch de áudio fica desligado e
indisponível, com uma explicação. Ao selecionar outro aplicativo, sua escolha
anterior de áudio é restaurada.

Escolher o card de Captura de jogo não inicia a captura nem testa o aplicativo:
é preciso confirmar em **Compartilhar**, **Trocar Fonte** ou **Adicionar tela**.
Só ficam disponíveis os métodos informados pelo backend; compatibilidade com
a janela escolhida ainda precisa ser verificada. Se a Captura de jogo ficar
indisponível, o Monky encerra essa tentativa e avisa que está tentando **Normal
para a mesma janela**. O aviso fica visível por 8 segundos para permitir a leitura
e indica uma tentativa, não uma imagem já
confirmada. Não escolhe outro monitor ou janela, não usa Chromium e não
desativa anti-cheat, Trusted Mode ou outras proteções. Se Normal também
falhar, o erro continua visível; não há troca para outra fonte.

O aviso de fonte fechada ou desconectada aparece por 8 segundos, sem exigir
confirmação em uma caixa de diálogo. Falhas repetidas da mesma fonte são
agrupadas enquanto ela não se recupera; os detalhes continuam nos logs.
Quando a prévia volta a apresentar vídeo, uma nova falha pode gerar outro aviso.

Para jogos, prefira **Captura de jogo** como primeira opção, seguindo a
[recomendação do OBS](https://obsproject.com/kb/game-capture-source).
Ela não é destinada a toda janela; jogos como CS2 podem impedir esse método.
O modo **Normal** pode exigir que o jogo esteja
em modo janela ou tela cheia sem bordas, sem alterar as proteções.
Essa é também a orientação do
[guia oficial do OBS](https://obsproject.com/kb/game-capture-troubleshooting);
o nome ou título da janela não é usado para prometer detecção ou compatibilidade.

Na aba **Janelas**, **Meu jogo funciona com Captura de jogo?** abre um guia local
com busca por título ou sigla, como CS2, GTA SA e LoL. São 14 referências a
limitações e orientações do OBS, agrupadas em **Use Normal** (alternativa
recomendada para esses casos) e **Requer atenção** (cuidados específicos).
Não é uma lista completa de jogos compatíveis nem uma garantia para o Monky.
Um jogo ausente significa apenas **sem informação catalogada**, não incompatível;
comece por Captura de jogo.
O guia não consulta a rede, testa jogos, inicia captura ou altera sua seleção;
o link da fonte oficial só abre o navegador quando você o aciona.

As orientações incluem DirectX 12 no Fortnite, janelas separadas para o
cliente e a partida do League of Legends e limitações de permissões ou de
múltiplas GPUs. A janela da partida deve ser escolhida explicitamente.
Não há seleção automática de outra GPU, elevação automática de permissões
nem recomendação para desativar proteções.

Abriu o jogo ou outra janela depois do seletor? Use **Atualizar**. Não há
atualização periódica em segundo plano. Se a fonte continuar disponível, a
aba, o ID selecionado, o método, a qualidade, o áudio e **Manter proporção**
são preservados. Uma fonte que desapareceu perde a seleção, sem ser
substituída por outra. Durante a atualização não é possível confirmar;
falhas ficam visíveis e permitem tentar novamente no mesmo modal.

Uma última dica que vale para qualquer programa de captura: compartilhar **a
janela do jogo** costuma custar menos que compartilhar o monitor inteiro, e
jogar em *fullscreen sem bordas* evita as trocas de modo que fazem o jogo
engasgar.

## Notificações e Sons

Ajuste os sons e avisos pessoais nesta aba. Isso não altera as permissões
de menção ou os eventos publicados pelo servidor; esses controles pertencem
à [administração](/administrar-servidor).

Em **Sons Personalizados**, todos os efeitos do aplicativo têm controles de
prévia, escolha de arquivo e restauração: microfone, áudio recebido,
entrada/saída da chamada, início/fim de compartilhamento, notificação do chat,
pressionar/soltar push-to-talk e reconexão. Os arquivos escolhidos persistem
ao reiniciar, inclusive nos efeitos cujo padrão é sintetizado.
Restaurar um efeito recupera seu arquivo ou tom original; **Restaurar todos**
remove todas as substituições. Isso não ativa notificações de chat nem sons
de PTT que você tenha desligado nas respectivas opções.

## Ferramentas de bots

Veja ferramentas instaladas, armazenamento, cache, autorizações e tarefas
locais. Uma concessão no servidor não permite que um bot execute tarefas no
seu computador sem consentimento.

<AppScreenshot src="/screenshots/ferramentas-pt.png" alt="Aba Ferramentas de bots com seções de armazenamento, ferramentas, permissões e tarefas." caption="A gestão é centralizada no cliente e o consentimento é por bot e dispositivo." />

Revogar uma autorização ou remover uma ferramenta encerra o trabalho afetado.
Confira [Ferramentas no seu computador](/bots#ferramentas-no-seu-computador)
antes de aprovar um pedido.

## Logs

Consulte os eventos do cliente para identificar em qual etapa uma operação
falhou. Antes de compartilhar logs, revise seu conteúdo e remova dados
sensíveis. O [Monitor do Servidor](/criar-seu-servidor#monitor-do-servidor)
é uma consulta separada, sujeita às permissões daquele servidor.

### Diagnosticar compartilhamento de tela

1. Em **Configurações → Logs**, ative **Gravar logs** antes de reproduzir.
2. Compartilhe a janela, jogo ou monitor e anote o horário, modo e qualidade
   escolhidos. Se possível, peça a outro participante para assistir, trocar a
   qualidade e parar de assistir. Teste também pausar a prévia ao desfocar o app.
3. Pare o compartilhamento e use **Exportar logs** na mesma aba. Para problemas
   de recepção, exporte também os logs do participante que estava assistindo.

Os registros `SCREEN_SHARE` com prefixo `Native screen` mostram admissão da
fonte, pré-verificação do encoder (inclusive falhas antes de existir uma fonte),
backend, resolução/FPS/bitrate, pipelines por qualidade, assistir/parar,
fallback de Jogo para Normal, estados da prévia e liberação de recursos.
`retained: true` indica que a limpeza ainda reteve recursos; não é confirmação
de encerramento. Os identificadores de correlação são hashes, não títulos de
janelas.

Esses diagnósticos não gravam pixels, quadros individuais, SDP/ICE, credenciais,
payloads completos ou mensagens/stacks livres de erros. Falhas registram a etapa
e códigos nativos disponíveis. Em `nativeDiagnostics`, o diagnóstico NVENC
preserva operações/capacidades conhecidas, versão da API, status numérico,
contagens de enumeração e valores obtidos/exigidos. Falhas de cor H264 preservam
`fullRange`, `primaries`, `transfer` e `matrix` observados (`null` indica campo
ausente), inclusive em erros aninhados. Outros textos continuam omitidos.
Repetições idênticas são limitadas. Consultar
métricas não gera uma linha por atualização. Os registros usam o mesmo
armazenamento local e rotação dos demais logs; com **Gravar logs** desativado,
novos eventos não são persistidos nem recuperados retroativamente. A gravação
continua enquanto o diálogo de exportação está aberto; o arquivo exportado
inclui os eventos gravados até a confirmação.

## Sobre e Updates

Consulte a versão, procure atualizações e reveja as notas da versão instalada.
Betas são pré-lançamentos e exigem optar por recebê-las; para uso cotidiano,
prefira uma versão estável. Veja [Atualizações](/download#atualizacoes).

Aqui também ficam opções de comportamento da janela e links da comunidade.
Se hospeda um servidor neste computador, diferencie **fechar a janela**,
**manter na bandeja** e **encerrar o servidor**: parar o processo afeta
quem está conectado.

## Conexão e interface

### Entrar no servidor ao abrir o Monky

Na Home, selecione ou informe o servidor e ative **Entrar ao abrir o Monky**,
ao lado de **Entrar no Servidor**. A escolha é salva somente depois de uma conexão
bem-sucedida. Há um único destino: conectar em outro servidor com o switch
ativado substitui o anterior. Uma tentativa que falha não altera o destino salvo.

A preferência vale nas próximas aberturas até você desligar esse mesmo switch;
desligá-lo desativa a entrada automática imediatamente, sem precisar conectar.
Não inicia servidores parados nem entra em voz. Ao migrar de uma configuração
antiga com vários destinos, somente a última escolha é mantida. A passagem da
Home para o servidor tem uma animação curta, desativada com movimento reduzido.

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

### Iniciar outro servidor durante uma chamada

Iniciar e visualizar um servidor próprio offline, pela Home ou pela barra
lateral, não entra automaticamente em voz e não interrompe a chamada atual,
o microfone, a câmera ou os compartilhamentos. Entrar em outro canal de voz
continua sendo uma ação separada.

Se outro servidor já estiver hospedado por esta instância do app, ele não será
desligado implicitamente. Use os controles de hospedagem para pará-lo
explicitamente quando for seguro, antes de iniciar um servidor diferente.

## Configurações do servidor: aplicação imediata

Essas configurações são compartilhadas e ficam no menu do **nome do servidor**,
não na engrenagem pessoal. O guia [Administrar um servidor](/administrar-servidor)
explica aplicação imediata, cargos, canais, limites, modo de voz e versão
do processo. Para permissões e avisos de compatibilidade de bots,
veja [Usar bots](/bots).
