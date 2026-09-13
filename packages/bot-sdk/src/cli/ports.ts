import { createServer } from 'node:net';

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
  host = getManifestBindHost()
): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy());
    const onError = (error: NodeJS.ErrnoException): void => {
      if (error.code === 'EADDRINUSE') {
        reject(new Error(
          `A porta ${port} j\u00e1 est\u00e1 em uso por um bot ou outro servi\u00e7o. ` +
          `Escolha outra porta. Se for este bot, execute "${cliName} stop" antes de continuar.`
        ));
        return;
      }
      reject(new Error(`N\u00e3o foi poss\u00edvel usar a porta ${port} em ${host}: ${error.message}`));
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
