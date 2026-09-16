# Monky Light

[English](README.en.md)

Núcleo nativo **headless** do Monky Light, em desenvolvimento. Conecta ao servidor
Monky e participa de chamadas de voz P2P e SFU, sem janela ou navegador residente.
Ainda não é o aplicativo final de bandeja nem um instalador publicado.

O núcleo não depende de Electron, Node ou webview em tempo de execução. Node é
uma ferramenta de construção: compila o `@monky/shared` e gera os contratos C++
antes da compilação nativa. Os alvos são Windows x64 e macOS 12+ Intel/Apple
Silicon. A execução local disponível foi em Windows; a matriz macOS está
preparada no CI, mas não substitui a qualificação real dessas plataformas.

## Construção

Pré-requisitos de desenvolvimento:

- Node.js 22 ou superior e as dependências npm do monorepo.
- CMake 3.28 a 3.31. A dependência SDP fixada ainda não é compatível com CMake 4.
- Windows x64: Visual Studio 2022/Build Tools com ferramentas C++ e Windows SDK.
  O script também encontra o CMake incluído no Visual Studio.
- macOS 12 ou superior: ferramentas de desenvolvimento do Xcode e CMake. Intel e Apple Silicon
  usam diretórios de construção separados.

Execute na raiz do repositório:

```powershell
npm run build:light
```

No macOS, selecione a arquitetura quando necessário:

```text
npm run build:light -- --arch x64
npm run build:light -- --arch arm64
```

Os resultados ficam em `apps\light\build\windows-x64`, `macos-x64` ou
`macos-arm64`. A configuração usada pelo script é `Release`. Para selecionar um
CMake fora do `PATH`, defina `MONKY_LIGHT_CMAKE` com o caminho do executável.

## Executar o núcleo

Use um servidor descartável da mesma branch/versão do protocolo e um perfil
exclusivo do Light, nunca o perfil do Monky instalado. A pasta pai do perfil
precisa existir; a última pasta é criada pelo programa. Exemplo no Windows
(ajuste o endereço para o servidor local que iniciou):

```powershell
& .\apps\light\build\windows-x64\bin\monky-light.exe `
  --profile "$env:LOCALAPPDATA\Monky-Light-development" `
  --server ws://127.0.0.1:8080 --nickname Light
```

O executável macOS fica dentro do bundle `monky-light.app`, em `bin` no diretório
da arquitetura. Execute o binário do bundle em um terminal para manter stdin e
stdout disponíveis. O bundle declara a finalidade de acesso ao microfone.

`--help` lista as opções. `--channel` aceita o ID de um canal de voz;
`--muted`/`--deafened` aplicam as preferências desde a entrada. Se o servidor
exigir senha, forneça `MONKY_LIGHT_PASSWORD` no ambiente do processo, não na
linha de comando. Ela não é salva no perfil.

A saída contém eventos JSON, incluindo `authenticated` com a lista de canais.
Digite um objeto JSON por linha no terminal, usando o ID recebido:

```json
{"command":"channels"}
{"command":"join","channelId":"ID-DO-CANAL"}
{"command":"mute","enabled":true}
{"command":"deafen","enabled":false}
{"command":"stats","id":"minha-consulta"}
{"command":"leave"}
{"command":"reconnect"}
{"command":"quit"}
```

`enabled:false` desfaz mute/deafen. Restrições impostas pelo servidor continuam
valendo. `stats` consulta dispositivos e RTP sob demanda; não há coleta periódica
de telemetria no núcleo. EOF, Ctrl+C e `quit` encerram conexão e mídia.

No macOS, a autorização do microfone é solicitada apenas quando uma chamada
precisa transmitir. Enquanto a permissão está pendente, é possível receber
áudio, sair da chamada e encerrar o aplicativo. Uma recusa mantém o microfone
mutado e gera `microphone-error`; não tenta contornar as configurações do sistema.
O fluxo de permissão do macOS ainda requer execução em um Mac.

## Contratos compartilhados

`scripts\generate-light-contracts.js` gera `generated\protocol.hpp` em cada
diretório de construção, diretamente das exportações compiladas do
`@monky/shared`. O cabeçalho contém versão do protocolo, tipos de mensagem,
códigos de erro, limites e intervalos de reconexão.

Não edite o cabeçalho gerado nem copie números de versão ou tipos de mensagem
para o código nativo. A geração não substitui a validação dos payloads ou a
implementação da máquina de estados do cliente.

```powershell
npm run test:light:scripts
```

O CI prepara execuções nativas em Windows, macOS Intel e macOS Apple Silicon.
As versões das ferramentas vêm de `buildTools` em `dependencies.json`; o cache
contém os arquivos de download, que continuam sujeitos à validação por hash.

## Identidade e isolamento de perfil

