'use strict';

const assert = require('node:assert/strict');
const { boundedCleanup } = require('./frameSink.cjs');
const {
  NATIVE_SCREEN_TEXTURE_IPC, nativeScreenTexturePortInfoSchema, nativeScreenTextureReceiptSchema,
} = require('@monky/shared');

async function sendTexture(imported, destination, metadata, onError, {
  timeoutMs = 12000,
  createChannel = () => new (require('electron').MessageChannelMain)(),
  onAcquired = () => {},
} = {}) {
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000);
  const native = imported.subtle;
  assert.equal(typeof native?.startTransferSharedTexture, 'function');
  assert.equal(typeof native?.setReleaseSyncToken, 'function');
  const info = nativeScreenTexturePortInfoSchema.parse({
    metadata, transfer: native.startTransferSharedTexture(),
  });
  const { port1, port2 } = createChannel();
  let acquired = false, receiverFailed = false, retired = false, reported = false, resolve;
  const completion = new Promise(yes => { resolve = yes; });
  const report = error => {
    clearTimeout(deadline);
    if (!reported) { reported = true; onError(error); }
  };
  const deadline = setTimeout(() => report(new Error(
    'Native texture acquisition timed out; the transfer and GPU lease remain owned.',
  )), timeoutMs);
  const message = event => {
    try {
      const receipt = nativeScreenTextureReceiptSchema.parse(event.data);
      if (receipt.kind === 'error') { receiverFailed = true; throw new Error(receipt.message); }
      if (receipt.kind === 'imported') {
        assert.equal(acquired, false, 'Duplicate native texture acquisition receipt.');
        const token = Buffer.from(receipt.syncToken, 'base64');
        assert.equal(token.toString('base64'), receipt.syncToken);
        assert.equal(token.length, Buffer.from(info.transfer.syncToken, 'base64').length);
        native.setReleaseSyncToken({ syncToken: receipt.syncToken });
        acquired = true;
        clearTimeout(deadline);
        onAcquired();
      } else {
        assert.ok(acquired || receiverFailed, 'Texture retirement arrived before acquisition or receiver failure.');
        assert.equal(retired, false, 'Duplicate native texture retirement receipt.');
        retired = true;
        resolve();
      }
    } catch (error) { report(error); }
  };
  const closed = () => {
    if (!retired) report(new Error('Native texture port closed without its GPU retirement receipt; ownership is retained.'));
  };
  port1.on('message', message);
  port1.on('close', closed);
  port1.start();
  try { destination.postMessage(NATIVE_SCREEN_TEXTURE_IPC.port, info, [port2]); }
  catch (error) {
    // postMessage may already have crossed the process boundary. A timeout or
    // exception is not permission to release an imported texture.
    report(error);
    port2.close();
  }
  await completion;
  port1.removeListener('message', message);
  port1.removeListener('close', closed);
  port1.close();
}

function registerTextureTransferReceiver(textures, ipcRenderer, receive, onError) {
  assert.equal(typeof textures?.subtle?.finishTransferSharedTexture, 'function');
  const active = new Map();
  const listener = (event, value) => {
    let port, native, released = false, complete;
    const release = () => {
      if (released || !native) return;
      released = true;
      native.release(() => {
        try { port.postMessage({ kind: 'retired' }); }
        catch (error) { onError(error); }
        finally { port.close(); active.delete(port); complete(); }
      });
    };
    try {
      assert.equal(event.ports.length, 1, 'Native texture transfer requires exactly one private port.');
      port = event.ports[0];
      const info = nativeScreenTexturePortInfoSchema.parse(value);
      active.set(port, new Promise(resolve => { complete = resolve; }));
      native = textures.subtle.finishTransferSharedTexture(info.transfer);
      const token = native.getFrameCreationSyncToken();
      nativeScreenTextureReceiptSchema.parse({ kind: 'imported', syncToken: token.syncToken });
      port.postMessage({ kind: 'imported', syncToken: token.syncToken });
      const importedSharedTexture = {
        getVideoFrame: () => native.getVideoFrame(),
        release,
      };
      void Promise.resolve().then(() => receive({ importedSharedTexture }, info.metadata))
        .catch(onError).finally(release).catch(onError);
    } catch (error) {
      onError(error);
      if (port) {
        try { port.postMessage({ kind: 'error', message: String(error.message ?? error).slice(0, 512) }); }
        catch (sendError) { onError(sendError); }
        if (native) release();
        else { port.close(); active.delete(port); complete?.(); }
      } else for (const unused of event.ports ?? []) unused.close();
    }
  };
  ipcRenderer.on(NATIVE_SCREEN_TEXTURE_IPC.port, listener);
  return async () => {
    await boundedCleanup((async () => {
      while (active.size) await Promise.all(active.values());
    })(), 'Native renderer texture retirement timed out; GPU receipts remain pending.', 12000);
    ipcRenderer.removeListener(NATIVE_SCREEN_TEXTURE_IPC.port, listener);
  };
}

module.exports = { sendTexture, registerTextureTransferReceiver };
