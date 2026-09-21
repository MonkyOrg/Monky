# Compartilhamento nativo de tela

[English](README.en.md)

O Monky usa libobs para capturar e redimensionar a fonte escolhida, **AMD AMF
ou NVIDIA NVENC para codificar H.264 em hardware** e WebRTC nativo para
transportar os frames **sem decodificar e recodificar o vídeo no transmissor**.
No Windows, o receptor nativo usa Media Foundation e SharedTexture. Voz e
câmera continuam usando seus caminhos próprios.

O backend de captura implementado é **Windows x64**. H.264 e Automático usam
H.264; **AV1 está indisponível**, indicado como Em breve. Não há fallback
automático para captura Chromium, encoder de software, outra fonte ou outro
método. A recepção Chromium continua disponível para perfis H.264 que o
dispositivo receptor consiga decodificar; isso não comprova capacidade de envio.

## Fontes e verificação de disponibilidade

| Seleção | Fonte libobs | Identidade preservada | Áudio opcional |
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
limites de 1920x1080, 120 FPS e 20000 kbps. A imagem é **esticada para a resolução
solicitada**, sem criar barras para preservar a proporção original. Perfis
diferentes podem exigir encoders e upload adicionais. Esses valores são
limites de configuração, não garantia de FPS, bitrate entregue ou desempenho.
O feedback de bitrate confirma configurações, não a aplicação medida no
hardware (`hardwareApplicationConfirmed: false`, `fpsApplied: null`).

A captura só começa após selecionar uma fonte e existir **demanda de prévia
local ou de espectador**. A prévia funciona sem espectadores: nesse caso usa
um pipeline local no perfil da fonte, sem publicar mídia na rede. Quando há
espectadores, ela reutiliza um perfil assistido e decodifica seus mesmos
frames H.264, sem segunda captura/encoder apenas para exibição. A fila da
prévia é limitada e não bloqueia o envio remoto.

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
Apenas uma fonte pode reservar áudio por vez. Se a captura de áudio não
estiver disponível, é preciso desativá-la explicitamente para enviar só vídeo;
não há troca silenciosa de escopo. Suporte do módulo e testes sem dispositivos
não substituem a validação do áudio físico no Windows de destino.

## Dependências OBS e Captura de Jogo

`scripts\buildCapture.cjs` gera `bin\win32-x64\capture-build.json` no **schema 3**.
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

Mantém-se a configuração normal OBS `anti_cheat_hook=true`; ela não autoriza
desativar anti-cheat, Trusted Mode ou alterar argumentos de lançamento.
Jogos protegidos, inclusive CS2 nas configurações protegidas, podem recusar
Captura de Jogo. Nesse caso, mantenha as proteções e, se desejar tentar WGC,
escolha **Janelas** e selecione manualmente a mesma janela. Não há promessa
de compatibilidade com o jogo nem troca automática de método/fonte.

## Build a partir de um checkout

Requisitos: Windows x64, Node.js 22+ x64, npm, Git, CPython **3.11.8+ da série
3.11, x64**, Visual Studio 2022 C++ (MSVC v143) com ATL/MFC, Windows SDK
**10.0.26100.0** com servicing **10.0.26100.3323 ou posterior** e Debugging Tools
x64. Reserve vários GB para fontes, ferramentas e build.
O Python deve ser um executável instalado, não o launcher da Microsoft Store.

Na raiz do checkout já atualizado, em PowerShell, ajuste o caminho do Python
e execute as etapas separadamente, interrompendo no primeiro erro. Antes do
rebuild, feche somente o Monky Dev desse checkout, não a versão instalada:

