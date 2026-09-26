import type { ClientLogger } from './clientLogger';

const disconnected = new Set<'stdout' | 'stderr'>();
const reported = new Set<'stdout' | 'stderr'>();
let logger: Pick<ClientLogger, 'write'> | null = null;

function reportDisconnectedOutputs(): void {
  if (!logger) return;
  for (const output of disconnected) {
    if (reported.has(output)) continue;
    logger.write({
      timestamp: new Date().toISOString(),
      level: 'WARN',
      category: 'APP',
      message: `Console ${output} disconnected (EPIPE). The application continues without that console output.`,
    });
    reported.add(output);
  }
}

// Electron itself logs rejected IPC calls to stderr. Install before other Main
// imports, and retain through shutdown; a missing console is not an app failure.
for (const output of ['stdout', 'stderr'] as const) {
  process[output].on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') throw error;
    disconnected.add(output);
    reportDisconnectedOutputs();
  });
}

export function setMainStdioLogger(value: Pick<ClientLogger, 'write'>): void {
  logger = value;
  reportDisconnectedOutputs();
}