`ProfileIdentity` é o proprietário da identidade da instalação. Recebe um caminho
absoluto, cria somente a pasta final quando necessário e exige que a pasta pai
já exista. Mantém a chave de assinatura e o lock durante toda a sua vida.

O arquivo público `monky-light.json` guarda versão do formato, chave pública e
um `deviceId` aleatório independente da chave. Não contém seed, chave privada ou
senha. Metadados inconsistentes, arquivos pendentes ou a ausência de um dos
componentes da identidade exigem recuperação explícita, nunca recriação silenciosa.
Diretórios com arquivos de outros aplicativos são recusados.

`IdentityStore` requer um diretório de perfil absoluto e já existente. Mantém um
lock exclusivo durante sua vida e armazena uma seed Ed25519 de 32 bytes com
DPAPI por usuário no Windows ou Keychain no macOS. Os métodos devem ser chamados
de forma serializada, e o chamador deve limpar os buffers de seed que possuir.

Identidade ausente é diferente de identidade inválida, bloqueada ou inacessível:
estas últimas situações geram erro, nunca uma substituição automática.
`save()` cria uma identidade nova e não sobrescreve uma existente. Recuperação,
importação e migração não fazem parte dessa API.

No Windows, `identity.dpapi.pending` indica uma gravação interrompida e exige
recuperação explícita. No macOS, cada `IdentityStore` mantém o Keychain padrão
selecionado na construção e restringe consultas e criação a ele, sem alterar a
lista de busca ou o padrão do usuário. A primeira abertura desabilita a UI do
Keychain legado para todo o processo headless, uma única vez: esse backend não
respeita os flags de UI por consulta do Keychain de proteção de dados. O cofre
precisa estar desbloqueado e legível, e `save()` também exige permissão de escrita.
Desbloqueio ou autorização devem ser feitos fora do processo antes de tentar
novamente. Keychains não relacionados, mesmo bloqueados, não interferem.
O serviço é `org.monky.light.identity.ed25519-seed.v1`, e a conta é o caminho
canônico do perfil. Mover o diretório ou reabrir com outro Keychain padrão exige
tratamento explícito de migração/recuperação; chaves não são movidas nem substituídas.

O executável de cenários da plataforma cria subdiretórios descartáveis e remove
apenas os arquivos e registros de Keychain que pertencem a eles. No Windows:

```powershell
npm run build:light -- --target monky-light-platform-test
& .\apps\light\build\windows-x64\bin\monky-light-platform-test.exe .\apps\light\build\windows-x64
```

No macOS, o executável fica em `bin` no diretório da arquitetura selecionada.
Passe esse diretório de construção existente como argumento; não use perfis
do Monky instalado nem servidores/dados de produção.
Os cenários de isolamento criam Keychains descartáveis, bloqueiam somente esses
Keychains e restauram o padrão e a lista de busca ao sair. Execute-os sem outros
testes de Keychain em paralelo. Em CI sem interface, prepare antes um Keychain
descartável como padrão, desbloqueado e gravável; restaure a configuração anterior
e exclua somente esse Keychain ao terminar.

Para os cenários nativos disponíveis, incluindo compatibilidade da assinatura
com o verificador usado pelo servidor:

```powershell
npm run test:light:native
```

## Conexão, voz e ciclo de vida

O transporte usa WinHTTP no Windows e Foundation no macOS, preservando a
validação TLS do sistema e recusando redirecionamentos. Mensagens recebidas são
limitadas por mensagem completa, inclusive quando fragmentadas; o limite inicial
de 8 MiB comporta os broadcasts opcionais de soundboard sem interpretá-los como voz.
No macOS, a exceção ATS do bundle permite `ws://` para os endereços definidos
pelo usuário, que não podem ser listados antecipadamente. Isso não desativa a
validação de certificados/hostname em `wss://`; prefira conexões criptografadas
fora de uma rede local confiável. O fixture de transporte usa a mesma política
de bundle, com identificador separado.

`ApplicationLoop` concentra eventos e prazos em uma thread, com fila limitada.
Quando não há trabalho nem prazo, aguarda uma notificação, sem polling.
`ConsoleControl` entrega linhas de entrada e sinais de encerramento; sua
destruição cancela leituras bloqueadas antes de liberar os callbacks.

`ProtocolSession` confirma a admissão antes de criar mídia, reconcilia a lista
de participantes e correlaciona respostas por conexão, geração, ID e tipo.
Reconectar preserva a identidade; expulsões cancelam a intenção de voltar à
chamada. Alterações P2P/SFU seguem o protocolo do servidor, sem fallback oculto.

`VoiceEngine` mantém ADM, processamento de áudio e fábrica WebRTC apenas durante
a chamada. Mute interrompe a captura real; deafen interrompe captura e reprodução.
Falhas de SDP/ICE de um participante P2P são isoladas daquele participante.
O áudio de tela não é confundido com microfone, e áudio de outra sessão do mesmo
usuário não é reproduzido.