```powershell
$Python = "C:\Python311\python.exe"
$env:PYTHON = $Python
$env:NODE_GYP_FORCE_PYTHON = $Python
$Git = (Get-Command git -CommandType Application | Select-Object -First 1).Source
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
$ElectronVersion = node -p "require('electron/package.json').version"
if ($LASTEXITCODE -ne 0) { throw 'Cannot read installed Electron version.' }
node node_modules\node-gyp\bin\node-gyp.js rebuild --directory=apps\client\native\screen-audio --target="$ElectronVersion" --arch=x64 --dist-url=https://electronjs.org/headers --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'screen-audio rebuild failed.' }
npm run prepare:native-screen -- --python="$Python" --git="$Git" --jobs=4
if ($LASTEXITCODE -ne 0) { throw 'Native screen preparation failed.' }
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Monky build failed.' }
npm start
```

`npm ci` usa o lockfile, mas o script de instalação de `screen-audio` adia
seu build. O `rebuild` usa o `node-gyp` já instalado no repositório e a versão
do Electron instalado **depois de `npm ci`**, não a versão do Node do terminal.
Ele recompila `apps\client\native\screen-audio\build\Release\screen_audio.node`.
Essa etapa é obrigatória também ao atualizar um checkout: as novas funções de
monitor/identidade de processo e os ACKs assíncronos de PCM exigem um addon
atualizado. As fixtures de `screen-audio\test` não substituem o addon de produção.
Não instale outro Electron ou `node-gyp` global nem reutilize um `.node` antigo
para contornar falhas.

`prepare:native-screen` usa `.native-screen`, ignorado pelo Git. Cria um venv
privado, obtém revisões fixadas, verifica os arquivos OBS por SHA-256, compila
o RTC e a captura de `screen-share` e reúne as licenças; **não compila
`screen-audio`**. Não usa diretórios de experimentos nem executa os hooks de
build do `gclient`. Checkouts modificados ou incompletos interrompem a
preparação; não são resetados ou substituídos silenciosamente.

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
New-Item -ItemType Directory .native-screen
$Python = "C:\Python311\python.exe"
$env:PYTHON = $Python
$env:NODE_GYP_FORCE_PYTHON = $Python
& $Python -c "import tarfile; tarfile.open('monky-native-sources-<versao>.tar.xz', 'r|xz').extractall('.native-screen', filter='data')"
npm ci
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
$ElectronVersion = node -p "require('electron/package.json').version"
if ($LASTEXITCODE -ne 0) { throw 'Cannot read installed Electron version.' }
node node_modules\node-gyp\bin\node-gyp.js rebuild --directory=apps\client\native\screen-audio --target="$ElectronVersion" --arch=x64 --dist-url=https://electronjs.org/headers --python="$Python"
if ($LASTEXITCODE -ne 0) { throw 'screen-audio rebuild failed.' }
node apps\client\native\screen-share\scripts\buildRtc.cjs --webrtc-root="$PWD\.native-screen\rtc\webrtc\src" --python="$Python" --jobs=4
node apps\client\native\screen-share\scripts\fetchObs.cjs --runtime-only
node apps\client\native\screen-share\scripts\buildCapture.cjs --obs-root="$PWD\.native-screen\obs-runtime" --deps-root="$PWD\.native-screen\obs-dependencies"
node apps\client\native\screen-share\scripts\notices.cjs
npm run build
```

Use esses comandos diretos, não o bootstrap de aquisição, sobre o snapshot:
o snapshot não carrega os locks ou a identidade do checkout da máquina de build.
A extração via Python preserva os nomes Unicode das fontes no Windows.
Ferramentas genéricas ainda exigem Node/Python/MSVC/SDK instalados; a etapa
`--runtime-only` baixa os binários OBS e as dependências fixadas para o build
padrão, incluindo NVENC e hooks; não é uma reconstrução offline completa.
`buildRtc.cjs` deve preceder `buildCapture.cjs`: ele gera também
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
O QA da prévia deve validar funcionamento sem espectadores, perda/retorno de
foco, opção de pausa desativada e continuidade dos espectadores. Resolução
e contagem de frames, sozinhas, não comprovam que os pixels decodificados
foram exibidos na interface.

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
