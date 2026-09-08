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

### Aparecer offline

Em **Meu Perfil → Visibilidade → Aparecer offline**, o switch altera sua
presença em todos os servidores conectados, inclusive os que estão em segundo
plano. Você passa para a seção offline da lista de membros e vê **Invisível**,
com um indicador circular vazado de alto contraste na barra inferior.
Os outros membros veem sua presença como offline; alterar nickname ou foto
não torna você online novamente.

Isso não desconecta o cliente nem interrompe uma chamada em andamento. Sua
participação em um canal de voz continua visível nesse canal.

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
