'use strict';

const { contextBridge, ipcRenderer, sharedTexture } = require('electron');
const { pathToFileURL } = require('node:url');
const { NativeVideoPresentationSink } = require('../runtime/presentationSink.cjs');
const { registerTextureReceiver } = require('../runtime/textureReceiver.cjs');
const { EncodedPreviewRenderer } = require('../runtime/encodedPreviewRenderer.cjs');
const { NATIVE_SCREEN_PREVIEW_IPC } = require('@monky/shared');
const errors = [];
let sink, pixels, presentationId, preview, copyPending = false;
const onError = error => { errors.push(error.message); console.error(error); };
const { registerNativeAudioPortReceiver } = require('../runtime/nativeAudioPortRenderer.cjs');
const audio = registerNativeAudioPortReceiver(ipcRenderer, require('@monky/shared'), {
  workletUrl: pathToFileURL(require.resolve('../runtime/nativePcmPlayout.worklet.js')).href, onError,
});
window.addEventListener('beforeunload', () => { void audio.dispose().catch(onError); }, { once: true });

async function acceptFrame(frame, timestamp, identity) {
  if (!sink) { frame.close(); return false; }
  if (!pixels && !copyPending) {
    copyPending = true;
    try {
      const buffer = new Uint8Array(frame.allocationSize({ format: 'RGBA' }));
      const layout = await frame.copyTo(buffer, { format: 'RGBA' });
      const width = frame.visibleRect.width, height = frame.visibleRect.height;
      const at = (x, y) => {
        const offset = layout[0].offset + Math.floor(y * height) * layout[0].stride + Math.floor(x * width) * 4;
        return [...buffer.subarray(offset, offset + 4)];
      };
      pixels = { width, height, top: at(.02, .05), bottom: at(.98, .95),
        left: at(.02, .5), right: at(.98, .5), center: at(.5, .5) };
    } finally { copyPending = false; }
  }
  return sink.acceptFrame(frame, timestamp, identity);
}

registerTextureReceiver(sharedTexture, {
  getSink: metadata => sink && metadata.presentationId === presentationId ? { acceptFrame } : null,
  onError,
});
ipcRenderer.on(NATIVE_SCREEN_PREVIEW_IPC.port, (event, info) => {
  if (!preview || info.presentationId !== presentationId || event.ports.length !== 1) {
    for (const port of event.ports) port.close();
    onError(new Error('Unexpected owned preview port.'));
    return;
  }
  preview.attach(event.ports[0]);
});

contextBridge.exposeInMainWorld('nativeCaptureSmoke', {
  async start(id, encoded = false) {
    if (sink) throw new Error('A smoke presentation is already active.');
    presentationId = id; pixels = null;
    sink = new NativeVideoPresentationSink(document.getElementById('screen-smoke-video'), onError);
    if (encoded) preview = new EncodedPreviewRenderer({ acceptFrame }, onError);
    return sink.start();
  },
  async sample() {
    return { pixels, errors: [...errors], sampledAtMs: performance.now(), playback: await sink?.sample(), audio: audio.getStats() };
  },
  async stop() {
    await preview?.stop(); preview = null;
    const current = sink;
    sink = null; presentationId = null;
    return current ? current.stop() : null;
  },
});
