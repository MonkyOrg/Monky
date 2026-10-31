'use strict';

// Loaded by sandboxed preloads, which can require no Node built-in module:
// everything here comes from the shared contracts and the platform.
const { within } = require('./asyncTools.cjs');
const {
  NATIVE_SCREEN_TEXTURE_IPC, nativeScreenTextureChannelInfoSchema, nativeScreenTextureMessageSchema,
  nativeScreenTextureReceiptSchema,
} = require('@monky/shared');

const MAX_TEXTURE_TRANSFERS = 16;

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function registerTextureTransferReceiver(textures, ipcRenderer, receive, onError) {
  check(typeof textures?.subtle?.finishTransferSharedTexture === 'function', 'Shared texture reception is unavailable.');
  const channels = new Map();
  const listener = (event, value) => {
    let port;
    try {
      check(event.ports.length === 1, 'Native texture transfer requires exactly one private port.');
      const { channelId } = nativeScreenTextureChannelInfoSchema.parse(value);
      check(!channels.has(channelId), 'Duplicate native texture channel.');
      port = event.ports[0];
      const active = new Map();
      let lastSequence = 0, closing = false, draining = false, finished = false, complete;
      const closed = new Promise(resolve => { complete = resolve; });
      const finish = () => {
        if (!closing || active.size || finished) return;
        finished = true;
        try { port.postMessage({ kind: 'closed' }); }
        catch (error) { onError(error); }
        finally {
          port.removeEventListener('message', message);
          port.close();
          channels.delete(channelId);
          complete();
        }
      };
      const close = () => { closing = true; finish(); return closed; };
      const drain = () => {
        if (!draining && !finished) {
          draining = true;
          try { port.postMessage({ kind: 'drain' }); }
          catch (error) { onError(error); }
        }
        return closed;
      };
      const message = event => {
        let native, sequence, released = false;
        const release = () => {
          if (released || !native) return;
          released = true;
          native.release(() => {
            try { port.postMessage({ kind: 'retired', sequence }); }
            catch (error) { onError(error); }
            finally { active.delete(sequence); finish(); }
          });
        };
        try {
          const packet = nativeScreenTextureMessageSchema.parse(event.data);
          if (packet.kind === 'close') { close(); return; }
          check(!closing, 'Native texture receiver is closing.');
          check(packet.sequence === lastSequence + 1, 'Native texture sequence is not consecutive.');
          check(active.size < MAX_TEXTURE_TRANSFERS, 'Native texture receiver credit exhausted.');
          sequence = packet.sequence;
          lastSequence = sequence;
          active.set(sequence, true);
          native = textures.subtle.finishTransferSharedTexture(packet.info.transfer);
          const token = native.getFrameCreationSyncToken();
          const receipt = nativeScreenTextureReceiptSchema.parse({ kind: 'imported', sequence, syncToken: token.syncToken });
          port.postMessage(receipt);
          const importedSharedTexture = { getVideoFrame: () => native.getVideoFrame(), release };
          void Promise.resolve().then(() => receive({ importedSharedTexture }, packet.info.metadata))
            .catch(onError).finally(release).catch(onError);
        } catch (error) {
          onError(error);
          if (sequence !== undefined) {
            try { port.postMessage({ kind: 'error', sequence, message: String(error.message ?? error).slice(0, 512) }); }
            catch (failure) { onError(failure); }
          }
          if (native) release();
          else {
            // A throwing import cannot prove GPU retirement to Main.
            active.delete(sequence);
            close();
          }
        }
      };
      channels.set(channelId, { drain, closed });
      port.addEventListener('message', message);
      port.start();
    } catch (error) {
      onError(error);
      for (const unused of event.ports ?? []) unused.close();
    }
  };
  ipcRenderer.on(NATIVE_SCREEN_TEXTURE_IPC.port, listener);
  return async () => {
    ipcRenderer.removeListener(NATIVE_SCREEN_TEXTURE_IPC.port, listener);
    await within(Promise.all([...channels.values()].map(channel => channel.drain())),
      12000, 'Native renderer texture retirement timed out; GPU receipts remain pending.');
  };
}

module.exports = { MAX_TEXTURE_TRANSFERS, registerTextureTransferReceiver };
