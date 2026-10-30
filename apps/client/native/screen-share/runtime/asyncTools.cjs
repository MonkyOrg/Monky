'use strict';

/** Settles like `promise`, or rejects with `message` once `milliseconds` pass. */
async function within(promise, milliseconds, message) {
  // A swapped (promise, message, ms) call would otherwise time out immediately.
  if (!Number.isFinite(milliseconds) || milliseconds < 0) {
    throw new TypeError(`Invalid deadline for "${message}": ${String(milliseconds)}.`);
  }
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
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
