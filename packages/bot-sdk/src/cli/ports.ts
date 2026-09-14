import { createServer } from 'node:net';
import type { BotLocale } from '@monky/shared';
import { cliText } from './locale';

export function getManifestBindHost(previousEnv?: {
  MONKY_SERVE_HOST?: unknown;
  env?: Record<string, unknown>;
}): string {
  const host = process.env.MONKY_SERVE_HOST ?? previousEnv?.MONKY_SERVE_HOST ??
    previousEnv?.env?.MONKY_SERVE_HOST ?? '0.0.0.0';
  if (typeof host !== 'string') throw new Error('MONKY_SERVE_HOST must contain a hostname or IP.');
  return host || '0.0.0.0';
}

export function assertManifestPortAvailable(
  port: number,
  cliName: string,
  host = getManifestBindHost(),
  locale: BotLocale = 'pt-BR',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(cliText(locale,
          `A porta ${port} j\u00e1 est\u00e1 em uso por um bot ou outro servi\u00e7o. ` +
          `Escolha outra porta. Se for este bot, execute "${cliName} stop" antes de continuar.`,
          `Port ${port} is already in use by a bot or another service. ` +
          `Choose another port. If it is this bot, run "${cliName} stop" before continuing.`
        )));
        return;
      }
      const code = error.code && /^[A-Z0-9_]{1,40}$/.test(error.code) ? ` (${error.code})` : '';
      reject(new Error(cliText(locale, `Não foi possível usar a porta ${port}. Verifique o host e as permissões.`,
        `Could not use port ${port}. Check the host and permissions.`) + code));
    };
    server.once('error', onError);
    server.listen({ port, host, exclusive: true }, () => {
      server.close((error) => {
        server.off('error', onError);
        if (error) reject(error);
        else resolve();
      });
    });
  });
}
