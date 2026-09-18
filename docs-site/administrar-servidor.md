# Administrar um servidor

Este guia reúne o que é **compartilhado por um servidor**: canais, cargos,
moderação, bots e limites. Microfone, câmera, idioma e preferências pessoais
ficam nas [Configurações do aplicativo](/configuracoes).

## Abrir as configurações

Clique no **nome do servidor → Configurações do Servidor**. Você precisa ser
dono, administrador ou ter as permissões correspondentes. Os controles
disponíveis dependem do seu acesso.

<AppScreenshot src="/screenshots/administrar-servidor-pt.png" alt="Aba Geral das configurações do servidor, com nome, limite de membros e cards de modo de voz P2P e SFU." caption="Estas escolhas afetam o servidor, não apenas o computador de quem abriu a janela." />

| Aba | Para que serve |
| --- | --- |
| Geral | Nome e imagem, limite de membros, modo de voz e informações do processo servidor |
| Segurança | Senha de entrada |
| Recursos de Voz e Vídeo | Permissão de Soundboard e relay TURN integrado |
| Armazenamento | Limites e uso de anexos |
| Notificações | Menções, edição de mensagens e avisos publicados no chat |
| Membros | Consultar membros e administrar acessos conforme suas permissões |
| Cargos | Organizar permissões, hierarquia e membros de cada cargo |
| Bots | Vincular, revisar capacidades e desvincular bots |

### Aplicação imediata

Switches e seleções aplicam imediatamente. Nomes, senhas e limites aplicam
ao terminar a edição, ao sair do campo ou pressionar `Enter`. **Pronto**
apenas fecha a janela; não desfaz o que já foi confirmado.

Enquanto houver uma operação pendente, o fechamento fica bloqueado. Um
download de TURN em 100% ainda precisa da confirmação de inicialização.
Erros indicam o que não foi aplicado e permitem corrigir e tentar novamente.

Criar, instalar, excluir e revogar continuam exigindo as ações explícitas.
Se a conexão ou a sessão mudar, reabra a janela para consultar o estado atual.

### Versão e informações

Em **Geral → Informações do Servidor**, a versão é a do processo que hospeda
o servidor, não a do cliente que você está usando. Clique para copiá-la.
Se estiver indisponível, não presuma que seja igual à do seu aplicativo.

Quando o servidor reinicia para atualizar, os clientes recebem um aviso
específico, inclusive se estiverem visualizando outro servidor. Aguarde e
tente reconectar. Um aviso de atualização não significa que a nova versão
já terminou de iniciar.

## Canais

Use o **+** ao lado de **Canais de Texto** ou **Canais de Voz**. Escolha o tipo,
informe o nome e revise os switches antes de criar.

Para editar ou excluir, abra **Mais opções** no canal. A exclusão é uma ação
destrutiva: confira o nome e o impacto no histórico antes de confirmar.

### Canal privado

Um canal privado fica visível apenas para os cargos escolhidos e para quem
tem acesso de gerenciamento aplicável. Não é uma senha separada do servidor.
Revise os cargos antes de compartilhar conteúdo sensível.

### Comandos de bots no canal

O switch **Permitir comandos de bots** controla comandos, formulários e
botões naquele canal. Desligado, vale inclusive para administradores.
Isso não substitui a [aprovação de capacidades de cada bot](/bots#preferencias-e-permissoes).

## Cargos e permissões

Abra **Cargos → Criar cargo**, dê um nome e escolha a cor. Use as abas do
editor para revisar **Permissões** e **Membros**. Um cargo pode ser atribuído
automaticamente a novos membros quando essa opção estiver habilitada.

<AppScreenshot src="/screenshots/cargos-pt.png" alt="Lista de cargos de um servidor demonstrativo, mostrando os cargos padrão e um cargo de facilitadores." caption="Separe permissões de uso e de administração. Evite conceder Administrador quando um acesso específico basta." />

Arrastar reordena os cargos. A hierarquia limita quem pode gerenciar cargos e
membros; não trate a cor ou a posição visual como prova de uma permissão.
Um membro pode ter mais de um cargo.

Permissões relacionadas a bots são separadas:

- **Executar comandos de bots**: permite usar comandos e interações.
- **Adicionar e gerenciar bots**: permite administrar vínculos e capacidades.
- **Configurar comportamento dos bots**: permite alterar o comportamento compartilhado.

As permissões de membros humanos não são atribuídas aos bots como cargos.
Para eles, use a revisão própria de capacidades.

## Moderação de voz

O menu de botão direito de um membro apresenta as ações que você pode usar.
Expulsar da voz ou mover para outro canal exige uma conexão em chamada.
Restringir microfone/áudio pode ser feito também fora da chamada, com a
permissão correspondente.

Um **bloqueio administrativo** vale para a identidade naquele servidor,
incluindo seus outros dispositivos. Reconectar, trocar de canal ou reiniciar
não remove a restrição: um administrador precisa liberá-la.

O mute pessoal e o bloqueio administrativo são distintos. O primeiro não
desfaz o segundo. Os ícones vermelhos de restrição indicam o bloqueio
administrativo; a pessoa ainda pode manter seu próprio microfone mutado
depois de ser liberada.

## Escolher P2P ou SFU

| Modo | Caminho da mídia | Principal cuidado |
| --- | --- | --- |
| P2P | Cada participante envia diretamente aos demais, ou por TURN quando necessário | Upload dos participantes e conectividade entre as redes |
| SFU | Participantes publicam no servidor, que encaminha aos espectadores | CPU, banda, IP anunciado e portas de mídia do servidor |

O modo pode ser escolhido em **Geral → Modo de Voz e Vídeo**. Mudar o modo
durante uma chamada reconfigura a mídia; avise os participantes e confira
as condições de rede antes.

TURN é um relay para conexões P2P que não conseguem um caminho direto.
SFU centraliza o encaminhamento da chamada. Nenhum deles substitui abrir a
porta de conexão ao servidor, nem torna uma máquina sob CGNAT publicamente
acessível sem uma rota adequada.

Consulte [TURN](/turn) e [Hospedagem em VPS](/hospedar-em-vps) para portas,
limites e preparação. O estimador de capacidade é uma orientação, não uma
garantia de desempenho para qualquer rede ou máquina.

## Operação e continuidade

- Mantenha cliente, servidor e bots com versões de protocolo compatíveis.
- Preserve o banco de dados e a identidade dos bots; não apague registros
  como primeiro passo de diagnóstico.
- Confira backups antes de migrações, exclusões e mudanças de hospedagem.
- Se hospeda pelo aplicativo, fechar/parar esse processo afeta todos os
  participantes. Para operação contínua, veja o [CLI](/cli) e a [VPS](/hospedar-em-vps).

Para gerenciar o acesso de um bot e entender por que ele aparece online sem
comandos, continue em [Usar bots](/bots).
