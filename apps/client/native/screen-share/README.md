# Compartilhamento nativo de tela

[English](README.en.md)

O Monky usa libobs para capturar e redimensionar a fonte escolhida, **AMD AMF
ou NVIDIA NVENC para codificar H.264 em hardware** e WebRTC nativo para
transportar os frames **sem decodificar e recodificar o vídeo no transmissor**.
No Windows, o receptor nativo usa Media Foundation e SharedTexture. Voz e
câmera continuam usando seus caminhos próprios.

O backend de captura implementado é **Windows x64**. H.264 e Automático usam
H.264; **AV1 está indisponível**, indicado como Em breve. Não há fallback
automático para captura Chromium, encoder de software ou outra fonte.
Se Captura de jogo não conseguir iniciar, há uma tentativa em **Normal** para
a mesma janela, após comprovar o encerramento da tentativa anterior.
A recepção Chromium continua disponível para perfis H.264 que o
dispositivo receptor consiga decodificar; isso não comprova capacidade de envio.
Em **Configurações → Qualidade e compartilhamento → Recepção de tela**, Windows
usa Nativo por padrão e Chromium somente por escolha explícita, nunca como
fallback. Uma falha nativa indica essa opção sem mudar o receptor. No macOS,
Chromium é o padrão e Nativo permanece desabilitado como Em breve. A preferência
salva vale para o próximo Assistir/Tentar novamente, sem interromper a recepção
ativa, alterar câmera/voz ou a captura. O aviso de limitações Chromium permanece
visível nas configurações.

## Fontes e verificação de disponibilidade

O seletor tem duas abas: **Telas** e **Janelas**. Após selecionar uma janela,
os cards oferecem **Normal** (padrão, WGC internamente) e **Captura de jogo**
para essa mesma fonte. Não há aba Jogos nem detecção automática de jogos.
Trocar o método preserva o ID da janela; escolher outra janela volta a Normal.
A seleção não executa probe/hook antes da confirmação explícita.
Use **Atualizar** se abrir um aplicativo depois do seletor. A lista não fica
consultando janelas/miniaturas continuamente enquanto você joga. Uma fonte que
desapareceu perde a seleção; uma atualização que falha não autoriza compartilhar
uma lista desatualizada.

| Método nativo | Fonte libobs | Identidade preservada | Áudio opcional |
|---|---|---|---|
| Janela (`window`) | `window_capture`, Windows Graphics Capture (WGC) | HWND, PID e instante de criação do processo | Aplicativo/processo selecionado |
| Monitor (`monitor`) | `monitor_capture`, WGC | Interface do dispositivo, nome GDI e limites físicos do monitor | Sistema, excluindo o Monky |
| Captura de Jogo (`game`) | `game_capture`, explicitamente para a janela escolhida | A mesma identidade HWND/PID/criação, não apenas título ou executável | Aplicativo/processo selecionado |

Os monitores vêm da enumeração nativa, não de um ordinal de tela do Electron.
Desconectar o monitor ou alterar sua identidade, posição ou resolução encerra
a fonte e exige nova seleção explícita; não se troca para a tela principal.
Minimizar ou ocultar uma janela/jogo é tratado como pausa, não como perda da
identidade. Restaurar permite retomar os frames. Fechar ou substituir a
janela/processo encerra o anúncio mesmo sem espectadores.

A disponibilidade tem três níveis diferentes:

1. `loadCaptureRuntime()` verifica arquivos e hashes, sem abrir a GPU.
   `captureKinds` declara implementação, **não qualificação de hardware**.
   O Main informa `requiresSelectionProbe: true`; o seletor mostra o preparo
   pendente, sem testar uma fonte arbitrária em segundo plano.
2. Depois da confirmação do usuário, o Main resolve a identidade selecionada
   e chama `CaptureBridge.prepare(target)`. Essa etapa abre gráficos OBS e
   verifica identidade, configuração e capacidade AMF/NVENC, mas não captura
   pixels da fonte nem inicia o encoder de produção. O Main encerra esse probe
   e comprova o fechamento do filho original antes de liberar sua reserva.
3. Com demanda de prévia local ou de espectador, `start` cria a fonte e o
   encoder. `READY` exige vínculo com a fonte e pacotes H.264 reais;
   `hardwareSessionConfirmed` só então pode ser verdadeiro.
   `hardwareQualified` permanece falso: uma sessão não qualifica todos os usos.