Ofertas do cliente completo podem conter vídeo mesmo quando o Light só quer voz.
O SDK fixado exige capacidades de vídeo não vazias durante essa negociação:
fábricas VP8 preguiçosas evitam instanciar codecs, e os transceivers de vídeo são
interrompidos antes da resposta. Os cenários de interoperabilidade conferem zero
encoders/decoders de vídeo criados; não há câmera, compartilhamento ou renderização
de vídeo neste marco.

O dispositivo de áudio sintético existe somente em `test`: fornece PCM mono a
48 kHz em blocos de 10 ms e mede a energia do áudio recebido. Não seleciona
hardware, mesmo quando o SDK solicita o dispositivo padrão. No Windows, somente
esse dispositivo de teste solicita temporariamente resolução de timer de 1 ms,
liberada ao parar seu worker; isso não altera o timer do cliente de produção.
O relógio de amostras é independente da frequência com que o sistema acorda o
worker: atrasos curtos acumulam até cinco blocos, como um buffer de dispositivo.
Atrasos maiores descartam o conteúdo antigo e retomam o relógio original, sem
acumular trabalho indefinidamente. Os diagnósticos de cadência separam espera,
processamento e blocos descartados. As esperas continuam canceláveis no teardown;
o simulador não solicita prioridade especial nem bloqueia o repouso do macOS.

O ambiente de servidor descartável usa o servidor real, limitado ao loopback,
sem divulgação na LAN ou servidores STUN externos:

```powershell
npm run test:light:server
```

## Exercitar voz e medir consumo

```powershell
npm run test:light:voice
```

Esse comando compila o núcleo/servidor e exercita PCM decodificado entre clientes
nativos e entre nativo/Chromium em P2P e SFU. Inclui três participantes, políticas
de voz, troca de sala, reconexão, expulsão, mudança de topologia, sinalização
inválida e permissão de microfone pendente/negada. Chromium pertence apenas ao
cenário de interoperabilidade; usa fontes sintéticas e dispositivos falsos.

Para exercitar **explicitamente o microfone físico** no Windows ou no Mac:

```powershell
npm run test:light:hardware
```

O cenário usa o executável de produção e um receptor sintético em loopback.
O outro participante não transmite som. Confere entrega de PCM e interrupção
da captura; não salva áudio nem envia dados para um servidor externo. Exige
dispositivo disponível e permissão do sistema; não substitui avaliação auditiva
por duas pessoas, dispositivos diferentes ou redes reais.

Para uma amostra reproduzível de recursos **no Windows**:

```powershell
npm run measure:light
```

São intervalos de aproximadamente 10 segundos em idle conectado, chamada P2P,
chamada SFU, deafen e após sair. A fonte é sintética, mas AEC, ganho automático
e supressão de ruído usam a política padrão. A medição cobre somente o PID do
cliente nativo, excluindo o servidor e o executor. `oneCoreCpuPercent` usa
**100% = um processador lógico**; `workingSetMiB` e `privateMiB` são medidas distintas
do Windows, não uma soma. Não há limiar de aprovação nem comparação automática
com Electron. Drivers, outros computadores e uso prolongado ainda precisam de
medição; memória residente pode reter páginas do alocador mesmo após o teardown.

Chat, soundboard, miniapps, assistir transmissões, bandeja e hospedagem pela CLI
ficam para marcos posteriores, com recursos opcionais carregados sob demanda.

## Distribuição

`dependencies.json` fixa a combinação WebRTC M140/libmediasoupclient usada para
qualificação local, incluindo hashes dos SDKs de cada arquitetura. Essa versão
mais antiga não está automaticamente aprovada para distribuição pública.
O pacote omite o objeto da API `FieldTrials`; a construção inclui a implementação
original da mesma revisão, com hashes verificados, sem alterar a biblioteca.

Há também uma correção restrita em `libmediasoupclient`: seções SDP sem codecs
podem omitir `rtcpFb` e `ext`. Consultas const a essas chaves ausentes causavam
comportamento indefinido na biblioteca. CMake verifica os hashes antes/depois
e compila uma cópia corrigida que trata essas duas listas opcionais como vazias,
sem modificar o checkout baixado. `sdk_check.cpp` cobre o caso.

O destino é um artefato separado na mesma release do Monky, usando a versão
calculada pelo pipeline existente. Identificação da aplicação, perfil,
instalação e atualização do Light permanecem separados do cliente completo.
O pipeline de publicação ainda não inclui estes componentes de desenvolvimento.
Assinatura, instaladores, atualização, política de manutenção do SDK e
qualificação macOS são pendências anteriores à distribuição pública.
