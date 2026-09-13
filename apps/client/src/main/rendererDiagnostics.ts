import type { WebContents } from 'electron';
import type { ClientLogger } from './clientLogger';

export function bindRendererDiagnostics(contents: WebContents, logger: Pick<ClientLogger, 'write'>): void {
  const webContentsId = contents.id;
  contents.on('render-process-gone', (_event, details) => {
    const data = { webContentsId, reason: details.reason, exitCode: details.exitCode };
    logger.write({
      timestamp: new Date().toISOString(),
      level: details.reason === 'clean-exit' ? 'INFO' : 'ERROR',
      category: 'APP',
      message: 'Renderer process terminated',
      data,
    });
    if (details.reason !== 'clean-exit') console.error('[Renderer lifecycle]', data);
  });
}
