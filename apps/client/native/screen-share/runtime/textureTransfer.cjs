'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { boundedCleanup } = require('./frameSink.cjs');
const {
  NATIVE_SCREEN_TEXTURE_IPC, nativeScreenTexturePortInfoSchema, nativeScreenTextureChannelInfoSchema,
  nativeScreenTextureMessageSchema, nativeScreenTextureReceiptSchema,
} = require('@monky/shared');

const MAX_TRANSFERS = 16;

class TextureChannel {
  constructor(destination, onError, { timeoutMs, createChannel }) {
    this.destination = destination;
    this.onError = onError;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.closing = false;
    this.closeSent = false;
    this.finished = false;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    const { port1, port2 } = createChannel();
    this.port = port1;
    this.message = event => {
      try { this.receive(nativeScreenTextureReceiptSchema.parse(event.data)); }
      catch (error) { this.onError(error); }
    };
    this.disconnected = () => {
      if (!this.finished)
        this.onError(new Error('Native texture port closed without its GPU retirement receipt; ownership is retained.'));
    };
    port1.on('message', this.message);
    port1.on('close', this.disconnected);
    port1.start();
    try {
      destination.postMessage(NATIVE_SCREEN_TEXTURE_IPC.port,
        nativeScreenTextureChannelInfoSchema.parse({ channelId: randomUUID() }), [port2]);
    } catch (error) {
      port1.removeListener('message', this.message);
      port1.removeListener('close', this.disconnected);
      // No frame has crossed this channel yet.
      try { port1.postMessage({ kind: 'close' }); }
      catch (failure) { this.onError(failure); }
      port1.close();
      port2.close();
      throw error;
    }
  }

  send(imported, metadata, onAcquired) {
    assert.ok(!this.closing && !this.finished, 'Native texture channel is closing.');
    assert.ok(this.pending.size < MAX_TRANSFERS, 'Native texture transfer credit exhausted.');
    assert.ok(Number.isSafeInteger(this.sequence + 1), 'Native texture sequence exhausted.');
    const native = imported.subtle;
    assert.equal(typeof native?.startTransferSharedTexture, 'function');
    assert.equal(typeof native?.setReleaseSyncToken, 'function');
    const info = nativeScreenTexturePortInfoSchema.parse({
      metadata, transfer: native.startTransferSharedTexture(),
    });
    const sequence = ++this.sequence;
    const record = { native, info, acquired: false, receiverFailed: false, reported: false, onAcquired };
    const completion = new Promise(resolve => { record.resolve = resolve; });
    record.report = error => {
      clearTimeout(record.deadline);
      if (!record.reported) { record.reported = true; this.onError(error); }
    };
    record.deadline = setTimeout(() => record.report(new Error(
      'Native texture acquisition timed out; the transfer and GPU lease remain owned.',
    )), this.timeoutMs);
    this.pending.set(sequence, record);
    try { this.port.postMessage(nativeScreenTextureMessageSchema.parse({ kind: 'frame', sequence, info })); }
    catch (error) { record.report(error); }
    return completion;
  }

  receive(receipt) {
    if (receipt.kind === 'drain') {
      this.closing = true;
      this.requestClose();
      return;
    }
    if (receipt.kind === 'closed') {
      assert.equal(this.pending.size, 0, 'Texture channel closed before its GPU receipts.');
      this.finished = true;
      this.closing = true;
      this.port.removeListener('message', this.message);
      this.port.removeListener('close', this.disconnected);
      this.port.close();
      this.resolveClosed();
      return;
    }
    const record = this.pending.get(receipt.sequence);
    assert.ok(record, 'Unknown or duplicate native texture receipt sequence.');
    try {
      if (receipt.kind === 'error') { record.receiverFailed = true; throw new Error(receipt.message); }
      if (receipt.kind === 'imported') {
        assert.equal(record.acquired, false, 'Duplicate native texture acquisition receipt.');
        const token = Buffer.from(receipt.syncToken, 'base64');
        assert.equal(token.toString('base64'), receipt.syncToken);
        assert.equal(token.length, Buffer.from(record.info.transfer.syncToken, 'base64').length);
        record.native.setReleaseSyncToken({ syncToken: receipt.syncToken });
        record.acquired = true;
        clearTimeout(record.deadline);
        record.onAcquired();
      } else {
        assert.ok(record.acquired || record.receiverFailed,
          'Texture retirement arrived before acquisition or receiver failure.');
        this.pending.delete(receipt.sequence);
        record.resolve();
        this.requestClose();
      }
    } catch (error) { record.report(error); }
  }

  requestClose() {
    if (!this.closing || this.finished || this.closeSent || this.pending.size) return;
    this.closeSent = true;
    try { this.port.postMessage({ kind: 'close' }); }
    catch (error) { this.onError(error); }
  }

  close() {
    this.closing = true;
    this.requestClose();
    return boundedCleanup(this.closed,
      'Native texture channel cleanup timed out; GPU receipts remain owned.', this.timeoutMs);
  }
}

class TextureTransferSender {
  constructor(onError, {
    timeoutMs = 12000, createChannel = () => new (require('electron').MessageChannelMain)(),
  } = {}) {
    assert.equal(typeof onError, 'function');
    assert.equal(typeof createChannel, 'function');
    assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60000);
    this.onError = onError;
    this.options = { timeoutMs, createChannel };
    this.channels = new Set();
    this.current = null;
    this.stopping = false;
  }

  send(imported, destination, metadata, onAcquired = () => {}) {
    assert.equal(this.stopping, false, 'Native texture sender is closing.');
    if (!this.current || this.current.destination !== destination || this.current.finished) {
      if (this.current && !this.current.finished)
        void this.current.close().catch(this.onError);
      assert.ok(this.channels.size < MAX_TRANSFERS + 1, 'Native texture channel budget exhausted.');
      const channel = new TextureChannel(destination, this.onError, this.options);
      this.channels.add(channel);
      void channel.closed.then(() => this.channels.delete(channel));
      this.current = channel;
    }
    return this.current.send(imported, metadata, onAcquired);
  }

  async close() {
    this.stopping = true;
    await Promise.all([...this.channels].map(channel => channel.close()));
    this.current = null;
  }
}

async function sendTexture(imported, destination, metadata, onError, { onAcquired, ...options } = {}) {
  const sender = new TextureTransferSender(onError, options);
  await sender.send(imported, destination, metadata, onAcquired);
  await sender.close();
}

function registerTextureTransferReceiver(textures, ipcRenderer, receive, onError) {
  assert.equal(typeof textures?.subtle?.finishTransferSharedTexture, 'function');
  const channels = new Map();
  const listener = (event, value) => {
    let port;
    try {
      assert.equal(event.ports.length, 1, 'Native texture transfer requires exactly one private port.');
      const { channelId } = nativeScreenTextureChannelInfoSchema.parse(value);
      assert.ok(!channels.has(channelId), 'Duplicate native texture channel.');
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
          assert.equal(closing, false, 'Native texture receiver is closing.');
          assert.equal(packet.sequence, lastSequence + 1, 'Native texture sequence is not consecutive.');
          assert.ok(active.size < MAX_TRANSFERS, 'Native texture receiver credit exhausted.');
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
    await boundedCleanup(Promise.all([...channels.values()].map(channel => channel.drain())),
      'Native renderer texture retirement timed out; GPU receipts remain pending.', 12000);
  };
}

module.exports = { TextureTransferSender, sendTexture, registerTextureTransferReceiver };