SPS/PPS são exigidos e validados no primeiro pacote, antes de enviar qualquer
vídeo, não na inicialização: o plugin NVENC do OBS só disponibiliza esses
cabeçalhos ao produzir o primeiro pacote. O fluxo começa com um IDR, e cada
keyframe recebe os parâmetros atuais para permitir espectadores tardios.
Cabeçalhos ausentes, inválidos ou fora dos limites continuam sendo erros.

Ao encerrar a fonte inteira, a retirada dos espectadores fecha diretamente
os pipelines compartilhados; não atualiza a demanda dos espectadores restantes
em um endpoint que está sendo encerrado. Falhas reais de limpeza continuam
sendo reportadas.
A trilha da prévia nativa pertence ao preload, não ao `VideoService`: encerrar
essa trilha antes do decoder fecha o writer enquanto ainda há frames chegando.
O proprietário bloqueia novos frames, encerra o decoder e drena o writer antes
de parar a trilha; timeout mantém os recursos retidos para nova tentativa.

Uma amostragem QPC/RTC que excede 2 ms descarta o quadro e invalida seus
dependentes, solicitando um IDR real pela recuperação existente (limite de
1,5 s). Não aumenta a tolerância do relógio, não inventa timestamps e não
transforma descontinuidades em sucesso. Avisos de conexão usam toast de
8 segundos, para não deixar um diálogo bloqueando o jogo após a recuperação.

