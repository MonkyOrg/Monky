'use strict';

const { NativeAudioOutputOwner } = require('./nativeAudioOutputOwner.cjs');
const { NativeAudioPortMain } = require('./nativeAudioPortMain.cjs');
const { notifyObserver } = require('./asyncTools.cjs');

function createNativeAudioOutput({
  engine, commands, webContents, frame, expectedUrl, sessionId, protocol, createMessageChannel, onError,
  timeoutMs = 5000,
}) {
  if (typeof onError !== 'function') throw new Error('Native audio output requires its Root error observer.');
  const report = (error, context) => notifyObserver('Native audio Root error observer', onError, error, Object.freeze({ ...context }));
  let owner;
  const renderer = new NativeAudioPortMain({
    webContents, frame, expectedUrl, sessionId, protocol, createMessageChannel,
    controls: {
      configureOutput: data => owner.configureOutput(data),
      grantCredits: data => owner.grantCredits(data),
      probe: data => owner.probe(data),
      calibrate: data => owner.calibrate(data),
      feedback: data => owner.feedback(data),
    },
    onError: (error, context) => {
      // A late error must stop its original output, never a replacement epoch.
      const stopping = owner.stop(context.epoch);
      void stopping.catch(cleanupError => report(cleanupError, { ...context, phase: 'renderer.cleanup' }));
      report(error, { ...context, phase: 'renderer' });
    },
  });
  owner = new NativeAudioOutputOwner(engine, commands, renderer, onError, { timeoutMs });
  return Object.freeze({ owner, renderer });
}

module.exports = { createNativeAudioOutput };
