import type { BotLocale } from '@monky/shared';
import { cliText } from './locale';

export type UpdateProgress =
  | { stage: 'downloading' | 'copying'; receivedBytes: number; totalBytes?: number; complete?: boolean }
  | { stage: 'checking' | 'verifying' | 'installing' | 'restarting' };
export type UpdateProgressHandler = (progress: UpdateProgress) => void;

const STAGES = {
  checking: ['Consultando a origem das atualizações…', 'Checking the update source…'],
  verifying: ['Verificando o pacote e a identidade do bot…', 'Verifying the archive and bot identity…'],
  installing: ['Instalando o pacote verificado com npm (offline)…', 'Installing the verified package with npm (offline)…'],
  restarting: ['Reiniciando pelo CLI recém-instalado…', 'Restarting through the newly installed CLI…'],
} as const;

export function formatUpdateProgress(progress: UpdateProgress, locale: BotLocale): string {
  if (progress.stage !== 'downloading' && progress.stage !== 'copying') {
    const [pt, en] = STAGES[progress.stage];
    return cliText(locale, pt, en);
  }
  const action = progress.stage === 'downloading'
    ? cliText(locale, 'Baixando', 'Downloading') : cliText(locale, 'Copiando', 'Copying');
  const received = `${progress.receivedBytes.toLocaleString(locale)} B`;
  const total = progress.totalBytes;
  if (total === undefined || total <= 0) {
    return `${action}: ${received} — ${cliText(locale, 'tamanho total desconhecido', 'total size unknown')}`;
  }
  const percent = Math.floor(progress.receivedBytes / total * 100);
  return `${action}: ${received} / ${total.toLocaleString(locale)} B (${percent}%)`;
}

export function createUpdateProgressReporter(locale: BotLocale): { report: UpdateProgressHandler; close: () => void } {
  let lineOpen = false;
  let previousStage = '';
  let previousBytes = 0;
  let previousTime = 0;
  const close = (): void => {
    if (lineOpen) process.stdout.write('\n');
    lineOpen = false;
  };
  return {
    report(progress) {
      const transfer = progress.stage === 'downloading' || progress.stage === 'copying';
      const now = Date.now();
      if (transfer && progress.complete && previousStage === progress.stage && previousBytes === progress.receivedBytes) {
        close();
        return;
      }
      if (transfer && previousStage === progress.stage && !progress.complete &&
          now - previousTime < (process.stdout.isTTY ? 100 : 2_000) &&
          progress.receivedBytes - previousBytes < (progress.totalBytes ? progress.totalBytes / 10 : 1024 * 1024)) return;
      const message = formatUpdateProgress(progress, locale);
      if (transfer && process.stdout.isTTY) {
        process.stdout.write(`\r\u001b[2K${message}`);
        lineOpen = true;
        if (progress.complete) close();
      } else {
        close();
        console.log(message);
      }
      previousStage = progress.stage;
      previousBytes = transfer ? progress.receivedBytes : 0;
      previousTime = now;
    },
    close,
  };
}