Se o diagnóstico AMF indicar `primaries=0`, com `transfer=1`, `matrix=1` e faixa
limitada, confira o driver: [AMF #354](https://github.com/GPUOpen-LibrariesAndSDKs/AMF/issues/354)
documenta esse metadado reservado mesmo quando o OBS solicita BT.709.
A AMD informou em 20/07/2026 que a correção estava no driver público; isso não
comprova disponibilidade para todo modelo. O mesmo erro foi relatado em um 5600G
após atualização, portanto atualizar não é uma solução garantida.
Declarar `InColorPrimaries=1` também não resolveu no 5600G testado. O host agora
corrige exclusivamente o metadado de primárias do SPS produzido pelo AMF quando
o pipeline próprio foi verificado como NV12/BT.709/faixa limitada e o SPS declara
exatamente `primaries=0`, `transfer=1`, `matrix=1`, `fullRange=false`. O parser
limitado de RBSP/EBSP corrige extradata e SPS em banda antes da prévia e da rede,
sem recodificar nem alterar VCL, dimensões, perfil ou timestamps. A correção é
registrada uma vez por host. Outros metadados, fluxos de terceiros e a validação
de cor do RTC não recebem essa exceção. A publicação física no 5600G ainda
precisa ser confirmada.

Na recepção, uma observação de relógio que expira durante o transporte IPC é
indisponível, não uma falha do áudio inteiro. O código estruturado
`ERR_RTC_AUDIO_CLOCK_OBSERVATION` retira a medição e permite recalibrar no mesmo
epoch, mantendo os limites de 200 ms e de incerteza. Contadores
`rejectedClockObservations` e `lastClockRejection` preservam o diagnóstico.
Valores impossíveis, PCM não confirmado e regressões reais continuam erros.

Alterações de qualidade fazem preflight com a fonte anterior ainda ativa.
Somente após admissão encerram a instância antiga e publicam a substituta com
o mesmo ID de compartilhamento. Stop bloqueia novas demandas imediatamente,
mas drena transações SFU/PCM já admitidas antes de invalidar seus callbacks;
timeout retém o proprietário para retry. Consultas de diagnóstico durante essa
retirada retornam indisponibilidade, sem inventar FPS zero.

O teto configurável é 3840x2160/120 FPS/80 Mbps, sem mudar os presets existentes,
com **máximo de 60 FPS ao atingir 3840 px de largura ou 2160 px de altura**.
O cliente aplica o mesmo limite nas listas, valores digitados e preferências
salvas. O contrato de recepção e o runtime mantêm compatibilidade com perfis de
clientes anteriores; a política de seleção não altera o protocolo.
Cada perfil negocia o nível H.264 necessário: pelo menos 5.1 para 1080p120,
5.2 para 4K60 e 6 para 4K120. O overlay versionado do WebRTC e o patch de
`h264-profile-level-id` acrescentam suporte real ao nível 6; os patches e
licenças acompanham as fontes correspondentes. Cliente e servidor exigem
protocolo 26. O teto de bitrate não é um piso: o controle de congestionamento
continua ativo e diferentes perfis podem consumir upload adicional.

Isso não torna todo encoder compatível com 4K120. No AMF instalado na RX 9070 XT
do ensaio, `MaxLevel=52` e `ProfileLevel=60` é rejeitado; 4K60/80 Mbps inicializa
em nível 5.2. O preflight consulta essa capacidade no adaptador selecionado,
sem capturar pixels, e recusa o perfil incompatível antes de retirar a fonte
antiga. Não muda para 60 FPS nem falsifica o nível silenciosamente. NVENC também
precisa admitir o nível solicitado. Inicialização não comprova cadência física.

O export separado `probeCaptureCapabilities()` inicializa o encoder na GPU
sem capturar uma fonte, mas **não é o fluxo de descoberta global do Main**.
Sua API não entrega ao chamador um comprovante de encerramento vinculado a
PID/nonce nem um owner para repetir a limpeza após rejeição/cancelamento.
Não a use para deduzir que é seguro remover o diretório ou liberar uma reserva;
o fluxo selecionado mantém esse controle de ownership e encerramento.

Os encoders são `h264_texture_amf` e `obs_nvenc_h264_tex`. O probe NVIDIA abre
uma sessão NVENC no dispositivo D3D11 efetivamente escolhido; marca/vendor
sozinho não comprova suporte. Os dois caminhos de textura fixados usam
**DXGI adapter 0**. Uma GPU AMD/NVIDIA secundária, especialmente em notebooks
híbridos com Intel no adapter 0, não é selecionada automaticamente nem tem
compatibilidade cross-adapter garantida. Modelo, driver, recursos disponíveis
e limite de sessões do encoder podem impedir o preparo ou a captura.

## Vídeo, áudio e demanda de prévia

O vídeo usa NV12, perfil H.264 Main, zero B-frames e GOP de um segundo, com
limites de 3840x2160, 120 FPS (60 FPS em 4K) e 80000 kbps, sujeitos ao encoder. O switch **Manter proporção** no
seletor vale somente para o compartilhamento que está sendo criado. Desligado
(padrão), estica a imagem para a resolução solicitada. Ligado, mantém a imagem
inteira centralizada e acrescenta barras pretas quando as proporções diferem,
sem cortar ou deformar a fonte. A escolha vale para a prévia e todos os perfis
de espectadores, inclusive depois de trocar a qualidade; não altera a resolução
ou o FPS configurados e não é uma preferência global. Perfis diferentes podem
exigir encoders e upload adicionais. Esses valores são
limites de configuração, não garantia de FPS, bitrate entregue ou desempenho.
O feedback de bitrate confirma configurações, não a aplicação medida no
hardware (`hardwareApplicationConfirmed: false`, `fpsApplied: null`).

A captura só começa após selecionar uma fonte e existir **demanda de prévia
local ou de espectador**. A prévia funciona sem espectadores: nesse caso usa
um pipeline local no perfil da fonte, sem publicar mídia na rede. Quando há
espectadores, ela reutiliza um perfil assistido e decodifica seus mesmos
frames H.264, sem segunda captura/encoder apenas para exibição. A fila da
prévia é limitada e não bloqueia o envio remoto.
Um novo compartilhamento abre sua prévia no modo foco; atualizações de
qualidade ou recuperação não desfazem a escolha posterior de sair do foco.
O indicador **Normal / Captura de jogo** só aparece depois de observar frames,
e acompanha o pipeline efetivo da prévia ou do espectador, não apenas a opção
solicitada. A sinalização desse estado exige cliente e servidor compatíveis com o protocolo 26.

A opção **Pausar prévia quando o Monky estiver fora de foco**, ativa por padrão,
controla somente a prévia local; perder foco não interrompe espectadores.
Desativá-la permite manter a prévia em outro monitor. Ao sair o último
espectador, a publicação remota é encerrada; se a prévia ainda tiver demanda,
um pipeline local pode continuar/recomeçar. Sem espectadores e sem demanda de
prévia, os recursos de captura/encoder são encerrados. Isso vale também para
Captura de Jogo, que não precisa de um espectador remoto para a prévia.

O áudio usa o caminho PCM nativo com timestamps: janela/jogo captura o
aplicativo selecionado; monitor captura o sistema **excluindo o Monky**, não
somente aplicativos visíveis naquele monitor. Não é captura de microfone.
Apenas uma fonte pode capturar áudio por vez. Ao substituir uma transmissão
com som, o seletor mantém a opção de áudio habilitada: o Main prepara a nova
fonte sem adquirir PCM, e o renderer aguarda o encerramento da fonte anterior
antes de ativar a prévia e o novo seletor de áudio. Uma falha de preparação
preserva a transmissão anterior; uma falha no encerramento impede a ativação
da substituta. Adicionar outra transmissão com som continua bloqueado enquanto
a primeira possui o áudio. Se a captura de áudio não
estiver disponível, é preciso desativá-la explicitamente para enviar só vídeo;
não há troca silenciosa de escopo. Suporte do módulo e testes sem dispositivos
não substituem a validação do áudio físico no Windows de destino.

Na reprodução, `currentFrame` é uma observação do relógio do grafo, não do
alto-falante. O Chromium 152.0.7977.130 [avança o grafo antes de atualizar o
worklet](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/third_party/blink/renderer/modules/webaudio/realtime_audio_destination_handler.cc);
essa [atualização pode ser pulada por um try-lock](https://raw.githubusercontent.com/chromium/chromium/152.0.7977.130/third_party/blink/renderer/modules/webaudio/base_audio_context.cc),
repetindo o timestamp mesmo com callbacks novos. O receptor retira imediatamente
a âncora de sincronização e incrementa apenas `clockEpoch`, sem trocar o epoch
de saída, o dispositivo ou o owner. O PCM ainda não reproduzido é contabilizado
em `discardedFrames`; os créditos em trânsito continuam válidos e limitados.
Enquanto o relógio estiver congelado, a saída fica em buffering/silêncio,
contabilizado em `repeatedContextFrames`. Só um avanço realmente observado e
a profundidade de buffer exigida permitem nova âncora; não se inventam timestamps.
Retrocesso real ou sobreposição parcial continua sendo erro explícito.

## Dependências OBS e Captura de Jogo

`scripts\buildCapture.cjs` gera `bin\win32-x64\capture-build.json` no **schema 4**.
Ele mantém OBS **32.1.1**, revisão
`7272af1375b38bc3cf4e0f98a5d999e8b76e9309`, com arquivos verificados por SHA-256.
Além de libobs/D3D11/WinRT, `obs-ffmpeg` e do módulo `win-capture` especializado,
o pacote inclui `obs-nvenc.dll`, dados de locale, probes
`obs-amf-test.exe`/`obs-nvenc-test.exe` e as dependências fixadas.
Os probes também ficam ao lado de `monky-screen-capture.exe`.
O header NVENC `include\ffnvcodec\nvEncodeAPI.h` do pacote de dependências é
verificado por `src\capture\runtime-additions.json`.

Os helpers OBS `graphics-hook32.dll`/`graphics-hook64.dll`,
`inject-helper32.exe`/`inject-helper64.exe` e
`get-graphics-offsets32.exe`/`get-graphics-offsets64.exe` são distribuídos em
`obs\data\obs-plugins\win-capture`, dentro do runtime privado. O preparo de
uma seleção `game` inicializa os helpers de offsets; a captura/injeção só
começa com demanda dessa seleção. Não há updater/download autônomo de
compatibilidade, instalação global de hooks ou registro global de camada
Vulkan. Isso é diferente dos hooks de **build do `gclient`**, que continuam
desativados.

Os dados imutáveis de `win-capture` são copiados, com verificação de cada
SHA-256, para `native-screen-capture\hooks-<hash>\data\obs-plugins\win-capture`
dentro do perfil selecionado. A chave deriva do conjunto completo de arquivos
fixados. Cada arquivo é publicado atomicamente, sem sobrescrever uma cópia
existente, que também precisa passar pelas verificações de caminho, tamanho e
hash. Configurações e ownership continuam privados por execução.
Uma DLL injetada pode permanecer mapeada no jogo após encerrar a transmissão:
por isso esse cache não é apagado no Stop, na pausa da prévia ou na troca de
qualidade. O encerramento ainda exige liberar a captura, o encoder, o transporte
e o processo auxiliar; não mata o jogo nem força o descarregamento de sua DLL.
Um runtime antigo deve ser recompilado para usar esse armazenamento e os dois
modos de proporção.

Mantém-se a configuração normal OBS `anti_cheat_hook=true`; ela não autoriza
desativar anti-cheat, Trusted Mode ou alterar argumentos de lançamento.
Captura de Jogo exige renderização compatível com o hook: não é um método
universal para qualquer aplicativo enumerado. O [guia oficial do
OBS](https://obsproject.com/kb/game-capture-troubleshooting) lista CS2 entre os
jogos com problemas conhecidos e orienta modo janela/sem bordas com captura de
janela. Não se pode deduzir qual proteção está ativa apenas pela falta de frames.
Uma falha de inicialização da fonte Game ou ausência de frames antes do prazo
inicia o fallback para **Normal**, com aviso discreto traduzido, sem desativar
proteções. O host anterior precisa confirmar seu encerramento; HWND, PID e
instante de criação são revalidados antes da única tentativa alternativa.
O transporte, espectadores, áudio, proporção e perfil permanecem os mesmos.
Perda da janela, cancelamento, erro do encoder ou falha após emitir vídeo não
autorizam trocar de método. Se Normal também falhar, o erro é explícito.
Para esses jogos, Normal pode exigir modo janela/sem bordas; não há garantia
de compatibilidade. O guia pesquisável no seletor resume limitações publicadas
pelo OBS, não uma lista completa de jogos homologados no Monky.

## Build a partir de um checkout

Requisitos: Windows x64, Node.js 22+ x64, npm, Git, CPython **3.11.8+ da série
3.11, x64**, Visual Studio **2022 (17.x)** C++ com **v143/MSVC 14.30–14.44**,
ATL/MFC e CRT redistribuível de release, Windows SDK
**10.0.26100.0** com servicing **10.0.26100.3323 ou posterior** e Debugging Tools
x64. Reserve vários GB para fontes, ferramentas e build.
O Python deve ser um executável instalado, não o launcher da Microsoft Store.

O seletor compartilhado em `scripts\windowsToolchain.cjs` considera somente
VS2022 completo e não preview, mesmo com VS2026 instalado. Escolhe a instalação
compatível mais recente dentro dessa faixa, informa versões/caminhos e rejeições,
e verifica ferramentas, integração v143, SDK e servicing antes de criar o venv,
baixar fontes ou compilar. **17.13.4 é a referência upstream dos pins, não um
patch exato obrigatório**; não implica suporte a VS2026 ou MSVC 14.5x.
O SDK 28000 sozinho não substitui o diretório 26100: `rc.exe` precisa continuar
na família 26100; as DLLs compartilhadas de Debugging Tools podem ser mais novas.

`--vs-install=<caminho absoluto>`, `--sdk-root=<caminho absoluto>` e
`--vswhere=<executável absoluto>` estão disponíveis no seletor, preparo,
bootstrap e builders. Uma seleção explícita inválida falha, sem escolher outra
instalação. O ambiente de outro Developer Prompt não é herdado pelos builds:
`vcvars`, GN, node-gyp e MSBuild recebem a instalação e as versões verificadas.
Nenhuma dessas etapas instala ou atualiza Visual Studio, MSVC ou SDK.

Na raiz do checkout já atualizado, em PowerShell comum, ajuste o caminho do Python
e execute as etapas separadamente, interrompendo no primeiro erro. Antes do
rebuild, feche somente o Monky Dev desse checkout, não a versão instalada:

```powershell
$Python = "C:\Python311\python.exe"
$env:PYTHON = $Python
$env:NODE_GYP_FORCE_PYTHON = $Python
$Git = (Get-Command git -CommandType Application | Select-Object -First 1).Source
node apps\client\native\screen-share\scripts\windowsToolchain.cjs --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'Windows toolchain preflight failed.' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
npm run prepare:native-screen -- --python="$Python" --git="$Git" --jobs=4
if ($LASTEXITCODE -ne 0) { throw 'Native screen preparation failed.' }
node apps\client\native\screen-share\scripts\buildScreenAudio.cjs --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'screen-audio rebuild failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Monky build failed.' }
npm start
```

`npm ci` usa o lockfile, mas o script de instalação de `screen-audio` adia
seu build. `buildScreenAudio.cjs` usa o `node-gyp` já instalado no repositório
para configurar os headers do Electron instalado **depois de `npm ci`**, não
os do Node do terminal. Em seguida, recompila
`apps\client\native\screen-audio\build\Release\screen_audio.node` com MSBuild,
fixando instalação/MSVC/SDK e usando o job privado gerado pelo preparo RTC.
Por isso esse comando vem **depois de `prepare:native-screen`**.
Execute-o no primeiro preparo ou quando mudarem as fontes do addon ou o Electron;
um addon anterior às funções de monitor/identidade e ACKs PCM precisa ser atualizado.
Se o addon já corresponde a essas fontes e ao Electron instalado, uma alteração
somente de scripts/TypeScript não exige outro rebuild de `screen-audio`.
As fixtures de `screen-audio\test` não substituem o addon de produção.
Não instale outro Electron ou `node-gyp` global nem reutilize um `.node` antigo
para contornar falhas.

O primeiro comando é um preflight somente leitura, sem build, download ou GPU,
e funciona antes de `npm ci`. Ele não altera o ambiente global nem os hooks de
instalação de outros pacotes que `npm ci` possa executar; use PowerShell comum,
não um Developer Prompt de outra versão do VS.

`prepare:native-screen` usa `.native-screen`, ignorado pelo Git. Após o preflight, cria um venv
privado, obtém revisões fixadas, verifica os arquivos OBS por SHA-256, compila
o RTC e a captura de `screen-share` e reúne as licenças; **não compila
`screen-audio`**. Não usa diretórios de experimentos nem executa os hooks de
build do `gclient`. Checkouts modificados ou incompletos interrompem a
preparação; não são resetados ou substituídos silenciosamente.

Downloads de arquivos compactados têm até três tentativas para falhas
transitórias de rede/servidor, com espera e descarte do arquivo parcial.
Cada tentativa concluída precisa validar o SHA-256 e o tamanho, quando fixado.
Falhas de integridade, certificado, redirecionamento inseguro ou HTTP
permanente interrompem o preparo sem repetir nem substituir o cache.

Esse roteiro não instala os pré-requisitos de sistema nem promete um preparo
completo em um comando em qualquer máquina. `nativeScreenReady: true` confirma
o build/runtime, não a captura, o driver ou o envio NVIDIA. O preparo em uma
máquina limpa e cada combinação GPU/driver ainda precisam de validação própria.

O build inclui o CRT redistribuível de release do Visual Studio no aplicativo.
Não depende de Visual Studio ou de um CRT previamente instalado no computador
de quem recebe o Monky.
Use um diretório de instalação curto: o host admite caminhos de até 240
caracteres, incluindo os nomes dos arquivos internos, e recusa aliases.

```powershell
npm run package
```

Esse comando usa o mesmo electron-builder da release, sem encerrar instâncias
alheias. Produz `release\win-unpacked\Monky.exe` e
`release\Monky-Windows.zip`. O empacotamento falha se binários, fontes
compiladas, runtime, CRT ou avisos de terceiros estiverem inconsistentes.

## Reaproveitamento no CI e na release Windows

O CI executa a suíte DOM Windows em outro runner `windows-2022`, em paralelo
ao preparo nativo e ao empacotamento. Os testes continuam sequenciais dentro
desse runner para não disputar fixtures de desktop/áudio. Os dois checks
`Build check` existentes aguardam o empacotamento nas duas plataformas e a
suíte DOM Windows; falha, cancelamento ou uma etapa paralela pulada não aprova
esses gates. A suíte DOM macOS continua no job de empacotamento.

CI e release mantêm cache somente de `.native-screen\downloads`: arquivos
compactados de runtime/dependências OBS, identificados pelo conteúdo, e os
arquivos de fontes selecionados pelas receitas OBS fixadas. A chave inclui
Windows x64, os manifestos e as receitas de download/verificação, sem fallback
por prefixo. CI e release usam namespaces separados. Antes do uso, cada arquivo
restaurado é conferido contra o SHA-256 confiável e o tamanho, quando fixado;
corrupção falha explicitamente, sem baixar uma substituição silenciosa. Sem
cache, os arquivos são baixados e verificados normalmente.

Isso **não é cache de binários nativos**: alterações de ABI do Electron,
compilador e fontes continuam compilando do zero. Não são restaurados árvore
WebRTC, marcadores de propriedade do checkout, venv Python, ferramentas
extraídas nem resultados de compilação nativa. Permanecem a seleção de Python
3.11, VS2022 v143 e SDK 10.0.26100.0, os contratos nativos, as verificações de
pacote, as licenças e os gates de geração/publicação das fontes correspondentes.

A execução fria ganha somente a oportunidade de sobrepor DOM Windows ao
trabalho nativo, ao custo da instalação e do build dos workspaces em outro
runner. A execução quente pode também evitar esses downloads OBS, mas ainda
extrai, valida, compila WebRTC e gera o arquivo de fontes da release. Não há
promessa de duração nem eliminação do custo principal da compilação nativa;
meça as execuções reais de CI/release antes de afirmar ganho de tempo.

## Licença e fontes correspondentes

O Monky é **GPL-3.0-or-later**. `LICENSE-MIT` preserva o aviso histórico do
projeto. Dependências mantêm seus próprios direitos e licenças; consulte
`THIRD_PARTY_NOTICES` e `licenses`. Os avisos WebRTC são derivados do grafo GN
realmente compilado. O FFmpeg distribuído usa GPL versão 3 ou posterior.
Direitos de patentes H.264 são uma questão separada da licença de software.

As fontes correspondentes são o código Monky da **mesma tag da release** e
`monky-native-sources-<versao>.tar.xz`, com seu manifesto JSON, na
[mesma página de release](https://github.com/MonkyOrg/Monky/releases).
O arquivo inclui fontes do SDK, bibliotecas OBS/FFmpeg e receitas de dependências,
inclusive as usadas por NVENC e pelos helpers de Game Capture. O host, os
ajustes de vínculo da fonte e as receitas de build Monky vêm do checkout da
mesma tag; o arquivo de fontes sozinho não é um runtime pronto. Ele inclui
`SOURCE-MANIFEST.json` e cópias deste guia em `SOURCE-README.md` e
`SOURCE-README.en.md`. Arquivos de fonte upstream são preservados com seu
checksum original, inclusive os que contêm links simbólicos de Unix.

Para gerar o arquivo, depois de preparar o runtime:

```powershell
$Version = (Get-Content apps\client\package.json | ConvertFrom-Json).version
npm run pack:native-sources -- --version=$Version
```

O destino padrão é `release\monky-native-sources-<versao>.tar.xz` e
`release\monky-native-sources-<versao>.json`. O script exige fontes e avisos
consistentes com o build e recusa sobrescrever um par já existente.
Não publique um manifesto com `publicationReady: false`: ele foi produzido
de uma árvore com alterações locais. A release verifica o commit, tamanho e
SHA-256 das fontes e só fica pública depois de confirmar todos os uploads.

## Reconstruindo com o arquivo de fontes

Obtenha o checkout Monky da mesma tag, confira os checksums da release e
instale os mesmos pré-requisitos de Python 3.11/MSVC/SDK descritos acima.
Em um checkout novo, sem `.native-screen`, substitua `<versao>` pelo nome do
arquivo baixado e execute cada etapa, parando em qualquer erro:

```powershell
$Python = "C:\Python311\python.exe"
$env:PYTHON = $Python
$env:NODE_GYP_FORCE_PYTHON = $Python
node apps\client\native\screen-share\scripts\windowsToolchain.cjs --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'Windows toolchain preflight failed.' }
New-Item -ItemType Directory .native-screen -ErrorAction Stop
& $Python -c "import tarfile; tarfile.open('monky-native-sources-<versao>.tar.xz', 'r|xz').extractall('.native-screen', filter='data')"
if ($LASTEXITCODE -ne 0) { throw 'Source extraction failed.' }
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
node apps\client\native\screen-share\scripts\buildRtc.cjs --webrtc-root="$PWD\.native-screen\rtc\webrtc\src" --python="$Python" --jobs=4
if ($LASTEXITCODE -ne 0) { throw 'RTC build failed.' }
node apps\client\native\screen-share\scripts\fetchObs.cjs --runtime-only
if ($LASTEXITCODE -ne 0) { throw 'Pinned OBS acquisition failed.' }
node apps\client\native\screen-share\scripts\buildCapture.cjs --obs-root="$PWD\.native-screen\obs-runtime" --deps-root="$PWD\.native-screen\obs-dependencies" --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'Capture build failed.' }
node apps\client\native\screen-share\scripts\buildScreenAudio.cjs --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'screen-audio rebuild failed.' }
node apps\client\native\screen-share\scripts\notices.cjs
if ($LASTEXITCODE -ne 0) { throw 'Native notices failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Monky build failed.' }
```

Use esses comandos diretos, não o bootstrap de aquisição, sobre o snapshot:
o snapshot não carrega os locks ou a identidade do checkout da máquina de build.
A extração via Python preserva os nomes Unicode das fontes no Windows.
Ferramentas genéricas ainda exigem Node/Python/MSVC/SDK instalados; a etapa
`--runtime-only` baixa os binários OBS e as dependências fixadas para o build
padrão, incluindo NVENC e hooks; não é uma reconstrução offline completa.
`buildRtc.cjs` deve preceder `buildCapture.cjs` e `buildScreenAudio.cjs`: ele gera também
`build\tools\monky_msvc_job.exe`, dentro deste módulo. Para alterar OBS/FFmpeg,
use suas fontes, receitas e ajustes Monky e atualize os pins do runtime para
seus novos binários; não misture helpers/hooks de outra versão do OBS.

O build verifica revisão, ABI, fontes e recursos, mas não promete binários
bit a bit idênticos entre versões distintas do toolchain.

## Validação

`npm run test:native-screen --workspace=@monky/client` cobre os contratos e
lifecycle sem exigir captura de hardware. O build C++ também executa contratos
sem abrir dispositivos. `test\nativeCaptureSmoke.cjs`, neste módulo, e
`apps\client\test\nativeScreenAppSmoke.cjs` exercitam mídia real em janelas
sintéticas próprias; exigem o hardware qualificado e um diretório novo de
artefatos via `--artifacts=<caminho_absoluto>`.

Os ensaios do aplicativo cobrem P2P/SFU, receptor Chromium, áudio, qualidade,
prévia local, Assistir/Parar, fullscreen, overlay, troca de servidor e queda
de conexão. `--window-lifecycle` acrescenta minimizar/restaurar;
`--idle-source-close` verifica fechar uma fonte sem espectadores.
`--publisher-stop` verifica dois ciclos de Parar no transmissor enquanto outro
participante assiste, seguidos de reinício com áudio na mesma chamada.
`--source-resize` altera o tamanho da janela sintética mantendo a fonte e o
perfil de saída; não altera a resolução do monitor nem simula tela cheia exclusiva.
O QA da prévia deve validar funcionamento sem espectadores, perda/retorno de
foco, opção de pausa desativada e continuidade dos espectadores. Resolução
e contagem de frames, sozinhas, não comprovam que os pixels decodificados
foram exibidos na interface.

### Limitação conhecida da recepção Chromium no Windows

O ensaio integrado na RX 9070 XT qualificou 4K60 com recepção nativa, mas
**não qualificou a cadência do receptor Chromium**. Mesmo em 1080p60, houve
congelamentos periódicos e resultados abaixo de 50 FPS. Durante um intervalo
sem ações do QA, o escopo `DXGISwapChainImageBacking::Present` bloqueou a thread
GPU por 262–285 ms; o despacho de decode atrasou, a fila do adapter encheu e
foram solicitados novos keyframes. O trace não distingue a chamada `Present1`
da espera de inicialização da swap chain, nem atribui a causa ao driver ou DWM.

A análise de 1.166 slices não encontrou quebra de continuidade de `frame_num`
ou POC. Desativar somente video overlays manteve o decode D3D11 por hardware,
mas não resolveu os bloqueios; esse workaround não foi aplicado ao aplicativo.
Não foram ampliadas filas, relaxados guards de IDR ou reduzidos os critérios
de aprovação. Essa falha permanece aberta e não deve ser apresentada como
corrigida pela qualificação do caminho nativo. O ensaio local também não
estabelece se houve regressão entre as betas.

Esses scripts de janela não qualificam monitor, Game Capture, NVIDIA ou tela
cheia exclusiva. A evidência local desta integração cobre AMF e WGC/Game em
uma fonte D3D11 sintética própria, incluindo minimizar/restaurar. A captura
física de monitor também passou em cenário com guarda de privacidade:
212 frames decodificados, 211 distintos, EOF e encerramento dos recursos GPU
verificados. Isso não é uma medição de desempenho. Desconexão/mudança de
resolução, hardware NVIDIA, jogos protegidos e áudio físico permanecem
dependentes de QA específico; NVIDIA requer validação externa. Loopback Windows
não substitui QA em duas máquinas, macOS físico ou rede externa.
Para verificar o módulo já empacotado, `nativeCaptureSmoke.cjs` também aceita
`--module=<caminho_absoluto_do_modulo>`; ele carrega o runtime e os binários
desse diretório, não os do checkout.
