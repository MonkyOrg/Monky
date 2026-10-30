import { appEvents } from './EventBus';
import { sessionManager, type ServerSession } from './SessionManager';
import { currentEventOrigin } from './sessionRouting';

/** Whether `session` is still the server on screen. */
export function isVisibleSession(session: ServerSession): boolean {
  return sessionManager.getActive() === session && sessionManager.get(session.key) === session;
}

/**
 * Keeps a view of `session`'s data honest while it is open (#490): `revalidate`
 * runs whenever that server's access or connection may have changed, and `gone`
 * once it is no longer the server on screen. Returns what stops listening.
 */
export function watchVisibleSession(session: ServerSession, revalidate: () => void, gone: () => void): () => void {
  const check = () => {
    const origin = currentEventOrigin();
    if (origin === null || origin === session.key) revalidate();
  };
  const unbind = [
    appEvents.on('server.updated', check),
    appEvents.on('server.roles_updated', check),
    appEvents.on('network.status', check),
    appEvents.on('session.changed', () => { if (!isVisibleSession(session)) gone(); }),
  ];
  return () => { for (const off of unbind) off(); };
}
