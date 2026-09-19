# Compartilhamento nativo de tela

[English](README.en.md)

O Monky usa libobs para capturar e redimensionar uma janela, AMF para codificar
H.264 e WebRTC nativo para transportar os frames **sem decodificar e recodificar
o vídeo no transmissor**. No Windows, o receptor usa Media Foundation e
SharedTexture. Voz e câmera continuam usando seus caminhos próprios.

O caminho de transmissão qualificado é **Windows x64, janela via Windows
Graphics Capture e AMD/AMF H.264**. Monitores, outros encoders e outros sistemas
mantêm o caminho Chromium, identificado no seletor. Um receptor Chromium só
aceita um perfil H.264 que sua capacidade de decodificação permita.

A imagem é **esticada para a resolução solicitada**, sem criar barras para
preservar a proporção original. Antes de alguém assistir não há pipeline de
transmissão nativa. A última assinatura encerrada libera o pipeline real.
Perfis diferentes podem exigir encoders e upload adicionais; selecionar
120 FPS não garante 120 imagens distintas por segundo nem elimina limites de
captura, GPU, apresentação ou rede.

## Build a partir de um checkout

Requisitos: Node.js 22+, Git, CPython **3.11.8+ da série 3.11, x64**, Visual Studio 2022 C++ com
ATL/MFC, Windows SDK **10.0.26100.0** com servicing **10.0.26100.3323 ou posterior**
e Debugging Tools x64. Reserve vários GB para fontes, ferramentas e build.
O Python deve ser um executável instalado, não o launcher da Microsoft Store.

Na raiz do repositório, em PowerShell, ajuste o caminho do Python:

```powershell
$Python = "C:\Python311\python.exe"
npm ci
npm run prepare:native-screen -- --python="$Python" --jobs=4
npm run build
npm start
```

`prepare:native-screen` usa `.native-screen`, ignorado pelo Git. Cria um venv
privado, obtém revisões fixadas, verifica os arquivos OBS por SHA-256, compila
o RTC e a captura e reúne as licenças. Não usa diretórios de experimentos nem
executa os hooks de build do `gclient`. Checkouts modificados ou incompletos
interrompem a preparação; não são resetados ou substituídos silenciosamente.

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
O arquivo inclui fontes do SDK, bibliotecas OBS/FFmpeg, receitas e patches.
Arquivos de fonte upstream são preservados com seu checksum original, inclusive
os que contêm links simbólicos de Unix.

Para gerar o arquivo, depois de preparar o runtime:

```powershell
$Version = (Get-Content apps\client\package.json | ConvertFrom-Json).version
npm run pack:native-sources -- --version=$Version
```

Não publique um manifesto com `publicationReady: false`: ele foi produzido
de uma árvore com alterações locais. A release verifica o commit, tamanho e
SHA-256 das fontes e só fica pública depois de confirmar todos os uploads.

## Reconstruindo com o arquivo de fontes

Obtenha o checkout Monky da mesma tag e confira os checksums da release.
Em um checkout novo, extraia o arquivo em `.native-screen`:

```powershell
New-Item -ItemType Directory .native-screen
$Python = "C:\Python311\python.exe"
& $Python -c "import tarfile; tarfile.open('monky-native-sources-<versao>.tar.xz', 'r|xz').extractall('.native-screen', filter='data')"
npm ci
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
`--runtime-only` baixa os binários OBS fixados para o build padrão. Para alterar
OBS/FFmpeg, use suas fontes, receitas e patches incluídos e atualize os pins
do runtime para seus novos binários.

O build verifica revisão, ABI, fontes e recursos, mas não promete binários
bit a bit idênticos entre versões distintas do toolchain.

## Validação

`npm run test:native-screen --workspace=apps/client` cobre os contratos e
lifecycle sem exigir captura de hardware. O build C++ também executa contratos
sem abrir dispositivos. `test\nativeCaptureSmoke.cjs`, neste módulo, e
`apps\client\test\nativeScreenAppSmoke.cjs` exercitam mídia real em janelas
sintéticas próprias; exigem o hardware qualificado e um diretório novo de
artefatos via `--artifacts=<caminho_absoluto>`.

Os ensaios do aplicativo cobrem P2P/SFU, receptor Chromium, áudio, qualidade,
Assistir/Parar, fullscreen, overlay, troca de servidor e queda de conexão.
Loopback Windows não substitui QA em duas máquinas, macOS físico ou rede externa.
Para verificar o módulo já empacotado, `nativeCaptureSmoke.cjs` também aceita
`--module=<caminho_absoluto_do_modulo>`; ele carrega o runtime e os binários
desse diretório, não os do checkout.
