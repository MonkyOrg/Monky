import fs from 'fs';
import path from 'path';

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
    'error.confirmSoundboardFolder': 'Não foi possível confirmar e salvar a pasta de sons. Escolha uma pasta local com permissão de escrita.',
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
    'error.confirmSoundboardFolder': 'Could not confirm and save the sound folder. Choose a local folder with write permission.',
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
