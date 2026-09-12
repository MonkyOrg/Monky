# Criar Seu Servidor

Na aba **Meus Servidores › Criar Servidor**, preencha nickname do anfitrião, nome do servidor, porta local, senha opcional, os canais iniciais de texto e voz e, se quiser, um limite de membros.

Clique em **Criar e Iniciar Servidor**. O servidor sobe na sua máquina, escuta em todas as interfaces de rede na porta escolhida e abre para visualização. Entrar em um canal de voz é uma ação separada.

Servidores criados ficam salvos (até 10). Depois, use **Iniciar**, **Parar** ou **X** na aba *Meus Servidores*.

Iniciar um servidor offline pela Home ou pela barra lateral preserva a chamada
atual, inclusive câmera, compartilhamentos e mute. Se outro servidor já estiver
hospedado nesta instância, ele não será substituído: pare-o explicitamente
quando for seguro antes de iniciar um diferente.

## Convidar amigos

Dentro do servidor, clique no **nome do servidor** › **Convidar Amigos**. O app mostra nome, IP público e porta, e copia o convite.

| Situação | IP que seus amigos devem usar |
|---|---|
| Mesma rede local | Seu IP local, ou a descoberta automática do app |
| Outra internet | Seu IP público + porta liberada no roteador |
| Sem mexer no roteador | IP da VPN, como Radmin VPN, Hamachi, ZeroTier ou Tailscale |

## Modos de Voz e Mídia (P2P Mesh vs SFU)

Ao criar ou administrar o servidor, você escolhe o modo de voz e vídeo:
- **P2P Mesh (Padrão):** O áudio e vídeo trafegam diretamente entre os participantes. O servidor apenas faz a sinalização, sem consumir CPU de transcodificação ou banda de mídia.
- **SFU Centralizado (mediasoup):** O fluxo de cada membro é enviado uma única vez ao servidor, que repassa aos demais participantes. Economiza CPU e upload de quem transmite telas em 1080p60. O app e o CLI incluem um **Estimador de Capacidade** para calcular o hardware e banda necessários.

## Liberar acesso pela internet

- **Porta TCP principal:** Libere a porta `3000` (ou a escolhida) no firewall e configure o port forwarding no roteador.
- **Portas para o SFU (mediasoup):** Se usar o modo SFU, libere também o range `40000-49151` — em UDP e em TCP — no roteador/firewall. Numa VPS, veja [Abrindo as portas do Modo SFU](/hospedar-em-vps#abrindo-as-portas-do-modo-sfu).
- **Sem mexer no roteador:** É possível usar uma VPN como Radmin VPN, Hamachi, ZeroTier ou Tailscale.

## Administrar

Em **Configurações do Servidor** é possível renomear o servidor, alterar/remover senha, alternar o modo de voz (P2P / SFU), definir ou remover o limite de membros e permitir ou bloquear o soundboard. Os cabeçalhos de canais têm **+** para criar e lixeira para apagar.

As edições aplicam imediatamente, e campos de texto aplicam ao terminar a
edição. **Pronto** fecha a janela; não há uma etapa final de salvar. Enquanto
uma operação aguarda confirmação do servidor, o fechamento fica bloqueado.
Falhas são mostradas e permitem correção e nova tentativa.

O limite conta **membros cadastrados**, não quem está online: uma pessoa ocupa a vaga a partir da primeira entrada, mesmo desconectada. Para liberar a vaga, expulse o membro. Com o limite desligado, o servidor aceita quantas pessoas quiserem entrar.

## Monitor do Servidor

Enquanto o servidor está rodando na sua máquina, o app mostra o que está acontecendo dentro dele. Abra pelo ícone de **monitoramento** ao lado do botão *Parar*, na aba *Meus Servidores*, ou pelo **nome do servidor › Monitor do Servidor** quando já estiver conectado.

O painel traz:

- **Métricas ao vivo**, atualizadas a cada 3 segundos: tempo ativo, pessoas conectadas, membros registrados (e o limite, quando houver), canais e mensagens.
- **Logs em tempo real**, com filtro por nível (`INFO`, `WARN`, `ERROR`), busca por texto, rolagem automática, botão para copiar o que está visível e botão para limpar.

O app guarda os registros mais recentes em memória — ao reiniciar o servidor, a lista recomeça. Para servidores rodando numa VPS, use [`monky logs`](/hospedar-em-vps).
