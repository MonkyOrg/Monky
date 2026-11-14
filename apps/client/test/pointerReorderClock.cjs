async function installReorderClock(contents) {
  await contents.executeJavaScript(`(${install.toString()})()`);
}

async function install() {
  const { REORDER_HOLD_MS } = await import('/utils/pointerReorder.ts');
  const set = window.setTimeout.bind(window);
  const clear = window.clearTimeout.bind(window);
  const pending = new Map();
  let nextId = -1;
  window.setTimeout = (callback, delay, ...args) => {
    if (delay !== REORDER_HOLD_MS || typeof callback !== 'function') return set(callback, delay, ...args);
    const id = nextId--;
    pending.set(id, () => callback(...args));
    return id;
  };
  window.clearTimeout = id => {
    if (!pending.delete(id)) clear(id);
  };
  window.reorderHold = {
    pending: () => pending.size,
    activate: () => {
      if (pending.size !== 1) throw new Error(`Expected one reorder hold, found ${pending.size}`);
      const [id, callback] = pending.entries().next().value;
      pending.delete(id);
      callback();
    },
  };
}

module.exports = { installReorderClock };
