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
- **Sensibilidade de Voz (VAD)** — ajuste olhando o medidor; deixe o marcador acima do nível em silêncio.
- **Supressão de Ruído (RNNoise)** — reduz teclado, cliques e ruído ambiente.
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

O botão direito no seu próprio nome também abre o menu do usuário, tanto
nas listas quanto no seu perfil da barra inferior. Nesse menu você pode
alternar o mute manual do microfone e do áudio, inclusive antes de entrar
em chamada. O controle de volume de voz só aparece para outros usuários;
as demais ações continuam respeitando as permissões do servidor.
Um mute manual nunca remove um bloqueio aplicado por administrador.

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
vermelho, sem a marca PTT. Um bloqueio feito por administrador usa o microfone
ou fone com um pequeno símbolo de proibido, também sem PTT. Essa distinção
aparece nos controles, nas listas de participantes e no overlay; o tooltip
informa o bloqueio do servidor. Fora de chamada, o estado de espera fica cinza.

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

No Windows, o Monky também captura a tela pela API **Windows Graphics Capture**,
que compõe na GPU e não entrega quadros quando nada muda na tela. Ela precisa do
Windows 10 1809 ou mais novo, e não funciona dentro de sessões de Área de
Trabalho Remota — nesses casos o Monky volta sozinho para o método antigo. Para
forçar o método antigo, inicie o app com a variável `MONKY_DISABLE_WGC=1`.

Uma última dica que vale para qualquer programa de captura: compartilhar **a
janela do jogo** costuma custar menos que compartilhar o monitor inteiro, e
jogar em *fullscreen sem bordas* evita as trocas de modo que fazem o jogo
engasgar.
