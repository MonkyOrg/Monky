/**
 * Tiny catalog for the strings the main process owns (#16).
 *
 * Native dialogs are created by Electron's main process, so they can't reach
 * the renderer catalog. The renderer pushes the active language here through
 * the `app-set-language` IPC channel whenever it changes, and these few strings
 * follow along.
 */
export type MainLanguage = 'pt-BR' | 'en';

const CATALOGS = {
  'pt-BR': {
    'dialog.selectProfilePhoto': 'Selecionar Foto de Perfil',
    'dialog.selectSoundFile': 'Selecionar Arquivo de Som',
    'dialog.saveBackup': 'Salvar backup do Monky',
    'dialog.openBackup': 'Abrir backup do Monky',
    'dialog.audioFilter': 'Áudio (WAV, MP3, OGG)',
    'dialog.selectSoundboardFolder': 'Selecionar Pasta de Sons (Soundboard)',
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
    'dialog.selectProfilePhoto': 'Select Profile Picture',
    'dialog.selectSoundFile': 'Select Sound File',
    'dialog.saveBackup': 'Save Monky backup',
    'dialog.openBackup': 'Open Monky backup',
    'dialog.audioFilter': 'Audio (WAV, MP3, OGG)',
    'dialog.selectSoundboardFolder': 'Select Sound Folder (Soundboard)',
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

export function setMainLanguage(language: string | undefined): void {
  if (language === 'en' || language === 'pt-BR') {
    currentLanguage = language;
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
