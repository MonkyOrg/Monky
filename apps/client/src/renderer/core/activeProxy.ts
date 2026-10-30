import { EventBus, type AppEventBus } from './EventBus';
import type { AppEvents } from './appEventMap';

/**
 * Bus that swallows everything emitted into it.
 *
 * Stores belonging to a background server keep updating their data, but their
 * change notifications must not reach the views — otherwise a message arriving
 * on the server you left would repaint the server you are looking at (#400).
 */
export const silentBus: AppEventBus = new EventBus<AppEvents>();

/**
 * Builds an object that always forwards to whichever instance is currently
 * active.
 *
 * The app has ~37 files importing `serverStore`, `chatStore` and friends as
 * singletons. Multi-server support needs one instance per server, so instead of
 * rewriting every call site the singleton becomes a stand-in that resolves the
 * active instance on each access. Methods are bound to the real instance so
 * `this` never leaks back through the proxy.
 */
export function createActiveProxy<T extends object>(getTarget: () => T): T {
  return new Proxy({} as T, {
    get(_ignored, prop) {
      const target = getTarget();
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
    set(_ignored, prop, value) {
      const target = getTarget();
      return Reflect.set(target, prop, value, target);
    },
    has(_ignored, prop) {
      return Reflect.has(getTarget(), prop);
    },
    ownKeys() {
      return Reflect.ownKeys(getTarget());
    },
    getOwnPropertyDescriptor(_ignored, prop) {
      const descriptor = Reflect.getOwnPropertyDescriptor(getTarget(), prop);
      // A proxy may only report a property as non-configurable when the stub
      // target really owns it, which it never does here.
      return descriptor ? { ...descriptor, configurable: true } : undefined;
    },
  });
}
