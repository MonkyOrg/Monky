'use strict';

const path = require('path');

let binding;
try {
  binding = require('./build/Release/screen_audio.node');
} catch {
  try {
    binding = require('./build/Debug/screen_audio.node');
  } catch {
    binding = null;
  }
}

function isSupported() {
  if (!binding) return false;
  return binding.isSupported();
}

function start(options, callback) {
  if (!binding) return { success: false, error: 'Native module not available' };
  return binding.start(options, callback);
}

function stop() {
  if (!binding) return { success: false };
  return binding.stop();
}

function getLastError() {
  if (!binding) return '';
  return binding.getLastError();
}

function getStatus() {
  if (!binding) return 0;
  return binding.getStatus();
}

function listWindowOwners() {
  if (!binding || typeof binding.listWindowOwners !== 'function') return [];
  return binding.listWindowOwners();
}

function listWindows() {
  if (!binding || typeof binding.listWindows !== 'function') return [];
  return binding.listWindows();
}

function restoreWindow(hwnd) {
  if (!binding || typeof binding.restoreWindow !== 'function') return false;
  return binding.restoreWindow(hwnd);
}

function getKeyboardLayout(previousId = '', characters = '') {
  if (!binding || typeof binding.getKeyboardLayout !== 'function') return null;
  return binding.getKeyboardLayout(previousId, characters);
}

module.exports = { isSupported, start, stop, getLastError, getStatus, listWindowOwners, listWindows, restoreWindow, getKeyboardLayout };
