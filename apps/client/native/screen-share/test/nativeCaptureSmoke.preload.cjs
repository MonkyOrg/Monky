'use strict';

const { contextBridge, ipcRenderer, sharedTexture } = require('electron');
const { pathToFileURL } = require('node:url');
const { NativeVideoPresentationSink } = require('../runtime/presentationSink.cjs');
const { registerTextureReceiver } = require('../runtime/textureReceiver.cjs');
const { EncodedPreviewRenderer } = require('../runtime/encodedPreviewRenderer.cjs');
const { NATIVE_SCREEN_PREVIEW_IPC, NATIVE_SCREEN_IPC, NATIVE_SCREEN_EVENT } = require('@monky/shared');
const errors = [];
const audioScheduling = [];
let sink, pixels, presentationId, preview, copyPending = false;
const onError = error => { errors.push(error.message); console.error(error); };
const { registerNativeAudioPortReceiver } = require('../runtime/nativeAudioPortRenderer.cjs');
const audio = registerNativeAudioPortReceiver(ipcRenderer, require('@monky/shared'), {
  workletUrl: pathToFileURL(require.resolve('../runtime/nativePcmPlayout.worklet.js')).href, onError,
  createWorklet: process.argv.includes('--native-audio-continuity-diagnostics') ? function(context, options) {
    const node = new AudioWorkletNode(context, 'native-pcm-playout', options);
    const state = { epoch: options.processorOptions.epoch, timeOrigin: performance.timeOrigin, credits: [], events: [], maxRoundtripMs: 0,
      maxPcmGapMs: 0, lastPcmAt: null, baseLatency: context.baseLatency, outputLatency: context.outputLatency };
    audioScheduling.push(state);
    const record = event => {
      state.events.push(event);
      if (state.events.length > 256) state.events.shift();
    };
    node.port.addEventListener('message', ({ data }) => {
      const at = performance.now();
      if (data.type === 'credits') {
        state.credits.push({ at, frames: data.frames });
        record({ type: 'credits', at, frames: data.frames, grantSequence: data.grantSequence });
      } else if (data.type === 'feedback' && data.underrun) {
        record({ type: 'underrun', at, playout: data.playout });
      }
    });
    const postMessage = node.port.postMessage.bind(node.port);
    node.port.postMessage = (data, ...args) => {
      if (data.type === 'pcm') {
        const at = performance.now(), credit = state.credits[0];
        if (!credit || credit.frames < data.packet.frames)
          throw new Error('The real audio diagnostic observed PCM without its worklet credit.');
        credit.frames -= data.packet.frames;
        if (credit.frames === 0) state.credits.shift();
        const roundtripMs = at - credit.at;
        state.maxRoundtripMs = Math.max(state.maxRoundtripMs, roundtripMs);
        const gapMs = state.lastPcmAt === null ? 0 : at - state.lastPcmAt;
        state.maxPcmGapMs = Math.max(state.maxPcmGapMs, gapMs);
        state.lastPcmAt = at;
        record({ type: 'pcm', at, sequence: data.packet.sequence, roundtripMs, gapMs });
      }
      return postMessage(data, ...args);
    };
    return node;
  } : undefined,
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

async function stop() {
  await preview?.stop(); preview = null;
  const current = sink;
  sink = null; presentationId = null;
  return current ? current.stop() : null;
}
ipcRenderer.on(NATIVE_SCREEN_EVENT, (_event, value) => {
  if (value.type === 'error') onError(new Error(value.message));
  if (value.type === 'presentation-stop') {
    void (async () => {
      if (value.presentationId !== presentationId) throw new Error('Unexpected owned presentation retirement.');
      await stop();
      await ipcRenderer.invoke(NATIVE_SCREEN_IPC.reply, {
        callId: value.callId, requestId: value.requestId, ok: true, value: null,
      });
    })().catch(onError);
  }
});
contextBridge.exposeInMainWorld('nativeCaptureSmoke', {
  command: value => ipcRenderer.invoke(NATIVE_SCREEN_IPC.invoke, value),
  async start(id, encoded = false) {
    if (sink) throw new Error('A smoke presentation is already active.');
    presentationId = id; pixels = null;
    sink = new NativeVideoPresentationSink(document.getElementById('screen-smoke-video'), onError);
    if (encoded) preview = new EncodedPreviewRenderer({ acceptFrame }, onError);
    return sink.start();
  },
  async sample() {
    return { pixels, errors: [...errors], sampledAtMs: performance.now(), playback: await sink?.sample(),
      audio: audio.getStats(), audioScheduling };
  },
  stop,
});
