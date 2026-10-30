'use strict';

// What a window's preload needs to present native screens and play their
// audio. Capture, transport and process management stay in the main process,
// so a preload that loads this entry never parses them (E-MAIN-8).
const { createNativeScreenPresentation } = require('./runtime/nativePresentationRenderer.cjs');
const { registerNativeAudioPortReceiver } = require('./runtime/nativeAudioPortRenderer.cjs');

module.exports = { createNativeScreenPresentation, registerNativeAudioPortReceiver };
