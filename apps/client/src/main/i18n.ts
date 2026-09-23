import fs from 'fs';
import path from 'path';

/**
 * Tiny catalog for the strings the main process owns (#16).
 *
 * Main-owned dialogs are created by Electron's main process, so they can't reach
 * the renderer catalog. The renderer pushes the active language here through
 * the `app-set-language` IPC channel whenever it changes, and these few strings
 * follow along.
 */
export type MainLanguage = 'pt-BR' | 'en';

const CATALOGS = {
  'pt-BR': {
    'crash.title': 'Ops! O Monky encontrou uma falha',
    'crash.description': 'A interface parou de funcionar. Você pode nos ajudar a entender o que aconteceu ou reabrir o aplicativo quando quiser.',
    'crash.privacy': 'Nada é reportado automaticamente. “Reportar bug” copia o diagnóstico abaixo e abre o formulário habitual no GitHub. Cole em “Contexto adicional” e revise antes de publicar.',
    'crash.report': 'Reportar bug',
    'crash.reopen': 'Reabrir Monky',
    'crash.close': 'Fechar Monky',
    'crash.copy': 'Copiar diagnóstico',
    'crash.details': 'Ver diagnóstico técnico',
    'crash.wait': 'Só um instante…',
    'crash.reportOpened': 'Formulário aberto. O diagnóstico foi copiado: cole em “Contexto adicional”. O Monky não publicou nenhum relatório.',
    'crash.reportOpenedNoCopy': 'Formulário aberto, mas não foi possível copiar. Selecione e copie o diagnóstico abaixo para “Contexto adicional”.',
    'crash.reportFailed': 'Não foi possível abrir o navegador. O diagnóstico foi copiado; tente novamente ou abra o formulário em Configurações › Sobre e Updates após reabrir o Monky.',
    'crash.actionFailed': 'Não foi possível concluir a ação. Tente novamente ou selecione e copie o diagnóstico abaixo.',
    'crash.copied': 'Diagnóstico copiado.',
    'crash.restartFailed': 'Não foi possível reabrir o Monky. Feche esta janela e abra o aplicativo pelo atalho.',
    'crash.nativeTitle': 'O Monky precisa de atenção',
    'crash.nativeDescription': 'A tela de recuperação também não pôde abrir. Você ainda pode reportar a falha ou reabrir o Monky.',
    'crash.nativePrivacy': 'Reportar copia este diagnóstico e abre o formulário habitual no GitHub. Cole em “Contexto adicional”, revise e publique somente se quiser.',
    'crash.fieldIncident': 'Incidente',
    'crash.fieldTime': 'Data (UTC)',
    'crash.fieldFailure': 'Falha',
    'crash.fieldCode': 'Código',
    'crash.fieldOs': 'Sistema',
    'crash.fieldUptime': 'Tempo aberto',
    'crash.fieldError': 'Erro',
    'crash.fieldSource': 'Origem',
    'dialog.selectProfilePhoto': 'Selecionar Foto de Perfil',
    'dialog.selectSoundFile': 'Selecionar Arquivo de Som',
    'dialog.saveBackup': 'Salvar backup do Monky',
    'dialog.openBackup': 'Abrir backup do Monky',
    'dialog.audioFilter': 'Áudio (WAV, MP3, OGG)',
    'dialog.selectSoundboardFolder': 'Selecionar Pasta de Sons (Soundboard)',
    'dialog.confirmSoundboardFolderTitle': 'Autorizar downloads na pasta salva',
    'dialog.confirmSoundboardFolderMessage': 'Permitir que o Monky salve áudios nesta pasta?',
    'dialog.confirmSoundboardFolderDetail': 'Pasta já configurada:\n{folder}\n\nEssa autorização é necessária uma única vez para salvar áudios solicitados aos bots. Sua pasta será mantida e nenhum arquivo existente será sobrescrito.',
    'dialog.allowSoundboardDownloads': 'Autorizar',
    'dialog.cancelSoundboardFolder': 'Cancelar',
    'localExecution.permissionTitle': 'Processamento local solicitado por um bot',
    'localExecution.permissionMessage': 'Permitir que {bot} use este computador?',
    'localExecution.permissionDetail':
      'Servidor: {server}\nOrigem: {origin}\nInstalação do bot: {botId}\nFinal da chave pública: {fingerprint}\n\nCapacidade: {capability}\n\nO Monky pode instalar Node.js, yt-dlp e FFmpeg em sua própria pasta de dados, com verificação de integridade. As ferramentas são compartilhadas entre bots e podem ocupar centenas de MB. Seu Node e as configurações do sistema não serão alterados.\n\nNão inclui acesso a contas ou cookies do navegador, nem execução de scripts enviados pelo bot. Você pode revogar a permissão, encerrar tarefas e remover ferramentas nas configurações do Monky.',
    'localExecution.youtubeAudio': 'Usar rede, CPU e memória para pesquisar e processar áudio público do YouTube. O áudio processado pode ser enviado ao bot.',
    'localExecution.deny': 'Não permitir',
    'localExecution.allowConnection': 'Até desconectar deste servidor',
    'localExecution.allowAlways': 'Sempre permitir para este bot',
    'localExecution.cancel': 'Cancelar',
    'localExecution.removeTitle': 'Remover ferramenta local',
    'localExecution.removeMessage': 'Remover {tool} deste dispositivo?',
    'localExecution.removeDetail':
      'Tarefas ativas afetadas: {count}.\n\nAs tarefas que dependem desta ferramenta serão encerradas, e as permissões correspondentes dos bots serão revogadas. A ferramenta não será reinstalada sem nova autorização. Outras ferramentas e arquivos pessoais serão mantidos.',
    'localExecution.remove': 'Remover e revogar permissões',
    'localExecution.clearCacheTitle': 'Limpar cache das ferramentas de bots',
    'localExecution.clearCacheMessage': 'Encerrar tarefas locais e limpar os arquivos temporários?',
    'localExecution.clearCacheDetail':
      'Tarefas ativas afetadas: {count}.\n\nDownloads e processamento em andamento serão interrompidos antes da limpeza. Ferramentas já instaladas e permissões salvas serão mantidas.',
    'localExecution.clearCache': 'Encerrar e limpar cache',
    'localExecution.stateFailed': 'Não foi possível ler o estado das ferramentas e permissões locais. Consulte os logs do cliente.',
    'localExecution.invalidOwner': 'Esta janela não pode acessar o processamento local de bots.',
    'localExecution.shutdownFailedTitle': 'Não foi possível encerrar o processamento local',
    'localExecution.shutdownFailedMessage': 'O Monky permaneceu aberto porque não conseguiu concluir a limpeza de uma tarefa local. Tente encerrar novamente; se o problema persistir, consulte os logs do cliente.',
    'localExecution.retryShutdown': 'Tentar encerrar novamente',
    'localExecution.keepOpen': 'Manter aberto',
    'localExecution.dialogTitle': 'Processamento no seu computador',
    'localExecution.toolsTitle': 'Ferramentas necessárias',
    'localExecution.toolsHint': 'Instalação portátil na pasta do Monky. Ferramentas já instaladas serão reutilizadas.',
    'localExecution.toolNodePurpose': 'Executa as operações autorizadas em um processo separado da interface.',
    'localExecution.toolYtdlpPurpose': 'Pesquisa vídeos públicos do YouTube e obtém seu fluxo de áudio.',
    'localExecution.toolFfmpegPurpose': 'Converte o áudio para o formato usado na chamada e nas prévias.',
    'localExecution.storageMaximum': 'Espaço adicional máximo: {size}',
    'localExecution.storageInstalled': '{size} já instalados · nenhum novo download',
    'localExecution.storageExplanation': 'Limite conservador das receitas, não o tamanho exato do download. Inclui arquivos verificados mantidos pelo Monky; o uso real aparece ao concluir. Cache temporário: até {cache}, removível nas configurações.',
    'localExecution.permissionLimits': 'Só esta capacidade e este bot, sem contas/cookies ou programas enviados pelo bot. Não muda seu Node ou o sistema. Revogável nas configurações.',
    'localExecution.securityDetails': 'Identidade e origem da solicitação',
    'localExecution.origin': 'Origem',
    'localExecution.botInstallation': 'Instalação do bot',
    'localExecution.publicKeySuffix': 'Final da chave pública',
    'localExecution.permissionDuration': 'Por quanto tempo permitir?',
    'localExecution.connectionHint': 'A autorização termina quando este cliente desconectar do servidor.',
    'localExecution.alwaysHint': 'Lembra este bot e esta capacidade neste servidor, inclusive ao reconectar. As ferramentas são verificadas sem abrir esta janela. Revogável nas configurações.',
    'localExecution.allowAndPrepare': 'Permitir e preparar',
    'localExecution.allowAlwaysAndPrepare': 'Sempre permitir e preparar',
    'localExecution.allowConnectionAndPrepare': 'Permitir até desconectar e preparar',
    'localExecution.close': 'Fechar',
    'localExecution.retry': 'Tentar novamente',
    'localExecution.attemptFailed': 'A tentativa {count} não foi concluída',
    'localExecution.maintenanceFailedTitle': 'Não foi possível concluir a ação',
    'localExecution.maintenanceWorking': 'Concluindo a ação…',
    'localExecution.maintenanceWorkingHint': 'Aguarde o encerramento das tarefas e a limpeza dos arquivos. O resultado será mostrado aqui.',
    'localExecution.maintenanceComplete': 'Ação concluída',
    'localExecution.toolFailed': 'Preparação falhou',
    'localExecution.upTo': 'Até {size}',
    'localExecution.toolInstalled': 'Já instalada',
    'localExecution.toolToInstall': 'Será instalada',
    'localExecution.toolSharedPreparation': 'Outro pedido está preparando',
    'localExecution.toolInvalid': 'Precisa de revisão',
    'localExecution.installingTitle': 'Preparando ferramentas',
    'localExecution.installingHint': 'O comando será liberado somente após a instalação e a validação. Você pode cancelar.',
    'localExecution.checkingTools': 'Verificando as ferramentas locais…',
    'localExecution.stageResolving': 'Consultando o download de {tool}…',
    'localExecution.stageDownloading': 'Baixando {tool}…',
    'localExecution.stageVerifying': 'Verificando a integridade de {tool}…',
    'localExecution.stageExtracting': 'Extraindo {tool}…',
    'localExecution.stageChecking': 'Validando {tool}…',
    'localExecution.downloadBytes': '{received} de {total}',
    'localExecution.cancellingTitle': 'Cancelando preparação…',
    'localExecution.cancellingHint': 'Encerrando processos e limpando arquivos incompletos. Aguarde.',
    'localExecution.installFailedTitle': 'Não foi possível preparar as ferramentas',
    'localExecution.installFailedHint': 'A preparação não foi concluída. Tente novamente ou feche esta janela. Os detalhes estão nos logs do cliente.',
    'localExecution.installStorageFailed': 'Não foi possível acessar ou limpar o armazenamento local. Verifique o espaço livre e as permissões da pasta do Monky.',
    'localExecution.installIntegrityFailed': 'Uma ferramenta não passou na verificação de integridade. Remova a ferramenta afetada em Configurações → Ferramentas de bots antes de autorizar novamente.',
    'localExecution.installDownloadFailed': 'Não foi possível obter as ferramentas do provedor. Confira sua conexão e tente novamente.',
    'localExecution.installUnsupported': 'As ferramentas necessárias não estão disponíveis neste sistema ou faltam pré-requisitos de extração.',
    'localExecution.installTimeout': 'A preparação excedeu o tempo limite. Os processos estão sendo encerrados; tente novamente depois.',
    'localExecution.installRevoked': 'A autorização foi revogada. Nenhum comando será liberado por esta preparação.',
    'localExecution.installCompleteTitle': 'Ferramentas prontas',
    'localExecution.installCompleteHint': 'Instalação e validação concluídas. Voltando ao comando…',
    'localExecution.dialogCommunicationFailed': 'Não foi possível atualizar esta janela. Feche-a e tente novamente.',
    'error.confirmSoundboardFolder': 'Não foi possível confirmar e salvar a pasta de sons. Escolha uma pasta local com permissão de escrita.',
    'error.defaultSoundboardFolder': 'Não foi possível preparar a pasta padrão de sons. Escolha outra pasta em Configurações → Soundboard.',
    'error.serverInviteUnavailable': 'Não foi possível ler o convite nesta janela.',
    'dialog.selectStickersFolder': 'Selecionar Pasta de Figurinhas',
    'error.audioFileTooLarge': 'Arquivo de áudio muito grande (máximo 3MB)',
    'error.noPendingUpdate': 'Nenhuma atualização pendente',
    'error.updaterUnavailable': 'Updater indisponível',
    'error.updaterDevMode': 'Atualização automática indisponível em modo de desenvolvimento',
    'error.startServerFailed': 'Falha ao iniciar servidor',
    'error.stopServerFailed': 'Falha ao parar servidor',
    'error.hostedServerAlreadyRunning':
      'Outro servidor já está em execução. Pare-o explicitamente pelos controles de hospedagem quando for seguro e tente novamente.',
    'error.startServerCleanupFailed':
      'Não foi possível iniciar nem encerrar completamente o servidor. Tente pará-lo explicitamente antes de iniciar outro. Início: {startError}. Encerramento: {stopError}.',
    'error.deleteServerDataFailed': 'Não foi possível apagar os dados do servidor',
    'error.deleteServerDataRunning': 'Pare o servidor antes de apagar os dados dele',
    'updateInstall.title': 'Atualizando o Monky',
    'updateInstall.installing': 'Instalando a versão {version}…',
    'updateInstall.installingGeneric': 'Instalando a atualização…',
    'updateInstall.installingHint':
      'Não abra o Monky agora — a instalação pode levar até cerca de um minuto, e ele reabre sozinho ao terminar.',
    'updateInstall.busy': 'A versão {version} está sendo instalada.',
    'updateInstall.busyHint':
      'Esta janela fecha sozinha. O Monky abre automaticamente quando a instalação terminar.',
    'updateInstall.finishing': 'Abrindo o Monky…',
    'updateInstall.finishingHint':
      'A atualização foi concluída. Só um instante enquanto o Monky abre.',
    'screenPermission.title': 'Permissão de gravação de tela',
    'screenPermission.message': 'O macOS está negando a captura de tela para o Monky.',
    'screenPermission.detail':
      'Isso costuma acontecer depois de atualizar o app: a autorização antiga continua marcada em Ajustes do Sistema, mas não vale mais para esta versão.\n\nUse "Reabrir permissão" para limpar a autorização antiga — o Monky vai reiniciar e o macOS vai perguntar de novo.',
    'screenPermission.reset': 'Reabrir permissão',
    'screenPermission.openSettings': 'Abrir Ajustes',
    'screenPermission.cancel': 'Cancelar',
    'screenPermission.resetFailedTitle': 'Não foi possível reabrir a permissão',
    'screenPermission.resetFailedDetail':
      'Feche o Monky por completo e rode no Terminal:\n\ntccutil reset ScreenCapture {bundleId}',
    'tray.tooltipIdle': 'Monky',
    'tray.tooltipDeafened': 'Monky (Áudio Mutado / Ensurdecido)',
    'tray.tooltipMuted': 'Monky (Microfone Mutado)',
    'tray.tooltipSpeaking': 'Monky (Microfone Ativo — Falando)',
    'tray.tooltipInCall': 'Monky (Em Chamada)',
    'tray.open': 'Abrir Monky',
    'tray.muteMic': 'Mutar Microfone',
    'tray.unmuteMic': 'Desmutar Microfone',
    'tray.deafen': 'Mutar Áudio (Ensurdecer)',
    'tray.undeafen': 'Desmutar Áudio (Ouvir)',
    'tray.quit': 'Fechar Monky',
  },
  en: {
    'crash.title': 'Oops! Monky ran into a problem',
    'crash.description': 'The interface stopped working. You can help us understand what happened, or reopen the app whenever you are ready.',
    'crash.privacy': 'Nothing is reported automatically. “Report a bug” copies the diagnostic below and opens the usual GitHub form. Paste into “Contexto adicional” (additional context) and review before publishing.',
    'crash.report': 'Report a bug',
    'crash.reopen': 'Reopen Monky',
    'crash.close': 'Close Monky',
    'crash.copy': 'Copy diagnostic',
    'crash.details': 'View technical diagnostic',
    'crash.wait': 'Just a moment…',
    'crash.reportOpened': 'Form opened. The diagnostic was copied: paste into “Contexto adicional” (additional context). Monky has not published a report.',
    'crash.reportOpenedNoCopy': 'Form opened, but the diagnostic could not be copied. Select and copy it below into “Contexto adicional” (additional context).',
    'crash.reportFailed': 'Could not open the browser. The diagnostic was copied; try again or open the form in Settings › About & Updates after reopening Monky.',
    'crash.actionFailed': 'Could not complete this action. Try again, or select and copy the diagnostic below.',
    'crash.copied': 'Diagnostic copied.',
    'crash.restartFailed': 'Could not reopen Monky. Close this window and open the app using its shortcut.',
    'crash.nativeTitle': 'Monky needs attention',
    'crash.nativeDescription': 'The recovery screen could not open either. You can still report the failure or reopen Monky.',
    'crash.nativePrivacy': 'Report copies this diagnostic and opens the usual GitHub form. Paste into “Contexto adicional” (additional context), review, and publish only if you want to.',
    'crash.fieldIncident': 'Incident',
    'crash.fieldTime': 'Time (UTC)',
    'crash.fieldFailure': 'Failure',
    'crash.fieldCode': 'Code',
    'crash.fieldOs': 'OS',
    'crash.fieldUptime': 'Uptime',
    'crash.fieldError': 'Error',
    'crash.fieldSource': 'Source',
    'dialog.selectProfilePhoto': 'Select Profile Picture',
    'dialog.selectSoundFile': 'Select Sound File',
    'dialog.saveBackup': 'Save Monky backup',
    'dialog.openBackup': 'Open Monky backup',
    'dialog.audioFilter': 'Audio (WAV, MP3, OGG)',
    'dialog.selectSoundboardFolder': 'Select Sound Folder (Soundboard)',
    'dialog.confirmSoundboardFolderTitle': 'Allow downloads to the saved folder',
    'dialog.confirmSoundboardFolderMessage': 'Allow Monky to save audio files to this folder?',
    'dialog.confirmSoundboardFolderDetail': 'Already configured folder:\n{folder}\n\nThis one-time permission allows saving audio requested from bots. Your folder will be kept and existing files will never be overwritten.',
    'dialog.allowSoundboardDownloads': 'Allow',
    'dialog.cancelSoundboardFolder': 'Cancel',
    'localExecution.permissionTitle': 'A bot requested local processing',
    'localExecution.permissionMessage': 'Allow {bot} to use this computer?',
    'localExecution.permissionDetail':
      'Server: {server}\nOrigin: {origin}\nBot installation: {botId}\nPublic key suffix: {fingerprint}\n\nCapability: {capability}\n\nMonky may install integrity-verified Node.js, yt-dlp and FFmpeg in its own data directory. Tools are shared between bots and may use hundreds of MB. Your Node installation and system settings will not be changed.\n\nThis does not include browser accounts or cookies, or running scripts sent by the bot. You can revoke permission, stop tasks and remove tools in Monky settings.',
    'localExecution.youtubeAudio': 'Use network, CPU and memory to search for and process public YouTube audio. Processed audio may be sent to the bot.',
    'localExecution.deny': 'Do not allow',
    'localExecution.allowConnection': 'Until disconnecting from this server',
    'localExecution.allowAlways': 'Always allow for this bot',
    'localExecution.cancel': 'Cancel',
    'localExecution.removeTitle': 'Remove local tool',
    'localExecution.removeMessage': 'Remove {tool} from this device?',
    'localExecution.removeDetail':
      'Affected active tasks: {count}.\n\nTasks that depend on this tool will stop and the corresponding bot permissions will be revoked. The tool will not be reinstalled without new approval. Other tools and personal files will be kept.',
    'localExecution.remove': 'Remove and revoke permissions',
    'localExecution.clearCacheTitle': 'Clear bot tools cache',
    'localExecution.clearCacheMessage': 'Stop local tasks and clear temporary files?',
    'localExecution.clearCacheDetail':
      'Affected active tasks: {count}.\n\nActive downloads and processing will stop before cleanup. Installed tools and saved permissions will be kept.',
    'localExecution.clearCache': 'Stop and clear cache',
    'localExecution.stateFailed': 'Could not read local tools and permissions. See the client logs.',
    'localExecution.invalidOwner': 'This window cannot access local bot processing.',
    'localExecution.shutdownFailedTitle': 'Could not finish local processing shutdown',
    'localExecution.shutdownFailedMessage': 'Monky stayed open because cleanup of a local task did not finish. Try closing again; if the problem persists, see the client logs.',
    'localExecution.retryShutdown': 'Try closing again',
    'localExecution.keepOpen': 'Keep open',
    'localExecution.dialogTitle': 'Processing on your computer',
    'localExecution.toolsTitle': 'Required tools',
    'localExecution.toolsHint': 'Portable installation in Monky’s folder. Already installed tools will be reused.',
    'localExecution.toolNodePurpose': 'Runs authorized operations in a process separate from the interface.',
    'localExecution.toolYtdlpPurpose': 'Searches public YouTube videos and obtains their audio streams.',
    'localExecution.toolFfmpegPurpose': 'Converts audio to the format used by voice calls and previews.',
    'localExecution.storageMaximum': 'Maximum additional storage: {size}',
    'localExecution.storageInstalled': '{size} already installed · no new download',
    'localExecution.storageExplanation': 'Conservative recipe limit, not the exact download size. Includes verified files retained by Monky; actual usage appears on completion. Temporary cache: up to {cache}, removable in settings.',
    'localExecution.permissionLimits': 'Only this capability and this bot, without browser accounts/cookies or bot-supplied programs. Your Node installation and system are unchanged. Revocable in settings.',
    'localExecution.securityDetails': 'Request identity and origin',
    'localExecution.origin': 'Origin',
    'localExecution.botInstallation': 'Bot installation',
    'localExecution.publicKeySuffix': 'Public key suffix',
    'localExecution.permissionDuration': 'How long should access last?',
    'localExecution.connectionHint': 'Authorization ends when this client disconnects from the server.',
    'localExecution.alwaysHint': 'Remembers this bot and capability on this server across reconnects. Tools are checked without opening this window. Revocable in settings.',
    'localExecution.allowAndPrepare': 'Allow and prepare',
    'localExecution.allowAlwaysAndPrepare': 'Always allow and prepare',
    'localExecution.allowConnectionAndPrepare': 'Allow until disconnect and prepare',
    'localExecution.close': 'Close',
    'localExecution.retry': 'Try again',
    'localExecution.attemptFailed': 'Attempt {count} did not complete',
    'localExecution.maintenanceFailedTitle': 'Could not complete the action',
    'localExecution.maintenanceWorking': 'Completing the action…',
    'localExecution.maintenanceWorkingHint': 'Wait for tasks to stop and files to be cleaned up. The result will appear here.',
    'localExecution.maintenanceComplete': 'Action completed',
    'localExecution.toolFailed': 'Preparation failed',
    'localExecution.upTo': 'Up to {size}',
    'localExecution.toolInstalled': 'Already installed',
    'localExecution.toolToInstall': 'Will be installed',
    'localExecution.toolSharedPreparation': 'Another request is preparing',
    'localExecution.toolInvalid': 'Needs attention',
    'localExecution.installingTitle': 'Preparing tools',
    'localExecution.installingHint': 'The command is available only after installation and validation finish. You can cancel.',
    'localExecution.checkingTools': 'Checking local tools…',
    'localExecution.stageResolving': 'Looking up the {tool} download…',
    'localExecution.stageDownloading': 'Downloading {tool}…',
    'localExecution.stageVerifying': 'Verifying {tool} integrity…',
    'localExecution.stageExtracting': 'Extracting {tool}…',
    'localExecution.stageChecking': 'Validating {tool}…',
    'localExecution.downloadBytes': '{received} of {total}',
    'localExecution.cancellingTitle': 'Cancelling preparation…',
    'localExecution.cancellingHint': 'Stopping processes and cleaning incomplete files. Please wait.',
    'localExecution.installFailedTitle': 'Could not prepare the tools',
    'localExecution.installFailedHint': 'Preparation did not finish. Try again or close this window. Details are in the client logs.',
    'localExecution.installStorageFailed': 'Could not access or clean local storage. Check free space and access to Monky’s folder.',
    'localExecution.installIntegrityFailed': 'A tool failed integrity verification. Remove the affected tool in Settings → Bot tools before authorizing again.',
    'localExecution.installDownloadFailed': 'Could not obtain tools from the provider. Check your connection and try again.',
    'localExecution.installUnsupported': 'The required tools are unavailable on this system, or extraction prerequisites are missing.',
    'localExecution.installTimeout': 'Tool preparation timed out. Processes are being stopped; try again later.',
    'localExecution.installRevoked': 'Authorization was revoked. This preparation will not unlock any command.',
    'localExecution.installCompleteTitle': 'Tools are ready',
    'localExecution.installCompleteHint': 'Installation and validation finished. Returning to your command…',
    'localExecution.dialogCommunicationFailed': 'Could not update this window. Close it and try again.',
    'error.confirmSoundboardFolder': 'Could not confirm and save the sound folder. Choose a local folder with write permission.',
    'error.defaultSoundboardFolder': 'Could not prepare the default sound folder. Choose another folder under Settings → Soundboard.',
    'error.serverInviteUnavailable': 'Could not read the invitation in this window.',
    'dialog.selectStickersFolder': 'Select Stickers Folder',
    'error.audioFileTooLarge': 'Audio file is too large (3MB maximum)',
    'error.noPendingUpdate': 'No pending update',
    'error.updaterUnavailable': 'Updater unavailable',
    'error.updaterDevMode': 'Automatic updates are unavailable in development mode',
    'error.startServerFailed': 'Failed to start the server',
    'error.stopServerFailed': 'Failed to stop the server',
    'error.hostedServerAlreadyRunning':
      'Another server is already running. Stop it explicitly using the hosting controls when it is safe, then try again.',
    'error.startServerCleanupFailed':
      'The server could not start or shut down completely. Try stopping it explicitly before starting another. Start: {startError}. Shutdown: {stopError}.',
    'error.deleteServerDataFailed': 'Could not delete the server data',
    'error.deleteServerDataRunning': 'Stop the server before deleting its data',
    'updateInstall.title': 'Updating Monky',
    'updateInstall.installing': 'Installing version {version}…',
    'updateInstall.installingGeneric': 'Installing the update…',
    'updateInstall.installingHint':
      "Don't open Monky right now — the install can take up to about a minute, and it reopens on its own when it's done.",
    'updateInstall.busy': 'Version {version} is being installed.',
    'updateInstall.busyHint':
      'This window closes on its own. Monky opens automatically when the install finishes.',
    'updateInstall.finishing': 'Opening Monky…',
    'updateInstall.finishingHint':
      'The update is done. Just a moment while Monky opens.',
    'screenPermission.title': 'Screen recording permission',
    'screenPermission.message': 'macOS is denying screen capture for Monky.',
    'screenPermission.detail':
      'This usually happens after an update: the old authorization is still checked in System Settings, but it no longer applies to this version.\n\nUse "Re-request permission" to clear the stale authorization — Monky will restart and macOS will ask again.',
    'screenPermission.reset': 'Re-request permission',
    'screenPermission.openSettings': 'Open Settings',
    'screenPermission.cancel': 'Cancel',
    'screenPermission.resetFailedTitle': 'Could not re-request the permission',
    'screenPermission.resetFailedDetail':
      'Quit Monky completely and run in Terminal:\n\ntccutil reset ScreenCapture {bundleId}',
    'tray.tooltipIdle': 'Monky',
    'tray.tooltipDeafened': 'Monky (Audio Muted / Deafened)',
    'tray.tooltipMuted': 'Monky (Microphone Muted)',
    'tray.tooltipSpeaking': 'Monky (Microphone Active — Speaking)',
    'tray.tooltipInCall': 'Monky (In Call)',
    'tray.open': 'Open Monky',
    'tray.muteMic': 'Mute Microphone',
    'tray.unmuteMic': 'Unmute Microphone',
    'tray.deafen': 'Mute Audio (Deafen)',
    'tray.undeafen': 'Unmute Audio (Listen)',
    'tray.quit': 'Quit Monky',
  },
} as const;

