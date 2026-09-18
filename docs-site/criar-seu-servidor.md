# Criar Seu Servidor

Na aba **Meus Servidores › Criar Servidor**, preencha nickname do anfitrião, nome do servidor, porta local, senha opcional, os canais iniciais de texto e voz e, se quiser, um limite de membros.

<AppScreenshot src="/screenshots/criar-servidor-pt.png" :width="1000" :height="1640" alt="Formulário de criação de servidor com nome, porta, canais iniciais, limite de membros e modo de voz." caption="O aplicativo hospeda na sua máquina. A disponibilidade pela internet depende também da rede e do firewall." />

Clique em **Criar e Iniciar Servidor**. O servidor sobe na sua máquina, escuta em todas as interfaces de rede na porta escolhida e abre para visualização. Entrar em um canal de voz é uma ação separada.

Servidores criados ficam salvos (até 10). Depois, use **Iniciar**, **Parar** ou **X** na aba *Meus Servidores*.

Iniciar um servidor offline pela Home ou pela barra lateral preserva a chamada
atual, inclusive câmera, compartilhamentos e mute. Se outro servidor já estiver
hospedado nesta instância, ele não será substituído: pare-o explicitamente
quando for seguro antes de iniciar um diferente.

Isso não muda a ação de **voltar à Home pela casinha**: ela pede confirmação
para desconectar dos servidores e encerrar a chamada. Para apenas iniciar
outro servidor salvo sem sair da chamada, use sua entrada na barra lateral.

## Convidar amigos

Dentro do servidor, clique no **nome do servidor** › **Convidar Amigos**. O app mostra nome, IP público e porta, e copia o convite.

| Situação | IP que seus amigos devem usar |
|---|---|
| Mesma rede local | Seu IP local, ou a descoberta automática do app |
| Outra internet | Seu IP público + porta liberada no roteador |
| Sem mexer no roteador | IP da VPN, como Radmin VPN, Hamachi, ZeroTier ou Tailscale |

## Modos de Voz e Mídia (P2P Mesh vs SFU)

Ao criar ou administrar o servidor, você escolhe o modo de voz e vídeo:
- **P2P Mesh (Padrão):** O áudio e vídeo tentam um caminho direto entre participantes. Sem relay, o servidor não encaminha essa mídia; se TURN for necessário, o relay usa banda para repassá-la.
- **SFU Centralizado (mediasoup):** O fluxo de cada membro é enviado uma única vez ao servidor, que repassa aos demais participantes. Economiza CPU e upload de quem transmite telas em 1080p60. O app e o CLI incluem um **Estimador de Capacidade** para calcular o hardware e banda necessários.

## Liberar acesso pela internet

- **Porta TCP principal:** Libere a porta `3000` (ou a escolhida) no firewall e configure o port forwarding no roteador.
- **Portas para o SFU (mediasoup):** Se usar o modo SFU, libere também o range `40000-49151` — em UDP e em TCP — no roteador/firewall. Numa VPS, veja [Abrindo as portas do Modo SFU](/hospedar-em-vps#abrindo-as-portas-do-modo-sfu).
- **Sem mexer no roteador:** É possível usar uma VPN como Radmin VPN, Hamachi, ZeroTier ou Tailscale.

## Administrar

Em **Configurações do Servidor** é possível renomear o servidor, alterar/remover
senha, alternar P2P/SFU e ajustar limites e Soundboard. Use **+** para criar
canais e **Mais opções** no canal para editar ou excluir.
O [guia de administração](/administrar-servidor) detalha cargos, canais privados
e moderação.

As edições aplicam imediatamente, e campos de texto aplicam ao terminar a
edição. **Pronto** fecha a janela; não há uma etapa final de salvar. Enquanto
uma operação aguarda confirmação do servidor, o fechamento fica bloqueado.
Falhas são mostradas e permitem correção e nova tentativa.

O limite conta **membros cadastrados**, não quem está online: uma pessoa ocupa a vaga a partir da primeira entrada, mesmo desconectada. Para liberar a vaga, expulse o membro. Com o limite desligado, o servidor aceita quantas pessoas quiserem entrar.

## Monitor do Servidor

Abra **nome do servidor › Monitor do Servidor** para consultar o servidor
conectado, inclusive quando ele roda em uma VPS. Administradores têm acesso;
outros membros precisam da permissão **Visualizar monitor do servidor** em um
cargo. **Gerenciar servidor**, sozinho, não concede esse acesso. O servidor
confere a autorização em cada solicitação; não é necessário hospedar nada
na máquina do cliente.

Para o servidor hospedado no próprio dispositivo, o ícone de **monitoramento**
ao lado de *Parar*, na aba *Meus Servidores*, continua abrindo o monitor
explicitamente local, separado do servidor remoto em foco.

O painel traz:

- **Métricas ao vivo**, atualizadas a cada 3 segundos: tempo ativo, pessoas conectadas, membros registrados (e o limite, quando houver), canais e mensagens.
- **Logs recentes**, com filtro por nível (`INFO`, `WARN`, `ERROR`), busca por texto, rolagem automática e cópia dos registros visíveis. **Limpar visualização** limpa apenas esta janela, sem apagar o histórico do servidor.

O histórico em memória é limitado. Os logs remotos apresentam resumos
operacionais protegidos, sem credenciais, dados privados ou detalhes do sistema;
os detalhes completos ficam com quem hospeda o servidor, inclusive por
[`monky logs`](/hospedar-em-vps). Trocar de servidor fecha o monitor remoto.
Desconexão ou perda da permissão interrompe as consultas e remove os dados
retidos na janela, sem desconectar você do Monky.
