import type http from 'http';
import { LIMITS } from '@monky/shared';

export function listenHttpServer(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onListening = () => { cleanup(); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    try {
      server.listen(port, host);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export function closeHttpServer(server: http.Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => {
      reject(new Error('HTTP connections did not close before the shutdown deadline'));
    }, LIMITS.SHUTDOWN_GRACE_MS * 3);
    deadline.unref?.();
    const forceClose = setTimeout(() => {
      try {
        server.closeAllConnections();
      } catch (error) {
        clearTimeout(deadline);
        reject(error);
      }
    }, LIMITS.SHUTDOWN_GRACE_MS * 2);
    forceClose.unref?.();
    const closed = (error?: Error) => {
      clearTimeout(forceClose);
      clearTimeout(deadline);
      // A failed bind still has a database/WSS owner to dispose, but no listener.
      if (error && (!('code' in error) || error.code !== 'ERR_SERVER_NOT_RUNNING')) reject(error);
      else resolve();
    };
    try {
      server.close(closed);
    } catch (error) {
      clearTimeout(forceClose);
      clearTimeout(deadline);
      reject(error);
    }
  });
}