export type MainTranslationKey = keyof (typeof CATALOGS)['pt-BR'];

let currentLanguage: MainLanguage = 'pt-BR';
let languageFile: string | null = null;

/** A tiny cache survives a renderer failing before its localStorage is readable. */
export function initializeMainLanguage(userData: string, systemLanguages: readonly string[]): void {
  languageFile = path.join(userData, 'main-language.json');
  currentLanguage = 'pt-BR';
  for (const candidate of systemLanguages) {
    const prefix = candidate.toLowerCase().split('-')[0];
    if (prefix !== 'pt' && prefix !== 'en') continue;
    currentLanguage = prefix === 'en' ? 'en' : 'pt-BR';
    break;
  }
  try {
    if (fs.statSync(languageFile).size > 100) {
      console.warn('[Main i18n] Saved language is oversized; using the system language');
      return;
    }
    const language: unknown = JSON.parse(fs.readFileSync(languageFile, 'utf8'));
    if (language === 'en' || language === 'pt-BR') currentLanguage = language;
    else console.warn('[Main i18n] Invalid saved language; using the system language');
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    console.warn('[Main i18n] Could not read the saved language; using the system language', error);
  }
}

export function setMainLanguage(language: string | undefined): void {
  if (language === 'en' || language === 'pt-BR') {
    currentLanguage = language;
    if (languageFile) {
      try {
        fs.writeFileSync(languageFile, JSON.stringify(language), 'utf8');
      } catch (error: unknown) {
        console.warn('[Main i18n] Could not persist the selected language', error);
      }
    }
  }
}

export function getMainLanguage(): MainLanguage {
  return currentLanguage;
}

export function mt(key: MainTranslationKey, params?: Record<string, string>): string {
  const template = CATALOGS[currentLanguage][key] ?? CATALOGS['pt-BR'][key] ?? key;
  if (!params) return template;
  return Object.entries(params).reduce(
    (text, [name, value]) => text.split(`{${name}}`).join(value),
    template as string
  );
}
