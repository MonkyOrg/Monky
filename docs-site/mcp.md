# Integração com IA por MCP

O Monky Desktop pode disponibilizar ferramentas para assistentes compatíveis com MCP, como o Codex CLI. O assistente controla sua identidade nas sessões já conectadas. O Monky precisa continuar em execução, inclusive minimizado.

## Conectar um assistente

1. Abra **Configurações → Integração com IA** no aplicativo desktop.
2. Ative **Habilitar integração**. O Monky mostrará a URL local.
3. Selecione **Adicionar assistente**, informe um nome e escolha os servidores e as ações permitidas. Para autorizar um servidor novo, conecte-se a ele primeiro.
4. Salve e copie os comandos da tela **Conectar ao Codex CLI**. A credencial aparece somente nessa tela.
5. Execute os comandos no terminal em que abrirá o Codex CLI. Depois inicie uma nova sessão do Codex e consulte `/mcp` para verificar a conexão.

Os comandos definem uma variável de ambiente e executam `codex mcp add` com `--url` e `--bearer-token-env-var`. A variável vale para o terminal atual; em outro terminal, defina-a novamente usando a credencial que guardou ou gere uma nova. O cliente do assistente pode ter suas próprias confirmações de ferramentas.

O transporte é **Streamable HTTP**, autenticado por bearer token. O endpoint escuta apenas em `127.0.0.1`; programas executados inteiramente na nuvem não conseguem acessá-lo diretamente. Um programa local pode usar um modelo na nuvem: informações retornadas pelas ferramentas podem ser enviadas ao provedor desse modelo.

## Ferramentas disponíveis

| Permissão | Ferramentas |
| --- | --- |
| Consultar informações e histórico | `get_state`, `list_servers`, `list_channels`, `list_members`, `read_messages`, `list_events`, `get_call_state` |
| Enviar mensagens | `send_message` |
| Criar eventos | `create_event` |
| Entrar e sair de chamadas | `join_call`, `leave_call` |

`list_servers` retorna a referência `sessionRef` de cada conexão autorizada. Use-a nas operações seguintes; depois de reconectar, consulte a lista novamente. As operações não mudam o servidor ou o canal visível na interface. A leitura de histórico não marca mensagens como lidas.

Mensagens são de texto em canais, sem anexos ou comandos de bots. `send_message` exige um UUID em `clientMessageId`; reutilize o mesmo UUID ao repetir a mesma tentativa. O servidor precisa anunciar `chat-delivery`, que evita entregar a mesma tentativa duas vezes.

Eventos são únicos, sem imagens ou recorrência, com audiência padrão do aplicativo. Informe início e término em milissegundos desde Unix epoch, um fuso IANA, como `America/Sao_Paulo`, e a localização. A listagem inclui eventos agendados e ativos. O servidor precisa oferecer `server-community` e seu usuário precisa ter permissão para criar eventos.

Uma nova entrada em chamada começa mutada e sem capturar o microfone. Você pode desmutar manualmente pelo aplicativo. O assistente não recebe áudio. Outra chamada ativa deve ser encerrada explicitamente antes de uma nova entrada. `leave_call` só encerra a sessão e a sala indicadas e confirma a liberação local, inclusive durante uma reconexão, sem esperar uma confirmação remota de saída.

Se uma escrita retornar `unknown_outcome`, confira o destino antes de repetir: perder a resposta não significa que a ação deixou de acontecer. Criações de eventos não são repetidas automaticamente.

## Gerenciar acesso

Na mesma aba, **Editar** altera os servidores e as capacidades. **Gerar nova credencial** invalida o token anterior; **Revogar acesso** impede novas chamadas e cancela operações pendentes. Ações que já chegaram ao servidor não são desfeitas. As permissões do servidor continuam valendo.

Depois de alterar permissões, reconecte o assistente para atualizar seu catálogo de ferramentas.

**Atividade recente** mantém as últimas 100 operações, com assistente, ação, horário e resultado. Conteúdo de mensagens e credenciais não entram nesse registro. Tokens são armazenados apenas como hashes no perfil do aplicativo.

A URL permanece a mesma entre reinicializações. Se a porta estiver ocupada, use **Gerar outra URL** e atualize a configuração do assistente. Monky Dev e instalações normais têm perfis, credenciais e portas separados.

## Validação em desenvolvimento

```powershell
npm run build
npm run test:mcp --workspace=apps/client
npm run start --workspace=apps/client
```

`test:mcp` verifica contratos, autenticação, cancelamento, configurações PT/EN e um servidor descartável da mesma branch com dois participantes em P2P e SFU. Não usa microfone físico nem perfis da instalação. Para validação manual, crie um servidor descartável no Monky Dev e siga a configuração do assistente acima; valide mensagens, eventos e chamadas antes de continuar a publicação.
