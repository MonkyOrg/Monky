'use strict';

async function within(promise, milliseconds, description) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(description)), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { within };
