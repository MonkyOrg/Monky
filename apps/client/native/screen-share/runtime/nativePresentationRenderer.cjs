'use strict';

const { nativeScreenPresentationSchema } = require('@monky/shared');
const { NativeVideoPresentationSink } = require('./presentationSink.cjs');
const { registerTextureReceiver } = require('./textureReceiver.cjs');

function createNativeScreenPresentation(textures, document, onError) {
  if (typeof document?.getElementById !== 'function' || typeof document.querySelectorAll !== 'function'
    || typeof textures?.setSharedTextureReceiver !== 'function' || typeof onError !== 'function')
    throw new Error('Native presentation needs its owned document, texture receiver and error observer.');
  const presentations = new Map();
  const report = (presentationId, error) => {
    try { onError(presentationId, error instanceof Error ? error : new Error(String(error))); }
    catch (observerError) { console.error('Native presentation error observer failed:', observerError); }
  };
  registerTextureReceiver(textures, {
    getSink: metadata => presentations.get(metadata.presentationId)?.sink ?? null,
    onError: error => report(null, error),
  });
  const stop = async input => {
    const id = nativeScreenPresentationSchema.shape.presentationId.parse(input);
    const entry = presentations.get(id);
    if (!entry) return;
    if (!entry.stopping) {
      entry.sink.stopAccepting();
      entry.stopping = (async () => {
        // Focus/grid players can share this track. Release their last GPU frame
        // before Main waits for SharedTexture retirement.
        for (const video of document.querySelectorAll('video')) {
          if (video !== entry.video && video.srcObject === entry.sink.stream) {
            video.pause();
            video.srcObject = null;
          }
        }
        await entry.sink.stop();
        if (presentations.get(id) === entry) presentations.delete(id);
      })();
      void entry.stopping.catch(() => { entry.stopping = null; });
    }
    await entry.stopping;
  };
  return Object.freeze({
    async attach(input) {
      const { presentationId, elementId } = nativeScreenPresentationSchema.parse(input);
      const video = document.getElementById(elementId);
      if (presentations.has(presentationId) || presentations.size >= 64 || !video || video.nodeName !== 'VIDEO')
        throw new Error('Native presentation destination is missing, retained or at capacity.');
      const sink = new NativeVideoPresentationSink(video, error => report(presentationId, error));
      const entry = { video, sink, stopping: null };
      presentations.set(presentationId, entry);
      try { await sink.start(); }
      catch (error) {
        try { await stop(presentationId); }
        catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Native presentation setup and cleanup failed.'); }
        throw error;
      }
    },
    stop,
    async sample(input) {
      const id = nativeScreenPresentationSchema.shape.presentationId.parse(input);
      const entry = presentations.get(id);
      if (!entry) return null;
      const stats = await entry.sink.sample();
      return {
        framesSubmitted: stats.counters.framesSubmitted, bridgeBusyDrops: stats.counters.bridgeBusyDrops,
        presentedFrames: stats.counters.presentedFrames, playbackStarted: stats.playbackStarted,
      };
    },
    async close() {
      const results = await Promise.allSettled([...presentations.keys()].map(stop));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'Native document presentations did not retire.');
    },
  });
}

module.exports = { createNativeScreenPresentation };
