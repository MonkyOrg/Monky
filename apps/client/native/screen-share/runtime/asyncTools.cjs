'use strict';

/**
 * Settles like `promise`, or rejects once `milliseconds` pass: with `new Error(timeout)`, or with the
 * error a `timeout` function returns at that moment. `timers` replaces the global clock in tests.
 */
function within(promise, milliseconds, timeout, { timers = globalThis } = {}) {
  // A swapped (promise, message, ms) call would otherwise time out immediately.
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    const label = typeof timeout === 'function' ? 'custom timeout' : timeout;
    return Promise.reject(new TypeError(`Invalid deadline for "${label}": ${String(milliseconds)}.`));
  }
  return new Promise((resolve, reject) => {
    const timer = timers.setTimeout(() => {
      try { reject(typeof timeout === 'function' ? timeout() : new Error(timeout)); }
      catch (error) { reject(error); }
    }, milliseconds);
    Promise.resolve(promise).then(value => { timers.clearTimeout(timer); resolve(value); },
      error => { timers.clearTimeout(timer); reject(error); });
  });
}

/**
 * Calls an observer whose failure must not escape into the caller: a synchronous
 * throw or a rejected returned Promise is only logged as "<label> failed".
 */
function notifyObserver(label, observer, ...args) {
  const failed = error => console.error(`${label} failed:`, error);
  try {
    const result = observer(...args);
    if (typeof result?.then === 'function') void Promise.resolve(result).catch(failed);
  } catch (error) { failed(error); }
}

module.exports = { within, notifyObserver };
