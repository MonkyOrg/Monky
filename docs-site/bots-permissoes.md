# Capacidades e ciclo de vida

Leia este guia antes de adicionar um recurso a um bot existente. Declarar,
aprovar e usar uma capacidade são etapas diferentes; reconectar não é uma
autorização implícita.

**Referência:** [BotCapability](/bots-api-cliente#botcapability),
[BotPermissions](/bots-api-cliente#botpermissions) e
[eventos e limpeza](/bots-api#duracao-e-limpeza).

## Permissões e canais

Em **Configurações do Servidor → Cargos**, **Adicionar e gerenciar bots** (`MANAGE_BOTS`) controla quem pode vincular, desvincular e revisar as capacidades dos bots; **Configurar comportamento dos bots** (`CONFIGURE_BOTS`) controla apenas as opções compartilhadas de comportamento. Nenhuma dessas permissões autoriza alterar nome ou avatar. **Executar comandos de bots** controla quem pode usar seus comandos e interações, e é habilitada inicialmente para membros e cargos existentes.

Ao criar ou editar um canal de texto, o switch **Permitir comandos de bots** vem ativado. Desativá-lo bloqueia comandos e respostas a formulários e seletores nesse canal, **inclusive para administradores**. Digitar `/` mostra o motivo do bloqueio. Alterações de permissões também afetam interações já abertas; mensagens e reações comuns continuam seguindo suas próprias permissões.

## Capacidades solicitadas e consentimento

`BotOptions.requestedCapabilities` é obrigatório. Declare somente as categorias realmente usadas; o SDK publica a mesma lista no manifest e em `COMMAND_REGISTER`. A declaração é um pedido, nunca uma autorização:

| Capacidade | Acesso controlado pelo servidor |
|------------|--------------------------------|
| `commands` | Entradas fornecidas ao invocar comandos, autocomplete, prévias, respostas privadas e formulários |
| `read_messages` | Mensagens, histórico e reações nos canais acessíveis; também necessário para citar outra mensagem |
| `send_messages` | Mensagens, respostas, reações e resultados públicos de comandos |
| `publish_voice` | Publicação de áudio em salas permitidas, sem receber mídia dos participantes |
| `local_execution` | Solicitação de tarefas e preparação de ferramentas no cliente; pode receber mídia produzida pela tarefa autorizada |
| `sound_download` | Solicitação de salvar áudio no Soundboard de quem chamou, sem acesso geral a arquivos |
| `selectors` | Controles públicos persistentes de escolha e suas respostas; publicar também exige `send_messages` |
| `miniapps` | Miniapps compartilhados nas salas de voz, incluindo ações de participantes autorizados |

Registrar comandos exige `commands`; comandos com `downloadsSound` também declaram `sound_download`, e aqueles com `localCapabilities` declaram `local_execution`. Respostas públicas exigem `send_messages`; a resposta privada padrão exige apenas `commands`. As permissões dos cargos, dos canais e de quem iniciou a ação continuam valendo.

**Recepção de voz não está disponível.** Pedidos como `receive_voice` são rejeitados. O servidor recusa consumo SFU por bots e negociações P2P que receberiam microfone, câmera ou compartilhamento; clientes não publicam essas trilhas para bots. Áudio de tarefas locais consentidas é uma rota separada, não escuta dos canais.

**Consentimento no computador é separado.** Permitir `local_execution` ou `sound_download` no servidor não instala ferramentas nem autoriza o dispositivo. A pessoa ainda controla os pedidos locais e pode recusá-los/revogá-los nas configurações de ferramentas locais. Preferências pessoais, idioma do bot e confirmação de nomes de arquivos não viram permissões administrativas.

No pedido de ferramentas, **Sempre permitir e preparar** lembra a autorização deste bot e capacidade neste servidor. Ao reconectar, o Monky verifica as ferramentas em segundo plano, sem reabrir o pedido. **Permitir até desconectar e preparar** continua disponível como escolha temporária; autorizações temporárias antigas não são promovidas automaticamente. As ferramentas ficam na instalação local do Monky e são reutilizadas por outros servidores, mas cada servidor/bot ainda precisa de seu próprio consentimento.

**Edição e migração segura.** As configurações do bot usam a mesma barra lateral e navegação por seções das configurações do app/servidor. Em **Permissões no servidor**, quem tem `MANAGE_BOTS` pode revisar os switches a qualquer momento. Salvar invalida a conexão anterior, encerra voz, tarefas locais, referências de fontes, prévias, interações e miniapps, e fecha seletores persistentes; o SDK pode reconectar. Trabalho assíncrono antigo não recupera acesso se uma permissão for reativada rapidamente.

A migração `026_bot_capability_consent.sql` preserva bots, tokens, identidades e configurações, mas **não inventa aprovação para bots existentes**: todos começam sem concessões e precisam declarar capacidades pelo SDK atualizado e passar pela revisão. Uma declaração alterada conserva somente concessões anteriores ainda solicitadas; capacidades novas permanecem desligadas. A revisão usa uma versão otimista, então mudanças concorrentes exigem recarregar.

**Bot online sem comandos.** Estar conectado não significa ter autorização para executar comandos. Ao digitar `/`, o catálogo diferencia bots desconectados, capacidades ainda não declaradas, revisão pendente e comandos não autorizados. Quem pode gerenciar bots também encontra **Configurar** no aviso, abrindo as configurações daquele bot; revise **Permissões no servidor** sem reinstalar nem conceder acesso automaticamente. Instalar ferramentas no computador não substitui essa aprovação. Se as permissões já estiverem corretas, confira a versão e o registro de comandos do bot.

**Bots não recebem cargos de pessoas.** As capacidades aprovadas controlam suas operações. Para comandos, respostas e entrada em voz privada, o servidor valida o acesso de quem invocou; aprovar `publish_voice` não permite ignorar as restrições dessa pessoa nem entrar em uma sala privada arbitrária. Retirar o acesso do chamador invalida a autorização de voz. Fora de um contexto autorizado, a visibilidade do bot continua limitada a canais públicos.

**Desvincular e vincular novamente.** O servidor informa a revogação ao bot antes de fechar a conexão. O SDK remove somente aquele cadastro, mantendo a identidade e os outros servidores. Se um cadastro antigo já revogado for restaurado, a rejeição explícita da autenticação também libera o novo vínculo; falhas de rede e incompatibilidade de protocolo não apagam cadastros. Uma nova instalação continua exigindo revisão das capacidades, e um vínculo ativo não pode ser substituído por outro token enviado ao manifest.

Na instalação por URL, a prévia dura cinco minutos, pertence à sessão/dispositivo do administrador e só pode ser consumida uma vez. `BOT_INSTALL_PREVIEW { manifestUrl }` retorna `{ previewId, expiresAt, manifest }`; `BOT_INSTALL { previewId, grantedCapabilities }` verifica novamente o conteúdo. Mudança no manifest, na declaração durante o registro ou na autorização de quem instala cancela o fluxo sem deixar um bot aprovado. Vínculos provisórios podem publicar identidade e declaração, não executar ações.

O SDK expõe `bot.getPermissions(serverId)` e o evento `permissionsChanged(permissions, { serverId })`, com `requested`, `granted`, `revision`, `reviewRequired`, `reviewedBy` e `reviewedAt`. São snapshots informativos por servidor, não uma forma de conceder permissões; a autoridade permanece no servidor.
