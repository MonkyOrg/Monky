'use strict';

const { contextBridge, ipcRenderer, sharedTexture } = require('electron');
const { pathToFileURL } = require('node:url');
const { NativeVideoPresentationSink } = require('../runtime/presentationSink.cjs');
const { registerTextureReceiver } = require('../runtime/textureReceiver.cjs');
const errors = [];
let sink, pixels, presentationId, copyPending = false;
const onError = error => { errors.push(error.message); console.error(error); };
const { registerNativeAudioPortReceiver } = require('../runtime/nativeAudioPortRenderer.cjs');
const audio = registerNativeAudioPortReceiver(ipcRenderer, require('@monky/shared'), {
  workletUrl: pathToFileURL(require.resolve('../runtime/nativePcmPlayout.worklet.js')).href, onError,
});
window.addEventListener('beforeunload', () => { void audio.dispose().catch(onError); }, { once: true });

registerTextureReceiver(sharedTexture, {
  getSink(metadata) {
    if (!sink || metadata.presentationId !== presentationId) return null;
    return {
      async acceptFrame(frame, timestamp, identity) {
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
      },
    };
  },
  onError,
});

contextBridge.exposeInMainWorld('nativeCaptureSmoke', {
  async start(id) {
    if (sink) throw new Error('A smoke presentation is already active.');
    presentationId = id; pixels = null;
    sink = new NativeVideoPresentationSink(document.getElementById('screen-smoke-video'), onError);
    return sink.start();
  },
  async sample() {
    return { pixels, errors: [...errors], sampledAtMs: performance.now(), playback: await sink?.sample(), audio: audio.getStats() };
  },
  async stop() {
    const current = sink;
    sink = null; presentationId = null;
    return current ? current.stop() : null;
  },
});
